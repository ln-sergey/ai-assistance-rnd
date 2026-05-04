// Собирает компактную таблицу правил для промптов LLM-агентов.
// Источники правды — text_rules.yaml + image_rules.yaml (полные описания
// с категориями и примерами). Промпт читать всё это не должен: контекста
// много, а агенту для разметки нужны только id, severity, title и краткий
// desc. Скрипт генерирует два независимых файла:
//   - datasets/text_rules.compact.json — для текстовой модерации
//   - datasets/image_rules.compact.json — для фото-модерации
// Файлы не склеиваются: текстовый агент не должен видеть IMG-правила
// и наоборот (тот же мотив, что и у split'а rules.yaml в этап 1).
//
// Image-таблица фильтруется по datasets/image_rules.scope.yaml: в
// промпт image-разметчика попадают только AI-only правила (Sprint P6
// Этап 0). Heuristic-разрешимые (blur/aspect/pHash/...) выводятся за
// scope. Если scope-конфиг отсутствует — fallback на все 30 правил
// (обратная совместимость).
//
// Идемпотентен: при одинаковом содержимом YAML и scope-конфига результат
// байт-в-байт совпадает (generated_at = last_updated из источника).
//
// Использование:
//   pnpm rules:compact

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const TEXT_RULES_PATH = join(REPO_ROOT, 'text_rules.yaml');
const IMAGE_RULES_PATH = join(REPO_ROOT, 'image_rules.yaml');
const IMAGE_SCOPE_PATH = join(REPO_ROOT, 'datasets/image_rules.scope.yaml');
const TEXT_OUT_PATH = join(REPO_ROOT, 'datasets/text_rules.compact.json');
const IMAGE_OUT_PATH = join(REPO_ROOT, 'datasets/image_rules.compact.json');

const DESC_MAX_CHARS = 200;

type Severity = 'low' | 'medium' | 'high' | 'critical';

interface RawRule {
  id: string;
  category?: string;
  title: string;
  description: string;
  example?: string;
  severity: Severity;
}

interface RawDoc {
  version: number;
  last_updated: string;
  severity_scale: Record<Severity, string>;
  rules: RawRule[];
}

interface CompactRule {
  id: string;
  severity: Severity;
  title: string;
  desc: string;
}

interface CompactDoc {
  version: 1;
  kind: 'text' | 'image';
  generated_at: string;
  severity_scale: Record<Severity, string>;
  rules: CompactRule[];
  scope?: {
    config: string;
    in_scope: number;
    out_of_scope: number;
  };
}

interface BuildSpec {
  src: string;
  out: string;
  kind: 'text' | 'image';
  expectedCount: number;
  idPattern: RegExp;
  scopePath?: string;
}

interface ScopeDoc {
  version: number;
  in_scope?: unknown;
  out_of_scope?: unknown;
}

interface LoadedScope {
  inScope: Set<string>;
  configRel: string;
  rawTotal: number; // всего id в in_scope (для логов)
  outOfScope: number; // всего id в out_of_scope (для логов)
}

async function loadScope(path: string): Promise<LoadedScope | null> {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf8');
  const doc = parseYaml(raw) as ScopeDoc;
  const inScope = new Set<string>();
  if (Array.isArray(doc.in_scope)) {
    for (const v of doc.in_scope) {
      if (typeof v === 'string') inScope.add(v.trim());
    }
  }
  let outCount = 0;
  if (Array.isArray(doc.out_of_scope)) {
    for (const v of doc.out_of_scope) {
      if (typeof v === 'string') outCount += 1;
      else if (v && typeof v === 'object') outCount += 1;
    }
  }
  return {
    inScope,
    configRel: path.replace(REPO_ROOT + '/', ''),
    rawTotal: inScope.size,
    outOfScope: outCount,
  };
}

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function buildDesc(description: string): string {
  const firstLine = description.split('\n')[0]?.trim() ?? '';
  if (firstLine.length <= DESC_MAX_CHARS) return firstLine;
  const truncated = firstLine.slice(0, DESC_MAX_CHARS);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
}

async function buildOne(spec: BuildSpec): Promise<{
  outPath: string;
  sizeBytes: number;
  totalRules: number;
  emittedRules: number;
  scopeConfig: string | null;
}> {
  const yaml = await readFile(spec.src, 'utf8');
  const doc = parseYaml(yaml) as RawDoc;

  if (!doc?.rules || !Array.isArray(doc.rules)) {
    bail(`[rules:compact] ${spec.src}: не найден массив rules`);
  }
  if (doc.rules.length !== spec.expectedCount) {
    bail(
      `[rules:compact] ${spec.src}: ожидалось ${spec.expectedCount} правил, найдено ${doc.rules.length}`,
    );
  }
  if (!doc.last_updated) bail(`[rules:compact] ${spec.src}: нет last_updated`);
  for (const k of ['low', 'medium', 'high', 'critical'] as Severity[]) {
    if (!doc.severity_scale?.[k]) bail(`[rules:compact] ${spec.src}: severity_scale.${k} отсутствует`);
  }
  for (const r of doc.rules) {
    if (!spec.idPattern.test(r.id)) {
      bail(`[rules:compact] ${spec.src}: id "${r.id}" не соответствует ${spec.idPattern}`);
    }
    if (!r.title || !r.description || !r.severity) {
      bail(`[rules:compact] ${spec.src}: правило ${r.id} неполное (нужны title, description, severity)`);
    }
  }

  // Опциональная фильтрация по scope-конфигу (Sprint P6 Этап 0).
  // Применяется только к image-правилам; для text-правил scopePath не
  // указан и фильтр не применяется. Если конфиг отсутствует — fallback
  // на полный набор (обратная совместимость).
  let scope: LoadedScope | null = null;
  if (spec.scopePath) {
    scope = await loadScope(spec.scopePath);
    if (scope) {
      const ruleIds = new Set(doc.rules.map((r) => r.id));
      for (const id of scope.inScope) {
        if (!ruleIds.has(id)) {
          bail(
            `[rules:compact] ${spec.scopePath}: in_scope содержит неизвестный rule_id "${id}" (нет в ${spec.src})`,
          );
        }
      }
    }
  }

  const filteredRules = scope
    ? doc.rules.filter((r) => scope!.inScope.has(r.id))
    : doc.rules;

  const compact: CompactDoc = {
    version: 1,
    kind: spec.kind,
    generated_at: doc.last_updated,
    severity_scale: doc.severity_scale,
    rules: filteredRules.map((r) => ({
      id: r.id,
      severity: r.severity,
      title: r.title.trim(),
      desc: buildDesc(r.description),
    })),
  };
  if (scope) {
    compact.scope = {
      config: scope.configRel,
      in_scope: scope.inScope.size,
      out_of_scope: scope.outOfScope,
    };
  }

  const json = JSON.stringify(compact, null, 2) + '\n';
  await writeFile(spec.out, json, 'utf8');
  return {
    outPath: spec.out,
    sizeBytes: Buffer.byteLength(json, 'utf8'),
    totalRules: doc.rules.length,
    emittedRules: filteredRules.length,
    scopeConfig: scope?.configRel ?? null,
  };
}

async function main(): Promise<void> {
  const specs: BuildSpec[] = [
    {
      src: TEXT_RULES_PATH,
      out: TEXT_OUT_PATH,
      kind: 'text',
      expectedCount: 35,
      idPattern: /^TXT-\d{2}$/,
    },
    {
      src: IMAGE_RULES_PATH,
      out: IMAGE_OUT_PATH,
      kind: 'image',
      expectedCount: 30,
      idPattern: /^IMG-\d{2}$/,
      scopePath: IMAGE_SCOPE_PATH,
    },
  ];
  for (const s of specs) {
    const { outPath, sizeBytes, totalRules, emittedRules, scopeConfig } = await buildOne(s);
    const rel = outPath.replace(REPO_ROOT + '/', '');
    const scopeNote = scopeConfig
      ? ` (scope=${scopeConfig}: ${emittedRules}/${totalRules})`
      : '';
    console.log(
      `[rules:compact] ${rel}: kind=${s.kind}, count=${emittedRules}/${totalRules}, size=${(sizeBytes / 1024).toFixed(1)} KB${scopeNote}`,
    );
  }
}

main().catch((err) => {
  console.error('[rules:compact] failure:', err);
  process.exit(1);
});
