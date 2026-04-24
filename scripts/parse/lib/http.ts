// HTTP-клиент парсеров: вежливый fetch + дисковый HTML-кэш + robots.txt.
// Отдельный от LLM-provider-клиента (они совершенно разные по сценариям).
// TTL кэша 7 дней — позволяет итерировать парсер без сетевых запросов.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import robotsParser from 'robots-parser';

import { PoliteQueue } from './polite-queue.js';

const USER_AGENT =
  'LocaltripBench/1.0 (R&D; contact: lsergio2001@gmail.com)';
const ACCEPT_LANGUAGE = 'ru,en;q=0.5';
const FETCH_TIMEOUT_MS = 30_000;
const HTML_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_HOST_DELAY_MS = 2_000;
const BACKOFF_MS = [1_000, 3_000] as const;

type RobotsChecker = ReturnType<typeof robotsParser>;

export interface HttpClientOptions {
  source: string;
  datasetsDir: string;
  // Дополнительные cookie на хост. Нужен для сайтов, которые без них бросают
  // на SSO-bounce страницу (пример: afisha.ru + `SberIdFailed=1`).
  cookiesByHost?: Record<string, string>;
}

export interface FetchHtmlResult {
  url: string;
  status: number;
  html: string;
  fromCache: boolean;
  contentType: string;
}

export interface FetchBinaryResult {
  url: string;
  status: number;
  bytes: Uint8Array;
  contentType: string;
}

export class RobotsDisallowedError extends Error {
  constructor(
    readonly url: string,
    readonly userAgent: string,
  ) {
    super(`robots.txt disallows ${url} for ${userAgent}`);
    this.name = 'RobotsDisallowedError';
  }
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    body?: string,
  ) {
    super(`HTTP ${status} on ${url}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
  }
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status >= 500;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      err.name === 'AbortError'
    );
  }
  return false;
}

export class HttpClient {
  private readonly queue: PoliteQueue;
  private readonly robotsByHost = new Map<string, RobotsChecker | null>();
  private readonly robotsInflight = new Map<string, Promise<RobotsChecker | null>>();
  private readonly binaryBypassLogged = new Set<string>();
  private readonly cacheDir: string;
  private readonly skippedFile: string;

  constructor(private readonly opts: HttpClientOptions) {
    this.queue = new PoliteQueue(DEFAULT_HOST_DELAY_MS);
    this.cacheDir = join(opts.datasetsDir, opts.source, 'html-cache');
    this.skippedFile = join(opts.datasetsDir, opts.source, 'skipped.txt');
  }

  private cachePaths(url: string): { html: string; headers: string } {
    const hash = sha1(url);
    return {
      html: join(this.cacheDir, `${hash}.html`),
      headers: join(this.cacheDir, `${hash}.headers.json`),
    };
  }

  private async readCache(
    url: string,
  ): Promise<{ html: string; headers: Record<string, string> } | null> {
    const paths = this.cachePaths(url);
    if (!existsSync(paths.html) || !existsSync(paths.headers)) {
      return null;
    }
    const st = await stat(paths.html);
    if (Date.now() - st.mtimeMs > HTML_CACHE_TTL_MS) {
      return null;
    }
    const [html, headersRaw] = await Promise.all([
      readFile(paths.html, 'utf8'),
      readFile(paths.headers, 'utf8'),
    ]);
    return { html, headers: JSON.parse(headersRaw) as Record<string, string> };
  }

  private async writeCache(
    url: string,
    html: string,
    headers: Record<string, string>,
  ): Promise<void> {
    const paths = this.cachePaths(url);
    await mkdir(dirname(paths.html), { recursive: true });
    await Promise.all([
      writeFile(paths.html, html, 'utf8'),
      writeFile(paths.headers, JSON.stringify(headers, null, 2), 'utf8'),
    ]);
  }

  private async loadRobots(host: string): Promise<RobotsChecker | null> {
    if (this.robotsByHost.has(host)) {
      return this.robotsByHost.get(host) ?? null;
    }
    const inflight = this.robotsInflight.get(host);
    if (inflight) return inflight;

    const promise = (async (): Promise<RobotsChecker | null> => {
      const robotsUrl = `https://${host}/robots.txt`;
      try {
        const result = await this.queue.enqueue(robotsUrl, async () => {
          return await this.rawFetch(robotsUrl, 'text');
        });
        if (result.status === 200 && typeof result.body === 'string') {
          const parser = robotsParser(robotsUrl, result.body);
          // robots-parser учитывает Crawl-delay: подхватываем
          const delay = parser.getCrawlDelay(USER_AGENT);
          if (typeof delay === 'number' && delay > 0) {
            this.queue.setHostDelay(host, Math.max(delay * 1000, DEFAULT_HOST_DELAY_MS));
            console.log(
              `[robots] ${host}: Crawl-delay ${delay}s применён`,
            );
          }
          this.robotsByHost.set(host, parser);
          return parser;
        }
        // 404 / другие коды — считаем, что правил нет
        this.robotsByHost.set(host, null);
        return null;
      } catch (err) {
        console.warn(
          `[robots] ${host}: не удалось загрузить robots.txt (${(err as Error).message}), продолжаем без него`,
        );
        this.robotsByHost.set(host, null);
        return null;
      } finally {
        this.robotsInflight.delete(host);
      }
    })();

    this.robotsInflight.set(host, promise);
    return promise;
  }

  private async checkRobots(url: string): Promise<void> {
    const host = new URL(url).host;
    const parser = await this.loadRobots(host);
    if (!parser) return;
    if (parser.isDisallowed(url, USER_AGENT) === true) {
      await mkdir(dirname(this.skippedFile), { recursive: true });
      const line = `${url}\t${new Date().toISOString()}\trobots.txt disallow\n`;
      await writeFile(this.skippedFile, line, { flag: 'a' });
      throw new RobotsDisallowedError(url, USER_AGENT);
    }
  }

  private async rawFetch(
    url: string,
    mode: 'text',
  ): Promise<{ status: number; body: string; headers: Record<string, string> }>;
  private async rawFetch(
    url: string,
    mode: 'binary',
  ): Promise<{ status: number; body: Uint8Array; headers: Record<string, string> }>;
  private async rawFetch(
    url: string,
    mode: 'text' | 'binary',
  ): Promise<{
    status: number;
    body: string | Uint8Array;
    headers: Record<string, string>;
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headersOut: Record<string, string> = {
        'User-Agent': USER_AGENT,
        'Accept-Language': ACCEPT_LANGUAGE,
        Accept:
          mode === 'text'
            ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            : 'image/*,*/*;q=0.8',
      };
      const host = (() => {
        try {
          return new URL(url).host;
        } catch {
          return '';
        }
      })();
      const cookie = this.opts.cookiesByHost?.[host];
      if (cookie) headersOut.Cookie = cookie;
      const res = await fetch(url, {
        headers: headersOut,
        signal: controller.signal,
        redirect: 'follow',
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      if (!res.ok && res.status !== 404) {
        const snippet = mode === 'text' ? await res.text().catch(() => '') : '';
        throw new HttpError(url, res.status, snippet);
      }
      const body =
        mode === 'text'
          ? await res.text()
          : new Uint8Array(await res.arrayBuffer());
      return { status: res.status, body, headers };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async withRetry<T>(url: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (err instanceof RobotsDisallowedError) throw err;
        if (err instanceof HttpError && err.status < 500) throw err;
        if (!isRetryableNetworkError(err)) throw err;
        if (attempt < BACKOFF_MS.length) {
          const wait = BACKOFF_MS[attempt] ?? 1000;
          console.warn(
            `[http] ${url}: ${(err as Error).message}, ретрай через ${wait}ms`,
          );
          await sleep(wait);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('retry exhausted');
  }

  async fetchHtml(url: string): Promise<FetchHtmlResult> {
    const cached = await this.readCache(url);
    if (cached) {
      return {
        url,
        status: 200,
        html: cached.html,
        fromCache: true,
        contentType: cached.headers['content-type'] ?? 'text/html',
      };
    }

    await this.checkRobots(url);

    const result = await this.queue.enqueue(url, async () =>
      this.withRetry(url, async () => this.rawFetch(url, 'text')),
    );

    if (result.status === 200) {
      await this.writeCache(url, result.body, result.headers);
    }

    console.log(
      `[http] GET ${url} → ${result.status} (${result.body.length} B, cache miss)`,
    );
    return {
      url,
      status: result.status,
      html: result.body,
      fromCache: false,
      contentType: result.headers['content-type'] ?? 'text/html',
    };
  }

  async fetchBinary(url: string): Promise<FetchBinaryResult> {
    // Бинарные ассеты (картинки из CDN) robots.txt-check не проходят —
    // многие CDN (например, selcdn.net) отдают Disallow: / для всех ботов,
    // что блокирует скачивание легитимных картинок карточек. Логируем обход
    // один раз на хост для прозрачности.
    const host = new URL(url).host;
    if (!this.binaryBypassLogged.has(host)) {
      console.log(
        `[http] CDN-skip bypass: ${host} robots.txt ignored for binary fetch`,
      );
      this.binaryBypassLogged.add(host);
    }
    const result = await this.queue.enqueue(url, async () =>
      this.withRetry(url, async () => this.rawFetch(url, 'binary')),
    );
    return {
      url,
      status: result.status,
      bytes: result.body,
      contentType: result.headers['content-type'] ?? 'application/octet-stream',
    };
  }
}
