// Единая обвязка для retry-логики HTTP-клиентов.
//
// Уровни:
//   * computeBackoff / isRetryableNetworkError / parseRetryAfter / safeReadText
//     — чистые утилиты (без побочных эффектов), легко тестировать.
//   * withRetry(fn, opts) — generic: вызывает fn, по ошибке решает через
//     retryOn(), спит и повторяет. Используется, когда нужен retry вокруг
//     чего-то не-HTTP (например, sleep-таймауты в mock-клиенте).
//   * requestWithRetry(...) — конкретизация под HTTP: выполняет fetch,
//     автоматически ретраит на 429 / 5xx (конфигурируется) и на сетевых
//     ошибках. Префикс сообщения об ошибке конфигурируется (`GigaChat 429`,
//     `YandexGPT 503`), чтобы логи в Promptfoo легко грепались.

export interface BackoffInput {
  attempt: number;
  baseMs: number;
  maxMs?: number;
  retryAfterSeconds?: number;
  jitter?: () => number;
}

export function computeBackoff(i: BackoffInput): number {
  const max = i.maxMs ?? 30_000;
  if (i.retryAfterSeconds !== undefined && Number.isFinite(i.retryAfterSeconds) && i.retryAfterSeconds >= 0) {
    return Math.min(max, Math.round(i.retryAfterSeconds * 1000));
  }
  const exp = i.baseMs * 2 ** i.attempt;
  const rnd = (i.jitter ?? Math.random)();
  // Равномерный джиттер в диапазоне [0.75, 1.25] * exp
  return Math.min(max, Math.round(exp * (0.75 + 0.5 * rnd)));
}

const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'ENETUNREACH',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_RESPONSE_EXCEEDED_SIZE',
]);

export function isRetryableNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;

  const rootCode = extractCode(e);
  if (rootCode && RETRYABLE_CODES.has(rootCode)) return true;

  // undici оборачивает низкоуровневую ошибку в TypeError, оригинал лежит в .cause
  const cause = (e as { cause?: unknown }).cause;
  const causeCode = extractCode(cause);
  if (causeCode && RETRYABLE_CODES.has(causeCode)) return true;

  if (e.name === 'TypeError' && /fetch failed/i.test(e.message)) return true;

  // AbortError из-за AbortSignal.timeout или обрыва соединения на стороне
  // undici. Пользовательский abort отсекается уровнем выше (signal.aborted).
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;

  return false;
}

function extractCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const c = (e as { code?: unknown }).code;
  return typeof c === 'string' ? c : undefined;
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export async function safeReadText(res: Response, maxChars = 200): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, maxChars);
  } catch {
    return '<no body>';
  }
}

// ==========================================================================
// Generic withRetry
// ==========================================================================

export interface RetryAction {
  /** Если ошибка содержит Retry-After — прокинуть сюда секунды. */
  retryAfterSeconds?: number;
}

export interface WithRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Если задан и уже aborted — сразу пробрасываем ошибку, не ретраим. */
  signal?: AbortSignal;
  /** Решает, ретраить ли эту ошибку. Возвращает null для пробрасывания наверх. */
  retryOn: (error: unknown, attempt: number) => RetryAction | null;
}

/**
 * Generic retry с экспонентой и джиттером. Не знает про HTTP, просто гоняет
 * `fn` с бэкоффом. Пользовательский AbortSignal уважается — если уже aborted,
 * ошибка пробрасывается без попытки ретрая.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: WithRetryOptions): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  const baseMs = opts.baseDelayMs ?? 1000;
  const maxMs = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const jitter = opts.jitter ?? Math.random;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      const action = opts.retryOn(e, attempt);
      if (action === null || attempt === maxRetries) throw e;
      const waitMs = computeBackoff({
        attempt,
        baseMs,
        maxMs,
        ...(action.retryAfterSeconds !== undefined && { retryAfterSeconds: action.retryAfterSeconds }),
        jitter,
      });
      await sleep(waitMs);
    }
  }
  throw new Error('withRetry: unreachable — цикл должен был либо вернуть, либо бросить');
}

// ==========================================================================
// HTTP-specific wrapper
// ==========================================================================

export interface RequestWithRetryOptions {
  url: string;
  /** Пересобираем init на каждой попытке (нужно GigaChat-у: заголовок auth
   *  может обновиться между попытками). */
  buildInit: () => Promise<RequestInit> | RequestInit;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Предикат: на каких кодах ретраим. Default: 429 + все 5xx. */
  shouldRetryStatus?: (status: number) => boolean;
  /** Префикс ошибки: `GigaChat 429`, `YandexGPT 503`. */
  errorPrefix: string;
}

const DEFAULT_RETRY_STATUS = (s: number): boolean => s === 429 || (s >= 500 && s < 600);

/**
 * HTTP-вариант ретрая. Возвращает успешный Response (2xx). Ретраит:
 *   * shouldRetryStatus(res.status) → true (по умолчанию 429 + 5xx)
 *   * сетевые ошибки из isRetryableNetworkError
 * Не ретраит:
 *   * 4xx кроме 429
 *   * Пользовательский abort (opts.signal.aborted === true)
 *   * Произвольные Error без известного кода (ошибки нашего же кода)
 */
export async function requestWithRetry(opts: RequestWithRetryOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const jitter = opts.jitter ?? Math.random;
  const maxRetries = opts.maxRetries ?? 4;
  const baseMs = opts.baseDelayMs ?? 1000;
  const maxMs = opts.maxDelayMs ?? 30_000;
  const shouldRetryStatus = opts.shouldRetryStatus ?? DEFAULT_RETRY_STATUS;

  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      const init = await opts.buildInit();
      res = await fetchImpl(opts.url, init);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      if (!isRetryableNetworkError(e) || attempt === maxRetries) throw e;
      lastErr = e;
      const waitMs = computeBackoff({ attempt, baseMs, maxMs, jitter });
      await sleep(waitMs);
      continue;
    }

    if (shouldRetryStatus(res.status)) {
      if (attempt === maxRetries) {
        throw new Error(
          `${opts.errorPrefix} ${res.status} после ${maxRetries + 1} попыток: ${await safeReadText(res)}`,
        );
      }
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const waitMs = computeBackoff({
        attempt,
        baseMs,
        maxMs,
        ...(retryAfter !== undefined && { retryAfterSeconds: retryAfter }),
        jitter,
      });
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      throw new Error(`${opts.errorPrefix} ${res.status}: ${await safeReadText(res)}`);
    }

    return res;
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${opts.errorPrefix}: retries exhausted`);
}
