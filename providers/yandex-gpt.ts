// YandexGPT custom provider для Promptfoo.
//
// Что внутри:
//   * Аутентификация API-ключом (`Authorization: Api-Key ...`). IAM-токены
//     намеренно не поддерживаем — ради одного long-lived ключа городить
//     refresh не хочется, это R&D-бенчмарк.
//   * YandexGPTClient — POST /foundationModels/v1/completion с retry на
//     429/5xx и сетевых ошибках (см. _shared/retry.ts).
//   * Per-model pricing в коде + override через config.pricing.
//   * YANDEX_MOCK=1 — короткое замыкание без сети: detoerминированная фикстура
//     `{"violations": [], "verdict": "approve"}` и фейковый usage.
//
// Картинки провайдер НЕ принимает — для модерации фотографий нужен
// yandex-vision (двухшаговый пайплайн Vision→YandexGPT). При image_url в
// промпте — бросаем с понятной ошибкой.

import { resolvePricingByTable, computePer1kCost } from './_shared/cost.js';
import {
  parseChatPrompt,
  type ParsedPrompt as SharedParsedPrompt,
} from './_shared/parse-prompt.js';
import { requestWithRetry as sharedRequestWithRetry } from './_shared/retry.js';
import type {
  PerTokenPricing,
  PromptfooProviderResponse,
  ResolvedPricing,
} from './_shared/types.js';

// ==========================================================================
// Типы запроса/ответа YandexGPT
// ==========================================================================

export type YandexGPTRole = 'system' | 'user' | 'assistant';

export interface YandexGPTMessage {
  role: YandexGPTRole;
  text: string;
}

export interface YandexGPTCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  stream?: false;
}

export interface YandexGPTCompletionPayload {
  modelUri: string;
  completionOptions: YandexGPTCompletionOptions;
  messages: YandexGPTMessage[];
}

export interface YandexGPTUsage {
  inputTextTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface YandexGPTAlternative {
  message: { role: string; text: string };
  status?: string;
}

export interface YandexGPTCompletionResponse {
  result: {
    alternatives: YandexGPTAlternative[];
    usage: YandexGPTUsage;
    modelVersion: string;
  };
}

// ==========================================================================
// Конфигурация
// ==========================================================================

export interface YandexEnvConfig {
  apiKey: string;
  folderId: string;
  /** Foundation Models API (YandexGPT). */
  llmApiUrl: string;
  /** Vision API. */
  visionApiUrl: string;
}

export type YandexGPTPricing = PerTokenPricing;

export interface YandexGPTProviderConfig {
  /** Обязательно. Напр.: `yandexgpt-lite/latest`, `yandexgpt/latest`, `yandexgpt/rc`. */
  model: string;
  temperature?: number;
  maxTokens?: number;
  pricing?: Partial<YandexGPTPricing>;
  maxRetries?: number;
  retryBaseMs?: number;
  /** Таймаут одного HTTP-запроса, мс. По умолчанию 60 000. */
  timeoutMs?: number;
}

// ==========================================================================
// Per-model pricing (рубли за 1000 токенов)
// ==========================================================================

/**
 * ОРИЕНТИРОВОЧНЫЕ тарифы Yandex Cloud Foundation Models по состоянию на
 * 2026-04. Перед публикацией отчёта сверять с yandex.cloud/ru/docs/foundation-models/pricing.
 *
 * Ключи — longest-prefix match по строке model:
 *   * `yandexgpt-lite/latest` → `yandexgpt-lite`
 *   * `yandexgpt/latest`      → `yandexgpt`
 *   * `yandexgpt/rc`          → `yandexgpt/rc` (длиннее чем `yandexgpt`, забирает приоритет)
 *
 * Тариф `yandexgpt/rc` приравнен к `yandexgpt/latest` (в момент коммита Yandex
 * двигает `rc` в `latest`, цены совпадают). При следующем сдвиге — обновить
 * таблицу; при локальном прогоне можно временно перекрыть через config.pricing.
 */
export const DEFAULT_PRICING: Record<string, YandexGPTPricing> = {
  'yandexgpt-lite': { promptPer1k: 0.2, completionPer1k: 0.2 },
  'yandexgpt': { promptPer1k: 1.2, completionPer1k: 1.2 },
  'yandexgpt/rc': { promptPer1k: 1.2, completionPer1k: 1.2 },
};

export function resolvePricing(
  model: string,
  override?: Partial<YandexGPTPricing>,
): ResolvedPricing<YandexGPTPricing> {
  return resolvePricingByTable<YandexGPTPricing>({
    table: DEFAULT_PRICING,
    model,
    ...(override !== undefined && { override }),
    zeroValues: { promptPer1k: 0, completionPer1k: 0 },
    // `-` не сепаратор: yandexgpt-lite и yandexgpt — разные модели.
    separators: ['/', ':'],
  });
}

export function computeCost(usage: YandexGPTUsage, pricing: YandexGPTPricing): number {
  return computePer1kCost(
    { prompt: usage.inputTextTokens, completion: usage.completionTokens },
    pricing,
  );
}

// ==========================================================================
// Парсинг промпта
// ==========================================================================

export interface YandexGPTParsedPrompt {
  messages: YandexGPTMessage[];
}

export function parsePrompt(raw: string): YandexGPTParsedPrompt {
  const parsed: SharedParsedPrompt = parseChatPrompt(raw);
  const messages: YandexGPTMessage[] = [];
  for (const m of parsed.messages) {
    if (m.images.length > 0) {
      throw new Error(
        'YandexGPT не принимает изображения — используй yandex-vision провайдер ' +
          '(двухшаговый Vision→GPT пайплайн).',
      );
    }
    // Yandex знает только system/user/assistant; `function` мапим в system.
    const role: YandexGPTRole = m.role === 'function' ? 'system' : m.role;
    messages.push({ role, text: m.text });
  }
  return { messages };
}

// ==========================================================================
// Client
// ==========================================================================

export interface YandexGPTClientDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
}

export interface CompleteRequest {
  model: string;
  messages: YandexGPTMessage[];
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CompleteResult {
  text: string;
  usage: YandexGPTUsage;
  modelVersion: string;
  raw: YandexGPTCompletionResponse;
}

export class YandexGPTClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  constructor(
    private readonly env: YandexEnvConfig,
    deps: YandexGPTClientDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.jitter = deps.jitter ?? Math.random;
  }

  buildModelUri(model: string): string {
    return `gpt://${this.env.folderId}/${model}`;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const payload: YandexGPTCompletionPayload = {
      modelUri: this.buildModelUri(req.model),
      completionOptions: {
        temperature: req.temperature ?? 0,
        // Yandex требует явное ограничение; 2000 — значение по умолчанию из ТЗ.
        maxTokens: req.maxTokens ?? 2000,
        stream: false,
      },
      messages: req.messages,
    };

    const res = await sharedRequestWithRetry({
      url: `${this.env.llmApiUrl}/foundationModels/v1/completion`,
      buildInit: () => {
        const signal = combineSignals(req.signal, req.timeoutMs);
        return {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Api-Key ${this.env.apiKey}`,
            'x-folder-id': this.env.folderId,
          },
          body: JSON.stringify(payload),
          ...(signal !== undefined && { signal }),
        };
      },
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      jitter: this.jitter,
      ...(req.maxRetries !== undefined && { maxRetries: req.maxRetries }),
      ...(req.retryBaseMs !== undefined && { baseDelayMs: req.retryBaseMs }),
      ...(req.signal !== undefined && { signal: req.signal }),
      // Yandex ретраим шире, чем GigaChat: 429 + все 5xx.
      shouldRetryStatus: (s) => s === 429 || (s >= 500 && s < 600),
      errorPrefix: 'YandexGPT',
    });

    const raw = (await res.json()) as YandexGPTCompletionResponse;
    const usage = normalizeUsage(raw.result?.usage);
    const alt = raw.result?.alternatives?.[0];
    if (!alt) throw new Error('YandexGPT: пустой alternatives в ответе');
    return {
      text: alt.message.text,
      usage,
      modelVersion: raw.result.modelVersion,
      raw,
    };
  }
}

/** Yandex возвращает счётчики токенов строками — нормализуем в числа. */
function normalizeUsage(u: unknown): YandexGPTUsage {
  const r = (u ?? {}) as Record<string, unknown>;
  return {
    inputTextTokens: toNumber(r.inputTextTokens),
    completionTokens: toNumber(r.completionTokens),
    totalTokens: toNumber(r.totalTokens),
  };
}

function toNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function combineSignals(user?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
  if (!timeoutMs) return user;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!user) return timeoutSignal;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn([user, timeoutSignal]);
  return user;
}

// ==========================================================================
// Env
// ==========================================================================

export function isYandexMock(): boolean {
  return process.env.YANDEX_MOCK === '1';
}

export function loadYandexEnvConfig(): YandexEnvConfig {
  // В mock-режиме ключи не нужны — клиенты не полезут в сеть.
  if (isYandexMock()) {
    return {
      apiKey: 'mock-api-key',
      folderId: 'mock-folder',
      llmApiUrl: 'https://mock.local/llm',
      visionApiUrl: 'https://mock.local/vision',
    };
  }
  const apiKey = process.env.YANDEX_API_KEY ?? '';
  const folderId = process.env.YANDEX_FOLDER_ID ?? '';
  const llmApiUrl = process.env.YANDEX_LLM_API_URL ?? 'https://llm.api.cloud.yandex.net';
  const visionApiUrl = process.env.YANDEX_VISION_API_URL ?? 'https://vision.api.cloud.yandex.net';
  if (!apiKey) throw new Error('YANDEX_API_KEY не задан в окружении');
  if (!folderId) throw new Error('YANDEX_FOLDER_ID не задан в окружении');
  return { apiKey, folderId, llmApiUrl, visionApiUrl };
}

/** Фикстура для YANDEX_MOCK=1. Детерминированный approve без нарушений. */
export function yandexGPTMockResponse(model: string): CompleteResult {
  const raw: YandexGPTCompletionResponse = {
    result: {
      alternatives: [
        {
          message: { role: 'assistant', text: '{"violations":[],"verdict":"approve"}' },
          status: 'ALTERNATIVE_STATUS_FINAL',
        },
      ],
      usage: { inputTextTokens: 100, completionTokens: 15, totalTokens: 115 },
      modelVersion: `${model}:mock`,
    },
  };
  return {
    text: raw.result.alternatives[0]!.message.text,
    usage: raw.result.usage,
    modelVersion: raw.result.modelVersion,
    raw,
  };
}

// ==========================================================================
// Promptfoo provider
// ==========================================================================

export interface PromptfooProviderOptions {
  id?: string;
  config?: YandexGPTProviderConfig;
}

export type { PromptfooProviderResponse };

export default class YandexGPTProvider {
  readonly providerId: string;
  readonly providerConfig: YandexGPTProviderConfig;
  private readonly client: YandexGPTClient | null;
  private readonly env: YandexEnvConfig;
  private readonly resolvedPricing: ResolvedPricing<YandexGPTPricing>;
  private readonly mock: boolean;

  constructor(options: PromptfooProviderOptions = {}) {
    const cfg = options.config;
    if (!cfg || typeof cfg.model !== 'string' || cfg.model.length === 0) {
      throw new Error(
        'YandexGPT provider: config.model обязателен. Укажите модель явно в YAML-конфиге ' +
          '(yandexgpt-lite/latest, yandexgpt/latest или yandexgpt/rc) — дефолта нет намеренно.',
      );
    }
    this.providerConfig = cfg;
    this.providerId = options.id ?? `yandexgpt:${cfg.model}`;
    this.mock = isYandexMock();
    this.env = loadYandexEnvConfig();
    this.client = this.mock ? null : new YandexGPTClient(this.env);
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
      const { messages } = parsePrompt(prompt);
      if (messages.length === 0) {
        throw new Error('YandexGPT: пустой список сообщений после парсинга промпта');
      }

      const res = this.mock
        ? yandexGPTMockResponse(this.providerConfig.model)
        : await this.client!.complete({
            model: this.providerConfig.model,
            messages,
            ...(this.providerConfig.temperature !== undefined && {
              temperature: this.providerConfig.temperature,
            }),
            ...(this.providerConfig.maxTokens !== undefined && {
              maxTokens: this.providerConfig.maxTokens,
            }),
            ...(this.providerConfig.maxRetries !== undefined && {
              maxRetries: this.providerConfig.maxRetries,
            }),
            ...(this.providerConfig.retryBaseMs !== undefined && {
              retryBaseMs: this.providerConfig.retryBaseMs,
            }),
            ...(this.providerConfig.timeoutMs !== undefined && {
              timeoutMs: this.providerConfig.timeoutMs,
            }),
            ...(options?.abortSignal !== undefined && { signal: options.abortSignal }),
          });

      return {
        output: res.text,
        tokenUsage: {
          prompt: res.usage.inputTextTokens,
          completion: res.usage.completionTokens,
          total: res.usage.totalTokens,
          numRequests: 1,
        },
        cost: computeCost(res.usage, this.resolvedPricing.pricing),
        latencyMs: Date.now() - t0,
        metadata: {
          model: this.providerConfig.model,
          modelVersion: res.modelVersion,
          folderId: this.env.folderId,
          pricingSource: this.resolvedPricing.source,
          ...(this.resolvedPricing.tableKey !== undefined && {
            pricingTableKey: this.resolvedPricing.tableKey,
          }),
          ...(this.mock && { mock: true }),
        },
        raw: res.raw,
      };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        latencyMs: Date.now() - t0,
      };
    }
  }
}
