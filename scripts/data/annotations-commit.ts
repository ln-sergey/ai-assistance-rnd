// Переносит заполненные скаффолды из datasets/annotations/pending/ в общий
// store datasets/annotations/<source>.json. Распознаёт два вида pending'а:
//
// 1) text-pending (без поля kind, имя <card_id>.json) — стандартная
//    разметка expected_clean / violations. Нормализуется, валидируется по
//    annotation.schema.json#/$defs/annotation, для TXT-нарушений
//    проверяется, что quote дословно встречается в карточке по field_path.
//    Запись в store перезаписывает существующую.
//
// 2) image-pending (kind: image_annotation_pending, имя
//    <card_id>.images.json) — разметка expected_image_clean /
//    image_violations. Валидируется отдельной схемой image-полей.
//    Требуется, чтобы в store уже была text-запись для этой карточки —
//    image-разметка мёрджится в неё, не трогая expected_clean / violations.
//    После commit'а проверяется, остались ли *.images.json с тем же
//    batch_id; если нет и в datasets/images-review/<batch-id>/ нет
//    посторонних файлов — папка партии удаляется (Р7 ТЗ Sprint P6).
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
const IMAGES_REVIEW_DIR = join(DATASETS_DIR, 'images-review');

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

interface ImageViolation {
  rule_id: string;
  severity: Severity;
  image_id: string;
  evidence: string;
  rationale: string;
  field_path?: string;
}

interface Annotation {
  expected_clean: boolean;
  violations: Violation[];
  notes: string | null;
  annotated_at: string;
  annotator: string;
  expected_image_clean?: boolean | null;
  image_violations?: ImageViolation[];
}

interface ImageAnnotationPatch {
  expected_image_clean: boolean;
  image_violations: ImageViolation[];
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
  kind?: unknown;
  batch_id?: unknown;
  card_excerpt?: unknown;
  expected_clean?: unknown;
  violations?: unknown;
  notes?: unknown;
  annotator?: unknown;
  annotated_at?: unknown;
  expected_image_clean?: unknown;
  image_violations?: unknown;
  images?: unknown;
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

interface Validators {
  text: ValidateFunction<Annotation>;
  image: ValidateFunction<ImageAnnotationPatch>;
}

async function loadValidators(): Promise<Validators> {
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

  const text = ajv.compile<Annotation>({ $ref: 'annotation.schema.json#/$defs/annotation' });
  // Image-pending содержит только image-поля + annotator/annotated_at —
  // text-блок (expected_clean/violations) уже лежит в <source>.json и
  // не дублируется в pending. Поэтому отдельная inline-схема, чтобы
  // не требовать text-полей при валидации.
  const imageSchema = {
    type: 'object',
    required: ['expected_image_clean', 'image_violations', 'annotated_at', 'annotator'],
    properties: {
      expected_image_clean: { type: 'boolean' },
      image_violations: {
        type: 'array',
        items: { $ref: 'test_case.schema.json#/$defs/violation_image_card' },
      },
      annotated_at: { type: 'string', format: 'date' },
      annotator: { type: 'string', minLength: 1 },
    },
    allOf: [
      {
        if: {
          properties: { expected_image_clean: { const: true } },
          required: ['expected_image_clean'],
        },
        then: { properties: { image_violations: { maxItems: 0 } } },
      },
      {
        if: {
          properties: { expected_image_clean: { const: false } },
          required: ['expected_image_clean'],
        },
        then: { properties: { image_violations: { minItems: 1 } } },
      },
    ],
  } as const;
  const image = ajv.compile<ImageAnnotationPatch>(imageSchema);
  return { text, image };
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

function normalizeText(raw: PendingRaw): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ('expected_clean' in raw) out.expected_clean = raw.expected_clean;
  if ('violations' in raw) out.violations = raw.violations;
  if ('notes' in raw) out.notes = raw.notes;
  if ('annotated_at' in raw) out.annotated_at = raw.annotated_at;
  if ('annotator' in raw) out.annotator = raw.annotator;
  // Image-поля прокидываются только если присутствуют — обратная
  // совместимость с pure-text pending'ами (Sprint P4/P5).
  if ('expected_image_clean' in raw) out.expected_image_clean = raw.expected_image_clean;
  if ('image_violations' in raw) out.image_violations = raw.image_violations;
  return out;
}

function normalizeImage(raw: PendingRaw): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ('expected_image_clean' in raw) out.expected_image_clean = raw.expected_image_clean;
  if ('image_violations' in raw) out.image_violations = raw.image_violations;
  if ('annotated_at' in raw) out.annotated_at = raw.annotated_at;
  if ('annotator' in raw) out.annotator = raw.annotator;
  return out;
}

function collectImageIds(card: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const images = card['images'];
  if (!Array.isArray(images)) return out;
  for (const img of images) {
    if (!img || typeof img !== 'object') continue;
    const id = (img as Record<string, unknown>)['image_id'];
    if (typeof id === 'string' && id.length > 0) out.add(id);
  }
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

function isImagePending(raw: PendingRaw, name: string): boolean {
  if (raw.kind === 'image_annotation_pending') return true;
  // Fallback по имени файла — на случай ручных правок.
  return name.endsWith('.images.json');
}

interface ProcessedTextEntry {
  source: string;
  caseId: string;
  ann: Annotation;
}

interface ProcessedImageEntry {
  source: string;
  caseId: string;
  patch: ImageAnnotationPatch;
  batchId: string | null;
  // Имена файлов в datasets/images-review/<batch-id>/, которые pending
  // закладывал в партию. Нужны, чтобы после commit'а понять, можно ли
  // удалять папку партии целиком (только если в ней не появилось ничего
  // постороннего).
  batchFilenames: string[];
}

async function processText(args: {
  raw: PendingRaw;
  caseId: string;
  source: string;
  validate: ValidateFunction<Annotation>;
  cards: Map<string, Record<string, unknown>>;
}): Promise<{ ok: true; entry: ProcessedTextEntry } | { ok: false; errors: string[] }> {
  const { raw, caseId, source, validate, cards } = args;
  const normalized = normalizeText(raw);
  if (!validate(normalized)) {
    return { ok: false, errors: [`${caseId}: schema — ${formatErrors(validate.errors)}`] };
  }
  const card = cards.get(caseId);
  if (!card) {
    return {
      ok: false,
      errors: [`${caseId}: карточка отсутствует в datasets/${source}/cards.raw.jsonl`],
    };
  }
  const ann = normalized as unknown as Annotation;
  const errors: string[] = [];
  for (const [i, v] of ann.violations.entries()) {
    if (!v.rule_id.startsWith('TXT-')) continue;
    if (!v.quote || v.quote.length === 0) {
      errors.push(`${caseId}: violations[${i}] TXT-правило требует непустой quote`);
      continue;
    }
    if (!quoteFoundIn(card, v.field_path, v.quote)) {
      errors.push(`${caseId}: violations[${i}] quote не найдена дословно в ${v.field_path}`);
    }
  }
  // Ссылочная целостность image_violations (если они присутствуют в
  // text-pending'е — допустимый сценарий, см. Sprint P5 миграции).
  const imageViolations = ann.image_violations ?? [];
  if (imageViolations.length > 0) {
    const validImageIds = collectImageIds(card);
    for (const [i, v] of imageViolations.entries()) {
      if (!validImageIds.has(v.image_id)) {
        errors.push(
          `${caseId}: image_violations[${i}] image_id=${v.image_id} не найден в card.images[]`,
        );
      }
      if (v.field_path !== undefined && v.field_path !== `images[${v.image_id}]`) {
        errors.push(
          `${caseId}: image_violations[${i}] field_path=${v.field_path} не совпадает с images[${v.image_id}]`,
        );
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entry: { source, caseId, ann } };
}

async function processImage(args: {
  raw: PendingRaw;
  caseId: string;
  source: string;
  validate: ValidateFunction<ImageAnnotationPatch>;
  cards: Map<string, Record<string, unknown>>;
  existingStore: AnnotationStore;
}): Promise<{ ok: true; entry: ProcessedImageEntry } | { ok: false; errors: string[] }> {
  const { raw, caseId, source, validate, cards, existingStore } = args;
  const normalized = normalizeImage(raw);
  if (!validate(normalized)) {
    return { ok: false, errors: [`${caseId}: image schema — ${formatErrors(validate.errors)}`] };
  }
  const card = cards.get(caseId);
  if (!card) {
    return {
      ok: false,
      errors: [`${caseId}: карточка отсутствует в datasets/${source}/cards.raw.jsonl`],
    };
  }
  const existing = existingStore.annotations[caseId];
  if (!existing) {
    return {
      ok: false,
      errors: [
        `${caseId}: text-разметка отсутствует в datasets/annotations/${source}.json. ` +
          'Сначала pnpm annotations:scaffold + pnpm annotations:commit для текста.',
      ],
    };
  }
  const patch = normalized as unknown as ImageAnnotationPatch;
  const errors: string[] = [];
  const validImageIds = collectImageIds(card);
  for (const [i, v] of patch.image_violations.entries()) {
    if (!validImageIds.has(v.image_id)) {
      errors.push(
        `${caseId}: image_violations[${i}] image_id=${v.image_id} не найден в card.images[]`,
      );
    }
    if (v.field_path !== undefined && v.field_path !== `images[${v.image_id}]`) {
      errors.push(
        `${caseId}: image_violations[${i}] field_path=${v.field_path} не совпадает с images[${v.image_id}]`,
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const batchId = typeof raw.batch_id === 'string' ? raw.batch_id : null;
  const batchFilenames: string[] = [];
  if (Array.isArray(raw.images)) {
    for (const it of raw.images) {
      if (!it || typeof it !== 'object') continue;
      const fp = (it as Record<string, unknown>)['file_path'];
      if (typeof fp !== 'string') continue;
      const base = fp.split('/').pop();
      if (base) batchFilenames.push(base);
    }
  }
  return { ok: true, entry: { source, caseId, patch, batchId, batchFilenames } };
}

async function tryRemoveBatchDir(
  batchId: string,
  expectedFilenames: ReadonlySet<string>,
): Promise<'removed' | 'kept' | 'absent'> {
  const dir = join(IMAGES_REVIEW_DIR, batchId);
  if (!existsSync(dir)) return 'absent';
  const entries = await readdir(dir);
  for (const name of entries) {
    if (!expectedFilenames.has(name)) {
      // Что-то постороннее — не наш скопированный файл. Не трогаем,
      // чтобы случайно не унести пользовательские заметки или ручные
      // вложения.
      return 'kept';
    }
  }
  await rm(dir, { recursive: true, force: true });
  return 'removed';
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
  // real-pending имеют префикс <source>_<id>.json (text) или
  // <source>_<id>.images.json (image).
  const entries = (await readdir(PENDING_DIR))
    .filter((n) => n.endsWith('.json') && !n.startsWith('synth-'))
    .sort();
  if (entries.length === 0) {
    console.log('[commit] pending пуст');
    return;
  }

  const validators = await loadValidators();
  const cardCache = new Map<string, Map<string, Record<string, unknown>>>();
  const updatedStores = new Map<string, AnnotationStore>();

  async function getCards(source: string): Promise<Map<string, Record<string, unknown>>> {
    let m = cardCache.get(source);
    if (!m) {
      m = await readCardsBySource(source);
      cardCache.set(source, m);
    }
    return m;
  }
  async function getStore(source: string): Promise<AnnotationStore> {
    let s = updatedStores.get(source);
    if (!s) {
      s = await readStore(source);
      updatedStores.set(source, s);
    }
    return s;
  }

  const errors: string[] = [];
  let committed = 0;
  let skipped = 0;
  const successfulPendings: string[] = [];
  const committedBatchFiles = new Map<string, Set<string>>();

  for (const name of entries) {
    const path = join(PENDING_DIR, name);
    let raw: PendingRaw;
    try {
      raw = JSON.parse(await readFile(path, 'utf8')) as PendingRaw;
    } catch (err) {
      errors.push(`${name}: невалидный JSON — ${(err as Error).message}`);
      continue;
    }

    const isImage = isImagePending(raw, name);
    const caseId =
      typeof raw.case_id === 'string'
        ? raw.case_id
        : name.replace(/\.images\.json$/, '').replace(/\.json$/, '');

    if (isImage) {
      if (raw.expected_image_clean === null || raw.expected_image_clean === undefined) {
        console.log(`[skip] ${caseId}: image-pending не размечен (expected_image_clean=null)`);
        skipped += 1;
        continue;
      }
    } else {
      if (raw.expected_clean === null || raw.expected_clean === undefined) {
        console.log(`[skip] ${caseId}: not annotated`);
        skipped += 1;
        continue;
      }
    }

    const source = inferSource(raw, knownSources);
    if (!source) {
      errors.push(
        `${caseId}: не удалось определить source (нет поля source и префикс case_id не совпадает с известными источниками: ${knownSources.join(', ')})`,
      );
      continue;
    }

    const cards = await getCards(source);

    if (isImage) {
      const store = await getStore(source);
      const result = await processImage({
        raw,
        caseId,
        source,
        validate: validators.image,
        cards,
        existingStore: store,
      });
      if (!result.ok) {
        errors.push(...result.errors);
        continue;
      }
      const existing = store.annotations[caseId];
      if (!existing) {
        // Защита: processImage уже проверил, но на всякий случай
        // подстрахуемся.
        errors.push(`${caseId}: внутренняя ошибка — text-аннотация исчезла после проверки`);
        continue;
      }
      const merged: Annotation = {
        ...existing,
        expected_image_clean: result.entry.patch.expected_image_clean,
        image_violations: result.entry.patch.image_violations,
        // annotator/annotated_at в image-pending относятся к моменту
        // image-разметки. Текст пишет свои в свой commit; здесь не
        // перезаписываем — иначе потеряем след text-разметчика.
      };
      store.annotations[caseId] = merged;
      successfulPendings.push(path);
      if (result.entry.batchId) {
        const set = committedBatchFiles.get(result.entry.batchId) ?? new Set<string>();
        for (const n of result.entry.batchFilenames) set.add(n);
        committedBatchFiles.set(result.entry.batchId, set);
      }
      committed += 1;
      console.log(`[ok-image] ${caseId} → annotations/${source}.json`);
    } else {
      const result = await processText({
        raw,
        caseId,
        source,
        validate: validators.text,
        cards,
      });
      if (!result.ok) {
        errors.push(...result.errors);
        continue;
      }
      const store = await getStore(source);
      store.annotations[caseId] = result.entry.ann;
      successfulPendings.push(path);
      committed += 1;
      console.log(`[ok] ${caseId} → annotations/${source}.json`);
    }
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

  // Очистка партионных папок: для каждого batch_id, у которого закоммитился
  // хотя бы один pending — проверить, остался ли в pending ещё кто-то с
  // тем же batch_id. Если нет и в datasets/images-review/<batch-id>/
  // остались только наши скопированные файлы (по списку из commit'нутых
  // pending'ов) — удалить папку целиком.
  if (committedBatchFiles.size > 0) {
    const remainingPending = existsSync(PENDING_DIR) ? await readdir(PENDING_DIR) : [];
    const remainingBatches = new Set<string>();
    for (const name of remainingPending) {
      if (!name.endsWith('.images.json')) continue;
      try {
        const raw = JSON.parse(await readFile(join(PENDING_DIR, name), 'utf8')) as PendingRaw;
        if (typeof raw.batch_id === 'string') remainingBatches.add(raw.batch_id);
      } catch {
        // битый pending — оставим как есть, разберёмся в следующий commit
      }
    }
    for (const [batchId, expectedFiles] of committedBatchFiles) {
      if (remainingBatches.has(batchId)) {
        console.log(`[commit] batch=${batchId}: оставшиеся pending'и есть, папку партии не трогаю`);
        continue;
      }
      const status = await tryRemoveBatchDir(batchId, expectedFiles);
      if (status === 'removed') console.log(`[commit] batch=${batchId}: папка партии удалена`);
      else if (status === 'kept')
        console.log(
          `[commit] batch=${batchId}: в папке партии есть посторонние файлы, не удаляю`,
        );
      else console.log(`[commit] batch=${batchId}: папка партии уже отсутствует`);
    }
  }

  // используем yes только чтобы не падать на нём; commit не интерактивен
  void args.yes;
}

main().catch((err) => {
  console.error('[commit] failure:', err);
  process.exit(1);
});
