// Переносит заполненные скаффолды из datasets/annotations/pending/ в общий
// store datasets/annotations/<source>.json. Каждый файл нормализуется
// (убираются служебные поля), валидируется по annotation.schema.json, и
// для TXT-нарушений проверяется, что quote дословно встречается в
// исходной карточке по field_path. Только после полной проверки запись
// мёрджится в store, и pending-файл удаляется.
//
// Идемпотентен: уже-коммитнутые карточки в pending не лежат, повторный
// прогон — no-op.
//
// Использование:
//   pnpm annotations:commit
//   pnpm annotations:commit -- --dry-run
//   pnpm annotations:commit -- --yes

import { existsSync } from 'node:fs';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';

import { loadSourcesConfig, realSources } from '../parse/lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const SCHEMA_DIR = join(DATASETS_DIR, 'schema');
const ANNOTATIONS_DIR = join(DATASETS_DIR, 'annotations');
const PENDING_DIR = join(ANNOTATIONS_DIR, 'pending');

interface CliArgs {
  dryRun: boolean;
  yes: boolean;
}

type Severity = 'low' | 'medium' | 'high' | 'critical';

interface Violation {
  rule_id: string;
  severity: Severity;
  field_path: string;
  quote: string | null;
  rationale: string;
}

interface Annotation {
  expected_clean: boolean;
  violations: Violation[];
  notes: string | null;
  annotated_at: string;
  annotator: string;
}

interface AnnotationStore {
  version: 1;
  annotations: Record<string, Annotation>;
}

interface PendingRaw {
  case_id?: unknown;
  source?: unknown;
  card_excerpt?: unknown;
  expected_clean?: unknown;
  violations?: unknown;
  notes?: unknown;
  annotator?: unknown;
  annotated_at?: unknown;
  _help?: unknown;
}

interface CardRecord {
  card: Record<string, unknown> & { id: string };
}

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
  let dryRun = false;
  let yes = false;
  for (const a of argv) {
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a === '--yes') {
      yes = true;
      continue;
    }
    bail(`[commit] неизвестный аргумент: ${a}`);
  }
  return { dryRun, yes };
}

async function loadAnnotationValidator(): Promise<ValidateFunction<Annotation>> {
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  ajv.addSchema(JSON.parse(await readFile(join(SCHEMA_DIR, 'product_card.schema.json'), 'utf8')));
  ajv.addSchema(JSON.parse(await readFile(join(SCHEMA_DIR, 'test_case.schema.json'), 'utf8')));
  ajv.addSchema(JSON.parse(await readFile(join(SCHEMA_DIR, 'annotation.schema.json'), 'utf8')));
  // Валидируем одиночную аннотацию через $defs/annotation
  return ajv.compile<Annotation>({ $ref: 'annotation.schema.json#/$defs/annotation' });
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return '(no error info)';
  return errors
    .map((e) => `${e.instancePath || '(root)'}: ${e.message ?? 'unknown'}`)
    .join('; ');
}

function quoteFoundIn(card: Record<string, unknown>, field_path: string, quote: string): boolean {
  const parts: (string | number)[] = [];
  let buf = '';
  for (let i = 0; i < field_path.length; i += 1) {
    const ch = field_path[i];
    if (ch === '.') {
      if (buf) parts.push(buf);
      buf = '';
    } else if (ch === '[') {
      if (buf) parts.push(buf);
      buf = '';
      const close = field_path.indexOf(']', i);
      const idx = parseInt(field_path.slice(i + 1, close), 10);
      parts.push(idx);
      i = close;
    } else {
      buf += ch;
    }
  }
  if (buf) parts.push(buf);

  let cursor: unknown = card;
  for (const p of parts) {
    if (cursor === null || cursor === undefined) return false;
    if (typeof p === 'number') {
      if (!Array.isArray(cursor)) return false;
      cursor = cursor[p];
    } else {
      if (typeof cursor !== 'object') return false;
      cursor = (cursor as Record<string, unknown>)[p];
    }
  }
  if (typeof cursor !== 'string') return false;
  return cursor.includes(quote);
}

function normalize(raw: PendingRaw): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ('expected_clean' in raw) out.expected_clean = raw.expected_clean;
  if ('violations' in raw) out.violations = raw.violations;
  if ('notes' in raw) out.notes = raw.notes;
  if ('annotated_at' in raw) out.annotated_at = raw.annotated_at;
  if ('annotator' in raw) out.annotator = raw.annotator;
  return out;
}

async function readCardsBySource(source: string): Promise<Map<string, Record<string, unknown>>> {
  const path = join(DATASETS_DIR, source, 'cards.raw.jsonl');
  const map = new Map<string, Record<string, unknown>>();
  try {
    const raw = await readFile(path, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as CardRecord;
      map.set(rec.card.id, rec.card);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return map;
}

async function readStore(source: string): Promise<AnnotationStore> {
  const path = join(ANNOTATIONS_DIR, `${source}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as AnnotationStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, annotations: {} };
    }
    throw err;
  }
}

async function writeStoreAtomic(source: string, store: AnnotationStore): Promise<void> {
  const path = join(ANNOTATIONS_DIR, `${source}.json`);
  const tmp = path + '.tmp';
  // Порядок ключей сохраняем как есть (insertion order JS-объекта): новые
  // записи добавляются в конец, перезапись существующей оставляет её
  // на исходной позиции.
  const out: AnnotationStore = { version: 1, annotations: store.annotations };
  await writeFile(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

function inferSource(raw: PendingRaw, knownSources: readonly string[]): string | null {
  if (typeof raw.source === 'string' && knownSources.includes(raw.source)) return raw.source;
  if (typeof raw.case_id === 'string') {
    for (const s of knownSources) {
      if (raw.case_id.startsWith(`${s}_`)) return s;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = await loadSourcesConfig();
  const knownSources = realSources(cfg);

  if (!existsSync(PENDING_DIR)) {
    console.log('[commit] datasets/annotations/pending/ нет — нечего коммитить');
    return;
  }

  // synth-*.json — pending для синтетики, обрабатываются pnpm synth:commit;
  // real-pending имеют префикс <source>_<id>.json.
  const entries = (await readdir(PENDING_DIR))
    .filter((n) => n.endsWith('.json') && !n.startsWith('synth-'))
    .sort();
  if (entries.length === 0) {
    console.log('[commit] pending пуст');
    return;
  }

  const validate = await loadAnnotationValidator();
  const cardCache = new Map<string, Map<string, Record<string, unknown>>>();

  const errors: string[] = [];
  let committed = 0;
  let skipped = 0;
  const updatedStores = new Map<string, AnnotationStore>();
  const successfulPendings: string[] = [];

  for (const name of entries) {
    const path = join(PENDING_DIR, name);
    let raw: PendingRaw;
    try {
      raw = JSON.parse(await readFile(path, 'utf8')) as PendingRaw;
    } catch (err) {
      errors.push(`${name}: невалидный JSON — ${(err as Error).message}`);
      continue;
    }

    const caseId = typeof raw.case_id === 'string' ? raw.case_id : name.replace(/\.json$/, '');

    if (raw.expected_clean === null || raw.expected_clean === undefined) {
      console.log(`[skip] ${caseId}: not annotated`);
      skipped += 1;
      continue;
    }

    const source = inferSource(raw, knownSources);
    if (!source) {
      errors.push(`${caseId}: не удалось определить source (нет поля source и префикс case_id не совпадает с известными источниками: ${knownSources.join(', ')})`);
      continue;
    }

    const normalized = normalize(raw);
    const ok = validate(normalized);
    if (!ok) {
      errors.push(`${caseId}: schema — ${formatErrors(validate.errors)}`);
      continue;
    }

    let cards = cardCache.get(source);
    if (!cards) {
      cards = await readCardsBySource(source);
      cardCache.set(source, cards);
    }
    const card = cards.get(caseId);
    if (!card) {
      errors.push(`${caseId}: карточка отсутствует в datasets/${source}/cards.raw.jsonl`);
      continue;
    }

    const ann = normalized as unknown as Annotation;
    let txtOk = true;
    for (const [i, v] of ann.violations.entries()) {
      if (!v.rule_id.startsWith('TXT-')) continue;
      if (!v.quote || v.quote.length === 0) {
        errors.push(`${caseId}: violations[${i}] TXT-правило требует непустой quote`);
        txtOk = false;
        continue;
      }
      if (!quoteFoundIn(card, v.field_path, v.quote)) {
        errors.push(`${caseId}: violations[${i}] quote не найдена дословно в ${v.field_path}`);
        txtOk = false;
      }
    }
    if (!txtOk) continue;

    let store = updatedStores.get(source);
    if (!store) {
      store = await readStore(source);
      updatedStores.set(source, store);
    }
    store.annotations[caseId] = ann;
    successfulPendings.push(path);
    committed += 1;
    console.log(`[ok] ${caseId} → annotations/${source}.json`);
  }

  console.log(
    `[commit] committed=${committed}, skipped=${skipped}, errors=${errors.length}` +
      (args.dryRun ? ' (dry-run)' : ''),
  );
  for (const e of errors) console.error('  ✗', e);

  if (args.dryRun) {
    console.log('[commit] dry-run: store не записан, pending не удалён');
    if (errors.length > 0) process.exit(1);
    return;
  }

  if (errors.length > 0) {
    console.error('[commit] есть ошибки — store не обновлён');
    process.exit(1);
  }

  for (const [source, store] of updatedStores) {
    await writeStoreAtomic(source, store);
  }
  for (const p of successfulPendings) {
    await rm(p, { force: true });
  }

  // используем yes только чтобы не падать на нём; commit не интерактивен
  void args.yes;
}

main().catch((err) => {
  console.error('[commit] failure:', err);
  process.exit(1);
});
