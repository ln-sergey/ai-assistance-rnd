// Хелперы над cheerio: нормализация текста, абсолютизация URL,
// сбор изображений из галереи.

import type { CheerioAPI } from 'cheerio';

export function normaliseText(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw
    .replace(/\u00A0/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function absoluteUrl(base: string, href: string | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export function metaContent($: CheerioAPI, name: string): string {
  const byName = $(`meta[name="${name}"]`).attr('content');
  if (byName) return normaliseText(byName);
  const byProp = $(`meta[property="${name}"]`).attr('content');
  return normaliseText(byProp);
}

export function extractImageUrls(
  $: CheerioAPI,
  scopeSelector: string,
  base: string,
): string[] {
  const urls = new Set<string>();
  $(scopeSelector)
    .find('img')
    .each((_, el) => {
      const $img = $(el);
      const candidates = [
        $img.attr('src'),
        $img.attr('data-src'),
        $img.attr('data-original'),
        $img.attr('data-lazy'),
      ];
      const srcset = $img.attr('srcset') ?? $img.attr('data-srcset');
      if (srcset) {
        // формат "url 1x, url 2x" — берём первый url
        const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
        if (first) candidates.push(first);
      }
      for (const c of candidates) {
        const abs = absoluteUrl(base, c ?? undefined);
        if (abs && /^https?:\/\//.test(abs)) {
          urls.add(abs);
        }
      }
    });
  return [...urls];
}

export function parseDurationMinutes(raw: string): number | null {
  // "3 часа", "1 час 30 минут", "45 мин", "2.5 часа", "90 минут"
  const norm = raw.toLowerCase().replace(',', '.');
  let minutes = 0;
  const hoursMatch = norm.match(/(\d+(?:\.\d+)?)\s*(?:час|ч)/);
  if (hoursMatch?.[1]) {
    minutes += Math.round(Number(hoursMatch[1]) * 60);
  }
  const minsMatch = norm.match(/(\d+)\s*(?:минут|мин)/);
  if (minsMatch?.[1]) {
    minutes += Number(minsMatch[1]);
  }
  const daysMatch = norm.match(/(\d+)\s*(?:дн|день|дня|дней|суток)/);
  if (daysMatch?.[1]) {
    minutes += Number(daysMatch[1]) * 24 * 60;
  }
  return minutes > 0 ? minutes : null;
}

export function parseGroupSize(raw: string): { min?: number; max?: number } | null {
  // "до 50 человек", "до 15", "группа до N", "от 2 до 8"
  const norm = raw.toLowerCase();
  const range = norm.match(/от\s+(\d+)\s+до\s+(\d+)/);
  if (range?.[1] && range?.[2]) {
    return { min: Number(range[1]), max: Number(range[2]) };
  }
  const maxOnly = norm.match(/до\s+(\d+)/);
  if (maxOnly?.[1]) {
    return { max: Number(maxOnly[1]) };
  }
  return null;
}
