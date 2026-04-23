// Общие типы, переиспользуемые всеми провайдерами.
// Форма Promptfoo-ответа зафиксирована здесь, чтобы не разъезжалась между
// GigaChat/Yandex/Vision.

export interface TokenUsage {
  prompt?: number;
  completion?: number;
  total?: number;
  cached?: number;
  /** Сколько реальных HTTP-вызовов ушло на один Promptfoo-кейс. */
  numRequests?: number;
}

export interface PromptfooProviderResponse {
  output?: string;
  error?: string;
  tokenUsage?: TokenUsage;
  cost?: number;
  raw?: unknown;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
}

export type PricingSource = 'config' | 'default-table' | 'merged' | 'none';

export interface ResolvedPricing<P> {
  pricing: P;
  source: PricingSource;
  /** Ключ, по которому попали в таблицу. undefined → без матча. */
  tableKey?: string;
}

/** Тариф «рубли за 1000 токенов» — общая форма GigaChat + YandexGPT. */
export type PerTokenPricing = {
  promptPer1k: number;
  completionPer1k: number;
};
