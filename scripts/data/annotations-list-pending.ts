// Печатает case_id'ы карточек, для которых ещё нет записи в
// datasets/annotations/<source>.json. Источник правды — cards.raw.jsonl
// каждого source из datasets/sources.config.json.
//
// Использование:
//   pnpm annotations:list
//   pnpm annotations:list -- --source=afisha
//   pnpm annotations:list -- --json

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSourcesConfig } from '../parse/lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const ANNOTATIONS_DIR = join(DATASETS_DIR, 'annotations');

interface CliArgs {
  source: string | null;
  json: boolean;
}

interface PendingItem {
  case_id: string;
  source: string;
}

interface CardRecord {
  card: { id: string };
}

interface AnnotationStore {
  version: 1;
  annotations: Record<string, unknown>;
}

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
  let source: string | null = null;
  let json = false;
  for (const a of argv) {
    const m = a.match(/^--source=(.+)$/);
    if (m?.[1]) {
      source = m[1];
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    bail(`[list] неизвестный аргумент: ${a}`);
  }
  return { source, json };
}

async function readJsonlIds(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as CardRecord).card.id);
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

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = await loadSourcesConfig();

  const allSources = Object.keys(cfg.sources).sort();
  if (args.source && !cfg.sources[args.source]) {
    const known = allSources.join(', ');
    bail(`[list] источник "${args.source}" не найден (известные: ${known})`);
  }
  const sources = args.source ? [args.source] : allSources;

  const pending: PendingItem[] = [];
  const perSource: Record<string, string[]> = {};

  for (const source of sources) {
    const ids = await readJsonlIds(join(DATASETS_DIR, source, 'cards.raw.jsonl'));
    const annotated = await readAnnotationKeys(source);
    const missing = ids.filter((id) => !annotated.has(id)).sort();
    perSource[source] = missing;
    for (const id of missing) pending.push({ case_id: id, source });
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(pending, null, 2) + '\n');
    return;
  }

  for (const source of sources) {
    const list = perSource[source] ?? [];
    console.log(`[pending] ${source}: ${list.length}`);
    for (const id of list) console.log(`  ${id}`);
  }
  console.log(`[pending] всего: ${pending.length}`);
}

main().catch((err) => {
  console.error('[list] failure:', err);
  process.exit(1);
});
