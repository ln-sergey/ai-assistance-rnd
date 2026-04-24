// Harvest URL-кандидатов для afisha.ru.
//
// Корневой sitemap.xml содержит 47 сабсайтмапов (фильмы, персоны, площадки,
// статьи и т.п.) — нам нужны только карточки событий, они лежат в
// sitemap_creation-00N.xml. Идём напрямую туда, чтобы не тратить polite-delay
// на нерелевантные категории.
//
// Три типа страниц событий: /concert/, /performance/, /festival/.
// Исключаем кино, спорт, клубы — не наш домен.
//
// Диверсификация: min 2 на тип (concert/performance/festival),
// остальное добирается случайно из объединённого пула с фиксированным сидом.

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpClient } from './lib/http.js';
import { fetchSitemapUrls } from './lib/sitemap.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');

// afisha разбивает карточки по 4 XML-файлам. Явно перечисляем —
// корневой sitemap index тянет ещё ~40 нерелевантных сабсайтмапов.
const CREATION_SITEMAPS = [
  'https://www.afisha.ru/exports/blue_sitemap/sitemap_creation-001.xml',
  'https://www.afisha.ru/exports/blue_sitemap/sitemap_creation-002.xml',
  'https://www.afisha.ru/exports/blue_sitemap/sitemap_creation-003.xml',
  'https://www.afisha.ru/exports/blue_sitemap/sitemap_creation-004.xml',
];

type EventType = 'concert' | 'performance' | 'festival';
const EVENT_RE: Record<EventType, RegExp> = {
  concert: /^https?:\/\/(?:www\.)?afisha\.ru\/concert\/[a-z0-9-]+-\d+\/?$/i,
  performance: /^https?:\/\/(?:www\.)?afisha\.ru\/performance\/[a-z0-9-]+-\d+\/?$/i,
  festival: /^https?:\/\/(?:www\.)?afisha\.ru\/festival\/[a-z0-9-]+-\d+\/?$/i,
};

const RANDOM_SEED = 42;
const TARGET_TOTAL = 9;
const MIN_PER_TYPE = 2;

// afisha.ru редиректит все запросы без SberID-cookie на SSO-bounce
// страницу (~1.5 KB HTML со скриптом window.location.href = backUrl).
// Выставляем SberIdFailed=1 — тот самый cookie, который сайт сам ставит
// после неудачного ping к id.sber.ru. С ним отдаёт нормальные страницы.
const AFISHA_COOKIES = {
  'www.afisha.ru': 'SberIdFailed=1',
  'afisha.ru': 'SberIdFailed=1',
};

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

function classify(url: string): EventType | null {
  if (EVENT_RE.concert.test(url)) return 'concert';
  if (EVENT_RE.performance.test(url)) return 'performance';
  if (EVENT_RE.festival.test(url)) return 'festival';
  return null;
}

async function main(): Promise<void> {
  const http = new HttpClient({
    source: 'afisha',
    datasetsDir: DATASETS_DIR,
    cookiesByHost: AFISHA_COOKIES,
  });

  const allUrls: string[] = [];
  for (const sm of CREATION_SITEMAPS) {
    console.log(`[harvest] загружаем ${sm}`);
    const entries = await fetchSitemapUrls(http, sm);
    console.log(`[harvest]   → ${entries.length} URL`);
    for (const e of entries) allUrls.push(e.loc);
  }
  console.log(`[harvest] всего URL в creation-sitemap: ${allUrls.length}`);

  const byType = new Map<EventType, string[]>([
    ['concert', []],
    ['performance', []],
    ['festival', []],
  ]);
  for (const u of allUrls) {
    const t = classify(u);
    if (t) byType.get(t)!.push(u);
  }
  for (const [t, arr] of byType) {
    console.log(`[harvest] ${t}: ${arr.length} подходящих`);
  }

  const rnd = mulberry32(RANDOM_SEED);
  const picked: string[] = [];
  const pickedSet = new Set<string>();

  // 1) минимум MIN_PER_TYPE с каждого типа, пока возможно
  for (const [t, arr] of byType) {
    const shuffled = shuffle(arr, rnd);
    const take = shuffled.slice(0, Math.min(MIN_PER_TYPE, shuffled.length));
    for (const u of take) {
      if (pickedSet.has(u)) continue;
      picked.push(u);
      pickedSet.add(u);
    }
    console.log(`[harvest] ${t}: пикнуто минимум ${take.length}`);
  }

  // 2) добираем по кругу до TARGET_TOTAL
  const allShuffled = shuffle(
    [...byType.values()].flat(),
    rnd,
  );
  for (const url of allShuffled) {
    if (picked.length >= TARGET_TOTAL) break;
    if (pickedSet.has(url)) continue;
    picked.push(url);
    pickedSet.add(url);
  }

  const counts = new Map<EventType, number>();
  for (const u of picked) {
    const t = classify(u);
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const report = [...counts.entries()]
    .map(([t, n]) => `${t}:${n}`)
    .join(', ');

  const header = [
    '# afisha URL candidates',
    `# harvested_at: ${new Date().toISOString()}`,
    `# sources: ${CREATION_SITEMAPS.length} creation-sitemap.xml`,
    `# seed: ${RANDOM_SEED}`,
    `# total: ${picked.length}`,
    `# by_type: ${report}`,
    '',
  ];

  const outPath = join(DATASETS_DIR, 'afisha', 'urls.txt');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, [...header, ...picked, ''].join('\n'), 'utf8');

  console.log(`[harvest] записано ${picked.length} URL (${report}) в ${outPath}`);
}

main().catch((err) => {
  console.error('[harvest] failure:', err);
  process.exit(1);
});
