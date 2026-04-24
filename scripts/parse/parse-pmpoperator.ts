// Парсер pmpoperator.ru. Читает URL из datasets/pmpoperator/urls.txt,
// для каждого парсит карточку тура и пишет JSONL.
//
// JSON-LD на карточках отсутствует — идём по DOM. Контент лежит в
// .tour-info-section, внутри каждой такой секции h2 определяет тип, а
// .html-content содержит собственно данные. Программа тура собирается
// из пар .tour-day-label + .tour-day-info.
//
// product_type: если в бейдже "N дней" N≥2 или "Двухдневный"/"Многодневный" —
// tour, иначе excursion.

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

const SOURCE = 'pmpoperator';
const PARSER_VERSION = 'v1';
const CARD_URL_RE =
  /^https?:\/\/(?:www\.)?pmpoperator\.ru\/tours\/([a-z0-9-]+)\/?$/i;
const MAX_IMAGES_PER_CARD = 4;
const MIN_FULL_DESCRIPTION = 100;

function parseUrl(url: string): { cardId: string; slug: string } | null {
  const m = url.match(CARD_URL_RE);
  if (!m?.[1]) return null;
  return { cardId: `pmpoperator_${m[1]}`, slug: m[1] };
}

// h2 → название секции. Ищем секцию .tour-info-section с нужным h2.
function sectionByHeading(
  $: cheerio.CheerioAPI,
  headingRe: RegExp,
): cheerio.Cheerio<never> | null {
  let result: cheerio.Cheerio<never> | null = null;
  $('.tour-info-section').each((_, el) => {
    const h2 = $(el).find('h2').first().text().trim();
    if (headingRe.test(h2) && result === null) {
      result = $(el) as unknown as cheerio.Cheerio<never>;
    }
  });
  return result;
}

function extractFullDescription(
  $: cheerio.CheerioAPI,
  programItems: ReadonlyArray<{ title: string; description: string }>,
): string {
  const section = sectionByHeading($, /описание\s+тура/i);
  const fromSection = section
    ? normaliseText(section.find('.html-content').first().text())
    : '';
  if (fromSection.length >= MIN_FULL_DESCRIPTION) return fromSection;
  // Часть авторских туров pmpoperator оставляет «Описание тура» пустым
  // и заполняет только «Программа тура». Чтобы карточка не выпадала
  // из бенчмарка, склеиваем дни программы — это и есть фактическое
  // описание продукта.
  const fromProgram = programItems
    .map((p) => `${p.title}. ${p.description}`.trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
  return fromSection.length >= fromProgram.length ? fromSection : fromProgram;
}

function extractProgramItems(
  $: cheerio.CheerioAPI,
): Array<{ order: number; title: string; description: string }> {
  const items: Array<{ order: number; title: string; description: string }> = [];
  // tour-day-label + сразу следующий .tour-day-info
  $('.tour-day-label').each((_, el) => {
    const label = normaliseText($(el).text());
    if (!label) return;
    const info = $(el).nextAll('.tour-day-info').first();
    const description = info.length > 0 ? normaliseText(info.text()) : '';
    items.push({
      order: items.length + 1,
      title: label.slice(0, 120),
      description,
    });
  });
  return items;
}

function extractServicesFromSection(
  $: cheerio.CheerioAPI,
  headingRe: RegExp,
  groupLabel: string,
): Array<{ name: string; description: string }> {
  const section = sectionByHeading($, headingRe);
  if (!section) return [];
  const out: Array<{ name: string; description: string }> = [];
  section.find('.html-content li').each((_, li) => {
    const text = normaliseText($(li).text());
    if (text.length < 2) return;
    out.push({
      name: `${groupLabel}: ${text.slice(0, 80)}`,
      description: text,
    });
  });
  return out;
}

// Парсит бейджи ".tour-badge--text".
function extractBadges($: cheerio.CheerioAPI): string[] {
  const badges: string[] = [];
  $('.tour-badge--text').each((_, el) => {
    const t = normaliseText($(el).text());
    if (t) badges.push(t);
  });
  return badges;
}

function decideProductType(badges: string[]): 'tour' | 'excursion' {
  for (const b of badges) {
    const m = b.match(/(\d+)\s*дн(?:я|ей|ь)?/i);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (n >= 2) return 'tour';
      if (n === 1) return 'excursion';
    }
    if (/двухдневный|многодневный/i.test(b)) return 'tour';
    if (/однодневный/i.test(b)) return 'excursion';
  }
  return 'excursion';
}

function extractDurationMinutes(badges: string[]): number | null {
  for (const b of badges) {
    const m = b.match(/(\d+)\s*дн(?:я|ей|ь)?/i);
    if (m?.[1]) {
      return Number(m[1]) * 24 * 60;
    }
  }
  return null;
}

function extractAgeRestriction(badges: string[]): string | null {
  for (const b of badges) {
    // "с 5 лет", "с 11 лет"
    const m = b.match(/с\s+(\d+)\s+лет/i);
    if (m?.[1]) return `${m[1]}+`;
  }
  return null;
}

function extractRouteInfo($: cheerio.CheerioAPI): string {
  return normaliseText($('.tour-route .route-info').first().text());
}

function extractShortDescription(
  $: cheerio.CheerioAPI,
  fullDesc: string,
): string {
  const metaDesc =
    $('meta[name="description"]').attr('content') ??
    $('meta[property="og:description"]').attr('content') ??
    '';
  if (metaDesc.trim()) return normaliseText(metaDesc);
  // Fallback: первое содержательное предложение full_description.
  // Пропускаем мусорные «День 1.», «Программа.» и т.п.
  const sentences = fullDesc.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (s.length >= 40) return s.slice(0, 300);
  }
  return sentences[0]?.slice(0, 300) ?? '';
}

// Картинки: из .tour-slider img (полноразмерные) + из инлайн background-image
// в swiper-thumbs (на случай, если в слайдере ничего нет).
function extractImages($: cheerio.CheerioAPI, base: string): string[] {
  const urls = new Set<string>();
  $('.tour-slider img, .tour-slider-thumbs img').each((_, el) => {
    const src = $(el).attr('src') ?? $(el).attr('data-src') ?? '';
    const abs = absoluteUrl(base, src);
    if (abs && /\.(jpe?g|png|webp)(\?|$)/i.test(abs)) urls.add(abs);
  });
  // fallback: background-image в inline style
  $('[style*="background-image"]').each((_, el) => {
    const style = $(el).attr('style') ?? '';
    const m = style.match(/url\(['"]?([^'")]+)['"]?\)/);
    if (!m?.[1]) return;
    const abs = absoluteUrl(base, m[1]);
    if (!abs) return;
    // отсекаем thumb_* — у pmpoperator полноразмерная версия лежит в соседнем файле без thumb_
    const fullSize = abs.replace(/\/thumb_/g, '/');
    if (/\.(jpe?g|png|webp)(\?|$)/i.test(fullSize)) urls.add(fullSize);
  });
  return [...urls];
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

  // program_items нужны раньше full_description: для карточек, у которых
  // секция «Описание тура» пустая, описание собирается из дней программы.
  const programItems = extractProgramItems($);
  if (programItems.length === 0) warnings.push('пустой program_items');

  const fullDesc = extractFullDescription($, programItems);
  if (fullDesc.length < MIN_FULL_DESCRIPTION) {
    warnings.push(
      `full_description короче ${MIN_FULL_DESCRIPTION} символов (${fullDesc.length})`,
    );
  }

  const shortDesc = extractShortDescription($, fullDesc);
  if (!shortDesc) warnings.push('пустой short_description');

  const services = [
    ...extractServicesFromSection(
      $,
      /входит\s+в\s+стоимость|включ[её]но/i,
      'Входит в стоимость',
    ),
    ...extractServicesFromSection(
      $,
      /оплачивается\s+отдельно|не\s+входит/i,
      'Оплачивается отдельно',
    ),
  ];

  const badges = extractBadges($);
  const productType = decideProductType(badges);
  const durationMinutes = extractDurationMinutes(badges);
  const ageRestriction = extractAgeRestriction(badges);
  const routeInfo = extractRouteInfo($);

  const images = extractImages($, url);
  if (images.length === 0) warnings.push('изображения не найдены');
  const { cardImages, records } = buildImageEntries(cardId, images);

  const card: ProductCard = {
    id: cardId,
    product_type: productType,
    title,
    short_description: shortDesc,
    full_description: fullDesc,
    program_items: programItems,
    services,
    location: {
      address: '',
      route_comment: routeInfo,
      meeting_point_comment: '',
    },
    contacts_block: { public_comment: '' },
    schedule: { format: 'recurring' },
    images: cardImages,
  };
  if (durationMinutes !== null) card.schedule.duration_minutes = durationMinutes;
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
        `[parse] ${cardId}: title="${record.card.title.slice(0, 60)}", ` +
          `product_type=${record.card.product_type}, ` +
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
