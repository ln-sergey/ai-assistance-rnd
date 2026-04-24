// Удаляет спаршеные данные одного источника (или всех):
//   datasets/<source>/cards.raw.jsonl
//   datasets/<source>/cards.rejected.jsonl
//   datasets/<source>/images.raw.jsonl
//   datasets/<source>/images.oversize.txt
//   datasets/<source>/html-cache/   (рекурсивно)
//   datasets/images/<source>_*.{jpg,png,webp,gif}
//
// НЕ трогает urls.txt (точка входа harvester'а), datasets/annotations/,
// datasets/cases/. Аннотации и материализованные case'ы — отдельной
// командой (annotations-delete).
//
// Использование:
//   pnpm cards:delete --source=afisha --dry-run
//   pnpm cards:delete --source=afisha --yes
//   pnpm cards:delete --all --yes

import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSourcesConfig } from '../parse/lib/config.js';
import { confirmInteractive, parseDeleteCli, resolveSources } from './lib/delete-cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const IMAGES_DIR = join(DATASETS_DIR, 'images');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

interface PlanItem {
  label: string;
  paths: string[];
  isDir: boolean;
}

async function findImagesForSource(source: string): Promise<string[]> {
  if (!existsSync(IMAGES_DIR)) return [];
  const entries = await readdir(IMAGES_DIR);
  const prefix = `${source}_`;
  const out: string[] = [];
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const dot = name.lastIndexOf('.');
    if (dot === -1) continue;
    if (!IMAGE_EXTS.has(name.slice(dot).toLowerCase())) continue;
    out.push(join(IMAGES_DIR, name));
  }
  return out.sort();
}

async function countDirEntries(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  return (await readdir(dir)).length;
}

async function buildPlan(source: string): Promise<PlanItem[]> {
  const srcDir = join(DATASETS_DIR, source);
  const items: PlanItem[] = [];

  for (const file of [
    'cards.raw.jsonl',
    'cards.rejected.jsonl',
    'images.raw.jsonl',
    'images.oversize.txt',
  ]) {
    const path = join(srcDir, file);
    items.push({
      label: file,
      paths: existsSync(path) ? [path] : [],
      isDir: false,
    });
  }

  const htmlCache = join(srcDir, 'html-cache');
  const htmlCount = await countDirEntries(htmlCache);
  items.push({
    label: `html-cache/ (${htmlCount} entries)`,
    paths: existsSync(htmlCache) ? [htmlCache] : [],
    isDir: true,
  });

  const imgs = await findImagesForSource(source);
  items.push({
    label: `datasets/images/${source}_* (${imgs.length} files)`,
    paths: imgs,
    isDir: false,
  });

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
    if (it.paths.length === 1 && it.isDir) {
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
      await rm(p, { recursive: it.isDir, force: true });
      n += 1;
    }
  }
  return n;
}

async function main(): Promise<void> {
  const args = parseDeleteCli();
  const cfg = await loadSourcesConfig();
  const sources = resolveSources(args, cfg);

  const plans = await Promise.all(
    sources.map(async (source) => ({ source, items: await buildPlan(source) })),
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
