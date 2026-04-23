// GigaChat custom provider для Promptfoo.
//
// Что внутри:
//   * GigaChatOAuthClient — single-flight получение access_token с TTL-кэшем.
//     Токен живёт 30 минут, обновляем за 2 минуты до истечения. Параллельные
//     вызовы getAccessToken() во время refresh ждут один и тот же промис.
//   * GigaChatClient — /chat/completions + /files (upload картинок). Retry
//     на 429/5xx и сетевых ошибках вынесен в _shared/retry.ts.
//   * DiskFileIdCache — sha256(bytes) → file_id с TTL 24ч в `.cache/`.
//   * GigaChatProvider — default export, реализующий Promptfoo ApiProvider.
//     Принимает промпт в виде строки или OpenAI-совместимого JSON. Если в
//     content есть image_url с data-URL, провайдер загружает картинку в
//     /files и кладёт file_id в messages[i].attachments — inline base64
//     GigaChat не поддерживает.
//   * GIGACHAT_MOCK=1 — короткое замыкание для локальной разработки и CI
//     без ключей: callApi возвращает детерминированную фикстуру.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { resolvePricingByTable, computePer1kCost } from './_shared/cost.js';
import {
  parseChatPrompt,
  type ChatRole,
  type ParsedPrompt as SharedParsedPrompt,
} from './_shared/parse-prompt.js';
import {
  requestWithRetry as sharedRequestWithRetry,
  computeBackoff,
  isRetryableNetworkError,
  parseRetryAfter,
  safeReadText,
} from './_shared/retry.js';
import type {
  PerTokenPricing,
  PricingSource,
  PromptfooProviderResponse,
  ResolvedPricing,
} from './_shared/types.js';

// Re-export утилит, которые исторически импортировались из этого модуля —
// чтобы тесты и внешний код не пришлось ломать.
export { computeBackoff, isRetryableNetworkError };

// ==========================================================================
// Типы запроса/ответа GigaChat
// ==========================================================================

export type GigaChatRole = ChatRole;

export interface GigaChatMessage {
  role: GigaChatRole;
  content: string;
  attachments?: string[];
}

export interface GigaChatCompletionPayload {
  model: string;
  messages: GigaChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  repetition_penalty?: number;
  stream?: false;
}

export interface GigaChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  precached_prompt_tokens?: number;
}

export interface GigaChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string };
    index: number;
    finish_reason: string;
  }>;
  usage: GigaChatUsage;
  model: string;
  created: number;
  object: string;
}

// ==========================================================================
// Конфигурация: окружение + параметры провайдера
// ==========================================================================

export interface GigaChatEnvConfig {
  authKey: string;
  scope: string;
  oauthUrl: string;
  apiUrl: string;
}

export type GigaChatPricing = PerTokenPricing;

export interface GigaChatProviderConfig {
  /** ОБЯЗАТЕЛЬНОЕ поле. Дефолта нет намеренно — см. README/CLAUDE.md. */
  model: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  repetition_penalty?: number;
  /** Полный или частичный override тарифа для модели. */
  pricing?: Partial<GigaChatPricing>;
  /** Сколько раз повторить на retryable-ошибках. По умолчанию 4. */
  maxRetries?: number;
  /** Базовая задержка backoff, мс. По умолчанию 1000. */
  retryBaseMs?: number;
  /** Таймаут одного HTTP-запроса, мс. По умолчанию 60 000. */
  timeoutMs?: number;
}

// ==========================================================================
// Per-model pricing table
// ==========================================================================

/**
 * Ставки в рублях за 1000 токенов. ОРИЕНТИРОВОЧНЫЕ: Sber меняет прайс без
 * предупреждения. Перед публикацией reports/summary.md — сверять с
 * developers.sber.ru/docs/ru/gigachat/pricing и, если изменилось, обновлять
 * таблицу ИЛИ передавать config.pricing в YAML-конфиге.
 *
 * Матчинг — longest-prefix: для `GigaChat-2-Max-preview` попадём в
 * `GigaChat-2-Max`. Неизвестная модель → cost = 0, metadata.pricingSource = 'none'.
 */
export const DEFAULT_PRICING: Record<string, GigaChatPricing> = {
  // Линейка 2 (актуальная на 2026)
  'GigaChat-2-Lite': { promptPer1k: 0.2, completionPer1k: 0.2 },
  'GigaChat-2-Pro': { promptPer1k: 1.5, completionPer1k: 1.5 },
  'GigaChat-2-Max': { promptPer1k: 1.95, completionPer1k: 1.95 },
  // Предыдущее поколение — на случай legacy-прогонов
  'GigaChat-Lite': { promptPer1k: 0.2, completionPer1k: 0.2 },
  'GigaChat-Pro': { promptPer1k: 1.5, completionPer1k: 1.5 },
  'GigaChat-Max': { promptPer1k: 1.95, completionPer1k: 1.95 },
};

export type { PricingSource, ResolvedPricing };

export function resolvePricing(model: string, override?: Partial<GigaChatPricing>): ResolvedPricing<GigaChatPricing> {
  return resolvePricingByTable<GigaChatPricing>({
    table: DEFAULT_PRICING,
    model,
    ...(override !== undefined && { override }),
    zeroValues: { promptPer1k: 0, completionPer1k: 0 },
  });
}

export function computeCost(usage: GigaChatUsage, pricing: GigaChatPricing): number {
  // У GigaChat отдельного публичного тарифа на precached_prompt_tokens нет —
  // тарифицируем по цене обычного промпта (верхняя граница).
  return computePer1kCost(
    { prompt: usage.prompt_tokens, completion: usage.completion_tokens },
    pricing,
  );
}

// ==========================================================================
// OAuth client
// ==========================================================================

interface CachedToken {
  accessToken: string;
  expiresAt: number; // unix ms
}

interface OAuthSuccess {
  access_token: string;
  expires_at: number; // unix ms по спеке GigaChat
}

export interface OAuthClientDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
  /** За сколько мс до истечения считать токен «пора обновить». По умолчанию 2 минуты. */
  refreshMarginMs?: number;
}

export class GigaChatOAuthClient {
  private cache: CachedToken | null = null;
  private inflight: Promise<CachedToken> | null = null;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly refreshMarginMs: number;

  constructor(
    private readonly env: GigaChatEnvConfig,
    deps: OAuthClientDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? (() => randomUUID());
    this.refreshMarginMs = deps.refreshMarginMs ?? 2 * 60 * 1000;
  }

  async getAccessToken(): Promise<string> {
    const cached = this.cache;
    if (cached && cached.expiresAt - this.refreshMarginMs > this.now()) {
      return cached.accessToken;
    }
    if (this.inflight) {
      return (await this.inflight).accessToken;
    }
    this.inflight = this.refresh();
    try {
      const fresh = await this.inflight;
      return fresh.accessToken;
    } finally {
      this.inflight = null;
    }
  }

  private async refresh(): Promise<CachedToken> {
    const res = await this.fetchImpl(this.env.oauthUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        RqUID: this.uuid(),
        Authorization: `Basic ${this.env.authKey}`,
      },
      body: `scope=${encodeURIComponent(this.env.scope)}`,
    });

    if (!res.ok) {
      throw new Error(`GigaChat OAuth ${res.status}: ${await safeReadText(res)}`);
    }

    const data = (await res.json()) as Partial<OAuthSuccess>;
    if (typeof data.access_token !== 'string' || typeof data.expires_at !== 'number') {
      throw new Error('GigaChat OAuth: ответ без access_token/expires_at');
    }

    const token: CachedToken = {
      accessToken: data.access_token,
      expiresAt: data.expires_at,
    };
    this.cache = token;
    return token;
  }

  /** Для тестов: сбросить кэш. */
  reset(): void {
    this.cache = null;
    this.inflight = null;
  }
}

// ==========================================================================
// File-id cache (sha256 bytes → GigaChat file_id)
// ==========================================================================

export interface FileIdCacheAdapter {
  get(hash: string): Promise<string | null>;
  set(hash: string, id: string): Promise<void>;
}

interface FileCacheEntry {
  id: string;
  uploadedAt: number;
}

export interface DiskFileIdCacheDeps {
  ttlMs?: number;
  now?: () => number;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, data: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
}

/**
 * Кэш на диске. Файл — `.cache/gigachat-files.json`. TTL 24 часа (GigaChat
 * удаляет файлы через ~48ч, берём половину с запасом).
 */
export class DiskFileIdCache implements FileIdCacheAdapter {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly readFileImpl: (path: string) => Promise<string>;
  private readonly writeFileImpl: (path: string, data: string) => Promise<void>;
  private readonly mkdirImpl: (path: string) => Promise<void>;

  private data: Record<string, FileCacheEntry> | null = null;

  constructor(
    private readonly path: string,
    deps: DiskFileIdCacheDeps = {},
  ) {
    this.ttlMs = deps.ttlMs ?? 24 * 60 * 60 * 1000;
    this.now = deps.now ?? Date.now;
    this.readFileImpl = deps.readFile ?? ((p) => readFile(p, 'utf8'));
    this.writeFileImpl = deps.writeFile ?? ((p, d) => writeFile(p, d));
    this.mkdirImpl =
      deps.mkdir ??
      (async (p) => {
        await mkdir(p, { recursive: true });
      });
  }

  private async load(): Promise<Record<string, FileCacheEntry>> {
    if (this.data !== null) return this.data;
    try {
      const raw = await this.readFileImpl(this.path);
      const parsed: unknown = JSON.parse(raw);
      const clean: Record<string, FileCacheEntry> = {};
      if (isRecord(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (isRecord(v) && typeof v.id === 'string' && typeof v.uploadedAt === 'number') {
            clean[k] = { id: v.id, uploadedAt: v.uploadedAt };
          }
        }
      }
      this.data = clean;
    } catch {
      // ENOENT / битый JSON — начинаем с пустого кэша.
      this.data = {};
    }
    return this.data;
  }

  async get(hash: string): Promise<string | null> {
    const data = await this.load();
    const entry = data[hash];
    if (!entry) return null;
    if (this.now() - entry.uploadedAt > this.ttlMs) {
      delete data[hash];
      return null;
    }
    return entry.id;
  }

  async set(hash: string, id: string): Promise<void> {
    const data = await this.load();
    data[hash] = { id, uploadedAt: this.now() };
    try {
      await this.mkdirImpl(dirname(this.path));
    } catch {
      // директория уже есть — игнорируем
    }
    await this.writeFileImpl(this.path, JSON.stringify(data, null, 2));
  }
}

/** Без-диска адаптер для тестов и коротких прогонов. */
export class InMemoryFileIdCache implements FileIdCacheAdapter {
  private readonly data = new Map<string, FileCacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(deps: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = deps.ttlMs ?? Number.POSITIVE_INFINITY;
    this.now = deps.now ?? Date.now;
  }

  async get(hash: string): Promise<string | null> {
    const entry = this.data.get(hash);
    if (!entry) return null;
    if (this.now() - entry.uploadedAt > this.ttlMs) {
      this.data.delete(hash);
      return null;
    }
    return entry.id;
  }

  async set(hash: string, id: string): Promise<void> {
    this.data.set(hash, { id, uploadedAt: this.now() });
  }
}

// ==========================================================================
// Chat / files client
// ==========================================================================

export interface GigaChatClientDeps {
  oauth: GigaChatOAuthClient;
  fileCache?: FileIdCacheAdapter;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
}

export interface ChatCompletionOptions {
  maxRetries?: number;
  retryBaseMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ImageUploadInput {
  base64: string;
  mime: string;
  filename?: string;
}

export class GigaChatClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;
  private readonly oauth: GigaChatOAuthClient;
  private readonly fileCache: FileIdCacheAdapter;

  constructor(
    private readonly env: GigaChatEnvConfig,
    deps: GigaChatClientDeps,
  ) {
    this.oauth = deps.oauth;
    this.fileCache = deps.fileCache ?? new InMemoryFileIdCache();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.jitter = deps.jitter ?? Math.random;
  }

  async chatCompletion(
    payload: GigaChatCompletionPayload,
    opts: ChatCompletionOptions = {},
  ): Promise<GigaChatCompletionResponse> {
    const res = await this.requestWithRetry(
      `${this.env.apiUrl}/chat/completions`,
      async () => {
        const signal = combineSignals(opts.signal, opts.timeoutMs);
        return this.withAuth({
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
          ...(signal !== undefined && { signal }),
        });
      },
      opts,
    );
    return (await res.json()) as GigaChatCompletionResponse;
  }

  /** Загрузить картинку в /files и получить file_id. Кэш в адаптере. */
  async uploadImage(input: ImageUploadInput): Promise<string> {
    const bytes = Buffer.from(input.base64, 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');

    const cached = await this.fileCache.get(hash);
    if (cached) return cached;

    const filename = input.filename ?? `${hash.slice(0, 12)}.${extFromMime(input.mime)}`;

    const res = await this.requestWithRetry(
      `${this.env.apiUrl}/files`,
      async () => {
        const form = new FormData();
        const blob = new Blob([bytes], { type: input.mime });
        form.append('file', blob, filename);
        form.append('purpose', 'general');
        return this.withAuth({
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: form,
        });
      },
      {},
    );

    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error('GigaChat /files: нет id в ответе');
    await this.fileCache.set(hash, data.id);
    return data.id;
  }

  /** Добавить Bearer-заголовок. Вызываем на каждой попытке — токен мог обновиться. */
  private async withAuth(init: RequestInit): Promise<RequestInit> {
    const token = await this.oauth.getAccessToken();
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    };
    return { ...init, headers };
  }

  private async requestWithRetry(
    url: string,
    buildInit: () => Promise<RequestInit>,
    opts: ChatCompletionOptions,
  ): Promise<Response> {
    return sharedRequestWithRetry({
      url,
      buildInit,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      jitter: this.jitter,
      ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
      ...(opts.retryBaseMs !== undefined && { baseDelayMs: opts.retryBaseMs }),
      ...(opts.signal !== undefined && { signal: opts.signal }),
      // GigaChat исторически ретраил только 429 и 503 — 5xx в документации
      // мельком, трогать поведение без повода не хочу.
      shouldRetryStatus: (s) => s === 429 || s === 503,
      errorPrefix: 'GigaChat',
    });
  }
}

// ==========================================================================
// Backoff + утилиты (re-exports для обратной совместимости тестов)
// ==========================================================================

export { computePer1kCost } from './_shared/cost.js';
export { safeReadText, parseRetryAfter, withRetry, requestWithRetry } from './_shared/retry.js';

function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/tiff':
      return 'tiff';
    case 'image/bmp':
      return 'bmp';
    default:
      return 'bin';
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Комбинирует пользовательский signal и таймаут. Node 20.3+ (AbortSignal.any). */
function combineSignals(user?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
  if (!timeoutMs) return user;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!user) return timeoutSignal;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([user, timeoutSignal]);
  return user;
}

// ==========================================================================
// Парсинг промпта: обратно-совместимая обёртка над parseChatPrompt
// ==========================================================================

export interface ParsedPrompt {
  messages: GigaChatMessage[];
  /** Извлечённые base64-картинки. messageIndex — индекс в messages[]. */
  images: Array<{ messageIndex: number; base64: string; mime: string }>;
}

export function parsePrompt(raw: string): ParsedPrompt {
  const parsed: SharedParsedPrompt = parseChatPrompt(raw);
  const messages: GigaChatMessage[] = [];
  const images: ParsedPrompt['images'] = [];
  parsed.messages.forEach((m, idx) => {
    messages.push({ role: m.role, content: m.text });
    for (const img of m.images) {
      images.push({ messageIndex: idx, base64: img.base64, mime: img.mime });
    }
  });
  return { messages, images };
}

// ==========================================================================
// Promptfoo ApiProvider
// ==========================================================================

export interface PromptfooProviderOptions {
  id?: string;
  config?: GigaChatProviderConfig;
}

export type { PromptfooProviderResponse };

const oauthRegistry = new Map<string, GigaChatOAuthClient>();
// Единственный дисковый кэш на процесс — его load/save потокобезопасны до
// разумного предела (последовательные await'ы); Promptfoo гоняет callApi
// по одной корутине на кейс, параллелизм ограничен --concurrency.
let defaultFileCache: FileIdCacheAdapter | null = null;

export function isGigaChatMock(): boolean {
  return process.env.GIGACHAT_MOCK === '1';
}

function loadEnvConfig(): GigaChatEnvConfig {
  // В mock-режиме ключи не нужны — провайдер вообще не полезет в сеть.
  if (isGigaChatMock()) {
    return {
      authKey: 'mock-auth-key',
      scope: process.env.GIGACHAT_SCOPE ?? 'GIGACHAT_API_PERS',
      oauthUrl: 'https://mock.local/oauth',
      apiUrl: 'https://mock.local/api/v1',
    };
  }
  const authKey = process.env.GIGACHAT_AUTH_KEY ?? '';
  const scope = process.env.GIGACHAT_SCOPE ?? 'GIGACHAT_API_PERS';
  const oauthUrl = process.env.GIGACHAT_OAUTH_URL ?? 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
  const apiUrl = process.env.GIGACHAT_API_URL ?? 'https://gigachat.devices.sberbank.ru/api/v1';
  if (!authKey) throw new Error('GIGACHAT_AUTH_KEY не задан в окружении');
  return { authKey, scope, oauthUrl, apiUrl };
}

function getOAuthClient(env: GigaChatEnvConfig): GigaChatOAuthClient {
  const keyHash = createHash('sha256').update(env.authKey).digest('hex');
  const key = `${env.oauthUrl}|${env.scope}|${keyHash}`;
  let client = oauthRegistry.get(key);
  if (!client) {
    client = new GigaChatOAuthClient(env);
    oauthRegistry.set(key, client);
  }
  return client;
}

function getDefaultFileCache(): FileIdCacheAdapter {
  if (defaultFileCache === null) {
    defaultFileCache = new DiskFileIdCache('.cache/gigachat-files.json');
  }
  return defaultFileCache;
}

/** Фикстура для GIGACHAT_MOCK=1 — детерминированный approve без нарушений. */
export function gigachatMockResponse(model: string): GigaChatCompletionResponse {
  return {
    choices: [
      {
        message: { role: 'assistant', content: '{"violations":[],"verdict":"approve"}' },
        index: 0,
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115 },
    model: `${model}:mock`,
    created: 0,
    object: 'chat.completion',
  };
}

export default class GigaChatProvider {
  readonly providerId: string;
  readonly providerConfig: GigaChatProviderConfig;
  private readonly client: GigaChatClient | null;
  private readonly resolvedPricing: ResolvedPricing<GigaChatPricing>;
  private readonly mock: boolean;

  constructor(options: PromptfooProviderOptions = {}) {
    const cfg = options.config;
    if (!cfg || typeof cfg.model !== 'string' || cfg.model.length === 0) {
      throw new Error(
        'GigaChat provider: config.model обязателен. Укажите модель явно в YAML-конфиге ' +
          '(например, GigaChat-2-Lite / GigaChat-2-Pro / GigaChat-2-Max) — дефолта нет намеренно.',
      );
    }
    this.providerConfig = cfg;
    this.providerId = options.id ?? `gigachat:${cfg.model}`;
    this.mock = isGigaChatMock();

    if (this.mock) {
      this.client = null;
    } else {
      const env = loadEnvConfig();
      const oauth = getOAuthClient(env);
      this.client = new GigaChatClient(env, {
        oauth,
        fileCache: getDefaultFileCache(),
      });
    }
    this.resolvedPricing = resolvePricing(cfg.model, cfg.pricing);
  }

  id(): string {
    return this.providerId;
  }

  async callApi(
    prompt: string,
    _context?: unknown,
    options?: { abortSignal?: AbortSignal },
  ): Promise<PromptfooProviderResponse> {
    const t0 = Date.now();
    try {
      const { messages, images } = parsePrompt(prompt);
      if (messages.length === 0) {
        throw new Error('GigaChat: пустой список сообщений после парсинга промпта');
      }

      if (this.mock) {
        const res = gigachatMockResponse(this.providerConfig.model);
        return this.buildResponse(res, t0, { mocked: true });
      }

      if (!this.client) throw new Error('GigaChat: клиент не инициализирован');

      if (images.length > 0) {
        await this.attachImages(messages, images);
      }

      const payload: GigaChatCompletionPayload = {
        model: this.providerConfig.model,
        messages,
        temperature: this.providerConfig.temperature ?? 0,
        ...(this.providerConfig.top_p !== undefined && { top_p: this.providerConfig.top_p }),
        ...(this.providerConfig.max_tokens !== undefined && { max_tokens: this.providerConfig.max_tokens }),
        ...(this.providerConfig.repetition_penalty !== undefined && {
          repetition_penalty: this.providerConfig.repetition_penalty,
        }),
      };

      const res = await this.client.chatCompletion(payload, {
        ...(this.providerConfig.maxRetries !== undefined && { maxRetries: this.providerConfig.maxRetries }),
        ...(this.providerConfig.retryBaseMs !== undefined && { retryBaseMs: this.providerConfig.retryBaseMs }),
        ...(this.providerConfig.timeoutMs !== undefined && { timeoutMs: this.providerConfig.timeoutMs }),
        ...(options?.abortSignal !== undefined && { signal: options.abortSignal }),
      });

      return this.buildResponse(res, t0, { mocked: false });
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        latencyMs: Date.now() - t0,
      };
    }
  }

  private buildResponse(
    res: GigaChatCompletionResponse,
    t0: number,
    ctx: { mocked: boolean },
  ): PromptfooProviderResponse {
    const first = res.choices[0];
    if (!first) throw new Error('GigaChat: пустой choices в ответе');
    return {
      output: first.message.content,
      tokenUsage: {
        prompt: res.usage.prompt_tokens,
        completion: res.usage.completion_tokens,
        total: res.usage.total_tokens,
        ...(res.usage.precached_prompt_tokens !== undefined && { cached: res.usage.precached_prompt_tokens }),
        numRequests: 1,
      },
      cost: computeCost(res.usage, this.resolvedPricing.pricing),
      latencyMs: Date.now() - t0,
      metadata: {
        model: res.model,
        finishReason: first.finish_reason,
        pricingSource: this.resolvedPricing.source,
        ...(this.resolvedPricing.tableKey !== undefined && { pricingTableKey: this.resolvedPricing.tableKey }),
        ...(ctx.mocked && { mock: true }),
      },
      raw: res,
    };
  }

  private async attachImages(
    messages: GigaChatMessage[],
    images: ParsedPrompt['images'],
  ): Promise<void> {
    if (!this.client) return;
    // GigaChat рекомендует ≤1 картинки на сообщение; если их больше — кладём все,
    // API ответит ошибкой, и это будет видно в error/raw.
    const byIndex = new Map<number, string[]>();
    for (const img of images) {
      const id = await this.client.uploadImage({ base64: img.base64, mime: img.mime });
      const list = byIndex.get(img.messageIndex) ?? [];
      list.push(id);
      byIndex.set(img.messageIndex, list);
    }
    for (const [idx, ids] of byIndex) {
      const m = messages[idx];
      if (!m) continue;
      m.attachments = [...(m.attachments ?? []), ...ids];
    }
  }
}
