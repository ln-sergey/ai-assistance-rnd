// Harvest URL-кандидатов для pmpoperator.ru из sitemap.xml.
//
// Шаги:
//   1) скачиваем sitemap (возможно sitemap_index → рекурсия)
//   2) фильтруем по паттерну /tours/<slug>
//   3) случайно сужаем до TARGET_TOTAL (seed фиксирован)
//
// Выход: datasets/pmpoperator/urls.txt

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpClient } from './lib/http.js';
import { fetchSitemapUrls } from './lib/sitemap.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');

const SITEMAP_URL = 'https://pmpoperator.ru/sitemap.xml';
const CARD_PATTERN =
  /^https?:\/\/(?:www\.)?pmpoperator\.ru\/tours\/([a-z0-9-]+)\/?$/i;

const RANDOM_SEED = 42;
const TARGET_TOTAL = 14;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const http = new HttpClient({ source: 'pmpoperator', datasetsDir: DATASETS_DIR });

  console.log(`[harvest] загружаем sitemap ${SITEMAP_URL}`);
  const sitemapEntries = await fetchSitemapUrls(http, SITEMAP_URL);
  console.log(`[harvest] из sitemap — ${sitemapEntries.length} URL всего`);

  const candidates: string[] = [];
  for (const entry of sitemapEntries) {
    if (CARD_PATTERN.test(entry.loc)) candidates.push(entry.loc);
  }
  console.log(`[harvest] матчит паттерн /tours/<slug> — ${candidates.length}`);

  const rnd = mulberry32(RANDOM_SEED);
  const shuffled = shuffle(candidates, rnd);
  const picked = shuffled.slice(0, Math.min(TARGET_TOTAL, shuffled.length));

  const header = [
    '# pmpoperator URL candidates',
    `# harvested_at: ${new Date().toISOString()}`,
    `# sitemap: ${SITEMAP_URL}`,
    `# seed: ${RANDOM_SEED}`,
    `# total: ${picked.length} (из ${candidates.length})`,
    '',
  ];

  const outPath = join(DATASETS_DIR, 'pmpoperator', 'urls.txt');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, [...header, ...picked, ''].join('\n'), 'utf8');

  console.log(`[harvest] записано ${picked.length} URL в ${outPath}`);
}

main().catch((err) => {
  console.error('[harvest] failure:', err);
  process.exit(1);
});
