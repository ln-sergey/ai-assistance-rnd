// Smoke-test: прогоняет один и тот же промпт через всех провайдеров.
// Нужен для sanity-check'а перед тем как запускать полный бенчмарк:
// если здесь что-то не работает — разбираемся до `promptfoo eval`.
//
// Запуск:
//   pnpm tsx scripts/smoke-test.ts                  # живые запросы
//   YANDEX_MOCK=1 GIGACHAT_MOCK=1 pnpm tsx scripts/smoke-test.ts   # без ключей
//   pnpm tsx scripts/smoke-test.ts --only=yandex-gpt,gigachat      # подмножество
//
// Выход: 0 — все ОК; 1 — хотя бы один провайдер упал.

import 'dotenv/config';

import GigaChatProvider from '../providers/gigachat.js';
import YandexGPTProvider from '../providers/yandex-gpt.js';
import YandexVisionProvider from '../providers/yandex-vision.js';
import type { PromptfooProviderResponse } from '../providers/_shared/types.js';

// ==========================================================================
// Фикстуры
// ==========================================================================

// Короткая карточка продукта, намеренно безобидная — smoke-тест не про
// качество классификации, а про «пайплайн собран, ответ пришёл, JSON валидный».
const SAMPLE_CARD =
  'Пешеходная экскурсия по Санкт-Петербургу. Сбор у Казанского собора, длительность 2 часа, группа до 10 человек. Маршрут по Невскому и набережным, рассказ об истории XIX века.';

const TEXT_PROMPT = [
  {
    role: 'system',
    content:
      'Ты — модератор карточек продуктов на маркетплейсе туристических активностей. ' +
      'Верни строго JSON вида {"violations":[],"verdict":"approve"|"needs_review"|"reject"}. ' +
      'Без комментариев и markdown.',
  },
  { role: 'user', content: `Карточка активности для модерации:\n\n${SAMPLE_CARD}` },
];

// 1x1 прозрачный PNG в base64 — минимальный валидный файл, которого достаточно
// чтобы дёрнуть Vision pipeline. В живом режиме Vision вернёт пустой OCR и
// низкие confidence у классификаторов — это всё, что нужно от smoke-теста.
const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

const VISION_PROMPT = [
  {
    role: 'system',
    content:
      'Ты — модератор фотографий карточек на маркетплейсе экскурсий. Верни строго JSON ' +
      '{"violations":[],"verdict":"approve"|"needs_review"|"reject"}. Без markdown.',
  },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'Проверь фото галереи карточки активности на допустимость.' },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}` },
      },
    ],
  },
];

// ==========================================================================
// Сборка списка провайдеров
// ==========================================================================

interface SmokeTarget {
  name: string;
  /** JSON-строка — в таком виде Promptfoo передаёт chat-формат промпта. */
  prompt: string;
  run: () => Promise<PromptfooProviderResponse>;
}

function buildTargets(): SmokeTarget[] {
  const textPrompt = JSON.stringify(TEXT_PROMPT);
  const visionPrompt = JSON.stringify(VISION_PROMPT);

  return [
    {
      name: 'gigachat (text)',
      prompt: textPrompt,
      run: () => {
        // GigaChat — базовая модель, доступна на GIGACHAT_API_PERS всегда.
        // Для полного бенчмарка в YAML-конфиге указывать конкретную версию
        // (GigaChat-2, GigaChat-2-Pro, GigaChat-2-Max), проверив её доступность
        // в скоупе ключа.
        const p = new GigaChatProvider({
          config: { model: 'GigaChat', temperature: 0 },
        });
        return p.callApi(textPrompt);
      },
    },
    {
      name: 'yandex-gpt (text)',
      prompt: textPrompt,
      run: () => {
        const p = new YandexGPTProvider({
          config: { model: 'yandexgpt-lite/latest', temperature: 0 },
        });
        return p.callApi(textPrompt);
      },
    },
    {
      name: 'yandex-vision (image + text)',
      prompt: visionPrompt,
      run: () => {
        const p = new YandexVisionProvider({
          config: { gptModel: 'yandexgpt-lite/latest', temperature: 0 },
        });
        return p.callApi(visionPrompt);
      },
    },
  ];
}

// ==========================================================================
// CLI
// ==========================================================================

function parseOnlyFilter(argv: string[]): Set<string> | null {
  const arg = argv.find((a) => a.startsWith('--only='));
  if (!arg) return null;
  const raw = arg.slice('--only='.length).trim();
  if (raw.length === 0) return null;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function matchesFilter(name: string, filter: Set<string> | null): boolean {
  if (!filter) return true;
  // Пользователь пишет `--only=gigachat,yandex-gpt` — матчим по префиксу имени.
  return [...filter].some((f) => name.startsWith(f));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + `… [+${s.length - n} chars]`;
}

function formatCost(v: number | undefined): string {
  if (v === undefined || v === 0) return '0 ₽';
  return `${v.toFixed(6)} ₽`;
}

function printResponse(name: string, resp: PromptfooProviderResponse): boolean {
  const ok = resp.error === undefined;
  const marker = ok ? 'OK ' : 'ERR';
  console.log(`\n── [${marker}] ${name} ─────────────────────────────────────`);
  if (!ok) {
    console.log(`  error:     ${resp.error}`);
    console.log(`  latency:   ${resp.latencyMs ?? '?'} ms`);
    return false;
  }
  const meta = resp.metadata ?? {};
  const usage = resp.tokenUsage ?? {};
  console.log(`  model:     ${String(meta.model ?? meta.modelVersion ?? '?')}`);
  console.log(`  latency:   ${resp.latencyMs ?? '?'} ms`);
  console.log(
    `  tokens:    prompt=${usage.prompt ?? '?'} completion=${usage.completion ?? '?'} ` +
      `total=${usage.total ?? '?'} requests=${usage.numRequests ?? 1}`,
  );
  const pricingSrc =
    meta.pricingSource ??
    (meta.gptPricingSource !== undefined || meta.visionPricingSource !== undefined
      ? `gpt=${String(meta.gptPricingSource ?? '?')}, vision=${String(meta.visionPricingSource ?? '?')}`
      : '?');
  console.log(`  cost:      ${formatCost(resp.cost)}  (${pricingSrc})`);
  if (meta.mock) console.log(`  mode:      MOCK`);
  if (meta.visionOcrText !== undefined) {
    console.log(`  vision.ocr:         ${truncate(String(meta.visionOcrText), 120)}`);
    console.log(`  vision.classifiers: ${JSON.stringify(meta.visionClassifierTop3)}`);
  }
  console.log(`  output:`);
  console.log(
    (resp.output ?? '')
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n'),
  );
  return true;
}

async function main(): Promise<void> {
  const filter = parseOnlyFilter(process.argv.slice(2));
  const targets = buildTargets().filter((t) => matchesFilter(t.name, filter));

  if (targets.length === 0) {
    console.error('smoke-test: --only не совпал ни с одним провайдером');
    process.exit(2);
  }

  console.log('smoke-test: провайдеры =', targets.map((t) => t.name).join(', '));
  console.log('smoke-test: YANDEX_MOCK =', process.env.YANDEX_MOCK ?? '(unset)');
  console.log('smoke-test: GIGACHAT_MOCK =', process.env.GIGACHAT_MOCK ?? '(unset)');

  let failures = 0;
  for (const t of targets) {
    try {
      const resp = await t.run();
      if (!printResponse(t.name, resp)) failures++;
    } catch (e) {
      console.log(`\n── [ERR] ${t.name} ─────────────────────────────────────`);
      console.log(`  throw: ${e instanceof Error ? e.message : String(e)}`);
      failures++;
    }
  }

  console.log(
    `\nsmoke-test: готово. ok=${targets.length - failures} / fail=${failures} / total=${targets.length}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
