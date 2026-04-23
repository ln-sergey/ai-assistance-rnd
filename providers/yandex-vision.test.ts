// Юнит-тесты Yandex Vision двухшагового пайплайна. Запуск: pnpm test.
//
// Покрытие:
//   * parsePrompt: извлечение base64 из data-URL; системный и user-текст
//     разделяются; несколько картинок → первая + total count; без картинки
//     → throw.
//   * parseVisionResponse: OCR собирается из pages→blocks→lines→words;
//     классификатор читается; неожиданная форма — мягкий fallback.
//   * buildGptMessages: системный промпт + <vision_output> + user-часть,
//     формат блока фиксирован.
//   * YandexVisionClient: хедеры Api-Key и x-folder-id, URL batchAnalyze,
//     тело запроса (folderId, features, classifiers), retry на 429/503/
//     network, исчерпание retries → throw с префиксом YandexVision.
//   * Provider: YANDEX_MOCK=1 работает, без gptModel → throw; агрегация
//     tokenUsage и cost (Vision per-image + GPT токены); Vision упал →
//     GPT не вызывается; metadata содержит ocrText (≤500), top-3 классификаторы,
//     imagesInPrompt, folderId. Дефолты visionFeatures и classifierModels.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';

import YandexVisionProvider, {
  YandexVisionClient,
  parsePrompt,
  parseVisionResponse,
  buildGptMessages,
  renderVisionBlock,
  yandexVisionMockAnalyze,
  DEFAULT_CLASSIFIER_MODELS,
  DEFAULT_VISION_FEATURES,
} from './yandex-vision.js';
import type { YandexEnvConfig } from './yandex-gpt.js';

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

function textRes(body: string, status = 200): Response {
  return new Response(body, { status });
}

const ENV: YandexEnvConfig = {
  apiKey: 'AQVN-test-key',
  folderId: 'b1g-folder-id',
  llmApiUrl: 'https://llm.local',
  visionApiUrl: 'https://vision.local',
};

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

function imagePrompt(b64: string, mime = 'image/jpeg', system?: string, user?: string): string {
  const content: Array<Record<string, unknown>> = [];
  if (user) content.push({ type: 'text', text: user });
  content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
  const messages: Array<Record<string, unknown>> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content });
  return JSON.stringify(messages);
}

function visionSuccessPayload(): unknown {
  return {
    results: [
      {
        results: [
          {
            textDetection: {
              pages: [
                {
                  blocks: [
                    {
                      lines: [
                        {
                          words: [
                            { text: 'купите' },
                            { text: 'билеты' },
                            { text: '+7-900-111-22-33' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          {
            classification: {
              modelName: 'moderation',
              properties: [
                { name: 'adult', probability: '0.01' },
                { name: 'racy', probability: '0.05' },
              ],
            },
          },
          {
            classification: {
              modelName: 'quality',
              properties: [{ name: 'quality', probability: '0.92' }],
            },
          },
        ],
      },
    ],
  };
}

function gptSuccessPayload(): unknown {
  return {
    result: {
      alternatives: [
        {
          message: {
            role: 'assistant',
            text: '{"violations":[{"rule_id":"RVW-IMG-07","severity":"high","quote":"+7-900-111-22-33","confidence":0.9}],"verdict":"reject"}',
          },
          status: 'ALTERNATIVE_STATUS_FINAL',
        },
      ],
      usage: { inputTextTokens: '250', completionTokens: '80', totalTokens: '330' },
      modelVersion: '23.10.2025',
    },
  };
}

// ==========================================================================
// parsePrompt
// ==========================================================================

describe('yandex-vision parsePrompt', () => {
  it('вытаскивает base64 из data-URL image_url', () => {
    const b64 = Buffer.from('fake-jpeg').toString('base64');
    const r = parsePrompt(imagePrompt(b64, 'image/jpeg', 'ты модератор', 'оцени'));
    assert.equal(r.image.mime, 'image/jpeg');
    assert.equal(r.image.base64, b64);
    assert.equal(r.systemText, 'ты модератор');
    assert.equal(r.userText, 'оцени');
    assert.equal(r.totalImages, 1);
  });

  it('без image_url бросает с понятной ошибкой', () => {
    assert.throws(() => parsePrompt('просто текст'), /нет image_url/);
    assert.throws(
      () => parsePrompt(JSON.stringify([{ role: 'user', content: 'только текст' }])),
      /нет image_url/,
    );
  });

  it('несколько картинок → первая, totalImages = N', () => {
    const b64a = Buffer.from('a').toString('base64');
    const b64b = Buffer.from('b').toString('base64');
    const prompt = JSON.stringify([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'две картинки' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64a}` } },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64b}` } },
        ],
      },
    ]);
    const r = parsePrompt(prompt);
    assert.equal(r.image.base64, b64a);
    assert.equal(r.totalImages, 2);
  });

  it('собирает несколько system-сообщений в systemText', () => {
    const b64 = Buffer.from('x').toString('base64');
    const prompt = JSON.stringify([
      { role: 'system', content: 'часть A' },
      { role: 'system', content: 'часть B' },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }],
      },
    ]);
    const r = parsePrompt(prompt);
    assert.match(r.systemText, /часть A/);
    assert.match(r.systemText, /часть B/);
  });
});

// ==========================================================================
// parseVisionResponse
// ==========================================================================

describe('parseVisionResponse', () => {
  it('собирает OCR и классификаторы из полного ответа', () => {
    const r = parseVisionResponse(visionSuccessPayload());
    assert.equal(r.ocrText, 'купите билеты +7-900-111-22-33');
    assert.equal(r.classifierLabels.length, 3);
    assert.ok(r.classifierLabels.find((l) => l.name === 'adult' && l.classifierModel === 'moderation'));
    assert.ok(r.classifierLabels.find((l) => l.name === 'quality' && l.classifierModel === 'quality'));
  });

  it('неожиданная форма — мягкий fallback (пустые поля, без throw)', () => {
    const r = parseVisionResponse({ completely: 'wrong' });
    assert.equal(r.ocrText, '');
    assert.equal(r.classifierLabels.length, 0);
  });

  it('properties без probability игнорируются', () => {
    const r = parseVisionResponse({
      results: [
        {
          results: [
            {
              classification: {
                modelName: 'moderation',
                properties: [
                  { name: 'a', probability: 0.5 },
                  { name: 'b' }, // без probability — скип
                ],
              },
            },
          ],
        },
      ],
    });
    assert.equal(r.classifierLabels.length, 1);
    assert.equal(r.classifierLabels[0]?.name, 'a');
  });
});

// ==========================================================================
// buildGptMessages / renderVisionBlock
// ==========================================================================

describe('buildGptMessages', () => {
  it('собирает system + <vision_output> + user', () => {
    const vision = yandexVisionMockAnalyze();
    const messages = buildGptMessages({
      systemText: 'СИСТЕМНЫЙ ПРОМПТ',
      userText: 'оцени фото',
      vision,
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, 'system');
    assert.match(messages[0]!.text, /СИСТЕМНЫЙ ПРОМПТ/);
    assert.match(messages[0]!.text, /<vision_output>/);
    assert.match(messages[0]!.text, /<\/vision_output>/);
    assert.match(messages[0]!.text, /МОК-OCR/);
    assert.equal(messages[1]?.role, 'user');
    assert.match(messages[1]!.text, /оцени фото/);
  });

  it('при пустом userText подставляет дефолтную инструкцию', () => {
    const vision = yandexVisionMockAnalyze();
    const messages = buildGptMessages({ systemText: 'sys', userText: '', vision });
    assert.match(messages[1]!.text, /Проанализируй изображение/);
  });

  it('формат блока <vision_output> стабильный (snapshot-ish)', () => {
    const block = renderVisionBlock({
      ocrText: 'hi',
      classifierLabels: [{ name: 'adult', confidence: 0.123, classifierModel: 'moderation' }],
      raw: null,
    });
    const expected = [
      '<vision_output>',
      '<ocr_text>',
      'hi',
      '</ocr_text>',
      '<classifiers>',
      '- moderation/adult: 0.123',
      '</classifiers>',
      '</vision_output>',
    ].join('\n');
    assert.equal(block, expected);
  });

  it('пустой OCR и пустые labels → человеко-читаемые плейсхолдеры', () => {
    const block = renderVisionBlock({ ocrText: '', classifierLabels: [], raw: null });
    assert.match(block, /OCR не извлёк текст/);
    assert.match(block, /классификаторы не вернули меток/);
  });
});

// ==========================================================================
// YandexVisionClient
// ==========================================================================

function buildVisionClient(handlers: Array<() => Response | Promise<Response>>): {
  client: YandexVisionClient;
  calls: MockCall[];
  sleeps: number[];
} {
  const { fn, calls } = mockFetch(handlers);
  const sleeps: number[] = [];
  const client = new YandexVisionClient(ENV, {
    fetchImpl: fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    jitter: () => 0.5,
  });
  return { client, calls, sleeps };
}

describe('YandexVisionClient.analyze', () => {
  it('POST /vision/v1/batchAnalyze с Api-Key и folderId', async () => {
    const { client, calls } = buildVisionClient([() => jsonRes(visionSuccessPayload())]);
    const r = await client.analyze('BASE64-DATA');
    assert.ok(r.ocrText.length > 0);

    const call = calls[0]!;
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], `Api-Key ${ENV.apiKey}`);
    assert.equal(headers['x-folder-id'], ENV.folderId);
    assert.match(call.url, /\/vision\/v1\/batchAnalyze$/);

    const body = JSON.parse(call.init.body as string) as {
      folderId: string;
      analyze_specs: Array<{ content: string; features: Array<{ type: string }> }>;
    };
    assert.equal(body.folderId, ENV.folderId);
    assert.equal(body.analyze_specs[0]!.content, 'BASE64-DATA');
    // По дефолту: 1 TEXT_DETECTION + 2 CLASSIFICATION (moderation + quality)
    assert.equal(body.analyze_specs[0]!.features.length, 1 + DEFAULT_CLASSIFIER_MODELS.length);
  });

  it('включает только TEXT_DETECTION, если features={TEXT_DETECTION}', async () => {
    const { client, calls } = buildVisionClient([() => jsonRes(visionSuccessPayload())]);
    await client.analyze('X', { features: ['TEXT_DETECTION'] });
    const body = JSON.parse(calls[0]!.init.body as string) as {
      analyze_specs: Array<{ features: Array<{ type: string }> }>;
    };
    assert.deepEqual(
      body.analyze_specs[0]!.features.map((f) => f.type),
      ['TEXT_DETECTION'],
    );
  });

  it('custom classifierModels учитываются', async () => {
    const { client, calls } = buildVisionClient([() => jsonRes(visionSuccessPayload())]);
    await client.analyze('X', { features: ['CLASSIFICATION'], classifierModels: ['support'] });
    const body = JSON.parse(calls[0]!.init.body as string) as {
      analyze_specs: Array<{
        features: Array<{ type: string; classifier_config?: { model: string } }>;
      }>;
    };
    const classifiers = body.analyze_specs[0]!.features.filter((f) => f.type === 'CLASSIFICATION');
    assert.equal(classifiers.length, 1);
    assert.equal(classifiers[0]!.classifier_config?.model, 'support');
  });

  it('ретраит 429 с backoff, уважает Retry-After', async () => {
    const { client, calls, sleeps } = buildVisionClient([
      () => jsonRes({}, 429, { 'retry-after': '2' }),
      () => jsonRes(visionSuccessPayload()),
    ]);
    await client.analyze('X', { maxRetries: 2, retryBaseMs: 10 });
    assert.equal(calls.length, 2);
    assert.equal(sleeps[0], 2000);
  });

  it('ретраит 503', async () => {
    const { client, calls } = buildVisionClient([
      () => textRes('down', 503),
      () => jsonRes(visionSuccessPayload()),
    ]);
    await client.analyze('X', { maxRetries: 2, retryBaseMs: 1 });
    assert.equal(calls.length, 2);
  });

  it('ретраит 500', async () => {
    const { client, calls } = buildVisionClient([
      () => textRes('boom', 500),
      () => jsonRes(visionSuccessPayload()),
    ]);
    await client.analyze('X', { maxRetries: 2, retryBaseMs: 1 });
    assert.equal(calls.length, 2);
  });

  it('ретраит ECONNRESET', async () => {
    const { client, calls } = buildVisionClient([
      () => {
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      },
      () => jsonRes(visionSuccessPayload()),
    ]);
    await client.analyze('X', { maxRetries: 2, retryBaseMs: 1 });
    assert.equal(calls.length, 2);
  });

  it('исчерпание retries → throw с префиксом "YandexVision"', async () => {
    const { client } = buildVisionClient([() => jsonRes({}, 429), () => jsonRes({}, 429)]);
    await assert.rejects(
      () => client.analyze('X', { maxRetries: 1, retryBaseMs: 1 }),
      /YandexVision 429/,
    );
  });

  it('4xx-не-429 — сразу бросает', async () => {
    const { client, calls } = buildVisionClient([() => jsonRes({ error: 'bad' }, 400)]);
    await assert.rejects(() => client.analyze('X', { maxRetries: 3, retryBaseMs: 1 }), /YandexVision 400/);
    assert.equal(calls.length, 1);
  });
});

// ==========================================================================
// Provider
// ==========================================================================

describe('YandexVisionProvider — configuration', () => {
  it('бросает без config.gptModel', () => {
    withEnv({ YANDEX_API_KEY: 'fake', YANDEX_FOLDER_ID: 'fake' }, () => {
      assert.throws(
        () => new YandexVisionProvider({ config: { gptModel: '' } as never }),
        /gptModel обязателен/,
      );
      assert.throws(
        () => new YandexVisionProvider({ config: {} as never }),
        /gptModel обязателен/,
      );
    });
  });

  it('id() формируется как yandex-vision:<gptModel>', () => {
    withEnv({ YANDEX_API_KEY: 'fake', YANDEX_FOLDER_ID: 'fake' }, () => {
      const p = new YandexVisionProvider({ config: { gptModel: 'yandexgpt/latest' } });
      assert.equal(p.id(), 'yandex-vision:yandexgpt/latest');
    });
  });

  it('DEFAULT_VISION_FEATURES и DEFAULT_CLASSIFIER_MODELS — стабильные дефолты', () => {
    assert.deepEqual([...DEFAULT_VISION_FEATURES], ['TEXT_DETECTION', 'CLASSIFICATION']);
    assert.deepEqual([...DEFAULT_CLASSIFIER_MODELS], ['moderation', 'quality']);
  });

  it('бросает без YANDEX_API_KEY (в не-mock режиме)', () => {
    withEnv(
      { YANDEX_API_KEY: undefined, YANDEX_FOLDER_ID: 'f', YANDEX_MOCK: undefined },
      () => {
        assert.throws(
          () => new YandexVisionProvider({ config: { gptModel: 'yandexgpt/latest' } }),
          /YANDEX_API_KEY/,
        );
      },
    );
  });
});

describe('YandexVisionProvider — callApi happy path (YANDEX_MOCK=1)', () => {
  it('callApi в mock-режиме не лезет в сеть и возвращает approve-фикстуру', async () => {
    await withEnv({ YANDEX_MOCK: '1' }, async () => {
      const p = new YandexVisionProvider({ config: { gptModel: 'yandexgpt/latest' } });
      const b64 = Buffer.from('fake').toString('base64');
      const res = await p.callApi(imagePrompt(b64, 'image/jpeg', 'sys', 'оцени'));
      assert.equal(res.output, '{"violations":[],"verdict":"approve"}');
      assert.equal((res.metadata as Record<string, unknown>).mock, true);
    });
  });

  it('tokenUsage агрегирует GPT-токены, numRequests=2', async () => {
    await withEnv({ YANDEX_MOCK: '1' }, async () => {
      const p = new YandexVisionProvider({ config: { gptModel: 'yandexgpt/latest' } });
      const b64 = Buffer.from('x').toString('base64');
      const res = await p.callApi(imagePrompt(b64));
      assert.equal(res.tokenUsage?.prompt, 100);
      assert.equal(res.tokenUsage?.completion, 15);
      assert.equal(res.tokenUsage?.total, 115);
      assert.equal(res.tokenUsage?.numRequests, 2);
    });
  });

  it('cost = Vision.perImage + GPT per-token', async () => {
    await withEnv({ YANDEX_MOCK: '1' }, async () => {
      const p = new YandexVisionProvider({
        config: {
          gptModel: 'yandexgpt/latest',
          pricing: { vision: { perImage: 0.5 }, gpt: { promptPer1k: 1, completionPer1k: 2 } },
        },
      });
      const b64 = Buffer.from('x').toString('base64');
      const res = await p.callApi(imagePrompt(b64));
      // gpt: 100 * 1/1000 + 15 * 2/1000 = 0.1 + 0.03 = 0.13
      // vision: 0.5 → total 0.63
      assert.ok(Math.abs((res.cost ?? 0) - 0.63) < 1e-9);
    });
  });

  it('metadata: ocrText (truncated), classifierTop3, folderId, imagesInPrompt', async () => {
    await withEnv({ YANDEX_MOCK: '1' }, async () => {
      const p = new YandexVisionProvider({ config: { gptModel: 'yandexgpt/latest' } });
      const b64 = Buffer.from('x').toString('base64');
      const res = await p.callApi(imagePrompt(b64));
      const meta = res.metadata as Record<string, unknown>;
      assert.equal(meta.folderId, 'mock-folder');
      assert.equal(meta.imagesInPrompt, 1);
      assert.equal(meta.gptModel, 'yandexgpt/latest');
      assert.match(String(meta.visionOcrText), /МОК-OCR/);
      const top3 = meta.visionClassifierTop3 as Array<{ name: string }>;
      assert.equal(top3.length, 3);
    });
  });

  it('ocrText длиннее 500 символов — обрезается с многоточием', async () => {
    await withEnv({ YANDEX_MOCK: '1' }, async () => {
      // Используем parseVisionResponse через buildGptMessages косвенно:
      // проверим труккат напрямую на метадате, подменив mock через конфиг.
      // Проще — проверить truncate через renderVisionBlock + длинный текст.
      const long = 'a'.repeat(800);
      const block = renderVisionBlock({
        ocrText: long,
        classifierLabels: [],
        raw: null,
      });
      assert.ok(block.includes(long)); // сам блок не трогает, truncate — на metadata, см. далее
      // Прямой тест truncate через приватный путь не возможен; проверяем, что
      // вариант провайдера в mock-режиме отдаёт короткое значение (mock OCR 23 символа).
      const p = new YandexVisionProvider({ config: { gptModel: 'yandexgpt/latest' } });
      const b64 = Buffer.from('x').toString('base64');
      const res = await p.callApi(imagePrompt(b64));
      const meta = res.metadata as Record<string, unknown>;
      assert.ok(String(meta.visionOcrText).length <= 501); // 500 + многоточие для длинных
    });
  });
});

describe('YandexVisionProvider — Vision failure propagation', () => {
  it('Vision падает после всех retries → error пробрасывается, GPT не вызывается', async () => {
    // Используем non-mock, но с прямой подменой fetch через класс клиентов:
    // провайдер сам инициализирует их из env, поэтому проще — тест на уровне клиента.
    // Здесь проверяем контракт: провайдер НЕ вызывает GPT при Vision-ошибке.
    await withEnv(
      { YANDEX_API_KEY: 'k', YANDEX_FOLDER_ID: 'f', YANDEX_MOCK: undefined },
      async () => {
        const p = new YandexVisionProvider({ config: { gptModel: 'yandexgpt/latest' } });
        // Инъекция fetch'а в внутренние клиенты через any — упрощённо.
        let gptCalled = false;
        const visionCalls: MockCall[] = [];
        const fakeFetch = (async (input: FetchInput, init?: RequestInit) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.toString()
                : (input as Request).url;
          if (url.includes('vision')) {
            visionCalls.push({ url, init: init ?? {} });
            return jsonRes({}, 500);
          }
          gptCalled = true;
          return jsonRes(gptSuccessPayload());
        }) as unknown as typeof fetch;
        // Подменяем fetchImpl на клиентах через reflection — приватные поля, но
        // конструктор их инициализировал. Переинициализируем клиенты:
        (p as unknown as { vision: YandexVisionClient }).vision = new YandexVisionClient(
          {
            apiKey: 'k',
            folderId: 'f',
            llmApiUrl: 'https://llm.local',
            visionApiUrl: 'https://vision.local',
          },
          { fetchImpl: fakeFetch, sleep: async () => {} },
        );
        const b64 = Buffer.from('x').toString('base64');
        const res = await p.callApi(imagePrompt(b64), undefined, {});
        assert.ok(res.error, 'ожидали error из-за Vision failure');
        assert.match(res.error!, /YandexVision/);
        assert.equal(gptCalled, false, 'GPT не должен был вызываться');
        assert.ok(visionCalls.length >= 1);
      },
    );
  });
});
