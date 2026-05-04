// Создаёт рабочие скаффолды для разметки в datasets/annotations/pending/.
//
// Режим text (default, --mode=text):
//   На каждую неразмеченную карточку — один JSON-файл с card_excerpt и
//   пустыми слотами под expected_clean/violations/annotator/notes.
//
// Режим images (--mode=images):
//   Выбирает карточки одного source'а с непустым card.images[] и без
//   image-разметки в datasets/annotations/<source>.json (поле
//   expected_image_clean отсутствует или null). Создаёт партионную папку
//   datasets/images-review/<batch-id>/ с копиями файлов всех image_id
//   карточек партии и для каждой карточки кладёт
//   datasets/annotations/pending/<card_id>.images.json. Локальный
//   AI-агент в интерактивной сессии открывает папку партии и заполняет
//   pending'и, потом коммитит через pnpm annotations:commit.
//
// Локальный агент (человек, Claude, ChatGPT, GigaChat) заполняет файлы
// и потом вызывает pnpm annotations:commit для переноса в общий store.
//
// Идемпотентен: если pending-файл уже существует — не перезаписывается.
// Если в datasets/annotations/<source>.json уже есть финальная запись с
// нужным полем (text или image) — pending не создаётся.
//
// Использование:
//   pnpm annotations:scaffold
//   pnpm annotations:scaffold -- --source=afisha
//   pnpm annotations:scaffold:images -- --source=sputnik8 --limit=10
//   pnpm annotations:scaffold:images -- --source=sputnik8 --card-id=sputnik8_57480
//   pnpm annotations:scaffold:images -- --source=sputnik8 --limit=5 --batch-id=20260504-sputnik8-001

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSourcesConfig, realSources } from '../parse/lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const ANNOTATIONS_DIR = join(DATASETS_DIR, 'annotations');
const PENDING_DIR = join(ANNOTATIONS_DIR, 'pending');
const IMAGES_DIR = join(DATASETS_DIR, 'images');
const IMAGES_REVIEW_DIR = join(DATASETS_DIR, 'images-review');

// Какие поля карточки попадают в текстовый скаффолд. Текстовая разметка не
// касается images/schedule/age_restriction/group_size/languages — выкидываем,
// чтобы не раздувать pending-файлы.
const EXCERPT_FIELDS = [
  'id',
  'product_type',
  'title',
  'short_description',
  'full_description',
  'program_items',
  'services',
  'location',
  'contacts_block',
] as const;

// Расширения, в которых лежат скачанные файлы (см. download-images.ts).
const IMAGE_EXTS = ['jpg', 'png', 'webp', 'gif'] as const;

const DEFAULT_IMAGES_LIMIT = 5;

type Mode = 'text' | 'images';

interface CliArgs {
  source: string | null;
  mode: Mode;
  limit: number | null;
  cardId: string | null;
  batchId: string | null;
}

interface CardRecord {
  card: Record<string, unknown> & { id: string };
}

interface AnnotationStore {
  version: 1;
  annotations: Record<string, unknown>;
}

interface CardImage {
  image_id: string;
  role: string;
  caption?: string | null;
}

interface TextPendingFile {
  case_id: string;
  source: string;
  card_excerpt: Record<string, unknown>;
  expected_clean: null;
  violations: [];
  notes: null;
  annotator: null;
  annotated_at: null;
  _help: {
    rules_path: string;
    schema_path: string;
    instruction: string;
  };
}

interface ImagePendingFile {
  case_id: string;
  source: string;
  kind: 'image_annotation_pending';
  batch_id: string;
  images: Array<{
    image_id: string;
    role: string;
    file_path: string;
  }>;
  expected_image_clean: null;
  image_violations: [];
  annotator: null;
  annotated_at: null;
  _help: {
    prompt_path: string;
    rules_path: string;
    schema_path: string;
    instruction: string;
  };
}

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
  let source: string | null = null;
  let mode: Mode = 'text';
  let limit: number | null = null;
  let cardId: string | null = null;
  let batchId: string | null = null;
  for (const a of argv) {
    let m: RegExpMatchArray | null;
    if ((m = a.match(/^--source=(.+)$/))) {
      source = m[1] ?? null;
      continue;
    }
    if ((m = a.match(/^--mode=(.+)$/))) {
      const v = m[1] ?? '';
      if (v !== 'text' && v !== 'images') {
        bail(`[scaffold] --mode=${v} не поддерживается (text|images)`);
      }
      mode = v;
      continue;
    }
    if ((m = a.match(/^--limit=(.+)$/))) {
      const n = Number(m[1]);
      if (!Number.isInteger(n) || n < 1) bail(`[scaffold] --limit должен быть целым ≥ 1, получено ${m[1]}`);
      limit = n;
      continue;
    }
    if ((m = a.match(/^--card-id=(.+)$/))) {
      cardId = m[1] ?? null;
      continue;
    }
    if ((m = a.match(/^--batch-id=(.+)$/))) {
      batchId = m[1] ?? null;
      continue;
    }
    bail(`[scaffold] неизвестный аргумент: ${a}`);
  }
  return { source, mode, limit, cardId, batchId };
}

async function readCards(path: string): Promise<CardRecord[]> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as CardRecord);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readAnnotationStore(source: string): Promise<AnnotationStore> {
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

function buildExcerpt(card: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of EXCERPT_FIELDS) {
    if (k in card) out[k] = card[k];
  }
  return out;
}

// Многострочная инструкция для LLM-агента, заполняющего text-pending.
const HELP_INSTRUCTION_TEXT = [
  'Заполни expected_clean (true/false), violations при dirty, annotator, annotated_at.',
  'Жёсткие правила:',
  '1. rule_id — только из datasets/text_rules.compact.json. Своих не выдумывать.',
  '   (Скаффолд текстовой разметки IMG-правила не использует — они в отдельном файле image_rules.compact.json.)',
  '2. severity — точно как в text_rules.compact.json для этого rule_id.',
  '3. quote — ДОСЛОВНЫЙ непрерывный фрагмент из card_excerpt по указанному field_path. Минимум 1 символ. Никаких многоточий и склеек.',
  '4. Для TXT-24 / TXT-26 при полностью пустом поле — это поле НЕ может быть field_path. Найти другое поле с проблемой или другое правило (например, TXT-23 — карточка как форма заявок).',
  '5. expected_clean=true ⟺ violations=[].',
  '6. Сомневаешься — clean.',
  'Подробности — docs/annotation-guide.md и prompts/annotate-conservative-v1.txt.',
].join('\n');

// Инструкция для image-pending. Промпт и гайд (Этап 3) указаны путями —
// агент откроет их сам.
const HELP_INSTRUCTION_IMAGES = [
  'Прочитай prompts/annotate-image-conservative-v1.txt.',
  'Открой каждое фото из images[].file_path (Read multimodal): они скопированы в datasets/images-review/<batch-id>/.',
  'Заполни expected_image_clean (true/false) и, если false — image_violations[].',
  'Жёсткие правила:',
  '1. rule_id — только AI-only IMG-правила из datasets/image_rules.compact.json (отфильтрован по datasets/image_rules.scope.yaml).',
  '2. severity — точно как в image_rules.compact.json для этого rule_id.',
  '3. image_id — обязательно из card.images[].image_id. Не выдумывать новые id.',
  '4. evidence — 1-2 предложения, что именно на кадре указывает на нарушение. Словесные ориентиры ("левый нижний угол", "на майке справа") — без bbox.',
  '5. expected_image_clean=true ⟺ image_violations=[].',
  '6. Сомневаешься → clean.',
  'По завершении: pnpm annotations:commit.',
].join('\n');

function buildTextPending(
  source: string,
  card: Record<string, unknown> & { id: string },
): TextPendingFile {
  return {
    case_id: card.id,
    source,
    card_excerpt: buildExcerpt(card),
    expected_clean: null,
    violations: [],
    notes: null,
    annotator: null,
    annotated_at: null,
    _help: {
      rules_path: 'datasets/text_rules.compact.json',
      schema_path: 'datasets/schema/annotation.schema.json',
      instruction: HELP_INSTRUCTION_TEXT,
    },
  };
}

function getCardImages(card: Record<string, unknown>): CardImage[] {
  const imgs = card['images'];
  if (!Array.isArray(imgs)) return [];
  const out: CardImage[] = [];
  for (const it of imgs) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    if (typeof r.image_id !== 'string' || typeof r.role !== 'string') continue;
    out.push({
      image_id: r.image_id,
      role: r.role,
      caption: typeof r.caption === 'string' ? r.caption : null,
    });
  }
  return out;
}

function findImageFileExt(imageId: string): string | null {
  for (const ext of IMAGE_EXTS) {
    if (existsSync(join(IMAGES_DIR, `${imageId}.${ext}`))) return ext;
  }
  return null;
}

// batch-id: <YYYYMMDD>-<source>-<NNN>. NNN инкрементится среди существующих
// папок этой даты и source'а.
function todayYmd(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

const BATCH_ID_RE = /^\d{8}-[a-z0-9_-]+-\d{3}$/;

async function resolveBatchId(source: string, override: string | null): Promise<string> {
  if (override) {
    if (!BATCH_ID_RE.test(override)) {
      bail(`[scaffold] --batch-id="${override}" не соответствует формату YYYYMMDD-<source>-NNN`);
    }
    return override;
  }
  const ymd = todayYmd();
  const prefix = `${ymd}-${source}-`;
  let max = 0;
  if (existsSync(IMAGES_REVIEW_DIR)) {
    const entries = await readdir(IMAGES_REVIEW_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!e.name.startsWith(prefix)) continue;
      const tail = e.name.slice(prefix.length);
      const n = Number(tail);
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  const next = String(max + 1).padStart(3, '0');
  return `${ymd}-${source}-${next}`;
}

interface ImageScaffoldStats {
  pendings_created: number;
  pendings_skipped: number;
  files_copied: number;
  files_skipped: number;
  cards_skipped_missing_files: number;
}

async function buildImagePending(args: {
  source: string;
  card: Record<string, unknown> & { id: string };
  batchId: string;
}): Promise<{ pending: ImagePendingFile; missing: string[] } | { missing: string[] }> {
  const { source, card, batchId } = args;
  const images = getCardImages(card);
  if (images.length === 0) return { missing: [] };
  const missing: string[] = [];
  const items: ImagePendingFile['images'] = [];
  for (const img of images) {
    const ext = findImageFileExt(img.image_id);
    if (!ext) {
      missing.push(img.image_id);
      continue;
    }
    items.push({
      image_id: img.image_id,
      role: img.role,
      file_path: `datasets/images-review/${batchId}/${img.image_id}.${ext}`,
    });
  }
  if (missing.length > 0) return { missing };
  return {
    pending: {
      case_id: card.id,
      source,
      kind: 'image_annotation_pending',
      batch_id: batchId,
      images: items,
      expected_image_clean: null,
      image_violations: [],
      annotator: null,
      annotated_at: null,
      _help: {
        prompt_path: 'prompts/annotate-image-conservative-v1.txt',
        rules_path: 'datasets/image_rules.compact.json',
        schema_path: 'datasets/schema/annotation.schema.json',
        instruction: HELP_INSTRUCTION_IMAGES,
      },
    },
    missing: [],
  };
}

async function copyBatchFiles(
  pending: ImagePendingFile,
  batchDir: string,
  stats: ImageScaffoldStats,
): Promise<void> {
  await mkdir(batchDir, { recursive: true });
  for (const it of pending.images) {
    const filename = it.file_path.split('/').pop();
    if (!filename) throw new Error(`[scaffold] не удалось извлечь имя файла из ${it.file_path}`);
    const ext = filename.split('.').pop();
    if (!ext) throw new Error(`[scaffold] нет расширения у ${filename}`);
    const src = join(IMAGES_DIR, `${it.image_id}.${ext}`);
    const dst = join(batchDir, filename);
    if (existsSync(dst)) {
      stats.files_skipped += 1;
      continue;
    }
    await copyFile(src, dst);
    stats.files_copied += 1;
  }
}

function hasImageAnnotation(record: unknown): boolean {
  if (!record || typeof record !== 'object') return false;
  return typeof (record as Record<string, unknown>)['expected_image_clean'] === 'boolean';
}

async function runText(args: CliArgs): Promise<void> {
  const cfg = await loadSourcesConfig();
  const allReal = realSources(cfg);
  if (args.source && !cfg.sources[args.source]) {
    const known = allReal.join(', ');
    bail(`[scaffold] источник "${args.source}" не найден (известные: ${known})`);
  }
  if (args.source && !allReal.includes(args.source)) {
    bail(
      `[scaffold] источник "${args.source}" не real (kind=${cfg.sources[args.source]?.kind}). ` +
        'Для синтетики используй pnpm synth:scaffold.',
    );
  }
  const sources = args.source ? [args.source] : allReal;

  await mkdir(PENDING_DIR, { recursive: true });

  let created = 0;
  let skippedExisting = 0;
  let skippedAnnotated = 0;

  for (const source of sources) {
    const cards = await readCards(join(DATASETS_DIR, source, 'cards.raw.jsonl'));
    const store = await readAnnotationStore(source);
    const annotated = new Set(Object.keys(store.annotations ?? {}));

    for (const rec of cards) {
      const id = rec.card.id;
      if (annotated.has(id)) {
        skippedAnnotated += 1;
        continue;
      }
      const target = join(PENDING_DIR, `${id}.json`);
      if (existsSync(target)) {
        skippedExisting += 1;
        continue;
      }
      const pending = buildTextPending(source, rec.card);
      await writeFile(target, JSON.stringify(pending, null, 2) + '\n', 'utf8');
      created += 1;
    }
  }

  console.log(
    `[scaffold] created=${created}, skipped_existing=${skippedExisting}, skipped_annotated=${skippedAnnotated}`,
  );
  if (created > 0) {
    console.log('[scaffold] заполни pending-файлы и запусти `pnpm annotations:commit`');
    console.log('[scaffold] инструкция: docs/annotation-guide.md');
  }
}

async function runImages(args: CliArgs): Promise<void> {
  if (!args.source) bail('[scaffold] image-режим требует --source=<X>');
  const cfg = await loadSourcesConfig();
  const allReal = realSources(cfg);
  if (!allReal.includes(args.source)) {
    bail(
      `[scaffold] image-режим: источник "${args.source}" не real (известные real: ${allReal.join(', ')})`,
    );
  }
  const limit = args.limit ?? DEFAULT_IMAGES_LIMIT;

  const cards = await readCards(join(DATASETS_DIR, args.source, 'cards.raw.jsonl'));
  if (cards.length === 0) {
    bail(`[scaffold] image-режим: ${args.source}/cards.raw.jsonl пуст или отсутствует`);
  }
  const store = await readAnnotationStore(args.source);
  const annotations = store.annotations ?? {};

  // Кандидаты: фото есть, image-разметки ещё нет.
  let candidates = cards
    .filter((c) => {
      const imgs = c.card.images;
      if (!Array.isArray(imgs) || imgs.length === 0) return false;
      if (hasImageAnnotation(annotations[c.card.id])) return false;
      return true;
    })
    .map((c) => c.card)
    .sort((a, b) => a.id.localeCompare(b.id));

  if (args.cardId) {
    candidates = candidates.filter((c) => c.id === args.cardId);
    if (candidates.length === 0) {
      bail(
        `[scaffold] image-режим: --card-id="${args.cardId}" не найден среди кандидатов ` +
          `(возможно карточка без фото, image-разметка уже есть, либо не из ${args.source})`,
      );
    }
  } else {
    candidates = candidates.slice(0, limit);
  }

  if (candidates.length === 0) {
    console.log(`[scaffold] image-режим: ${args.source} — все карточки с фото уже размечены`);
    return;
  }

  // Требование: text-разметка должна существовать. Без неё image-разметка
  // всё равно не имеет, куда мёрджиться (annotation.schema требует
  // expected_clean/violations/annotated_at/annotator).
  const missingText = candidates
    .filter((c) => !(c.id in annotations))
    .map((c) => c.id);
  if (missingText.length > 0) {
    bail(
      `[scaffold] image-режим: у ${missingText.length} карточек нет text-разметки в ` +
        `datasets/annotations/${args.source}.json (${missingText.slice(0, 5).join(', ')}${missingText.length > 5 ? '…' : ''}). ` +
        'Сначала pnpm annotations:scaffold + pnpm annotations:commit для текста.',
    );
  }

  const batchId = await resolveBatchId(args.source, args.batchId);
  const batchDir = join(IMAGES_REVIEW_DIR, batchId);

  await mkdir(PENDING_DIR, { recursive: true });

  const stats: ImageScaffoldStats = {
    pendings_created: 0,
    pendings_skipped: 0,
    files_copied: 0,
    files_skipped: 0,
    cards_skipped_missing_files: 0,
  };
  const created: string[] = [];
  const skipped: string[] = [];
  const skippedMissing: Array<{ id: string; missing: string[] }> = [];

  for (const card of candidates) {
    const pendingPath = join(PENDING_DIR, `${card.id}.images.json`);
    if (existsSync(pendingPath)) {
      stats.pendings_skipped += 1;
      skipped.push(card.id);
      continue;
    }
    const built = await buildImagePending({ source: args.source, card, batchId });
    if (!('pending' in built)) {
      stats.cards_skipped_missing_files += 1;
      skippedMissing.push({ id: card.id, missing: built.missing });
      continue;
    }
    await copyBatchFiles(built.pending, batchDir, stats);
    await writeFile(pendingPath, JSON.stringify(built.pending, null, 2) + '\n', 'utf8');
    stats.pendings_created += 1;
    created.push(card.id);
  }

  console.log(`[scaffold] image batch_id=${batchId}`);
  console.log(`[scaffold] batch dir: datasets/images-review/${batchId}/`);
  console.log(
    `[scaffold] pendings_created=${stats.pendings_created}, pendings_skipped=${stats.pendings_skipped}, ` +
      `files_copied=${stats.files_copied}, files_skipped=${stats.files_skipped}, ` +
      `cards_skipped_missing_files=${stats.cards_skipped_missing_files}`,
  );
  for (const id of created) console.log(`  + ${id}`);
  for (const id of skipped) console.log(`  = ${id} (pending уже существует)`);
  for (const it of skippedMissing) {
    console.log(
      `  ! ${it.id}: пропущена, нет файлов для image_id ${it.missing.join(', ')} в datasets/images/. ` +
        'Запусти `pnpm images:download --source=' + args.source + '`.',
    );
  }
  if (stats.pendings_created > 0) {
    console.log(
      '[scaffold] заполни pending-файлы (datasets/annotations/pending/<id>.images.json) и запусти `pnpm annotations:commit`',
    );
    console.log('[scaffold] инструкция: docs/image-annotation-guide.md');
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.mode === 'images') {
    await runImages(args);
  } else {
    await runText(args);
  }
}

main().catch((err) => {
  console.error('[scaffold] failure:', err);
  process.exit(1);
});
