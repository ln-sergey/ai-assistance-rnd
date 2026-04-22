// Юнит-тесты GigaChat-провайдера на мок-ответах.
// Запуск: pnpm test (см. package.json → node --import tsx --test ...).
//
// Тестируем отдельно:
//   * OAuth: TTL-кэш, refresh за 2 минуты до истечения, single-flight,
//     форма запроса (Basic, RqUID, body), ошибки 4xx.
//   * Backoff: уважение Retry-After, экспонента, cap.
//   * isRetryableNetworkError: детекция ECONNRESET, ETIMEDOUT, undici-ошибок,
//     `TypeError: fetch failed`, AbortError; отказ на обычных Error.
//   * Chat client: успех, 429→200, 429→429→200 с Retry-After, 503, 400 без
//     retry, network-retry на ECONNRESET, пользовательский abort без retry.
//   * Upload: дедупликация через адаптер кэша, интеграция с диском (моки fs).
//   * DiskFileIdCache: запись → чтение, TTL-истечение, битый JSON.
//   * parsePrompt: plain text, chat array, image_url, fallback.
//   * resolvePricing / computeCost: таблица, config override (полный,
//     частичный), неизвестная модель, longest-prefix match.
//   * GigaChatProvider: throw на отсутствующей модели.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';

import GigaChatProvider, {
  GigaChatOAuthClient,
  GigaChatClient,
  InMemoryFileIdCache,
  DiskFileIdCache,
  type GigaChatEnvConfig,
  computeBackoff,
  computeCost,
  isRetryableNetworkError,
  parsePrompt,
  resolvePricing,
} from './gigachat.js';

// ==========================================================================
// Моки
// ==========================================================================

interface MockCall {
  url: string;
  init: RequestInit;
}

type FetchInput = Parameters<typeof fetch>[0];

function mockFetch(handlers: Array<() => Response | Promise<Response>>): {
  fn: typeof fetch;
  calls: MockCall[];
} {
  let i = 0;
  const calls: MockCall[] = [];
  const fn = (async (input: FetchInput, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init: init ?? {} });
    const handler = handlers[i++];
    if (!handler) throw new Error(`mockFetch: нет обработчика для вызова #${i}`);
    return handler();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textRes(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

const ENV: GigaChatEnvConfig = {
  authKey: 'dGVzdDp0ZXN0', // base64("test:test")
  scope: 'GIGACHAT_API_PERS',
  oauthUrl: 'https://oauth.local/api/v2/oauth',
  apiUrl: 'https://api.local/api/v1',
};

const THIRTY_MIN = 30 * 60 * 1000;

// ==========================================================================
// OAuth
// ==========================================================================

describe('GigaChatOAuthClient', () => {
  it('кэширует токен в пределах TTL минус 2-минутный запас', async () => {
    const now = { t: 1_700_000_000_000 };
    const { fn, calls } = mockFetch([
      () => jsonRes({ access_token: 'tok-1', expires_at: now.t + THIRTY_MIN }),
    ]);
    const client = new GigaChatOAuthClient(ENV, {
      fetchImpl: fn,
      now: () => now.t,
      uuid: () => 'uuid-fixed',
    });

    assert.equal(await client.getAccessToken(), 'tok-1');
    now.t += 10 * 60 * 1000;
    assert.equal(await client.getAccessToken(), 'tok-1');
    assert.equal(calls.length, 1, 'повторный вызов не должен бить сеть');
  });

  it('обновляет токен, когда до истечения осталось менее 2 минут', async () => {
    const now = { t: 1_700_000_000_000 };
    const firstExpires = now.t + THIRTY_MIN;
    const { fn, calls } = mockFetch([
      () => jsonRes({ access_token: 'tok-1', expires_at: firstExpires }),
      () => jsonRes({ access_token: 'tok-2', expires_at: now.t + 60 * 60 * 1000 }),
    ]);
    const client = new GigaChatOAuthClient(ENV, { fetchImpl: fn, now: () => now.t });

    assert.equal(await client.getAccessToken(), 'tok-1');
    now.t = firstExpires - 60 * 1000; // внутри 2-минутной margin-зоны
    assert.equal(await client.getAccessToken(), 'tok-2');
    assert.equal(calls.length, 2);
  });

  it('single-flight: параллельные вызовы делят один refresh', async () => {
    const now = { t: 1_700_000_000_000 };
    type ResolveFn = (r: Response) => void;
    const resolvers: ResolveFn[] = [];
    const { fn, calls } = mockFetch([
      () =>
        new Promise<Response>((r) => {
          resolvers.push(r);
        }),
    ]);
    const client = new GigaChatOAuthClient(ENV, { fetchImpl: fn, now: () => now.t });

    const p1 = client.getAccessToken();
    const p2 = client.getAccessToken();
    const p3 = client.getAccessToken();

    await new Promise((r) => setImmediate(r));
    const resolve = resolvers[0];
    assert.ok(resolve, 'fetch должен был быть вызван');
    resolve(jsonRes({ access_token: 'tok-parallel', expires_at: now.t + THIRTY_MIN }));

    const [a, b, c] = await Promise.all([p1, p2, p3]);
    assert.equal(a, 'tok-parallel');
    assert.equal(b, 'tok-parallel');
    assert.equal(c, 'tok-parallel');
    assert.equal(calls.length, 1);
  });

  it('отправляет Basic auth, RqUID и scope в body', async () => {
    const now = { t: 1 };
    const { fn, calls } = mockFetch([
      () => jsonRes({ access_token: 'x', expires_at: now.t + THIRTY_MIN }),
    ]);
    const client = new GigaChatOAuthClient(ENV, {
      fetchImpl: fn,
      now: () => now.t,
      uuid: () => 'my-rq-uid',
    });
    await client.getAccessToken();

    const call = calls[0];
    assert.ok(call);
    const headers = call.init.headers as Record<string, string>;
    assert.equal(call.url, ENV.oauthUrl);
    assert.equal(call.init.method, 'POST');
    assert.equal(headers['Authorization'], `Basic ${ENV.authKey}`);
    assert.equal(headers['RqUID'], 'my-rq-uid');
    assert.equal(headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(call.init.body, 'scope=GIGACHAT_API_PERS');
  });

  it('бросает понятную ошибку на не-200 OAuth', async () => {
    const { fn } = mockFetch([() => textRes('Unauthorized', 401)]);
    const client = new GigaChatOAuthClient(ENV, { fetchImpl: fn, now: () => 1 });
    await assert.rejects(() => client.getAccessToken(), /OAuth 401/);
  });

  it('после неудачного refresh следующий вызов снова пробует', async () => {
    const now = { t: 1 };
    const { fn, calls } = mockFetch([
      () => textRes('Boom', 500),
      () => jsonRes({ access_token: 'tok-recover', expires_at: now.t + THIRTY_MIN }),
    ]);
    const client = new GigaChatOAuthClient(ENV, { fetchImpl: fn, now: () => now.t });
    await assert.rejects(() => client.getAccessToken());
    assert.equal(await client.getAccessToken(), 'tok-recover');
    assert.equal(calls.length, 2);
  });
});

// ==========================================================================
// Backoff
// ==========================================================================

describe('computeBackoff', () => {
  it('уважает Retry-After (в секундах)', () => {
    assert.equal(
      computeBackoff({ attempt: 0, baseMs: 1000, retryAfterSeconds: 5, jitter: () => 0 }),
      5000,
    );
  });

  it('ограничивается maxMs при больших attempt', () => {
    assert.equal(
      computeBackoff({ attempt: 20, baseMs: 1000, maxMs: 10_000, jitter: () => 1 }),
      10_000,
    );
  });

  it('растёт экспоненциально', () => {
    const a0 = computeBackoff({ attempt: 0, baseMs: 1000, jitter: () => 0.5 });
    const a1 = computeBackoff({ attempt: 1, baseMs: 1000, jitter: () => 0.5 });
    const a2 = computeBackoff({ attempt: 2, baseMs: 1000, jitter: () => 0.5 });
    assert.ok(a1 > a0);
    assert.ok(a2 > a1);
  });

  it('игнорирует отрицательный Retry-After и падает в экспоненту', () => {
    const ms = computeBackoff({ attempt: 1, baseMs: 1000, retryAfterSeconds: -5, jitter: () => 0.5 });
    assert.equal(ms, 2000);
  });
});

// ==========================================================================
// isRetryableNetworkError
// ==========================================================================

describe('isRetryableNetworkError', () => {
  it('детектит ECONNRESET в .code', () => {
    const e = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    assert.equal(isRetryableNetworkError(e), true);
  });

  it('детектит ETIMEDOUT в .code', () => {
    const e = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    assert.equal(isRetryableNetworkError(e), true);
  });

  it('детектит код в .cause (undici wrapping)', () => {
    const cause = Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' });
    const e = new TypeError('fetch failed');
    (e as unknown as { cause: unknown }).cause = cause;
    assert.equal(isRetryableNetworkError(e), true);
  });

  it('детектит generic TypeError: fetch failed без кода', () => {
    assert.equal(isRetryableNetworkError(new TypeError('fetch failed')), true);
  });

  it('детектит AbortError', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    assert.equal(isRetryableNetworkError(e), true);
  });

  it('не ретраит обычный Error без кода и правильного имени', () => {
    assert.equal(isRetryableNetworkError(new Error('oops')), false);
  });

  it('не ретраит не-Error значения', () => {
    assert.equal(isRetryableNetworkError('string'), false);
    assert.equal(isRetryableNetworkError(null), false);
    assert.equal(isRetryableNetworkError(undefined), false);
  });
});

// ==========================================================================
// Chat client
// ==========================================================================

function buildClient(chatHandlers: Array<() => Response | Promise<Response>>): {
  client: GigaChatClient;
  sleeps: number[];
  chatCalls: MockCall[];
} {
  const oauthFetch = mockFetch([
    () => jsonRes({ access_token: 'tk', expires_at: Date.now() + THIRTY_MIN }),
  ]);
  const oauth = new GigaChatOAuthClient(ENV, { fetchImpl: oauthFetch.fn });
  const chatFetch = mockFetch(chatHandlers);
  const sleeps: number[] = [];
  const client = new GigaChatClient(ENV, {
    oauth,
    fetchImpl: chatFetch.fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    jitter: () => 0.5, // детерминированный джиттер
  });
  return { client, sleeps, chatCalls: chatFetch.calls };
}

describe('GigaChatClient.chatCompletion', () => {
  it('возвращает распарсенный ответ на 200', async () => {
    const { client, chatCalls } = buildClient([
      () =>
        jsonRes({
          choices: [
            {
              message: { role: 'assistant', content: '{"verdict":"approve","violations":[]}' },
              index: 0,
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 10, total_tokens: 130 },
          model: 'GigaChat-2-Max:2.0.28.2',
          created: 123,
          object: 'chat.completion',
        }),
    ]);
    const res = await client.chatCompletion({
      model: 'GigaChat-2-Max',
      messages: [{ role: 'user', content: 'отзыв' }],
    });
    assert.equal(res.choices[0]?.message.content, '{"verdict":"approve","violations":[]}');
    assert.equal(res.usage.total_tokens, 130);

    const call = chatCalls[0];
    assert.ok(call);
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer tk');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.match(call.url, /\/chat\/completions$/);
  });

  it('ретраит 429 с backoff, уважает Retry-After', async () => {
    const { client, sleeps, chatCalls } = buildClient([
      () => jsonRes({ message: 'rate limited' }, 429),
      () => jsonRes({ message: 'rate limited' }, 429, { 'retry-after': '2' }),
      () =>
        jsonRes({
          choices: [{ message: { role: 'assistant', content: 'done' }, index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: 'm',
          created: 0,
          object: 'chat.completion',
        }),
    ]);

    const res = await client.chatCompletion(
      { model: 'GigaChat-2-Max', messages: [{ role: 'user', content: 'x' }] },
      { maxRetries: 3, retryBaseMs: 10 },
    );

    assert.equal(res.choices[0]?.message.content, 'done');
    assert.equal(chatCalls.length, 3);
    assert.equal(sleeps.length, 2);
    assert.equal(sleeps[1], 2000); // Retry-After
    assert.equal(sleeps[0], 10); // экспонента * (0.75 + 0.5*0.5) = 10
  });

  it('исчерпание ретраев даёт понятную ошибку', async () => {
    const { client } = buildClient([() => jsonRes({}, 429), () => jsonRes({}, 429)]);
    await assert.rejects(
      () =>
        client.chatCompletion(
          { model: 'm', messages: [{ role: 'user', content: 'x' }] },
          { maxRetries: 1, retryBaseMs: 1 },
        ),
      /GigaChat 429/,
    );
  });

  it('503 тоже ретраится', async () => {
    const { client, chatCalls } = buildClient([
      () => textRes('upstream down', 503),
      () =>
        jsonRes({
          choices: [{ message: { role: 'assistant', content: 'ok' }, index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: 'm',
          created: 0,
          object: 'chat.completion',
        }),
    ]);
    const res = await client.chatCompletion(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { maxRetries: 2, retryBaseMs: 1 },
    );
    assert.equal(res.choices[0]?.message.content, 'ok');
    assert.equal(chatCalls.length, 2);
  });

  it('не ретраит 400 — сразу бросает', async () => {
    const { client, chatCalls } = buildClient([() => jsonRes({ error: 'bad request' }, 400)]);
    await assert.rejects(
      () =>
        client.chatCompletion(
          { model: 'm', messages: [{ role: 'user', content: 'x' }] },
          { maxRetries: 3, retryBaseMs: 1 },
        ),
      /GigaChat 400/,
    );
    assert.equal(chatCalls.length, 1);
  });

  it('ретраит ECONNRESET и доходит до успеха', async () => {
    const { client, chatCalls, sleeps } = buildClient([
      () => {
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      },
      () =>
        jsonRes({
          choices: [{ message: { role: 'assistant', content: 'recovered' }, index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: 'm',
          created: 0,
          object: 'chat.completion',
        }),
    ]);
    const res = await client.chatCompletion(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { maxRetries: 2, retryBaseMs: 5 },
    );
    assert.equal(res.choices[0]?.message.content, 'recovered');
    assert.equal(chatCalls.length, 2);
    assert.equal(sleeps.length, 1);
  });

  it('ретраит undici "fetch failed" с .cause ETIMEDOUT', async () => {
    const { client, chatCalls } = buildClient([
      () => {
        const e = new TypeError('fetch failed');
        (e as unknown as { cause: unknown }).cause = Object.assign(new Error('timed out'), {
          code: 'UND_ERR_CONNECT_TIMEOUT',
        });
        throw e;
      },
      () =>
        jsonRes({
          choices: [{ message: { role: 'assistant', content: 'ok' }, index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: 'm',
          created: 0,
          object: 'chat.completion',
        }),
    ]);
    const res = await client.chatCompletion(
      { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      { maxRetries: 2, retryBaseMs: 1 },
    );
    assert.equal(res.choices[0]?.message.content, 'ok');
    assert.equal(chatCalls.length, 2);
  });

  it('не ретраит при пользовательском aborted signal', async () => {
    const { client, chatCalls } = buildClient([
      () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      },
    ]);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() =>
      client.chatCompletion(
        { model: 'm', messages: [{ role: 'user', content: 'x' }] },
        { maxRetries: 3, retryBaseMs: 1, signal: ac.signal },
      ),
    );
    assert.equal(chatCalls.length, 1, 'должен был быть один вызов без ретраев');
  });

  it('не ретраит обычный Error без известного кода', async () => {
    const { client, chatCalls } = buildClient([
      () => {
        throw new Error('something unexpected');
      },
    ]);
    await assert.rejects(
      () =>
        client.chatCompletion(
          { model: 'm', messages: [{ role: 'user', content: 'x' }] },
          { maxRetries: 3, retryBaseMs: 1 },
        ),
      /something unexpected/,
    );
    assert.equal(chatCalls.length, 1);
  });
});

// ==========================================================================
// Upload (картинки для vision)
// ==========================================================================

describe('GigaChatClient.uploadImage', () => {
  it('загружает один раз и переиспользует file_id для того же содержимого', async () => {
    const oauthFetch = mockFetch([
      () => jsonRes({ access_token: 'tk', expires_at: Date.now() + THIRTY_MIN }),
    ]);
    const oauth = new GigaChatOAuthClient(ENV, { fetchImpl: oauthFetch.fn });
    const uploadFetch = mockFetch([() => jsonRes({ id: 'file-abc' })]);
    const client = new GigaChatClient(ENV, {
      oauth,
      fetchImpl: uploadFetch.fn,
      sleep: async () => {},
      fileCache: new InMemoryFileIdCache(),
    });

    const b64 = Buffer.from('fake-png-bytes').toString('base64');
    const id1 = await client.uploadImage({ base64: b64, mime: 'image/png' });
    const id2 = await client.uploadImage({ base64: b64, mime: 'image/png' });

    assert.equal(id1, 'file-abc');
    assert.equal(id2, 'file-abc');
    assert.equal(uploadFetch.calls.length, 1, 'второй upload должен быть из кэша');

    const call = uploadFetch.calls[0];
    assert.ok(call);
    assert.match(call.url, /\/files$/);
    assert.equal(call.init.method, 'POST');
    assert.ok(call.init.body instanceof FormData);
  });

  it('бросает, если /files не вернул id', async () => {
    const oauthFetch = mockFetch([
      () => jsonRes({ access_token: 'tk', expires_at: Date.now() + THIRTY_MIN }),
    ]);
    const oauth = new GigaChatOAuthClient(ENV, { fetchImpl: oauthFetch.fn });
    const uploadFetch = mockFetch([() => jsonRes({})]);
    const client = new GigaChatClient(ENV, {
      oauth,
      fetchImpl: uploadFetch.fn,
      sleep: async () => {},
      fileCache: new InMemoryFileIdCache(),
    });
    await assert.rejects(
      () => client.uploadImage({ base64: Buffer.from('x').toString('base64'), mime: 'image/jpeg' }),
      /нет id/,
    );
  });
});

// ==========================================================================
// DiskFileIdCache
// ==========================================================================

describe('DiskFileIdCache', () => {
  function makeFakeFs(): {
    cache: DiskFileIdCache;
    files: Map<string, string>;
    mkdirs: string[];
    now: { t: number };
  } {
    const files = new Map<string, string>();
    const mkdirs: string[] = [];
    const now = { t: 1_000_000_000_000 };
    const cache = new DiskFileIdCache('/tmp/test/gigachat-files.json', {
      ttlMs: 24 * 60 * 60 * 1000,
      now: () => now.t,
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) {
          const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          throw err;
        }
        return v;
      },
      writeFile: async (p, d) => {
        files.set(p, d);
      },
      mkdir: async (p) => {
        mkdirs.push(p);
      },
    });
    return { cache, files, mkdirs, now };
  }

  it('set → get возвращает тот же id', async () => {
    const { cache } = makeFakeFs();
    await cache.set('hash1', 'file-1');
    assert.equal(await cache.get('hash1'), 'file-1');
  });

  it('пишет на диск после set и создаёт директорию', async () => {
    const { cache, files, mkdirs } = makeFakeFs();
    await cache.set('hash1', 'file-1');
    assert.ok(files.get('/tmp/test/gigachat-files.json'));
    assert.deepEqual(mkdirs, ['/tmp/test']);
  });

  it('читает существующий файл при первом get', async () => {
    const { cache, files } = makeFakeFs();
    files.set(
      '/tmp/test/gigachat-files.json',
      JSON.stringify({ hash1: { id: 'file-1', uploadedAt: 1_000_000_000_000 } }),
    );
    assert.equal(await cache.get('hash1'), 'file-1');
  });

  it('TTL 24ч: истёкший entry возвращает null', async () => {
    const { cache, files, now } = makeFakeFs();
    files.set(
      '/tmp/test/gigachat-files.json',
      JSON.stringify({ hash1: { id: 'file-1', uploadedAt: now.t - 25 * 60 * 60 * 1000 } }),
    );
    assert.equal(await cache.get('hash1'), null);
  });

  it('TTL 24ч: свежий entry (< 24ч) возвращает id', async () => {
    const { cache, files, now } = makeFakeFs();
    files.set(
      '/tmp/test/gigachat-files.json',
      JSON.stringify({ hash1: { id: 'file-1', uploadedAt: now.t - 23 * 60 * 60 * 1000 } }),
    );
    assert.equal(await cache.get('hash1'), 'file-1');
  });

  it('битый JSON — стартуем с пустого кэша', async () => {
    const { cache, files } = makeFakeFs();
    files.set('/tmp/test/gigachat-files.json', 'not-json{{{');
    assert.equal(await cache.get('anything'), null);
    await cache.set('hash1', 'file-1');
    assert.equal(await cache.get('hash1'), 'file-1');
  });

  it('отсутствие файла — пустой кэш без ошибок', async () => {
    const { cache } = makeFakeFs();
    assert.equal(await cache.get('missing'), null);
  });
});

// ==========================================================================
// parsePrompt
// ==========================================================================

describe('parsePrompt', () => {
  it('обычную строку превращает в одно user-сообщение', () => {
    const r = parsePrompt('привет, мир');
    assert.deepEqual(r.messages, [{ role: 'user', content: 'привет, мир' }]);
    assert.equal(r.images.length, 0);
  });

  it('парсит OpenAI-совместимый chat-массив', () => {
    const r = parsePrompt(
      JSON.stringify([
        { role: 'system', content: 'ты модератор' },
        { role: 'user', content: 'отзыв: хороший продукт' },
      ]),
    );
    assert.equal(r.messages.length, 2);
    assert.equal(r.messages[0]?.role, 'system');
    assert.equal(r.messages[1]?.content, 'отзыв: хороший продукт');
  });

  it('извлекает image_url и возвращает base64 + mime', () => {
    const b64 = Buffer.from('png-bytes').toString('base64');
    const r = parsePrompt(
      JSON.stringify([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'опиши картинку' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        },
      ]),
    );
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0]?.content, 'опиши картинку');
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0]?.mime, 'image/png');
    assert.equal(r.images[0]?.base64, b64);
    assert.equal(r.images[0]?.messageIndex, 0);
  });

  it('некорректный JSON → fallback в plain user', () => {
    const r = parsePrompt('{не json');
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0]?.content, '{не json');
  });

  it('принимает форму { messages: [...] }', () => {
    const r = parsePrompt(JSON.stringify({ messages: [{ role: 'user', content: 'ok' }] }));
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0]?.content, 'ok');
  });

  it('неизвестная роль нормализуется в user', () => {
    const r = parsePrompt(JSON.stringify([{ role: 'invalid', content: 'x' }]));
    assert.equal(r.messages[0]?.role, 'user');
  });
});

// ==========================================================================
// resolvePricing + computeCost
// ==========================================================================

describe('resolvePricing', () => {
  it('точный матч из таблицы — source=default-table', () => {
    const r = resolvePricing('GigaChat-2-Max');
    assert.equal(r.source, 'default-table');
    assert.equal(r.tableKey, 'GigaChat-2-Max');
    assert.equal(r.pricing.promptPer1k, 1.95);
  });

  it('префиксный матч по билд-суффиксу ":"', () => {
    const r = resolvePricing('GigaChat-2-Max:2.0.28.2');
    assert.equal(r.source, 'default-table');
    assert.equal(r.tableKey, 'GigaChat-2-Max');
  });

  it('префиксный матч по "-preview"', () => {
    const r = resolvePricing('GigaChat-2-Max-preview');
    assert.equal(r.source, 'default-table');
    assert.equal(r.tableKey, 'GigaChat-2-Max');
  });

  it('longest-prefix: Max побеждает над более коротким', () => {
    const r = resolvePricing('GigaChat-2-Max-something');
    assert.equal(r.tableKey, 'GigaChat-2-Max');
    // Lite/Pro короче Max по длине, не могут перехватить
    assert.equal(r.pricing.promptPer1k, 1.95);
  });

  it('неизвестная модель без override → source=none, тариф 0', () => {
    const r = resolvePricing('GigaChat-666-Ultra');
    assert.equal(r.source, 'none');
    assert.equal(r.tableKey, undefined);
    assert.equal(r.pricing.promptPer1k, 0);
    assert.equal(r.pricing.completionPer1k, 0);
  });

  it('полный config-override → source=config (таблица игнорируется)', () => {
    const r = resolvePricing('GigaChat-2-Max', { promptPer1k: 10, completionPer1k: 20 });
    assert.equal(r.source, 'config');
    assert.equal(r.pricing.promptPer1k, 10);
    assert.equal(r.pricing.completionPer1k, 20);
  });

  it('частичный override + таблица → source=merged', () => {
    const r = resolvePricing('GigaChat-2-Max', { promptPer1k: 10 });
    assert.equal(r.source, 'merged');
    assert.equal(r.pricing.promptPer1k, 10);
    assert.equal(r.pricing.completionPer1k, 1.95); // из таблицы
  });

  it('частичный override без таблицы → source=merged с 0 для недозаданных', () => {
    const r = resolvePricing('Unknown', { promptPer1k: 5 });
    assert.equal(r.source, 'merged');
    assert.equal(r.pricing.promptPer1k, 5);
    assert.equal(r.pricing.completionPer1k, 0);
  });
});

describe('computeCost', () => {
  it('умножает на тариф /1000', () => {
    const c = computeCost(
      { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      { promptPer1k: 2, completionPer1k: 6 },
    );
    assert.equal(c, 5);
  });

  it('нулевой тариф → ноль', () => {
    const c = computeCost(
      { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      { promptPer1k: 0, completionPer1k: 0 },
    );
    assert.equal(c, 0);
  });

  it('дробные тарифы считаются корректно', () => {
    const c = computeCost(
      { prompt_tokens: 250, completion_tokens: 100, total_tokens: 350 },
      { promptPer1k: 0.2, completionPer1k: 0.6 },
    );
    assert.ok(Math.abs(c - 0.11) < 1e-9);
  });
});

// ==========================================================================
// GigaChatProvider (минимум, без реальных вызовов)
// ==========================================================================

describe('GigaChatProvider', () => {
  it('бросает, если config.model не задан', () => {
    const prev = process.env.GIGACHAT_AUTH_KEY;
    process.env.GIGACHAT_AUTH_KEY = 'fake';
    try {
      assert.throws(() => new GigaChatProvider({}), /model обязателен/);
      assert.throws(
        () => new GigaChatProvider({ config: { model: '' } }),
        /model обязателен/,
      );
    } finally {
      if (prev === undefined) delete process.env.GIGACHAT_AUTH_KEY;
      else process.env.GIGACHAT_AUTH_KEY = prev;
    }
  });

  it('инициализируется с явно заданной моделью', () => {
    const prev = process.env.GIGACHAT_AUTH_KEY;
    process.env.GIGACHAT_AUTH_KEY = 'fake';
    try {
      const p = new GigaChatProvider({ config: { model: 'GigaChat-2-Lite' } });
      assert.equal(p.id(), 'gigachat:GigaChat-2-Lite');
    } finally {
      if (prev === undefined) delete process.env.GIGACHAT_AUTH_KEY;
      else process.env.GIGACHAT_AUTH_KEY = prev;
    }
  });
});
