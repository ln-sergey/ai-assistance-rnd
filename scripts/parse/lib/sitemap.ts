// Рекурсивный парсер sitemap.xml / sitemap_index.xml.
// Возвращает плоский список URL из всех дочерних sitemap'ов.
// Ограничение глубины рекурсии — защита от циклов.

import { XMLParser } from 'fast-xml-parser';

import type { HttpClient } from './http.js';

interface SitemapUrl {
  loc: string;
  lastmod?: string;
}

interface ParsedUrlset {
  urlset?: { url?: RawUrlEntry | RawUrlEntry[] };
  sitemapindex?: { sitemap?: RawUrlEntry | RawUrlEntry[] };
}

interface RawUrlEntry {
  loc?: string;
  lastmod?: string;
}

const MAX_DEPTH = 4;

function coerceArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function normaliseEntry(raw: RawUrlEntry): SitemapUrl | null {
  if (!raw.loc) return null;
  const entry: SitemapUrl = { loc: raw.loc.trim() };
  if (raw.lastmod) entry.lastmod = raw.lastmod;
  return entry;
}

export async function fetchSitemapUrls(
  http: HttpClient,
  sitemapUrl: string,
  depth = 0,
): Promise<SitemapUrl[]> {
  if (depth > MAX_DEPTH) {
    console.warn(`[sitemap] глубина > ${MAX_DEPTH}, пропуск ${sitemapUrl}`);
    return [];
  }

  const { html, status } = await http.fetchHtml(sitemapUrl);
  if (status !== 200) {
    console.warn(`[sitemap] ${sitemapUrl} → HTTP ${status}, пропуск`);
    return [];
  }

  const parser = new XMLParser({
    ignoreAttributes: true,
    trimValues: true,
    parseTagValue: false,
  });
  const parsed = parser.parse(html) as ParsedUrlset;

  if (parsed.sitemapindex?.sitemap) {
    const children = coerceArray(parsed.sitemapindex.sitemap);
    const results: SitemapUrl[] = [];
    for (const child of children) {
      if (!child.loc) continue;
      const nested = await fetchSitemapUrls(http, child.loc, depth + 1);
      results.push(...nested);
    }
    return results;
  }

  if (parsed.urlset?.url) {
    const urls = coerceArray(parsed.urlset.url);
    const entries: SitemapUrl[] = [];
    for (const u of urls) {
      const entry = normaliseEntry(u);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  console.warn(`[sitemap] ${sitemapUrl}: неизвестный формат, пропуск`);
  return [];
}

export type { SitemapUrl };
