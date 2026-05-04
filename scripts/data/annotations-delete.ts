// Удаляет разметку одного источника (или всех). Поведение зависит от
// --scope:
//
// --scope=all (default):
//   real:
//     datasets/annotations/<source>.json                       (полностью)
//     datasets/annotations/pending/<source>_*.json             (text-pending'и)
//     datasets/annotations/pending/<source>_*.images.json      (image-pending'и)
//     datasets/images-review/<YYYYMMDD>-<source>-<NNN>/        (партии)
//     datasets/cases/real-clean/<source>_*.json                (если не --keep-cases)
//     datasets/cases/real-dirty/<source>_*.json                (если не --keep-cases)
//   synthetic:
//     datasets/annotations/synthetic.json                      (полностью)
//     datasets/annotations/pending/synth-*.json                (если есть)
//     datasets/cases/synthetic-clean/synth_*.json              (если не --keep-cases)
//     datasets/cases/synthetic-dirty/synth_*.json              (если не --keep-cases)
//
// --scope=images:
//   real:
//     image-поля (expected_image_clean, image_violations) удаляются in-place
//     из datasets/annotations/<source>.json (text-разметка остаётся);
//     datasets/annotations/pending/<source>_*.images.json и
//     datasets/images-review/<YYYYMMDD>-<source>-<NNN>/ удаляются.
//     Cases не трогаются: их перематериализация — отдельной командой.
//   synthetic:
//     ничего не делает (у синтетики нет фото).
//
// НЕ трогает cards.raw.jsonl, images.raw.jsonl, картинки. Сырые данные
// сносятся отдельной командой (cards-delete).
//
// Использование:
//   pnpm annotations:delete --source=afisha --dry-run
//   pnpm annotations:delete --source=afisha --yes
//   pnpm annotations:delete --source=synthetic --yes
//   pnpm annotations:delete --all --yes --keep-cases
//   pnpm annotations:delete --source=sputnik8 --scope=images --yes

import { existsSync } from 'node:fs';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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
const IMAGES_REVIEW_DIR = join(DATASETS_DIR, 'images-review');

type Scope = 'all' | 'images';

interface PlanItem {
  label: string;
  paths: string[];
}

// Кастомное действие — переписать <source>.json без image-полей. Нужно
// в scope=images, чтобы text-разметка осталась, а image-разметка ушла.
interface InPlacePatch {
  label: string;
  apply: () => Promise<number>; // возвращает число затронутых записей
}

async function listJsonByPrefix(dir: string, prefix: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
    .map((n) => join(dir, n))
    .sort();
}

async function listImagePendings(source: string): Promise<string[]> {
  if (!existsSync(PENDING_DIR)) return [];
  const entries = await readdir(PENDING_DIR);
  return entries
    .filter((n) => n.startsWith(`${source}_`) && n.endsWith('.images.json'))
    .map((n) => join(PENDING_DIR, n))
    .sort();
}

async function listBatchDirsForSource(source: string): Promise<string[]> {
  if (!existsSync(IMAGES_REVIEW_DIR)) return [];
  const entries = await readdir(IMAGES_REVIEW_DIR, { withFileTypes: true });
  const re = new RegExp(`^\\d{8}-${source}-\\d{3}$`);
  return entries
    .filter((e) => e.isDirectory() && re.test(e.name))
    .map((e) => join(IMAGES_REVIEW_DIR, e.name))
    .sort();
}

interface AnyAnnotation {
  expected_clean?: unknown;
  violations?: unknown;
  notes?: unknown;
  annotated_at?: unknown;
  annotator?: unknown;
  expected_image_clean?: unknown;
  image_violations?: unknown;
}

interface AnnotationStore {
  version: 1;
  annotations: Record<string, AnyAnnotation>;
}

async function buildPatchStripImageFields(source: string): Promise<InPlacePatch | null> {
  const path = join(ANNOTATIONS_DIR, `${source}.json`);
  if (!existsSync(path)) return null;
  return {
    label: `annotations/${source}.json (image-поля → удалить, text оставить)`,
    apply: async () => {
      const raw = await readFile(path, 'utf8');
      const store = JSON.parse(raw) as AnnotationStore;
      let touched = 0;
      for (const ann of Object.values(store.annotations ?? {})) {
        const before =
          'expected_image_clean' in ann ? 1 : 0 + ('image_violations' in ann ? 1 : 0);
        if ('expected_image_clean' in ann) delete ann.expected_image_clean;
        if ('image_violations' in ann) delete ann.image_violations;
        if (before > 0) touched += 1;
      }
      const tmp = path + '.tmp';
      await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
      await rename(tmp, path);
      return touched;
    },
  };
}

async function buildPlanRealAll(source: string, keepCases: boolean): Promise<{
  items: PlanItem[];
  patches: InPlacePatch[];
}> {
  const items: PlanItem[] = [];

  const storePath = join(ANNOTATIONS_DIR, `${source}.json`);
  items.push({
    label: `annotations/${source}.json`,
    paths: existsSync(storePath) ? [storePath] : [],
  });

  const prefix = `${source}_`;
  const pending = await listJsonByPrefix(PENDING_DIR, prefix);
  // listJsonByPrefix вернул и `*.json`, и `*.images.json` (оба удовлетворяют
  // фильтру). Это то, что нужно для scope=all.
  items.push({
    label: `annotations/pending/${source}_*.json (${pending.length} files)`,
    paths: pending,
  });

  const batchDirs = await listBatchDirsForSource(source);
  items.push({
    label: `images-review/<batch-id>/ for ${source} (${batchDirs.length} dirs)`,
    paths: batchDirs,
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

  return { items, patches: [] };
}

async function buildPlanRealImages(source: string): Promise<{
  items: PlanItem[];
  patches: InPlacePatch[];
}> {
  const items: PlanItem[] = [];
  const patches: InPlacePatch[] = [];

  const pendingImages = await listImagePendings(source);
  items.push({
    label: `annotations/pending/${source}_*.images.json (${pendingImages.length} files)`,
    paths: pendingImages,
  });

  const batchDirs = await listBatchDirsForSource(source);
  items.push({
    label: `images-review/<batch-id>/ for ${source} (${batchDirs.length} dirs)`,
    paths: batchDirs,
  });

  const patch = await buildPatchStripImageFields(source);
  if (patch) patches.push(patch);

  return { items, patches };
}

async function buildPlanSyntheticAll(keepCases: boolean): Promise<{
  items: PlanItem[];
  patches: InPlacePatch[];
}> {
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

  return { items, patches: [] };
}

function printPlan(source: string, items: PlanItem[], patches: InPlacePatch[]): void {
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
  for (const p of patches) {
    console.log(`  ~ ${p.label}`);
  }
}

async function execute(items: PlanItem[], patches: InPlacePatch[]): Promise<{
  removed: number;
  patched: number;
}> {
  let removed = 0;
  for (const it of items) {
    for (const p of it.paths) {
      // Папки удаляем рекурсивно (recursive: true).
      await rm(p, { force: true, recursive: true });
      removed += 1;
    }
  }
  let patched = 0;
  for (const p of patches) {
    patched += await p.apply();
  }
  return { removed, patched };
}

async function main(): Promise<void> {
  const args = parseDeleteCli(['keep-cases'], ['scope']);
  const keepCases = args.flags.has('keep-cases');
  const scopeRaw = args.kv.get('scope') ?? 'all';
  if (scopeRaw !== 'all' && scopeRaw !== 'images') {
    console.error(`[delete] --scope=${scopeRaw} не поддерживается (all|images)`);
    process.exit(2);
  }
  const scope: Scope = scopeRaw;

  const cfg = await loadSourcesConfig();
  const sources = resolveSources(args, cfg);

  const plans = await Promise.all(
    sources.map(async (source) => {
      const entry = cfg.sources[source];
      if (!entry) throw new Error(`[delete] internal: ${source} нет в config`);
      const kind = sourceKind(entry);
      if (scope === 'images') {
        if (kind === 'synthetic') {
          return { source, items: [], patches: [] as InPlacePatch[] };
        }
        return { source, ...(await buildPlanRealImages(source)) };
      }
      // scope=all
      if (kind === 'synthetic') {
        return { source, ...(await buildPlanSyntheticAll(keepCases)) };
      }
      return { source, ...(await buildPlanRealAll(source, keepCases)) };
    }),
  );

  for (const { source, items, patches } of plans) printPlan(source, items, patches);

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

  let totalRemoved = 0;
  let totalPatched = 0;
  for (const { source, items, patches } of plans) {
    const { removed, patched } = await execute(items, patches);
    const patchedSuffix = patched > 0 ? `, image-поля удалены у ${patched} аннотаций` : '';
    console.log(`[delete] ${source}: удалено ${removed} путей${patchedSuffix}`);
    totalRemoved += removed;
    totalPatched += patched;
  }
  console.log(
    `[delete] итого удалено путей: ${totalRemoved}` +
      (totalPatched > 0 ? `, in-place-правок: ${totalPatched}` : ''),
  );
}

main().catch((err) => {
  console.error('[delete] failure:', err);
  process.exit(1);
});
