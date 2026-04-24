// Harvest URL-кандидатов для scantour.ru из sitemap_index.xml.
//
// WordPress: sitemap_index.xml ссылается на post-sitemap.xml + page-sitemap.xml.
// Карточки туров лежат как post'ы на корне слага. Под /tours/* и /tour_type/*
// стоит Disallow в robots.txt — эти URL исключаем.
//
// Выход: datasets/scantour/urls.txt

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpClient } from './lib/http.js';
import { fetchSitemapUrls } from './lib/sitemap.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');

// sitemap_index содержит десяток post-types — нам нужен именно
// tour-sitemap (permalink-и перенесены на корневой slug:
// scantour.ru/<slug>, а /tours/* запрещено robots.txt).
const SITEMAP_URL = 'https://scantour.ru/tour-sitemap.xml';
const EXCLUDED_PATH_RE = /\/(tours|tour_type|tour-category|category|author|tag|wp-content|feed)/i;

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

function isCandidate(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.host !== 'scantour.ru' && u.host !== 'www.scantour.ru') return false;
    if (EXCLUDED_PATH_RE.test(u.pathname)) return false;
    // tour-sitemap.xml уже содержит только post type "tour" — все нужные URL
    // лежат как /<slug>/. Требуем корневой slug и минимум 2 дефиса.
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return false;
    const slug = parts[0] ?? '';
    if (slug.length < 10) return false;
    if ((slug.match(/-/g) ?? []).length < 2) return false;
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const http = new HttpClient({ source: 'scantour', datasetsDir: DATASETS_DIR });

  console.log(`[harvest] загружаем sitemap_index ${SITEMAP_URL}`);
  const sitemapEntries = await fetchSitemapUrls(http, SITEMAP_URL);
  console.log(`[harvest] из sitemap — ${sitemapEntries.length} URL всего`);

  const candidates: string[] = [];
  for (const entry of sitemapEntries) {
    if (isCandidate(entry.loc)) candidates.push(entry.loc);
  }
  console.log(`[harvest] после фильтра (корневой slug + ключевые слова) — ${candidates.length}`);

  const rnd = mulberry32(RANDOM_SEED);
  const shuffled = shuffle(candidates, rnd);
  const picked = shuffled.slice(0, Math.min(TARGET_TOTAL, shuffled.length));

  const header = [
    '# scantour URL candidates',
    `# harvested_at: ${new Date().toISOString()}`,
    `# sitemap: ${SITEMAP_URL}`,
    `# seed: ${RANDOM_SEED}`,
    `# total: ${picked.length} (из ${candidates.length})`,
    '# robots.txt: /tours и /tour_type запрещены → берём только корневые slug',
    '',
  ];

  const outPath = join(DATASETS_DIR, 'scantour', 'urls.txt');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, [...header, ...picked, ''].join('\n'), 'utf8');

  console.log(`[harvest] записано ${picked.length} URL в ${outPath}`);
}

main().catch((err) => {
  console.error('[harvest] failure:', err);
  process.exit(1);
});
