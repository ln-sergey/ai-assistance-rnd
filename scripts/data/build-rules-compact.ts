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
// Идемпотентен: при одинаковом содержимом YAML результат байт-в-байт
// совпадает (generated_at = last_updated из источника).
//
// Использование:
//   pnpm rules:compact

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const TEXT_RULES_PATH = join(REPO_ROOT, 'text_rules.yaml');
const IMAGE_RULES_PATH = join(REPO_ROOT, 'image_rules.yaml');
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
}

interface BuildSpec {
  src: string;
  out: string;
  kind: 'text' | 'image';
  expectedCount: number;
  idPattern: RegExp;
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

async function buildOne(spec: BuildSpec): Promise<{ outPath: string; sizeBytes: number }> {
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

  const compact: CompactDoc = {
    version: 1,
    kind: spec.kind,
    generated_at: doc.last_updated,
    severity_scale: doc.severity_scale,
    rules: doc.rules.map((r) => ({
      id: r.id,
      severity: r.severity,
      title: r.title.trim(),
      desc: buildDesc(r.description),
    })),
  };

  const json = JSON.stringify(compact, null, 2) + '\n';
  await writeFile(spec.out, json, 'utf8');
  return { outPath: spec.out, sizeBytes: Buffer.byteLength(json, 'utf8') };
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
    },
  ];
  for (const s of specs) {
    const { outPath, sizeBytes } = await buildOne(s);
    const rel = outPath.replace(REPO_ROOT + '/', '');
    console.log(`[rules:compact] ${rel}: kind=${s.kind}, count=${s.expectedCount}, size=${(sizeBytes / 1024).toFixed(1)} KB`);
  }
}

main().catch((err) => {
  console.error('[rules:compact] failure:', err);
  process.exit(1);
});
