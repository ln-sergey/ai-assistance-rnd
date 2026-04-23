# Providers

Кастомные провайдеры Promptfoo для R&D-бенчмарка. По одному файлу на провайдера
(см. CLAUDE.md §6). Общие куски — в `_shared/`.

| Файл | Что делает | Модальность |
|------|------------|-------------|
| `gigachat.ts` | Sber GigaChat (OAuth + /chat/completions + /files для картинок) | text + image |
| `yandex-gpt.ts` | YandexGPT (Api-Key + /foundationModels/v1/completion) | text |
| `yandex-vision.ts` | Двухшаговый пайплайн Yandex Vision → YandexGPT | text + image |
| `_shared/retry.ts` | `withRetry` / `requestWithRetry` + определение сетевых ошибок | — |
| `_shared/parse-prompt.ts` | Парсинг prompt'а Promptfoo (plain, chat-array, OpenAI content parts) | — |
| `_shared/cost.ts` | Longest-prefix матч модели в таблице тарифов + расчёт | — |
| `_shared/types.ts` | `PerTokenPricing`, `ResolvedPricing`, `PromptfooProviderResponse` | — |


## Подключение в конфиге

```yaml
providers:
  - id: yandex-gpt:yandexgpt-lite/latest
    config:
      provider: ./providers/yandex-gpt.ts
      model: yandexgpt-lite/latest
      temperature: 0
      maxTokens: 800

  - id: yandex-vision+yandexgpt
    config:
      provider: ./providers/yandex-vision.ts
      gptModel: yandexgpt/latest
      classifierModels: [moderation, quality]   # опционально

  - id: gigachat:GigaChat-2
    config:
      provider: ./providers/gigachat.ts
      model: GigaChat-2
```

Модель указывается **всегда явно**: у всех трёх провайдеров дефолта нет —
конструктор бросает без `model` / `gptModel`. Это защита от случайного
прогона через самую дорогую модель.


## Переменные окружения

Полный список — в `.env.example`. Минимум для работы:

| Провайдер | Обязательно | Опционально |
|-----------|-------------|-------------|
| `gigachat` | `GIGACHAT_AUTH_KEY`, `GIGACHAT_SCOPE` | `GIGACHAT_OAUTH_URL`, `GIGACHAT_API_URL`, `GIGACHAT_MOCK` |
| `yandex-gpt` | `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` | `YANDEX_LLM_API_URL`, `YANDEX_MOCK` |
| `yandex-vision` | `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` | `YANDEX_VISION_API_URL`, `YANDEX_LLM_API_URL`, `YANDEX_MOCK` |

Для `gigachat` на Node.js без TLS-доверия к Минцифры OAuth-запрос к
`ngw.devices.sberbank.ru` упадёт с `fetch failed` — см. ниже «TLS: сертификат
Минцифры».


## TLS: сертификат Минцифры (нужен для GigaChat)

GigaChat OAuth-эндпоинт (`ngw.devices.sberbank.ru:9443`) подписан корневым
сертификатом Минцифры, которого нет в стандартном store Node.js. Без него
любой запрос падает с `fetch failed` (undici не доверяет chain'у).

### Как получить сертификат

  1. Скачать `russiantrustedca.pem` с [gosuslugi.ru/crt](https://www.gosuslugi.ru/crt) — раздел «Сертификат Минцифры России».
  2. Положить в удобное место (но **не** в репозиторий — `*.pem` в `.gitignore`).

### Как подключить

Нужно, чтобы Node.js стартовал с переменной
`NODE_EXTRA_CA_CERTS=/absolute/path/to/russiantrustedca.pem`. Есть три
способа, работают все — выбирайте по ситуации:

**1. Одноразово в терминале**

```bash
NODE_EXTRA_CA_CERTS=~/certs/russiantrustedca.pem pnpm smoke
NODE_EXTRA_CA_CERTS=~/certs/russiantrustedca.pem pnpm eval:text
```

**2. В shell-профиле (для регулярных прогонов)**

```bash
# ~/.zshrc / ~/.bashrc
export NODE_EXTRA_CA_CERTS="$HOME/certs/russiantrustedca.pem"
```

После этого `pnpm smoke` и `promptfoo eval` работают без префикса.

**3. В Claude Code — чтобы агент мог запускать `pnpm smoke` сам**

Скопируйте шаблон и подставьте путь:

```bash
cp .claude/settings.local.json.example .claude/settings.local.json
# отредактируйте NODE_EXTRA_CA_CERTS внутри
```

`.claude/settings.local.json` в `.gitignore` — пути у всех разные. После
правки **перезапустите сессию Claude Code** (env из settings подхватывается
при старте). Теперь Claude может вызывать `pnpm smoke` и получать
живые ответы GigaChat без дополнительных действий с вашей стороны.

### Проверка

```bash
YANDEX_MOCK=1 GIGACHAT_MOCK=1 pnpm smoke       # всё зелёное без сертификата
pnpm smoke                                     # live — gigachat должен быть OK
```

### Почему не в коде провайдера

Сознательно не читаем `GIGACHAT_CA_BUNDLE` из кода: `NODE_EXTRA_CA_CERTS`
работает глобально для всех `fetch`-вызовов Node, без custom `undici.Agent`.
Это проще, и других российских эндпоинтов со специфичной цепочкой у нас нет.
Если в будущем понадобится изолировать CA именно для gigachat — добавим
`dispatcher` на уровне клиента.


## Mock-режим

Для CI и локальной разработки без ключей:

```bash
YANDEX_MOCK=1 GIGACHAT_MOCK=1 pnpm test
YANDEX_MOCK=1 npx promptfoo eval -c configs/text-moderation.yaml
```

В мок-режиме:
  * провайдер **не обращается к сети** (ни к OAuth, ни к completion, ни к /files);
  * возвращает детерминированную фикстуру `{"violations": [], "verdict": "approve"}`;
  * `tokenUsage` и `latencyMs` заполнены правдоподобными заглушками;
  * `metadata.pricingSource` работает как обычно (ценник берётся из таблицы/override);
  * `cost` рассчитывается — так проще проверять формулу без реальных ключей.

Smoke-тесты пайплайна должны проходить под `*_MOCK=1`. Реальные прогоны
(оценка качества, стабильность, финальные отчёты) — всегда без моков.


## Тарифы

`DEFAULT_PRICING` (в `gigachat.ts` / `yandex-gpt.ts`) и `DEFAULT_VISION_PRICING`
(в `yandex-vision.ts`) — таблицы в коде. Матчинг по модели — longest-prefix
по сепараторам, специфичным для провайдера:

  * GigaChat: `-`, `:`, `/` (`GigaChat-2-Max:2.0.28.2` → `GigaChat-2-Max`);
  * Yandex: `/`, `:` (`yandexgpt/rc` → `yandexgpt/rc`; `yandexgpt-lite` и
    `yandexgpt` — разные модели, `-` сепаратором **не** считается).

Override на конкретный прогон — `config.pricing` в YAML-конфиге Promptfoo:

```yaml
config:
  pricing: { promptPer1k: 0.15, completionPer1k: 0.60 }   # Yandex / GigaChat
  pricing: { perImage: 0.18 }                              # Vision
```

В ответе провайдера `metadata.pricingSource` указывает, откуда цена:

  * `default-table` — матч по `DEFAULT_PRICING` без override;
  * `config` — полный override из YAML (таблица проигнорирована);
  * `merged` — частичный override + недостающие поля из таблицы (или нули, если
    модели нет в таблице);
  * `none` — ни таблицы, ни override; `cost = 0`.

**Перед публикацией отчёта** сверять таблицы с актуальными тарифами провайдера —
цены меняются. Env-переменной для тарифа нет умышленно: он не секрет и должен
жить рядом с кодом.


## Архитектура `yandex-vision`

Двухшаговый пайплайн, см. `ARCHITECTURE.md`:

  1. **Vision** (`POST /vision/v1/batchAnalyze`): картинки из prompt'а отдаются
     в `TEXT_DETECTION` + `CLASSIFIER` (модели `moderation`, `quality` по
     умолчанию). Ответ парсится в `{ocrText, classifierLabels[]}`.
  2. **YandexGPT**: результат Vision вшивается в system-prompt как
     `<vision_output>OCR: ...\nClassifiers: ...</vision_output>` и вместе с
     пользовательским текстом отправляется в completion.

`numRequests: 2`, стоимость считается как сумма (GPT per-1k токены + Vision
per-image × количество картинок). Метаданные ответа содержат
`visionOcrText` (≤500 символов), `visionClassifierTop3`, `folderId`,
`imagesInPrompt`.

При провале Vision GPT **не вызывается** — ошибка пробрасывается наверх.


## Retry-поведение

`_shared/retry.ts::requestWithRetry` ретраит:

  * HTTP 429 и 5xx (точный диапазон — через `shouldRetryStatus`);
  * сетевые ошибки: `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, undici `UND_ERR_*`,
    `TypeError: fetch failed`, `AbortError` **без** пользовательского сигнала;
  * уважает `Retry-After` (секунды или HTTP-дата), фолбэк — экспонента с
    uniform jitter `[0.75; 1.25]`.

Пользовательский `abortSignal` (Ctrl+C в Promptfoo) ретраем не тормозится.


## Как добавить нового провайдера

  1. Создать `providers/<name>.ts` и `providers/<name>.test.ts`.
  2. Использовать `_shared/*`: не копипастить retry / parse-prompt / cost.
  3. Таблицу `DEFAULT_PRICING` положить рядом с кодом провайдера.
  4. Модель — обязательный конфиг; без неё конструктор бросает.
  5. Если провайдер требует ключи — добавить `<NAME>_MOCK=1` short-circuit,
     чтобы тесты и CI работали без секретов.
  6. Обновить `.env.example` и эту таблицу.

Запрещено (см. CLAUDE.md):

  * смешивать провайдеров в один супер-клиент;
  * дефолтить модель (кроме явных исключений типа `moderation`/`quality`
    классификаторов Vision);
  * подключать Qwen / DashScope / OpenRouter до явной отмашки.
