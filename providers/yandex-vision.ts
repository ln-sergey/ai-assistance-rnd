// Yandex Vision custom provider для Promptfoo — двухшаговый пайплайн
// для модерации фотографий (см. ARCHITECTURE.md §3):
//
//   1. Vision batchAnalyze: OCR (TEXT_DETECTION) + классификаторы
//      (CLASSIFICATION, модели `moderation`, `quality`, `support`).
//   2. Результат Vision склеивается в системный промпт для YandexGPT —
//      «вот что Vision нашёл, классифицируй по правилам image_rules».
//   3. Ответ YandexGPT отдаётся как output провайдера. tokenUsage и cost
//      агрегируются: GPT-токены + Vision-изображения (per-image тариф).
//
// Почему именно pipeline, а не отдельные провайдеры: в Promptfoo Yandex Vision
// бесполезен сам по себе (он не выдаёт JSON по нашей таксономии), а запускать
// два провайдера последовательно в одной ячейке нельзя. Собираем pipeline
// как один custom-провайдер.
//
// YANDEX_MOCK=1: оба клиента заменяются фикстурами; в фикстуре виден
// ожидаемый shape пайплайна, не бьёт сеть.

import {
  parseChatPrompt,
  type ParsedImage,
  type ParsedPrompt as SharedParsedPrompt,
} from './_shared/parse-prompt.js';
import { requestWithRetry as sharedRequestWithRetry } from './_shared/retry.js';
import { resolvePricingByTable } from './_shared/cost.js';
import type { PromptfooProviderResponse, ResolvedPricing } from './_shared/types.js';

import {
  YandexGPTClient,
  loadYandexEnvConfig,
  isYandexMock,
  resolvePricing as resolveGPTPricing,
  computeCost as computeGPTCost,
  yandexGPTMockResponse,
  type CompleteResult,
  type YandexEnvConfig,
  type YandexGPTMessage,
  type YandexGPTPricing,
} from './yandex-gpt.js';

// ==========================================================================
// Константы: какие классификаторы вызываем по умолчанию
// ==========================================================================

/**
 * Публичные Vision-классификаторы. Точный список — в доках:
 * https://yandex.cloud/ru/docs/vision/concepts/classifier
 * По умолчанию берём `moderation` (adult/gore/racy) и `quality` (фокус,
 * шум, освещённость). `support` (связь контекста с карточкой) — опциональный.
 */
export const DEFAULT_CLASSIFIER_MODELS: readonly string[] = ['moderation', 'quality'];

export type VisionFeatureType = 'TEXT_DETECTION' | 'CLASSIFICATION';

export const DEFAULT_VISION_FEATURES: readonly VisionFeatureType[] = [
  'TEXT_DETECTION',
  'CLASSIFICATION',
];

// ==========================================================================
// Типы запроса/ответа Vision
// ==========================================================================

export interface VisionFeature {
  type: VisionFeatureType;
  text_detection_config?: { language_codes: string[] };
  classifier_config?: { model: string };
}

export interface VisionAnalyzeRequest {
  folderId: string;
  analyze_specs: Array<{
    content: string; // base64
    features: VisionFeature[];
  }>;
}

export interface VisionClassifierLabel {
  name: string;
  confidence: number;
  classifierModel: string;
}

export interface VisionAnalyzeResult {
  ocrText: string;
  classifierLabels: VisionClassifierLabel[];
  raw: unknown;
}

// ==========================================================================
// Pricing — Vision тарифицируется по картинкам, не по токенам
// ==========================================================================

/**
 * Рубли за одну обработанную картинку (суммарно, без разбивки по фичам).
 * Тип `type` (а не `interface`) — чтобы resolvePricingByTable мог принять
 * P extends Record<string, number>: interface без index-signature не
 * удовлетворяет constraint'у.
 */
export type VisionPricing = {
  perImage: number;
};

/**
 * ОРИЕНТИРОВОЧНО по yandex.cloud/ru/docs/vision/pricing на 2026-04.
 * Точная цена зависит от фичи (OCR / классификация / лица и т.д.), здесь
 * хранится агрегированная оценка для одного вызова batchAnalyze с нашими
 * дефолтными features (TEXT_DETECTION + 2 CLASSIFICATION). Сверять перед публикацией.
 */
export const DEFAULT_VISION_PRICING: Record<string, VisionPricing> = {
  'yandex-vision': { perImage: 0.2 },
};

function resolveVisionPricing(
  override?: Partial<VisionPricing>,
): ResolvedPricing<VisionPricing> {
  return resolvePricingByTable<VisionPricing>({
    table: DEFAULT_VISION_PRICING,
    model: 'yandex-vision',
    ...(override !== undefined && { override }),
    zeroValues: { perImage: 0 },
    separators: ['/', ':'],
  });
}

// ==========================================================================
// Vision client
// ==========================================================================

export interface YandexVisionClientDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
}

export interface AnalyzeOptions {
  features?: readonly VisionFeatureType[];
  classifierModels?: readonly string[];
  languageCodes?: readonly string[];
  maxRetries?: number;
  retryBaseMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class YandexVisionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  constructor(
    private readonly env: YandexEnvConfig,
    deps: YandexVisionClientDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.jitter = deps.jitter ?? Math.random;
  }

  async analyze(imageBase64: string, opts: AnalyzeOptions = {}): Promise<VisionAnalyzeResult> {
    const features = buildFeatures(opts);
    const payload: VisionAnalyzeRequest = {
      folderId: this.env.folderId,
      analyze_specs: [{ content: imageBase64, features }],
    };

    const res = await sharedRequestWithRetry({
      url: `${this.env.visionApiUrl}/vision/v1/batchAnalyze`,
      buildInit: () => {
        const signal = combineSignals(opts.signal, opts.timeoutMs);
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
      ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
      ...(opts.retryBaseMs !== undefined && { baseDelayMs: opts.retryBaseMs }),
      ...(opts.signal !== undefined && { signal: opts.signal }),
      shouldRetryStatus: (s) => s === 429 || (s >= 500 && s < 600),
      errorPrefix: 'YandexVision',
    });

    const raw = (await res.json()) as unknown;
    return parseVisionResponse(raw);
  }
}

function buildFeatures(opts: AnalyzeOptions): VisionFeature[] {
  const featureTypes = opts.features ?? DEFAULT_VISION_FEATURES;
  const classifierModels = opts.classifierModels ?? DEFAULT_CLASSIFIER_MODELS;
  const languages = opts.languageCodes ?? ['ru', 'en'];

  const out: VisionFeature[] = [];
  for (const type of featureTypes) {
    if (type === 'TEXT_DETECTION') {
      out.push({ type, text_detection_config: { language_codes: [...languages] } });
    } else if (type === 'CLASSIFICATION') {
      for (const model of classifierModels) {
        out.push({ type, classifier_config: { model } });
      }
    }
  }
  return out;
}

/**
 * Разбор ответа Yandex Vision v1 batchAnalyze. Структура в реальности:
 *   results: [{ results: [{ textDetection?, classification? }, ...] }]
 * OCR собираем из pages→blocks→lines→words. Классификатор знает имя модели
 * на верхнем уровне (и/или в ответе) — мы его восстанавливаем по порядку
 * фич, которые отправляли.
 *
 * Парсер дефенсивный: неожиданные форма не роняет, просто возвращает пустое.
 */
export function parseVisionResponse(raw: unknown): VisionAnalyzeResult {
  const root = isRecord(raw) ? raw : {};
  const outerResults = Array.isArray(root.results) ? root.results : [];
  const firstOuter = outerResults[0];
  const innerResults =
    isRecord(firstOuter) && Array.isArray(firstOuter.results) ? firstOuter.results : [];

  let ocrText = '';
  const classifierLabels: VisionClassifierLabel[] = [];

  for (const entry of innerResults) {
    if (!isRecord(entry)) continue;
    if (isRecord(entry.textDetection)) {
      ocrText = concatOcrText(entry.textDetection) || ocrText;
    }
    if (isRecord(entry.classification)) {
      const classifier = entry.classification;
      const modelName =
        typeof classifier.modelName === 'string'
          ? classifier.modelName
          : typeof classifier.model === 'string'
            ? classifier.model
            : 'unknown';
      const properties = Array.isArray(classifier.properties) ? classifier.properties : [];
      for (const prop of properties) {
        if (!isRecord(prop)) continue;
        const name = typeof prop.name === 'string' ? prop.name : '';
        const probability =
          typeof prop.probability === 'number'
            ? prop.probability
            : typeof prop.probability === 'string'
              ? Number(prop.probability)
              : NaN;
        if (!name || !Number.isFinite(probability)) continue;
        classifierLabels.push({ name, confidence: probability, classifierModel: modelName });
      }
    }
  }

  return { ocrText, classifierLabels, raw };
}

function concatOcrText(td: Record<string, unknown>): string {
  const pages = Array.isArray(td.pages) ? td.pages : [];
  const pieces: string[] = [];
  for (const page of pages) {
    if (!isRecord(page)) continue;
    const blocks = Array.isArray(page.blocks) ? page.blocks : [];
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      const lines = Array.isArray(block.lines) ? block.lines : [];
      for (const line of lines) {
        if (!isRecord(line)) continue;
        const words = Array.isArray(line.words) ? line.words : [];
        const lineText = words
          .map((w) => (isRecord(w) && typeof w.text === 'string' ? w.text : ''))
          .filter(Boolean)
          .join(' ');
        if (lineText) pieces.push(lineText);
      }
    }
  }
  return pieces.join('\n');
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
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
// Парсинг промпта
// ==========================================================================

export interface YandexVisionParsedPrompt {
  systemText: string;
  userText: string;
  image: ParsedImage;
  /** Если картинок в промпте больше одной — возвращаем первую, но считаем. */
  totalImages: number;
}

export function parsePrompt(raw: string): YandexVisionParsedPrompt {
  const parsed: SharedParsedPrompt = parseChatPrompt(raw);
  const systemParts: string[] = [];
  const userParts: string[] = [];
  let image: ParsedImage | null = null;
  let totalImages = 0;
  for (const m of parsed.messages) {
    if (m.images.length > 0) {
      totalImages += m.images.length;
      if (image === null) image = m.images[0] ?? null;
    }
    if (!m.text) continue;
    if (m.role === 'system') systemParts.push(m.text);
    else userParts.push(m.text);
  }
  if (!image) {
    throw new Error(
      'YandexVision: в промпте нет image_url — провайдер работает только с картинками. ' +
        'Передайте изображение как data-URL в content-части OpenAI-формата.',
    );
  }
  return {
    systemText: systemParts.join('\n\n'),
    userText: userParts.join('\n\n'),
    image,
    totalImages,
  };
}

// ==========================================================================
// Склейка итогового промпта для YandexGPT
// ==========================================================================

export interface BuildGptMessagesInput {
  systemText: string;
  userText: string;
  vision: VisionAnalyzeResult;
}

/**
 * Собирает messages для YandexGPT. Оригинальный системный промпт + блок
 * <vision_output> (OCR + классификаторы) + оригинальный user-текст.
 * Формат фиксированный — тесты его проверяют, чтобы случайный рефакторинг
 * не порвал ожидания промпта.
 */
export function buildGptMessages(input: BuildGptMessagesInput): YandexGPTMessage[] {
  const { systemText, userText, vision } = input;
  const visionBlock = renderVisionBlock(vision);
  const system = [systemText.trim(), visionBlock].filter(Boolean).join('\n\n');
  const user = userText.trim().length > 0
    ? userText
    : 'Проанализируй изображение по правилам, используя блок <vision_output> как предварительный результат Vision.';

  const messages: YandexGPTMessage[] = [];
  if (system) messages.push({ role: 'system', text: system });
  messages.push({ role: 'user', text: user });
  return messages;
}

export function renderVisionBlock(v: VisionAnalyzeResult): string {
  const ocrBody = v.ocrText.trim() || '(OCR не извлёк текст)';
  const labels =
    v.classifierLabels.length > 0
      ? v.classifierLabels
          .map((l) => `- ${l.classifierModel}/${l.name}: ${l.confidence.toFixed(3)}`)
          .join('\n')
      : '- (классификаторы не вернули меток)';
  return [
    '<vision_output>',
    '<ocr_text>',
    ocrBody,
    '</ocr_text>',
    '<classifiers>',
    labels,
    '</classifiers>',
    '</vision_output>',
  ].join('\n');
}

// ==========================================================================
// Provider config
// ==========================================================================

export interface YandexVisionProviderConfig {
  /** Зафиксировано — используется для id(). */
  model?: 'yandex-vision-pipeline';
  /** Обязательно. YandexGPT модель для финального шага. */
  gptModel: string;
  visionFeatures?: VisionFeatureType[];
  classifierModels?: string[];
  languageCodes?: string[];
  temperature?: number;
  maxTokens?: number;
  pricing?: {
    gpt?: Partial<YandexGPTPricing>;
    vision?: Partial<VisionPricing>;
  };
  maxRetries?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
}

export interface PromptfooProviderOptions {
  id?: string;
  config?: YandexVisionProviderConfig;
}

export type { PromptfooProviderResponse };

// ==========================================================================
// Mock fixtures
// ==========================================================================

export function yandexVisionMockAnalyze(): VisionAnalyzeResult {
  return {
    ocrText: 'МОК-OCR: текст на фото',
    classifierLabels: [
      { name: 'adult', confidence: 0.01, classifierModel: 'moderation' },
      { name: 'racy', confidence: 0.05, classifierModel: 'moderation' },
      { name: 'quality', confidence: 0.92, classifierModel: 'quality' },
    ],
    raw: { mock: true },
  };
}

// ==========================================================================
// Provider
// ==========================================================================

export default class YandexVisionProvider {
  readonly providerId: string;
  readonly providerConfig: YandexVisionProviderConfig;
  private readonly env: YandexEnvConfig;
  private readonly vision: YandexVisionClient | null;
  private readonly gpt: YandexGPTClient | null;
  private readonly gptPricing: ResolvedPricing<YandexGPTPricing>;
  private readonly visionPricing: ResolvedPricing<VisionPricing>;
  private readonly mock: boolean;

  constructor(options: PromptfooProviderOptions = {}) {
    const cfg = options.config;
    if (!cfg || typeof cfg.gptModel !== 'string' || cfg.gptModel.length === 0) {
      throw new Error(
        'YandexVision provider: config.gptModel обязателен (модель для финального шага, ' +
          'например yandexgpt/latest). Vision сам не решает задачу модерации — он только ' +
          'готовит OCR и метки для GPT.',
      );
    }
    this.providerConfig = cfg;
    this.providerId = options.id ?? `yandex-vision:${cfg.gptModel}`;
    this.mock = isYandexMock();
    this.env = loadYandexEnvConfig();
    if (this.mock) {
      this.vision = null;
      this.gpt = null;
    } else {
      this.vision = new YandexVisionClient(this.env);
      this.gpt = new YandexGPTClient(this.env);
    }
    this.gptPricing = resolveGPTPricing(cfg.gptModel, cfg.pricing?.gpt);
    this.visionPricing = resolveVisionPricing(cfg.pricing?.vision);
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
      const parsed = parsePrompt(prompt);

      // Шаг 1: Vision (всегда, даже в mock — фикстура).
      const visionResult = await this.runVision(parsed.image, options?.abortSignal);

      // Шаг 2: GPT на склеенном промпте.
      const gptMessages = buildGptMessages({
        systemText: parsed.systemText,
        userText: parsed.userText,
        vision: visionResult,
      });
      const gptResult = await this.runGpt(gptMessages, options?.abortSignal);

      // Агрегация: один HTTP на Vision + один на GPT (в mock — ноль HTTP, но
      // логически это те же два шага).
      const visionCost = this.visionPricing.pricing.perImage;
      const gptCost = computeGPTCost(gptResult.usage, this.gptPricing.pricing);

      return {
        output: gptResult.text,
        tokenUsage: {
          prompt: gptResult.usage.inputTextTokens,
          completion: gptResult.usage.completionTokens,
          total: gptResult.usage.totalTokens,
          numRequests: 2,
        },
        cost: gptCost + visionCost,
        latencyMs: Date.now() - t0,
        metadata: {
          model: this.providerConfig.model ?? 'yandex-vision-pipeline',
          gptModel: this.providerConfig.gptModel,
          gptModelVersion: gptResult.modelVersion,
          folderId: this.env.folderId,
          visionOcrText: truncate(visionResult.ocrText, 500),
          visionClassifierTop3: topK(visionResult.classifierLabels, 3),
          visionCost,
          gptCost,
          gptPricingSource: this.gptPricing.source,
          visionPricingSource: this.visionPricing.source,
          imagesInPrompt: parsed.totalImages,
          ...(this.mock && { mock: true }),
        },
        raw: { vision: visionResult.raw, gpt: gptResult.raw },
      };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        latencyMs: Date.now() - t0,
      };
    }
  }

  private async runVision(image: ParsedImage, signal?: AbortSignal): Promise<VisionAnalyzeResult> {
    if (this.mock) return yandexVisionMockAnalyze();
    if (!this.vision) throw new Error('YandexVision: клиент не инициализирован');
    const cfg = this.providerConfig;
    return this.vision.analyze(image.base64, {
      ...(cfg.visionFeatures && { features: cfg.visionFeatures }),
      ...(cfg.classifierModels && { classifierModels: cfg.classifierModels }),
      ...(cfg.languageCodes && { languageCodes: cfg.languageCodes }),
      ...(cfg.maxRetries !== undefined && { maxRetries: cfg.maxRetries }),
      ...(cfg.retryBaseMs !== undefined && { retryBaseMs: cfg.retryBaseMs }),
      ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
      ...(signal !== undefined && { signal }),
    });
  }

  private async runGpt(messages: YandexGPTMessage[], signal?: AbortSignal): Promise<CompleteResult> {
    if (this.mock) return yandexGPTMockResponse(this.providerConfig.gptModel);
    if (!this.gpt) throw new Error('YandexVision: GPT-клиент не инициализирован');
    const cfg = this.providerConfig;
    return this.gpt.complete({
      model: cfg.gptModel,
      messages,
      ...(cfg.temperature !== undefined && { temperature: cfg.temperature }),
      ...(cfg.maxTokens !== undefined && { maxTokens: cfg.maxTokens }),
      ...(cfg.maxRetries !== undefined && { maxRetries: cfg.maxRetries }),
      ...(cfg.retryBaseMs !== undefined && { retryBaseMs: cfg.retryBaseMs }),
      ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
      ...(signal !== undefined && { signal }),
    });
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function topK(labels: VisionClassifierLabel[], k: number): VisionClassifierLabel[] {
  return [...labels].sort((a, b) => b.confidence - a.confidence).slice(0, k);
}
