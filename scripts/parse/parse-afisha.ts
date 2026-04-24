// Парсер afisha.ru. Карточки событий: concert / performance / festival.
//
// Сайт редиректит все запросы без SberID-cookie на SSO-bounce (~1.5 KB HTML
// со скриптом редиректа). Ставим Cookie: SberIdFailed=1 — тот самый, что сайт
// сам выставляет после неудачного ping — и получаем нормальный SSR. Хак
// задокументирован в harvest-afisha.ts и реализован через cookiesByHost
// в HttpClient.
//
// Стратегия извлечения: JSON-LD (schema.org/Event подтипы) для
// name/description/image/жанра + DOM по data-test-атрибутам для возраста
// и длинного описания (OBJECT-DESCRIPTION-CONTENT → RESTRICT-TEXT).
// Классы хешированы (CSS-modules) — по ним не ищем.
//
// Ограничения:
//  - Расписание (даты, площадки) в SSR отсутствует — подтягивается по API
//    на клиенте. schedule.format: 'recurring', dates: пустой.
//  - program_items формируем из performer/director/actor, если есть в JSON-LD.
//  - services всегда пустой: у событий их нет по продуктовой логике.

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cheerio from 'cheerio';

import { HttpClient } from './lib/http.js';
import { metaContent, normaliseText } from './lib/html.js';
import { makeImageId } from './lib/image-id.js';
import { parseLimitArg, readJsonlIds, readUrlsFile } from './lib/jsonl.js';
import type { CardRecord, ImageRecord, ProductCard } from './lib/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');

const SOURCE = 'afisha';
const PARSER_VERSION = 'v1';
const CARD_URL_RE =
  /^https?:\/\/(?:www\.)?afisha\.ru\/(concert|performance|festival)\/([a-z0-9-]+-\d+)\/?$/i;
const MAX_IMAGES_PER_CARD = 4;
const MIN_FULL_DESCRIPTION = 60; // у событий описания короткие, 100 редко

const AFISHA_COOKIES = {
  'www.afisha.ru': 'SberIdFailed=1',
  'afisha.ru': 'SberIdFailed=1',
};

interface ParsedUrl {
  kind: 'concert' | 'performance' | 'festival';
  slug: string;
  cardId: string;
}

function parseUrl(url: string): ParsedUrl | null {
  const m = url.match(CARD_URL_RE);
  if (!m?.[1] || !m?.[2]) return null;
  const kind = m[1].toLowerCase() as ParsedUrl['kind'];
  const slug = m[2];
  return { kind, slug, cardId: `afisha_${kind}_${slug}` };
}

interface JsonLdNode {
  '@type'?: string;
  name?: string;
  description?: string;
  image?: string | { url?: string };
  alternateName?: string;
  performer?: Array<{ name?: string; '@type'?: string }>;
  director?: Array<{ name?: string; '@type'?: string }>;
  actor?: Array<{ name?: string; '@type'?: string }>;
  eventStatus?: string;
}

// afisha кладёт в JSON-LD один граф с BreadcrumbList + главным событием.
// Ищем ноду с подтипом *Event.
function findEventNode(html: string): JsonLdNode | null {
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const body = m[1];
      if (!body) continue;
      const raw = JSON.parse(body) as unknown;
      const nodes: unknown[] = [];
      if (raw && typeof raw === 'object' && '@graph' in raw) {
        const graph = (raw as { '@graph': unknown[] })['@graph'];
        if (Array.isArray(graph)) nodes.push(...graph);
      } else {
        nodes.push(raw);
      }
      for (const node of nodes) {
        if (node && typeof node === 'object' && '@type' in node) {
          const t = (node as { '@type': unknown })['@type'];
          if (typeof t === 'string' && t.endsWith('Event')) {
            return node as JsonLdNode;
          }
        }
      }
    } catch {
      // битый JSON — пропускаем блок
    }
  }
  return null;
}

function extractTitle($: cheerio.CheerioAPI, jsonLd: JsonLdNode | null): string {
  if (jsonLd?.name) return normaliseText(jsonLd.name);
  const fromDom = $('[data-test="ITEM-NAME"]').first().text();
  if (fromDom) return normaliseText(fromDom);
  return normaliseText($('h1').first().text());
}

// Длинное описание: сначала JSON-LD (там очищенный текст), затем
// RESTRICT-TEXT внутри OBJECT-DESCRIPTION-CONTENT. На событиях с пустым
// блоком описание действительно отсутствует — пишем пустую строку.
function extractFullDescription(
  $: cheerio.CheerioAPI,
  jsonLd: JsonLdNode | null,
): string {
  const chunks: string[] = [];
  if (jsonLd?.description) chunks.push(normaliseText(jsonLd.description));

  $('[data-test="OBJECT-DESCRIPTION-CONTENT"]').each((_, el) => {
    $(el)
      .find('[data-test="RESTRICT-TEXT"]')
      .each((_i, inner) => {
        const text = normaliseText($(inner).text());
        if (text.length >= 20) chunks.push(text);
      });
  });

  // дедуп: если JSON-LD description = начало RESTRICT-TEXT, оставляем длинный
  chunks.sort((a, b) => b.length - a.length);
  return chunks[0] ?? '';
}

function extractShortDescription(
  $: cheerio.CheerioAPI,
  jsonLd: JsonLdNode | null,
  fullDesc: string,
): string {
  const meta =
    metaContent($, 'og:description') || metaContent($, 'description');
  if (meta && !/^Концерт\s|^Спектакль\s|^Фестиваль\s/.test(meta)) {
    // og:description часто мусорный «Концерт <Название>» — если так, берём JSON-LD
    return normaliseText(meta);
  }
  if (jsonLd?.description) {
    const txt = normaliseText(jsonLd.description);
    // первое предложение
    const first = txt.split(/(?<=[.!?])\s+/)[0];
    return first && first.length >= 20 ? first : txt;
  }
  if (fullDesc) {
    const first = fullDesc.split(/(?<=[.!?])\s+/)[0];
    return first && first.length >= 20 ? first : fullDesc.slice(0, 200);
  }
  return meta;
}

// Возраст: META-FIELD с aria-label="Возраст" → строка вида "18+".
function extractAgeRestriction($: cheerio.CheerioAPI): string | null {
  let age: string | null = null;
  $('[data-test="META-FIELD"]').each((_, el) => {
    const label = $(el).attr('aria-label') ?? '';
    if (!/Возраст/i.test(label)) return;
    const value = normaliseText(
      $(el).find('[data-test="META-FIELD-VALUE"]').text(),
    );
    if (/^\d+\+$/.test(value)) age = value;
  });
  return age;
}

// Жанры (Драматический, Юмор, Стендап, …) → categories-like. В схеме карточки
// отдельного поля нет, возвращаем для логирования и в full_description не
// пихаем — тип уже закодирован в URL.
function extractGenres($: cheerio.CheerioAPI): string[] {
  const genres: string[] = [];
  $('[data-test="META-FIELD"]').each((_, el) => {
    const label = $(el).attr('aria-label') ?? '';
    if (!/Жанры?/i.test(label)) return;
    $(el)
      .find('[data-test="META-FIELD-VALUE"] a')
      .each((_i, a) => {
        const text = normaliseText($(a).text());
        if (text) genres.push(text);
      });
    if (genres.length === 0) {
      const text = normaliseText(
        $(el).find('[data-test="META-FIELD-VALUE"]').text(),
      );
      for (const part of text.split(/[,;]/)) {
        const p = part.trim();
        if (p) genres.push(p);
      }
    }
  });
  return [...new Set(genres)];
}

// program_items: для спектакля — режиссёр; для концерта — performer/actor.
// Ограничены SSR JSON-LD: у многих событий эти массивы пустые.
function extractProgramItems(
  jsonLd: JsonLdNode | null,
): Array<{ order: number; title: string; description: string }> {
  if (!jsonLd) return [];
  const items: Array<{ order: number; title: string; description: string }> = [];
  let order = 1;
  const pushPerson = (role: string, list: JsonLdNode['performer']): void => {
    if (!list) return;
    for (const p of list) {
      const name = normaliseText(p?.name ?? '');
      if (!name) continue;
      items.push({ order: order++, title: `${role}: ${name}`, description: name });
    }
  };
  pushPerson('Режиссёр', jsonLd.director);
  pushPerson('Исполнитель', jsonLd.performer);
  pushPerson('Актёр', jsonLd.actor);
  return items;
}

// Изображения: главный постер — из COVER (img внутри data-test="COVER" >
// picture/img). og:image часто проксирован через img*.rl0.ru (CDN-resize);
// берём src оригинала с s3.afisha.ru, иначе og:image.
function extractImages(
  $: cheerio.CheerioAPI,
  jsonLd: JsonLdNode | null,
): string[] {
  const out = new Set<string>();
  const pushS3 = (url: string | undefined | null): void => {
    if (!url) return;
    if (/^https?:\/\/s3\.afisha\.ru\//.test(url)) out.add(url);
  };

  // JSON-LD image
  if (jsonLd?.image) {
    const raw =
      typeof jsonLd.image === 'string' ? jsonLd.image : jsonLd.image.url;
    if (raw && raw.startsWith('http')) pushS3(raw);
  }

  // COVER → первый <img> с s3 src
  $('[data-test="COVER"] img').each((_, el) => {
    pushS3($(el).attr('src'));
  });
  // fallback: первый data-test="IMAGE"
  $('[data-test="IMAGE"]')
    .slice(0, 1)
    .each((_, el) => {
      pushS3($(el).attr('src'));
    });

  // og:image — последний fallback, если s3 не нашли. Здесь допускаем
  // rl0.ru, но обрезаем путь до s3-оригинала, когда URL содержит /s3.afisha.ru/.
  const og = metaContent($, 'og:image');
  if (out.size === 0 && og) {
    const s3Match = og.match(/https?:\/\/s3\.afisha\.ru\/[^"'\s]+/);
    if (s3Match) out.add(s3Match[0]);
    else if (og.startsWith('http')) out.add(og);
  }

  return [...out];
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
  parsed: ParsedUrl,
  html: string,
): { record: CardRecord; images: ImageRecord[] } {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const jsonLd = findEventNode(html);

  const title = extractTitle($, jsonLd);
  if (!title) warnings.push('пустой title');

  const fullDesc = extractFullDescription($, jsonLd);
  if (fullDesc.length < MIN_FULL_DESCRIPTION) {
    warnings.push(
      `full_description короче ${MIN_FULL_DESCRIPTION} символов (${fullDesc.length})`,
    );
  }

  const shortDesc = extractShortDescription($, jsonLd, fullDesc);
  if (!shortDesc) warnings.push('пустой short_description');

  const programItems = extractProgramItems(jsonLd);
  const ageRestriction = extractAgeRestriction($);
  const genres = extractGenres($);
  const imageUrls = extractImages($, jsonLd);
  if (imageUrls.length === 0) warnings.push('изображения не найдены');

  const { cardImages, records } = buildImageEntries(parsed.cardId, imageUrls);

  const card: ProductCard = {
    id: parsed.cardId,
    product_type: 'event',
    title,
    short_description: shortDesc,
    full_description: fullDesc,
    program_items: programItems,
    services: [],
    location: {
      address: '',
      route_comment: '',
      meeting_point_comment: '',
    },
    contacts_block: { public_comment: '' },
    schedule: { format: 'recurring' },
    images: cardImages,
    age_restriction: ageRestriction,
    languages: ['ru'],
  };

  const record: CardRecord = {
    card,
    _meta: {
      source_site: SOURCE,
      source_url: url,
      fetched_at: new Date().toISOString(),
      parser_version: PARSER_VERSION,
      json_ld_found: jsonLd !== null,
      warnings: [
        ...warnings,
        ...(genres.length > 0 ? [`genres: ${genres.join(', ')}`] : []),
      ],
    },
  };
  return { record, images: records };
}

async function main(): Promise<void> {
  const limit = parseLimitArg(10);
  const urlsPath = join(DATASETS_DIR, SOURCE, 'urls.txt');
  if (!existsSync(urlsPath)) {
    console.error(`[parse] нет файла ${urlsPath}. Запусти harvest:${SOURCE}.`);
    process.exit(2);
  }
  const allUrls = await readUrlsFile(urlsPath);
  const http = new HttpClient({
    source: SOURCE,
    datasetsDir: DATASETS_DIR,
    cookiesByHost: AFISHA_COOKIES,
  });

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
    if (knownCardIds.has(parsed.cardId)) {
      console.log(`[parse] card уже есть (${parsed.cardId}), пропуск`);
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
      const { record, images } = buildCard(url, parsed, fetched.html);
      await appendFile(cardsPath, JSON.stringify(record) + '\n', 'utf8');
      knownCardIds.add(parsed.cardId);
      for (const img of images) {
        if (knownImageIds.has(img.image_id)) continue;
        await appendFile(imagesPath, JSON.stringify(img) + '\n', 'utf8');
        knownImageIds.add(img.image_id);
      }
      wrote++;
      console.log(
        `[parse] ${parsed.cardId}: title="${record.card.title.slice(0, 60)}", ` +
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
