// Парсер sputnik8.com. Читает URL-ы из datasets/sputnik8/urls.txt,
// для каждого скачивает HTML, извлекает поля продуктовой карточки (DOM-only
// по решению пользователя — JSON-LD игнорируем) и пишет два JSONL:
//
//   datasets/sputnik8/cards.raw.jsonl    — по одной карточке на строку
//   datasets/sputnik8/images.raw.jsonl   — метаданные изображений для
//                                          последующего скачивания
//
// Идемпотентность: повторный запуск не дублирует строки (дедуп по card.id
// и image_id). При пустой карточке (< 100 символов full_description) —
// сохраняем, но помечаем в _meta.warnings.

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';

import { HttpClient } from './lib/http.js';
import {
  absoluteUrl,
  extractImageUrls,
  metaContent,
  normaliseText,
  parseDurationMinutes,
  parseGroupSize,
} from './lib/html.js';
import { makeImageId } from './lib/image-id.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');

const SOURCE = 'sputnik8';
const PARSER_VERSION = 'v1';
const CARD_URL_RE =
  /^https?:\/\/(?:www\.)?sputnik8\.com\/ru\/([a-z0-9-]+)\/activities\/(\d+)-([^/?#]+)\/?$/i;
const MAX_IMAGES_PER_CARD = 4; // cover + 3 gallery (по решению)
const MIN_FULL_DESCRIPTION = 100;

interface ProductCard {
  id: string;
  product_type: 'tour' | 'excursion' | 'event';
  title: string;
  short_description: string;
  full_description: string;
  program_items: Array<{ order: number; title: string; description: string }>;
  services: Array<{ name: string; description: string }>;
  location: {
    address: string;
    route_comment: string;
    meeting_point_comment: string;
  };
  contacts_block: { public_comment: string };
  schedule: {
    format: 'once' | 'recurring' | 'ondemand';
    dates?: string[];
    duration_minutes?: number;
  };
  age_restriction?: string | null;
  group_size?: { min?: number; max?: number } | null;
  languages?: string[];
  images: Array<{ image_id: string; role: 'cover' | 'gallery'; caption?: string | null }>;
}

interface CardRecord {
  card: ProductCard;
  _meta: {
    source_site: string;
    source_url: string;
    fetched_at: string;
    parser_version: string;
    json_ld_found: boolean;
    warnings: string[];
  };
}

interface ImageRecord {
  image_id: string;
  linked_card_id: string;
  role: 'cover' | 'gallery';
  caption: string | null;
  source_url: string;
  file_path: string;
  _meta: {
    queued_at: string;
  };
}

function parseArgs(): { limit: number } {
  let limit = 10;
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--limit=(\d+)$/);
    if (m?.[1]) limit = Number(m[1]);
  }
  return { limit };
}

async function readUrlsFile(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

async function readJsonlIds(path: string, key: string): Promise<Set<string>> {
  const known = new Set<string>();
  if (!existsSync(path)) return known;
  const raw = await readFile(path, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const idCandidate =
        key === 'card.id'
          ? ((parsed.card as { id?: string } | undefined)?.id)
          : (parsed[key] as string | undefined);
      if (typeof idCandidate === 'string') known.add(idCandidate);
    } catch {
      // строка битая — ок, следующий прогон перепишет
    }
  }
  return known;
}

function looksLikeContentImage(url: string): boolean {
  const lower = url.toLowerCase();
  if (
    lower.includes('logo') ||
    lower.includes('icon') ||
    lower.includes('sprite') ||
    lower.includes('avatar') ||
    lower.includes('/flag') ||
    lower.endsWith('.svg')
  ) {
    return false;
  }
  return (
    lower.includes('activity') ||
    lower.includes('/photo') ||
    lower.includes('/image') ||
    lower.includes('/upload') ||
    lower.includes('/media') ||
    lower.includes('/cdn') ||
    lower.includes('selcdn') ||
    lower.includes('sputnik8')
  );
}

// sputnik8 — SSR-lite: основные фотки карточки прокидываются как URL
// внутри inline-JSON, а в DOM попадает только пачка <img> для связанных
// карточек. Поэтому DOM-обход img-тегов не ловит галерею — идём по
// сырому HTML регулярками.
//
// Формат URL галереи в selcdn:
//   https://<bucket>.selcdn.net/<uuid>/-/format/webp/-/quality/<q>/-/stretch/off/-/resize/1900x/
//
// Дедуп по UUID: один и тот же файл встречается в 5–10 вариантах размеров.
function extractSputnikGalleryUrls(html: string): string[] {
  const re =
    /https:\/\/[a-f0-9-]+\.selcdn\.net\/([a-f0-9-]+)\/(?:-\/[^"'\s)\\]+\/)*/g;
  const byUuid = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const url = match[0];
    const uuid = match[1];
    if (!uuid) continue;
    // отсекаем микро-превью (70x70 — аватарки ревьюеров)
    const sizeMatch = url.match(/scale_crop\/(\d+)x(\d+)/);
    if (sizeMatch?.[1] && sizeMatch?.[2]) {
      const w = Number(sizeMatch[1]);
      const h = Number(sizeMatch[2]);
      if (w < 200 || h < 200) continue;
    }
    // предпочитаем "широкий" вариант resize/<N>x/ c N≥900, иначе берём что
    // первый попался (голый URL без трансформаций — тоже ок, CDN вернёт
    // оригинал).
    const widthMatch = url.match(/resize\/(\d+)x/);
    const width = widthMatch?.[1] ? Number(widthMatch[1]) : 0;
    const prev = byUuid.get(uuid);
    if (!prev) {
      byUuid.set(uuid, url);
      continue;
    }
    const prevWidth = (prev.match(/resize\/(\d+)x/)?.[1]
      ? Number(prev.match(/resize\/(\d+)x/)?.[1])
      : 0) as number;
    if (width > prevWidth) byUuid.set(uuid, url);
  }
  return [...byUuid.values()];
}

function extractFullDescription($: cheerio.CheerioAPI): string {
  // Канонический блок описания на странице активности sputnik8.
  // Раньше тут был «выбираем самый длинный chunk среди всего, что
  // подходит под [class*=description|about|content]» — но в этот фильтр
  // попадали блоки отзывов, биографии гида и SEO-меню, и «самый длинный»
  // оказывался не описанием продукта. Канонический селектор пуст у
  // ~единиц карточек — для них падаем в fallback по <p> в body.
  const canonical = $('.activity-page-description__details-content').first();
  if (canonical.length > 0) {
    const text = normaliseText(canonical.text());
    if (text.length >= 40) return text;
  }
  // Fallback: берём <p>-параграфы в body. Мы тут уже знаем, что
  // канонического блока нет либо он почти пустой, поэтому это
  // компромисс на случай редкого варианта вёрстки.
  const paras: string[] = [];
  $('body p').each((_, el) => {
    const text = normaliseText($(el).text());
    if (text.length >= 40) paras.push(text);
  });
  return paras.slice(0, 30).join('\n\n');
}

function extractProgramItems(
  $: cheerio.CheerioAPI,
): Array<{ order: number; title: string; description: string }> {
  const items: Array<{ order: number; title: string; description: string }> = [];
  // sputnik8 использует блоки «Что увидите», «Программа», «Маршрут» с
  // ul/ol или перечислением — попробуем общий паттерн.
  const headingRe = /(что увидите|маршрут|программа|план экскурсии)/i;
  $('h2, h3').each((_, el) => {
    const heading = $(el).text();
    if (!headingRe.test(heading)) return;
    let next = $(el).next();
    let depth = 0;
    while (next.length && depth < 5) {
      const tag = next[0]?.type === 'tag' ? next[0].tagName : '';
      if (tag === 'ul' || tag === 'ol') {
        next.find('li').each((idx, li) => {
          const text = normaliseText($(li).text());
          if (text.length < 3) return;
          const titleMatch = text.split(/[—–:.]/)[0]?.trim() ?? text;
          items.push({
            order: items.length + 1,
            title: titleMatch.slice(0, 120),
            description: text,
          });
        });
        break;
      }
      next = next.next();
      depth++;
    }
  });
  return items;
}

function extractServices(
  $: cheerio.CheerioAPI,
): Array<{ name: string; description: string }> {
  const services: Array<{ name: string; description: string }> = [];
  const headingRe = /(что входит|входит в стоимость|включ[её]но|не входит|оплачивается отдельно)/i;
  $('h2, h3, h4').each((_, el) => {
    const heading = normaliseText($(el).text());
    if (!headingRe.test(heading)) return;
    const groupLabel = /не входит|отдельно/i.test(heading)
      ? 'Оплачивается отдельно'
      : 'Входит в стоимость';
    let next = $(el).next();
    let depth = 0;
    while (next.length && depth < 5) {
      const tag = next[0]?.type === 'tag' ? next[0].tagName : '';
      if (tag === 'ul' || tag === 'ol') {
        next.find('li').each((_idx, li) => {
          const text = normaliseText($(li).text());
          if (text.length < 2) return;
          services.push({
            name: `${groupLabel}: ${text.slice(0, 80)}`,
            description: text,
          });
        });
        break;
      }
      next = next.next();
      depth++;
    }
  });
  return services;
}

function extractLocation($: cheerio.CheerioAPI): {
  address: string;
  route_comment: string;
  meeting_point_comment: string;
} {
  const addr = normaliseText(
    $('[class*="address" i], [class*="location" i]').first().text(),
  );
  const meeting = normaliseText(
    $(
      '[class*="meeting" i], [class*="point" i], [class*="starting" i]',
    )
      .first()
      .text(),
  );
  return {
    address: addr.slice(0, 400),
    route_comment: '',
    meeting_point_comment: meeting.slice(0, 400),
  };
}

function extractLanguages(pageText: string): string[] {
  const langs = new Set<string>();
  if (/русск(ий|ом)/i.test(pageText)) langs.add('ru');
  if (/английск(ий|ом)|english/i.test(pageText)) langs.add('en');
  if (/китайск(ий|ом)/i.test(pageText)) langs.add('zh');
  if (/немецк(ий|ом)/i.test(pageText)) langs.add('de');
  if (/французск(ий|ом)/i.test(pageText)) langs.add('fr');
  return [...langs];
}

function parseUrl(url: string): { cardId: string; city: string } | null {
  const m = url.match(CARD_URL_RE);
  if (!m?.[1] || !m?.[2]) return null;
  return { cardId: `sputnik8_${m[2]}`, city: m[1].toLowerCase() };
}

function buildImageEntries(
  cardId: string,
  sourceUrls: string[],
): { cardImages: ProductCard['images']; records: ImageRecord[] } {
  const limited = sourceUrls.slice(0, MAX_IMAGES_PER_CARD);
  const cardImages: ProductCard['images'] = [];
  const records: ImageRecord[] = [];
  limited.forEach((sourceUrl, i) => {
    const role: 'cover' | 'gallery' = i === 0 ? 'cover' : 'gallery';
    const image_id = makeImageId(cardId, i);
    cardImages.push({ image_id, role, caption: null });
    records.push({
      image_id,
      linked_card_id: cardId,
      role,
      caption: null,
      source_url: sourceUrl,
      file_path: `datasets/images/${image_id}`, // расширение добавится при скачивании
      _meta: { queued_at: new Date().toISOString() },
    });
  });
  return { cardImages, records };
}

function buildCard(
  url: string,
  cardId: string,
  html: string,
): { record: CardRecord; images: ImageRecord[] } {
  const $ = cheerio.load(html);
  const warnings: string[] = [];

  const title = normaliseText($('h1').first().text());
  if (!title) warnings.push('пустой title');

  const shortDesc =
    metaContent($, 'og:description') || metaContent($, 'description');
  if (!shortDesc) warnings.push('пустой short_description');

  const fullDesc = extractFullDescription($);
  if (fullDesc.length < MIN_FULL_DESCRIPTION) {
    warnings.push(
      `full_description короче ${MIN_FULL_DESCRIPTION} символов (${fullDesc.length})`,
    );
  }

  const programItems = extractProgramItems($);
  const services = extractServices($);
  const location = extractLocation($);

  const pageText = normaliseText($('body').text());
  const durationMinutes = parseDurationMinutes(pageText);
  const groupSizeRaw = parseGroupSize(pageText);
  const groupSize =
    groupSizeRaw && (groupSizeRaw.max !== undefined || groupSizeRaw.min !== undefined)
      ? groupSizeRaw
      : null;
  const languages = extractLanguages(pageText);

  // Сначала regex по сырому HTML (галерея sputnik8 живёт в JSON-блобе).
  const jsonImages = extractSputnikGalleryUrls(html);
  // Плюс DOM-обход на случай <img> в карточках-сателлитах — бракуем по фильтру.
  const gallerySelector =
    '[class*="gallery" i], [class*="slider" i], [class*="carousel" i], main, article';
  const hasGallery = $(gallerySelector).length > 0;
  const domImages = extractImageUrls(
    $,
    hasGallery ? gallerySelector : 'body',
    url,
  ).filter(looksLikeContentImage);
  const filteredImages = [...new Set([...jsonImages, ...domImages])];
  if (filteredImages.length === 0) warnings.push('изображения не найдены');

  const { cardImages, records } = buildImageEntries(cardId, filteredImages);

  const card: ProductCard = {
    id: cardId,
    product_type: 'excursion',
    title,
    short_description: shortDesc,
    full_description: fullDesc,
    program_items: programItems,
    services,
    location,
    contacts_block: { public_comment: '' },
    schedule: { format: 'recurring' },
    images: cardImages,
  };
  if (durationMinutes !== null) card.schedule.duration_minutes = durationMinutes;
  if (groupSize) card.group_size = groupSize;
  if (languages.length > 0) card.languages = languages;

  const record: CardRecord = {
    card,
    _meta: {
      source_site: SOURCE,
      source_url: url,
      fetched_at: new Date().toISOString(),
      parser_version: PARSER_VERSION,
      json_ld_found: false,
      warnings,
    },
  };
  return { record, images: records };
}

async function main(): Promise<void> {
  const { limit } = parseArgs();
  const urlsPath = join(DATASETS_DIR, SOURCE, 'urls.txt');
  if (!existsSync(urlsPath)) {
    console.error(`[parse] нет файла ${urlsPath}. Запусти harvest:${SOURCE}.`);
    process.exit(2);
  }
  const allUrls = await readUrlsFile(urlsPath);
  const http = new HttpClient({ source: SOURCE, datasetsDir: DATASETS_DIR });

  const cardsPath = join(DATASETS_DIR, SOURCE, 'cards.raw.jsonl');
  const imagesPath = join(DATASETS_DIR, SOURCE, 'images.raw.jsonl');
  await mkdir(dirname(cardsPath), { recursive: true });

  const knownCardIds = await readJsonlIds(cardsPath, 'card.id');
  const knownImageIds = await readJsonlIds(imagesPath, 'image_id');

  let processed = 0;
  let wrote = 0;
  let skipped = 0;
  const startedAt = Date.now();

  for (const url of allUrls) {
    if (processed >= limit) break;
    const parsed = parseUrl(url);
    if (!parsed) {
      console.warn(`[parse] URL не совпадает с паттерном, пропуск: ${url}`);
      continue;
    }
    const { cardId } = parsed;
    if (knownCardIds.has(cardId)) {
      console.log(`[parse] card уже есть (${cardId}), пропуск`);
      skipped++;
      continue;
    }

    try {
      const fetched = await http.fetchHtml(url);
      if (fetched.status !== 200) {
        console.warn(`[parse] ${url} → HTTP ${fetched.status}, пропуск`);
        skipped++;
        continue;
      }
      const { record, images } = buildCard(url, cardId, fetched.html);
      await appendFile(cardsPath, JSON.stringify(record) + '\n', 'utf8');
      knownCardIds.add(cardId);
      for (const img of images) {
        if (knownImageIds.has(img.image_id)) continue;
        await appendFile(imagesPath, JSON.stringify(img) + '\n', 'utf8');
        knownImageIds.add(img.image_id);
      }
      wrote++;
      console.log(
        `[parse] ${cardId}: title="${record.card.title.slice(0, 60)}", ` +
          `full_description=${record.card.full_description.length} B, ` +
          `images=${images.length}, warnings=${record._meta.warnings.length}`,
      );
    } catch (err) {
      console.error(`[parse] ${url}: ${(err as Error).message}`);
      skipped++;
    } finally {
      processed++;
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[parse] готово: processed=${processed}, wrote=${wrote}, skipped=${skipped}, elapsed=${elapsed}s`,
  );
}

main().catch((err) => {
  console.error('[parse] failure:', err);
  process.exit(1);
});
