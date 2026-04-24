// Создаёт рабочие скаффолды для разметки в datasets/annotations/pending/.
// На каждую неразмеченную карточку — один JSON-файл с card_excerpt и пустыми
// слотами под expected_clean/violations/annotator/notes. Локальный агент
// (человек, Claude, ChatGPT, GigaChat) заполняет файлы и потом вызывает
// pnpm annotations:commit для переноса в общий store.
//
// Идемпотентен: если pending-файл уже существует — не перезаписывается.
// Если в datasets/annotations/<source>.json уже есть финальная запись —
// pending не создаётся.
//
// Использование:
//   pnpm annotations:scaffold
//   pnpm annotations:scaffold -- --source=afisha

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSourcesConfig } from '../parse/lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const ANNOTATIONS_DIR = join(DATASETS_DIR, 'annotations');
const PENDING_DIR = join(ANNOTATIONS_DIR, 'pending');

// Какие поля карточки попадают в скаффолд. Текстовая разметка не касается
// images/schedule/age_restriction/group_size/languages — выкидываем, чтобы
// не раздувать pending-файлы.
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

interface CliArgs {
  source: string | null;
}

interface CardRecord {
  card: Record<string, unknown> & { id: string };
}

interface AnnotationStore {
  version: 1;
  annotations: Record<string, unknown>;
}

interface PendingFile {
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

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
  let source: string | null = null;
  for (const a of argv) {
    const m = a.match(/^--source=(.+)$/);
    if (m?.[1]) {
      source = m[1];
      continue;
    }
    bail(`[scaffold] неизвестный аргумент: ${a}`);
  }
  return { source };
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

async function readAnnotationKeys(source: string): Promise<Set<string>> {
  const path = join(ANNOTATIONS_DIR, `${source}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    const store = JSON.parse(raw) as AnnotationStore;
    return new Set(Object.keys(store.annotations ?? {}));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
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

function buildPending(source: string, card: Record<string, unknown> & { id: string }): PendingFile {
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
      rules_path: 'rules.yaml',
      schema_path: 'datasets/schema/annotation.schema.json',
      instruction:
        'Заполни expected_clean (true/false), violations при dirty, annotator, annotated_at. Для TXT-* нарушений quote должна дословно встречаться в card_excerpt по field_path. Подробности — docs/annotation-guide.md.',
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = await loadSourcesConfig();

  const allSources = Object.keys(cfg.sources).sort();
  if (args.source && !cfg.sources[args.source]) {
    const known = allSources.join(', ');
    bail(`[scaffold] источник "${args.source}" не найден (известные: ${known})`);
  }
  const sources = args.source ? [args.source] : allSources;

  await mkdir(PENDING_DIR, { recursive: true });

  let created = 0;
  let skippedExisting = 0;
  let skippedAnnotated = 0;

  for (const source of sources) {
    const cards = await readCards(join(DATASETS_DIR, source, 'cards.raw.jsonl'));
    const annotated = await readAnnotationKeys(source);

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
      const pending = buildPending(source, rec.card);
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

main().catch((err) => {
  console.error('[scaffold] failure:', err);
  process.exit(1);
});
