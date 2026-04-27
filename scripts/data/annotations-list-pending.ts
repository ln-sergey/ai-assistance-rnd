// Печатает что осталось разметить:
//   1) для real-источников — case_id'ы из cards.raw.jsonl без записи
//      в datasets/annotations/<source>.json;
//   2) для synthetic — pending-файлы datasets/annotations/pending/synth-*.json,
//      сгруппированные по target_rule_id.
//
// Использование:
//   pnpm annotations:list
//   pnpm annotations:list -- --source=afisha
//   pnpm annotations:list -- --json

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSourcesConfig, realSources } from '../parse/lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const ANNOTATIONS_DIR = join(DATASETS_DIR, 'annotations');
const PENDING_DIR = join(ANNOTATIONS_DIR, 'pending');

interface CliArgs {
  source: string | null;
  json: boolean;
}

interface PendingItem {
  case_id: string;
  source: string;
}

interface SynthPendingItem {
  case_id: string;
  target_rule_id: string;
  filled: boolean;
}

interface CardRecord {
  card: { id: string };
}

interface AnnotationStore {
  version: 1;
  annotations: Record<string, unknown>;
}

interface SynthPendingFile {
  case_id?: unknown;
  target_rule_id?: unknown;
  card?: unknown;
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

async function readSynthPendings(): Promise<SynthPendingItem[]> {
  if (!existsSync(PENDING_DIR)) return [];
  const names = (await readdir(PENDING_DIR))
    .filter((n) => n.startsWith('synth-') && n.endsWith('.json'))
    .sort();
  const out: SynthPendingItem[] = [];
  for (const name of names) {
    const raw = await readFile(join(PENDING_DIR, name), 'utf8');
    const doc = JSON.parse(raw) as SynthPendingFile;
    const caseId = typeof doc.case_id === 'string' ? doc.case_id : name.replace(/\.json$/, '');
    const ruleId =
      typeof doc.target_rule_id === 'string' ? doc.target_rule_id : '<unknown>';
    out.push({ case_id: caseId, target_rule_id: ruleId, filled: doc.card != null });
  }
  return out;
}

function groupSynthByRule(items: readonly SynthPendingItem[]): Map<string, SynthPendingItem[]> {
  const m = new Map<string, SynthPendingItem[]>();
  for (const it of items) {
    const arr = m.get(it.target_rule_id) ?? [];
    arr.push(it);
    m.set(it.target_rule_id, arr);
  }
  return m;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = await loadSourcesConfig();

  const allReal = realSources(cfg);
  if (args.source && !cfg.sources[args.source]) {
    const known = Object.keys(cfg.sources).join(', ');
    bail(`[list] источник "${args.source}" не найден (известные: ${known})`);
  }

  // Real pending: cards в cards.raw.jsonl без записи в annotations/<source>.json.
  const realFilter =
    args.source && allReal.includes(args.source) ? [args.source] : allReal;
  const realPending: PendingItem[] = [];
  const perSource: Record<string, string[]> = {};

  if (!args.source || allReal.includes(args.source)) {
    for (const source of realFilter) {
      const ids = await readJsonlIds(join(DATASETS_DIR, source, 'cards.raw.jsonl'));
      const annotated = await readAnnotationKeys(source);
      const missing = ids.filter((id) => !annotated.has(id)).sort();
      perSource[source] = missing;
      for (const id of missing) realPending.push({ case_id: id, source });
    }
  }

  // Synthetic pending: синт-файлы в pending-каталоге по target_rule_id.
  const showSynth = !args.source || args.source === 'synthetic';
  const synthPending = showSynth ? await readSynthPendings() : [];

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ real: realPending, synthetic: synthPending }, null, 2) + '\n',
    );
    return;
  }

  if (!args.source || args.source !== 'synthetic') {
    for (const source of realFilter) {
      const list = perSource[source] ?? [];
      console.log(`[pending real] ${source}: ${list.length}`);
      for (const id of list) console.log(`  ${id}`);
    }
    console.log(`[pending real] всего: ${realPending.length}`);
  }

  if (showSynth) {
    const byRule = groupSynthByRule(synthPending);
    const ruleIds = [...byRule.keys()].sort();
    if (synthPending.length === 0) {
      console.log('[pending synthetic] всего: 0');
    } else {
      const filled = synthPending.filter((p) => p.filled).length;
      const empty = synthPending.length - filled;
      const breakdown = ruleIds
        .map((r) => `${r}: ${byRule.get(r)?.length ?? 0}`)
        .join(', ');
      console.log(`[pending synthetic] ${breakdown} (всего: ${synthPending.length}, заполнено: ${filled}, пусто: ${empty})`);
      for (const r of ruleIds) {
        for (const it of byRule.get(r) ?? []) {
          const mark = it.filled ? '●' : '○';
          console.log(`  ${mark} ${it.case_id}`);
        }
      }
    }
  }
}

main().catch((err) => {
  console.error('[list] failure:', err);
  process.exit(1);
});
