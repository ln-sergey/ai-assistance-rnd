// Юнит-тесты YandexGPT-провайдера. Запуск: pnpm test.
//
// Покрытие:
//   * parsePrompt: plain, chat-массив, {messages}, отклонение image_url,
//     нормализация `function`-роли.
//   * Env-валидация: отсутствие YANDEX_API_KEY / YANDEX_FOLDER_ID → throw.
//   * Client: 200 success (числовой и строковый usage), 429 / 503 / 500 /
//     network → backoff → success, исчерпание maxRetries → throw с префиксом,
//     Retry-After, 400 без retry, user-aborted signal без retry, modelUri,
//     Authorization: Api-Key, folder в заголовке.
//   * resolvePricing + computeCost для всех трёх моделей, override полный и
//     частичный.
//   * Provider: throw без config.model, id() формат, metadata.model /
//     metadata.folderId / metadata.modelVersion, YANDEX_MOCK=1 не бьёт в сеть.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';

import YandexGPTProvider, {
  YandexGPTClient,
  type YandexEnvConfig,
  computeCost,
  parsePrompt,
  resolvePricing,
  yandexGPTMockResponse,
} from './yandex-gpt.js';

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

const ENV: YandexEnvConfig = {
  apiKey: 'AQVN-test-key',
  folderId: 'b1g-folder-id',
  llmApiUrl: 'https://llm.local',
  visionApiUrl: 'https://vision.local',
};

function buildClient(handlers: Array<() => Response | Promise<Response>>): {
  client: YandexGPTClient;
  calls: MockCall[];
  sleeps: number[];
} {
  const { fn, calls } = mockFetch(handlers);
  const sleeps: number[] = [];
  const client = new YandexGPTClient(ENV, {
    fetchImpl: fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    jitter: () => 0.5, // детерминистичный джиттер
  });
  return { client, calls, sleeps };
}

function makeSuccess(textOut = '{"violations":[],"verdict":"approve"}'): Response {
  return jsonRes({
    result: {
      alternatives: [
        { message: { role: 'assistant', text: textOut }, status: 'ALTERNATIVE_STATUS_FINAL' },
      ],
      // Yandex реально возвращает токены строками — тут так же.
      usage: { inputTextTokens: '120', completionTokens: '30', totalTokens: '150' },
      modelVersion: '23.10.2025',
    },
  });
}

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): void | Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ==========================================================================
// parsePrompt
// ==========================================================================

describe('yandex-gpt parsePrompt', () => {
  it('обычную строку превращает в одно user-сообщение', () => {
    const r = parsePrompt('привет, мир');
    assert.deepEqual(r.messages, [{ role: 'user', text: 'привет, мир' }]);
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
    assert.equal(r.messages[0]?.text, 'ты модератор');
    assert.equal(r.messages[1]?.text, 'отзыв: хороший продукт');
  });

  it('принимает форму {messages: [...]}', () => {
    const r = parsePrompt(JSON.stringify({ messages: [{ role: 'user', content: 'ok' }] }));
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0]?.text, 'ok');
  });

  it('бросает с понятной ошибкой на image_url', () => {
    const b64 = Buffer.from('fake').toString('base64');
    assert.throws(
      () =>
        parsePrompt(
          JSON.stringify([
            {
              role: 'user',
              content: [
                { type: 'text', text: 'опиши' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
              ],
            },
          ]),
        ),
      /yandex-vision/i,
    );
  });

  it('некорректный JSON → fallback в plain user', () => {
    const r = parsePrompt('{не json');
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0]?.text, '{не json');
  });

  it('роль function мапится в system', () => {
    const r = parsePrompt(JSON.stringify([{ role: 'function', content: 'tool-out' }]));
    assert.equal(r.messages[0]?.role, 'system');
  });
});

// ==========================================================================
// resolvePricing + computeCost
// ==========================================================================

describe('yandex-gpt resolvePricing', () => {
  it('yandexgpt-lite/latest → из таблицы', () => {
    const r = resolvePricing('yandexgpt-lite/latest');
    assert.equal(r.source, 'default-table');
    assert.equal(r.tableKey, 'yandexgpt-lite');
    assert.equal(r.pricing.promptPer1k, 0.2);
  });

  it('yandexgpt/latest → из таблицы', () => {
    const r = resolvePricing('yandexgpt/latest');
    assert.equal(r.source, 'default-table');
    assert.equal(r.tableKey, 'yandexgpt');
    assert.equal(r.pricing.promptPer1k, 1.2);
  });

  it('yandexgpt/rc → longest-prefix (не "yandexgpt")', () => {
    const r = resolvePricing('yandexgpt/rc');
    assert.equal(r.source, 'default-table');
    assert.equal(r.tableKey, 'yandexgpt/rc');
  });

  it('неизвестная модель → source=none, тариф 0', () => {
    const r = resolvePricing('yandexgpt-ultra');
    assert.equal(r.source, 'none');
    assert.equal(r.pricing.promptPer1k, 0);
  });

  it('полный config-override → source=config', () => {
    const r = resolvePricing('yandexgpt/latest', { promptPer1k: 10, completionPer1k: 20 });
    assert.equal(r.source, 'config');
    assert.equal(r.pricing.promptPer1k, 10);
    assert.equal(r.pricing.completionPer1k, 20);
  });

  it('частичный override + таблица → source=merged', () => {
    const r = resolvePricing('yandexgpt/latest', { promptPer1k: 5 });
    assert.equal(r.source, 'merged');
    assert.equal(r.pricing.promptPer1k, 5);
    assert.equal(r.pricing.completionPer1k, 1.2);
  });
});

describe('yandex-gpt computeCost', () => {
  it('умножает на тариф /1000', () => {
    const c = computeCost(
      { inputTextTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      { promptPer1k: 2, completionPer1k: 6 },
    );
    assert.equal(c, 5);
  });

  it('нулевой тариф → ноль', () => {
    const c = computeCost(
      { inputTextTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      { promptPer1k: 0, completionPer1k: 0 },
    );
    assert.equal(c, 0);
  });
});

// ==========================================================================
// YandexGPTClient — happy path + заголовки
// ==========================================================================

describe('YandexGPTClient.complete — happy path', () => {
  it('отправляет правильные заголовки, тело и возвращает распарсенный ответ', async () => {
    const { client, calls } = buildClient([() => makeSuccess('hello world')]);

    const res = await client.complete({
      model: 'yandexgpt/latest',
      messages: [{ role: 'user', text: 'отзыв' }],
    });

    assert.equal(res.text, 'hello world');
    // Yandex возвращает строки — клиент должен привести к числам.
    assert.equal(res.usage.inputTextTokens, 120);
    assert.equal(res.usage.completionTokens, 30);
    assert.equal(res.usage.totalTokens, 150);
    assert.equal(res.modelVersion, '23.10.2025');

    const call = calls[0];
    assert.ok(call);
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], `Api-Key ${ENV.apiKey}`);
    assert.equal(headers['x-folder-id'], ENV.folderId);
    assert.equal(headers['Content-Type'], 'application/json');
    assert.match(call.url, /\/foundationModels\/v1\/completion$/);
    assert.equal(call.init.method, 'POST');
  });

  it('строит modelUri вида gpt://<folder>/<model>', async () => {
    const { client, calls } = buildClient([() => makeSuccess()]);
    await client.complete({
      model: 'yandexgpt-lite/latest',
      messages: [{ role: 'user', text: 'x' }],
    });
    const body = JSON.parse(calls[0]!.init.body as string) as { modelUri: string };
    assert.equal(body.modelUri, `gpt://${ENV.folderId}/yandexgpt-lite/latest`);
  });

  it('передаёт temperature и maxTokens в completionOptions', async () => {
    const { client, calls } = buildClient([() => makeSuccess()]);
    await client.complete({
      model: 'yandexgpt/latest',
      messages: [{ role: 'user', text: 'x' }],
      temperature: 0.3,
      maxTokens: 500,
    });
    const body = JSON.parse(calls[0]!.init.body as string) as {
      completionOptions: { temperature: number; maxTokens: number; stream: boolean };
    };
    assert.equal(body.completionOptions.temperature, 0.3);
    assert.equal(body.completionOptions.maxTokens, 500);
    assert.equal(body.completionOptions.stream, false);
  });

  it('дефолтная temperature=0 и maxTokens=2000', async () => {
    const { client, calls } = buildClient([() => makeSuccess()]);
    await client.complete({
      model: 'yandexgpt/latest',
      messages: [{ role: 'user', text: 'x' }],
    });
    const body = JSON.parse(calls[0]!.init.body as string) as {
      completionOptions: { temperature: number; maxTokens: number };
    };
    assert.equal(body.completionOptions.temperature, 0);
    assert.equal(body.completionOptions.maxTokens, 2000);
  });

  it('бросает на пустом alternatives', async () => {
    const { client } = buildClient([
      () =>
        jsonRes({
          result: {
            alternatives: [],
            usage: { inputTextTokens: 0, completionTokens: 0, totalTokens: 0 },
            modelVersion: 'x',
          },
        }),
    ]);
    await assert.rejects(
      () => client.complete({ model: 'm', messages: [{ role: 'user', text: 'x' }] }),
      /пустой alternatives/,
    );
  });
});

// ==========================================================================
// YandexGPTClient — retry
// ==========================================================================

describe('YandexGPTClient.complete — retry', () => {
  it('429 → backoff → 200, уважает Retry-After', async () => {
    const { client, calls, sleeps } = buildClient([
      () => jsonRes({}, 429),
      () => jsonRes({}, 429, { 'retry-after': '3' }),
      () => makeSuccess(),
    ]);
    const res = await client.complete({
      model: 'yandexgpt/latest',
      messages: [{ role: 'user', text: 'x' }],
      maxRetries: 3,
      retryBaseMs: 10,
    });
    assert.ok(res.text);
    assert.equal(calls.length, 3);
    assert.equal(sleeps.length, 2);
    assert.equal(sleeps[1], 3000);
  });

  it('503 тоже ретраится', async () => {
    const { client, calls } = buildClient([() => textRes('down', 503), () => makeSuccess()]);
    const res = await client.complete({
      model: 'yandexgpt/latest',
      messages: [{ role: 'user', text: 'x' }],
      maxRetries: 2,
      retryBaseMs: 1,
    });
    assert.ok(res.text);
    assert.equal(calls.length, 2);
  });

  it('500 ретраится (расширенный список 5xx, отличие от GigaChat)', async () => {
    const { client, calls } = buildClient([() => textRes('boom', 500), () => makeSuccess()]);
    const res = await client.complete({
      model: 'yandexgpt/latest',
      messages: [{ role: 'user', text: 'x' }],
      maxRetries: 2,
      retryBaseMs: 1,
    });
    assert.ok(res.text);
    assert.equal(calls.length, 2);
  });

  it('исчерпание retries → error с префиксом "YandexGPT"', async () => {
    const { client } = buildClient([() => jsonRes({}, 429), () => jsonRes({}, 429)]);
    await assert.rejects(
      () =>
        client.complete({
          model: 'yandexgpt/latest',
          messages: [{ role: 'user', text: 'x' }],
          maxRetries: 1,
          retryBaseMs: 1,
        }),
      /YandexGPT 429/,
    );
  });

  it('400 не ретраит — сразу бросает', async () => {
    const { client, calls } = buildClient([() => jsonRes({ error: 'bad' }, 400)]);
    await assert.rejects(
      () =>
        client.complete({
          model: 'm',
          messages: [{ role: 'user', text: 'x' }],
          maxRetries: 3,
          retryBaseMs: 1,
        }),
      /YandexGPT 400/,
    );
    assert.equal(calls.length, 1);
  });

  it('ECONNRESET ретраится и доходит до успеха', async () => {
    const { client, calls } = buildClient([
      () => {
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      },
      () => makeSuccess(),
    ]);
    const res = await client.complete({
      model: 'yandexgpt/latest',
      messages: [{ role: 'user', text: 'x' }],
      maxRetries: 2,
      retryBaseMs: 1,
    });
    assert.ok(res.text);
    assert.equal(calls.length, 2);
  });

  it('undici "fetch failed" с .cause ETIMEDOUT ретраится', async () => {
    const { client, calls } = buildClient([
      () => {
        const e = new TypeError('fetch failed');
        (e as unknown as { cause: unknown }).cause = Object.assign(new Error('timed out'), {
          code: 'UND_ERR_CONNECT_TIMEOUT',
        });
        throw e;
      },
      () => makeSuccess(),
    ]);
    const res = await client.complete({
      model: 'yandexgpt/latest',
      messages: [{ role: 'user', text: 'x' }],
      maxRetries: 2,
      retryBaseMs: 1,
    });
    assert.ok(res.text);
    assert.equal(calls.length, 2);
  });

  it('aborted пользовательский signal → не ретраит', async () => {
    const { client, calls } = buildClient([
      () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      },
    ]);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() =>
      client.complete({
        model: 'yandexgpt/latest',
        messages: [{ role: 'user', text: 'x' }],
        maxRetries: 3,
        retryBaseMs: 1,
        signal: ac.signal,
      }),
    );
    assert.equal(calls.length, 1);
  });
});

// ==========================================================================
// Provider
// ==========================================================================

describe('YandexGPTProvider', () => {
  it('бросает без config.model', () => {
    withEnv({ YANDEX_API_KEY: 'fake', YANDEX_FOLDER_ID: 'fake' }, () => {
      assert.throws(() => new YandexGPTProvider({}), /model обязателен/);
      assert.throws(
        () => new YandexGPTProvider({ config: { model: '' } }),
        /model обязателен/,
      );
    });
  });

  it('бросает без YANDEX_API_KEY', () => {
    withEnv({ YANDEX_API_KEY: undefined, YANDEX_FOLDER_ID: 'fake', YANDEX_MOCK: undefined }, () => {
      assert.throws(
        () => new YandexGPTProvider({ config: { model: 'yandexgpt/latest' } }),
        /YANDEX_API_KEY/,
      );
    });
  });

  it('бросает без YANDEX_FOLDER_ID', () => {
    withEnv({ YANDEX_API_KEY: 'fake', YANDEX_FOLDER_ID: undefined, YANDEX_MOCK: undefined }, () => {
      assert.throws(
        () => new YandexGPTProvider({ config: { model: 'yandexgpt/latest' } }),
        /YANDEX_FOLDER_ID/,
      );
    });
  });

  it('id() формируется как yandexgpt:<model>', () => {
    withEnv({ YANDEX_API_KEY: 'fake', YANDEX_FOLDER_ID: 'fake' }, () => {
      const p = new YandexGPTProvider({ config: { model: 'yandexgpt-lite/latest' } });
      assert.equal(p.id(), 'yandexgpt:yandexgpt-lite/latest');
    });
  });

  it('YANDEX_MOCK=1: callApi не лезет в сеть, возвращает фикстуру', async () => {
    await withEnv({ YANDEX_MOCK: '1' }, async () => {
      const p = new YandexGPTProvider({ config: { model: 'yandexgpt/latest' } });
      const res = await p.callApi('test-prompt');
      assert.equal(res.output, '{"violations":[],"verdict":"approve"}');
      assert.equal(res.tokenUsage?.total, 115);
      assert.equal((res.metadata as Record<string, unknown>).mock, true);
    });
  });

  it('metadata содержит model, folderId, modelVersion, pricingSource', async () => {
    await withEnv({ YANDEX_MOCK: '1' }, async () => {
      const p = new YandexGPTProvider({ config: { model: 'yandexgpt/latest' } });
      const res = await p.callApi('x');
      const meta = res.metadata as Record<string, unknown>;
      assert.equal(meta.model, 'yandexgpt/latest');
      assert.equal(meta.folderId, 'mock-folder');
      assert.equal(meta.modelVersion, 'yandexgpt/latest:mock');
      assert.equal(meta.pricingSource, 'default-table');
    });
  });

  it('yandexGPTMockResponse — возвращает корректную форму', () => {
    const m = yandexGPTMockResponse('yandexgpt-lite/latest');
    assert.ok(m.text.includes('approve'));
    assert.equal(m.usage.totalTokens, 115);
    assert.equal(m.modelVersion, 'yandexgpt-lite/latest:mock');
  });

  it('callApi возвращает error-объект (а не throw) при ошибке парсинга', async () => {
    await withEnv({ YANDEX_MOCK: '1' }, async () => {
      const p = new YandexGPTProvider({ config: { model: 'yandexgpt/latest' } });
      const b64 = Buffer.from('x').toString('base64');
      const res = await p.callApi(
        JSON.stringify([
          {
            role: 'user',
            content: [
              { type: 'text', text: 'x' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
            ],
          },
        ]),
      );
      assert.match(res.error ?? '', /yandex-vision/i);
    });
  });
});
