// Парсер scantour.ru. Читает URL из datasets/scantour/urls.txt.
//
// Особенности:
// - permalink-и перенесены на корневой slug: /<slug>/ (не /tours/, там Disallow);
// - нет JSON-LD про Tour/Event (только WebPage/Breadcrumb);
// - календарь дат рисуется JS — в исходном HTML дат почти нет, поэтому
//   schedule.dates оставляем пустым;
// - программа лежит в .tour_prog_content: .tour_prog_day_tit ("1 ДЕНЬ") задаёт
//   день, h3 внутри — пункты;
// - галерея в .tour-gallery-horizontal как <a href="..." style="background-image">:
//   берём href (full-size), style — только запасной вариант.

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';

import { absoluteUrl, normaliseText } from './lib/html.js';
import { HttpClient } from './lib/http.js';
import { makeImageId } from './lib/image-id.js';
import { parseLimitArg, readJsonlIds, readUrlsFile } from './lib/jsonl.js';
import type { CardRecord, ImageRecord, ProductCard } from './lib/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');

const SOURCE = 'scantour';
const PARSER_VERSION = 'v1';
const CARD_URL_RE =
  /^https?:\/\/(?:www\.)?scantour\.ru\/([a-z0-9-]+)\/?$/i;
const MAX_IMAGES_PER_CARD = 4;
const MIN_FULL_DESCRIPTION = 100;

function parseUrl(url: string): { cardId: string; slug: string } | null {
  const m = url.match(CARD_URL_RE);
  if (!m?.[1]) return null;
  // slug scantour иногда очень длинный — обрезаем до 80 символов для читаемости
  // card.id, но оставляем уникальным по исходнику (полный slug в _meta.source_url).
  const slug = m[1];
  const cardSlug = slug.length > 80 ? slug.slice(0, 80) : slug;
  return { cardId: `scantour_${cardSlug}`, slug };
}

function extractShortAndFullDescription(
  $: cheerio.CheerioAPI,
): { short: string; full: string } {
  const full = normaliseText($('.tour_short_content').first().text());
  const meta =
    $('meta[name="description"]').attr('content') ??
    $('meta[property="og:description"]').attr('content') ??
    '';
  const short = meta.trim()
    ? normaliseText(meta)
    : full.split(/(?<=[.!?])\s+/)[0]?.slice(0, 300) ?? '';
  return { short, full };
}

function extractProgramItems(
  $: cheerio.CheerioAPI,
): Array<{ order: number; title: string; description: string }> {
  const items: Array<{ order: number; title: string; description: string }> = [];
  const root = $('.tour_prog_content').first();
  if (root.length === 0) return items;

  let currentDay = '';
  let currentPoints: string[] = [];

  const flush = () => {
    if (!currentDay) return;
    // отправляем текущие пункты как один item на день
    if (currentPoints.length > 0) {
      items.push({
        order: items.length + 1,
        title: currentDay,
        description: currentPoints.join(' | ').slice(0, 4000),
      });
    } else {
      items.push({
        order: items.length + 1,
        title: currentDay,
        description: '',
      });
    }
    currentPoints = [];
  };

  // обходим прямых потомков .tour_prog_content и ищем day-titles/h3
  root.find('*').each((_, el) => {
    const $el = $(el);
    if ($el.hasClass('tour_prog_day_tit')) {
      flush();
      currentDay = normaliseText($el.text()).slice(0, 120);
      return;
    }
    if (el.type === 'tag' && el.tagName === 'h3') {
      const t = normaliseText($el.text());
      if (t && t.length >= 3) currentPoints.push(t);
    }
  });
  flush();
  return items;
}

function extractServices(
  $: cheerio.CheerioAPI,
): Array<{ name: string; description: string }> {
  const services: Array<{ name: string; description: string }> = [];
  // .tour_include: включено + дополнительные блоки (в т.ч. оплачивается
  // отдельно). Заголовок секции в .tour_include_title.
  const seen = new Set<string>();
  $('.tour_include').each((_, el) => {
    const $el = $(el);
    const title =
      normaliseText($el.find('.tour_include_title').first().text()) ||
      'Услуги';
    // пункты обычно как <li>
    $el.find('.tour_include_content li').each((_i, li) => {
      const text = normaliseText($(li).text());
      if (text.length < 2) return;
      const key = `${title}:${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      services.push({
        name: `${title}: ${text.slice(0, 80)}`,
        description: text,
      });
    });
    // если <li> нет, берём весь текст как единый item
    if ($el.find('.tour_include_content li').length === 0) {
      const text = normaliseText($el.find('.tour_include_content').first().text());
      if (text.length >= 3) {
        const key = `${title}:${text.slice(0, 80)}`;
        if (!seen.has(key)) {
          seen.add(key);
          services.push({ name: title, description: text.slice(0, 2000) });
        }
      }
    }
  });
  return services;
}

function extractMeetingPoint($: cheerio.CheerioAPI): string {
  // .tour_place_content может содержать 2 точки сбора (СПб + Дыбенко по tz) —
  // собираем весь текст целиком.
  const raw = normaliseText($('.tour_place_content').first().text());
  return raw.slice(0, 600);
}

function extractImages($: cheerio.CheerioAPI, base: string): string[] {
  const urls = new Set<string>();
  $('.tour-gallery-horizontal a.tour-gallery__column, .tour-gallery-horizontal a.fancybox').each(
    (_, el) => {
      const href = $(el).attr('href');
      const abs = absoluteUrl(base, href);
      if (abs && /\.(jpe?g|png|webp)(\?|$)/i.test(abs)) urls.add(abs);
    },
  );
  // fallback: background-image внутри .tour-gallery__column
  if (urls.size === 0) {
    $('.tour-gallery-horizontal a').each((_, el) => {
      const style = $(el).attr('style') ?? '';
      const m = style.match(/url\(['"]?([^'")]+)['"]?\)/);
      if (!m?.[1]) return;
      const abs = absoluteUrl(base, m[1]);
      if (abs && /\.(jpe?g|png|webp)(\?|$)/i.test(abs)) urls.add(abs);
    });
  }
  return [...urls];
}

function extractAgeRestriction(bodyText: string): string | null {
  const m = bodyText.match(/(?:с|от)\s+(\d+)\s+лет/i);
  if (m?.[1]) return `${m[1]}+`;
  return null;
}

function extractScheduleDates(html: string): string[] {
  // Календарь JS-генерируется — в SSR обычно 0–1 дат. Берём всё, что найдём.
  const re = /\b(20\d{2}-\d{2}-\d{2})\b/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) seen.add(m[1]);
  }
  return [...seen].sort().slice(0, 50);
}

function extractDayCount($: cheerio.CheerioAPI): number {
  return $('.tour_prog_day_tit').length;
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
      file_path: `datasets/images/${image_id}`,
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

  const { short, full } = extractShortAndFullDescription($);
  if (full.length < MIN_FULL_DESCRIPTION) {
    warnings.push(
      `full_description короче ${MIN_FULL_DESCRIPTION} символов (${full.length})`,
    );
  }
  if (!short) warnings.push('пустой short_description');

  const programItems = extractProgramItems($);
  if (programItems.length === 0) warnings.push('пустой program_items');

  const services = extractServices($);
  const meeting = extractMeetingPoint($);
  const images = extractImages($, url);
  if (images.length === 0) warnings.push('изображения не найдены');
  const { cardImages, records } = buildImageEntries(cardId, images);

  const dayCount = extractDayCount($);
  const productType: 'tour' | 'excursion' = dayCount >= 2 ? 'tour' : 'excursion';
  const durationMinutes =
    dayCount > 0 ? dayCount * 24 * 60 : undefined;

  const pageText = normaliseText($('body').text());
  const ageRestriction = extractAgeRestriction(pageText);
  const dates = extractScheduleDates(html);

  const card: ProductCard = {
    id: cardId,
    product_type: productType,
    title,
    short_description: short,
    full_description: full,
    program_items: programItems,
    services,
    location: {
      address: '',
      route_comment: '',
      meeting_point_comment: meeting,
    },
    contacts_block: { public_comment: '' },
    schedule: { format: 'recurring' },
    images: cardImages,
    languages: ['ru'],
  };
  if (durationMinutes !== undefined) card.schedule.duration_minutes = durationMinutes;
  if (dates.length > 0) card.schedule.dates = dates;
  if (ageRestriction) card.age_restriction = ageRestriction;

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
  const limit = parseLimitArg(15);
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
        `[parse] ${cardId.slice(0, 60)}: product_type=${record.card.product_type}, ` +
          `program_items=${record.card.program_items.length}, ` +
          `services=${record.card.services.length}, ` +
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
