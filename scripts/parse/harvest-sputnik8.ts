// Harvest URL-кандидатов для sputnik8.com из sitemap.xml.
//
// Шаги:
//   1) скачиваем sitemap (учитывая sitemap_index)
//   2) фильтруем по паттерну /ru/<city>/activities/<id>-<slug>
//   3) группируем по городу
//   4) сэмплируем: СПб ~40%, Москва ~25%, остальное ~35%
//   5) минимум 2 карточки на город из выбранного бакета
//   6) seed фиксирован для воспроизводимости
//
// Выход: datasets/sputnik8/urls.txt (плоский список, один URL на строку,
// комментарии `# ...` допустимы).

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpClient } from './lib/http.js';
import { fetchSitemapUrls } from './lib/sitemap.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');

const SITEMAP_URL = 'https://www.sputnik8.com/sitemap.xml';
const CARD_PATTERN =
  /^https?:\/\/(?:www\.)?sputnik8\.com\/ru\/([a-z0-9-]+)\/activities\/(\d+)-[^/?#]+\/?$/i;

const RANDOM_SEED = 42;
const TARGET_TOTAL = 40;
const SPB_SHARE = 0.40;
const MSK_SHARE = 0.25;
const REST_SHARE = 1 - SPB_SHARE - MSK_SHARE;
const MIN_PER_CITY = 2;

const SPB_CITIES = new Set([
  'st-petersburg',
  'saint-petersburg',
  'sankt-peterburg',
  'spb',
  'piter',
]);
const MSK_CITIES = new Set(['moscow', 'moskva']);

// mulberry32 — детерминированный PRNG, хватает для сэмплирования.
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

type Bucket = 'spb' | 'msk' | 'rest';

function bucketOf(city: string): Bucket {
  if (SPB_CITIES.has(city)) return 'spb';
  if (MSK_CITIES.has(city)) return 'msk';
  return 'rest';
}

interface CandidateUrl {
  url: string;
  city: string;
  bucket: Bucket;
}

async function main(): Promise<void> {
  const http = new HttpClient({ source: 'sputnik8', datasetsDir: DATASETS_DIR });

  console.log(`[harvest] загружаем sitemap ${SITEMAP_URL}`);
  const sitemapEntries = await fetchSitemapUrls(http, SITEMAP_URL);
  console.log(`[harvest] из sitemap — ${sitemapEntries.length} URL всего`);

  const candidates: CandidateUrl[] = [];
  for (const entry of sitemapEntries) {
    const match = entry.loc.match(CARD_PATTERN);
    if (!match) continue;
    const city = (match[1] ?? '').toLowerCase();
    if (!city) continue;
    candidates.push({ url: entry.loc, city, bucket: bucketOf(city) });
  }
  console.log(
    `[harvest] матчит паттерн карточки — ${candidates.length}`,
  );

  const byBucket = new Map<Bucket, CandidateUrl[]>([
    ['spb', []],
    ['msk', []],
    ['rest', []],
  ]);
  for (const c of candidates) {
    byBucket.get(c.bucket)!.push(c);
  }

  const byCityInRest = new Map<string, CandidateUrl[]>();
  for (const c of byBucket.get('rest') ?? []) {
    const arr = byCityInRest.get(c.city) ?? [];
    arr.push(c);
    byCityInRest.set(c.city, arr);
  }

  const rnd = mulberry32(RANDOM_SEED);

  const targetSpb = Math.round(TARGET_TOTAL * SPB_SHARE);
  const targetMsk = Math.round(TARGET_TOTAL * MSK_SHARE);
  const targetRest = TARGET_TOTAL - targetSpb - targetMsk;

  const pickFromBucket = (
    bucket: Bucket,
    want: number,
    label: string,
  ): CandidateUrl[] => {
    const pool = byBucket.get(bucket) ?? [];
    if (pool.length === 0) {
      console.warn(`[harvest] ${label}: пул пуст`);
      return [];
    }
    const shuffled = shuffle(pool, rnd);
    const picked = shuffled.slice(0, Math.min(want, shuffled.length));
    console.log(
      `[harvest] ${label}: доступно ${pool.length}, выбрано ${picked.length}`,
    );
    return picked;
  };

  const pickRestDiverse = (want: number): CandidateUrl[] => {
    const cities = [...byCityInRest.keys()];
    const cityOrder = shuffle(cities, rnd);
    const picked: CandidateUrl[] = [];
    // первый проход: минимум MIN_PER_CITY с каждого города, где возможно
    for (const city of cityOrder) {
      if (picked.length >= want) break;
      const pool = shuffle(byCityInRest.get(city) ?? [], rnd);
      const take = Math.min(MIN_PER_CITY, pool.length, want - picked.length);
      picked.push(...pool.slice(0, take));
    }
    // второй проход: добираем остаток по циклу по городам
    let guard = 0;
    while (picked.length < want && guard < 1000) {
      guard++;
      let added = false;
      for (const city of cityOrder) {
        if (picked.length >= want) break;
        const pool = byCityInRest.get(city) ?? [];
        const already = picked.filter((p) => p.city === city).length;
        if (already >= pool.length) continue;
        const shuffled = shuffle(pool, rnd);
        const next = shuffled[already];
        if (next && !picked.some((p) => p.url === next.url)) {
          picked.push(next);
          added = true;
        }
      }
      if (!added) break;
    }
    console.log(
      `[harvest] rest: городов ${cities.length}, выбрано ${picked.length} URL`,
    );
    return picked;
  };

  const pickedSpb = pickFromBucket('spb', targetSpb, 'spb');
  const pickedMsk = pickFromBucket('msk', targetMsk, 'msk');
  const pickedRest = pickRestDiverse(targetRest);

  const all = [...pickedSpb, ...pickedMsk, ...pickedRest];
  if (all.length < 30) {
    console.warn(
      `[harvest] внимание: собрано ${all.length} URL, ожидалось ≥ 30`,
    );
  }

  const byCityCounts = new Map<string, number>();
  for (const c of all) {
    byCityCounts.set(c.city, (byCityCounts.get(c.city) ?? 0) + 1);
  }
  const cityReport = [...byCityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([city, n]) => `${city}: ${n}`)
    .join(', ');

  const header = [
    '# sputnik8 URL candidates',
    `# harvested_at: ${new Date().toISOString()}`,
    `# sitemap: ${SITEMAP_URL}`,
    `# seed: ${RANDOM_SEED}`,
    `# total: ${all.length}`,
    `# bucket_spb: ${pickedSpb.length}, bucket_msk: ${pickedMsk.length}, bucket_rest: ${pickedRest.length}`,
    `# by_city: ${cityReport}`,
    '',
  ];

  const outPath = join(DATASETS_DIR, 'sputnik8', 'urls.txt');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, [...header, ...all.map((c) => c.url), ''].join('\n'), 'utf8');

  console.log(`[harvest] записано ${all.length} URL в ${outPath}`);
  console.log(`[harvest] распределение по городам: ${cityReport}`);
}

main().catch((err) => {
  console.error('[harvest] failure:', err);
  process.exit(1);
});
