// Удаляет разметку одного источника (или всех):
//   real:
//     datasets/annotations/<source>.json                       (полностью)
//     datasets/annotations/pending/<source>_*.json             (если есть)
//     datasets/cases/real-clean/<source>_*.json                (если не --keep-cases)
//     datasets/cases/real-dirty/<source>_*.json                (если не --keep-cases)
//   synthetic:
//     datasets/annotations/synthetic.json                      (полностью)
//     datasets/annotations/pending/synth-*.json                (если есть)
//     datasets/cases/synthetic-clean/synth_*.json              (если не --keep-cases)
//     datasets/cases/synthetic-dirty/synth_*.json              (если не --keep-cases)
//
// НЕ трогает cards.raw.jsonl, images.raw.jsonl, картинки. Сырые данные
// сносятся отдельной командой (cards-delete).
//
// Использование:
//   pnpm annotations:delete --source=afisha --dry-run
//   pnpm annotations:delete --source=afisha --yes
//   pnpm annotations:delete --source=synthetic --yes
//   pnpm annotations:delete --all --yes --keep-cases

import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSourcesConfig, sourceKind } from '../parse/lib/config.js';
import { confirmInteractive, parseDeleteCli, resolveSources } from './lib/delete-cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const ANNOTATIONS_DIR = join(DATASETS_DIR, 'annotations');
const PENDING_DIR = join(ANNOTATIONS_DIR, 'pending');
const CASES_DIR = join(DATASETS_DIR, 'cases');
const REAL_CLEAN = join(CASES_DIR, 'real-clean');
const REAL_DIRTY = join(CASES_DIR, 'real-dirty');
const SYNTH_CLEAN = join(CASES_DIR, 'synthetic-clean');
const SYNTH_DIRTY = join(CASES_DIR, 'synthetic-dirty');

interface PlanItem {
  label: string;
  paths: string[];
}

async function listJsonByPrefix(dir: string, prefix: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
    .map((n) => join(dir, n))
    .sort();
}

async function buildPlanReal(source: string, keepCases: boolean): Promise<PlanItem[]> {
  const items: PlanItem[] = [];

  const storePath = join(ANNOTATIONS_DIR, `${source}.json`);
  items.push({
    label: `annotations/${source}.json`,
    paths: existsSync(storePath) ? [storePath] : [],
  });

  const prefix = `${source}_`;
  const pending = await listJsonByPrefix(PENDING_DIR, prefix);
  items.push({
    label: `annotations/pending/${source}_*.json (${pending.length} files)`,
    paths: pending,
  });

  if (!keepCases) {
    const clean = await listJsonByPrefix(REAL_CLEAN, prefix);
    items.push({
      label: `cases/real-clean/${source}_*.json (${clean.length} files)`,
      paths: clean,
    });
    const dirty = await listJsonByPrefix(REAL_DIRTY, prefix);
    items.push({
      label: `cases/real-dirty/${source}_*.json (${dirty.length} files)`,
      paths: dirty,
    });
  }

  return items;
}

async function buildPlanSynthetic(keepCases: boolean): Promise<PlanItem[]> {
  const items: PlanItem[] = [];

  const storePath = join(ANNOTATIONS_DIR, 'synthetic.json');
  items.push({
    label: 'annotations/synthetic.json',
    paths: existsSync(storePath) ? [storePath] : [],
  });

  // synth-pending'и имеют префикс synth- (не synthetic_), поэтому отдельная
  // ветка glob'а. См. конвенцию в synthesize-scaffold.ts.
  const pending = await listJsonByPrefix(PENDING_DIR, 'synth-');
  items.push({
    label: `annotations/pending/synth-*.json (${pending.length} files)`,
    paths: pending,
  });

  if (!keepCases) {
    const clean = await listJsonByPrefix(SYNTH_CLEAN, 'synth_');
    items.push({
      label: `cases/synthetic-clean/synth_*.json (${clean.length} files)`,
      paths: clean,
    });
    const dirty = await listJsonByPrefix(SYNTH_DIRTY, 'synth_');
    items.push({
      label: `cases/synthetic-dirty/synth_*.json (${dirty.length} files)`,
      paths: dirty,
    });
  }

  return items;
}

function printPlan(source: string, items: PlanItem[]): void {
  console.log(`[plan] source=${source}`);
  for (const it of items) {
    if (it.paths.length === 0) {
      console.log(`  - ${it.label}: (нет)`);
      continue;
    }
    if (it.paths.length === 1 && !it.label.includes('(')) {
      console.log(`  - ${it.label}: ${it.paths[0]}`);
      continue;
    }
    console.log(`  - ${it.label}:`);
    for (const p of it.paths.slice(0, 5)) console.log(`      ${p}`);
    if (it.paths.length > 5) console.log(`      … +${it.paths.length - 5}`);
  }
}

async function execute(items: PlanItem[]): Promise<number> {
  let n = 0;
  for (const it of items) {
    for (const p of it.paths) {
      await rm(p, { force: true });
      n += 1;
    }
  }
  return n;
}

async function main(): Promise<void> {
  const args = parseDeleteCli(['keep-cases']);
  const keepCases = args.flags.has('keep-cases');
  const cfg = await loadSourcesConfig();
  const sources = resolveSources(args, cfg);

  const plans = await Promise.all(
    sources.map(async (source) => {
      const entry = cfg.sources[source];
      if (!entry) throw new Error(`[delete] internal: ${source} нет в config`);
      const items =
        sourceKind(entry) === 'synthetic'
          ? await buildPlanSynthetic(keepCases)
          : await buildPlanReal(source, keepCases);
      return { source, items };
    }),
  );

  for (const { source, items } of plans) printPlan(source, items);

  if (args.dryRun) {
    console.log('[delete] dry-run: ничего не удалено');
    return;
  }

  if (!args.yes) {
    const ok = await confirmInteractive();
    if (!ok) {
      console.log('[delete] отменено');
      return;
    }
  }

  let total = 0;
  for (const { source, items } of plans) {
    const n = await execute(items);
    console.log(`[delete] ${source}: удалено ${n} путей`);
    total += n;
  }
  console.log(`[delete] итого удалено: ${total}`);
}

main().catch((err) => {
  console.error('[delete] failure:', err);
  process.exit(1);
});
