# ТЗ — парсинг реальных карточек (Sprint P1–P2)

Следующая сессия(и) Claude Code. Этот документ самодостаточен: читается
«с холода», предполагает только знание `CLAUDE.md`, `ARCHITECTURE.md`,
`rules.yaml`, `docs/data-sources.md` и двух JSON Schema в
`datasets/schema/`.

## Цель

Собрать **реальные карточки продуктов** с 4 утверждённых источников в
JSONL-датасет, соответствующий `product_card.schema.json`. Карточки не
размечаются на нарушения и не обрабатываются синтетикой — этим занимаются
последующие спринты.

## Scope / Out of scope

**In scope:**

- Код парсеров в `scripts/parse/` (TypeScript, `pnpm`).
- Harvesting URL-кандидатов через sitemap.xml с учётом диверсификации.
- HTTP-клиент с политикой «вежливого» фетчинга и дисковым HTML-кэшем.
- Извлечение полей `product_card` из HTML + JSON-LD (если есть).
- Скачивание изображений карточек в `datasets/images/` + манифест.
- Валидация каждой карточки против `product_card.schema.json`.
- Текстовый summary-отчёт по результату сбора.

**Out of scope (явное решение пользователя):**

- Ручная валидация baseline и разметка «грязных» реальных карточек на
  `expected_violations` — отдельный спринт.
- Генерация синтетических текстовых кейсов — отдельный спринт.
- Разметка изображений (image_case) — отдельный спринт.

Из этого следует: **парсеры НЕ оборачивают карточки в `test_case`**.
Они выдают «сырые» `product_card` + метаданные происхождения. Обёртка в
`test_case` и проставление `expected_violations` — работа следующего
этапа.

## Утверждённые объёмы

По [project memory / data-sources.md](data-sources.md):

| Источник        | Цель    | `product_type` |
|-----------------|---------|----------------|
| sputnik8.com    | 25–30   | excursion      |
| pmpoperator.ru  | 10–15   | tour/excursion |
| scantour.ru     | 10–15   | tour/excursion |
| afisha.ru       | 5–10    | event          |

Итого **50–70 реальных карточек**. Распределение по городам: СПб ~40 %,
Москва ~25 %, регионы ~25 %, прочее ~10 % (sputnik8 — основной рычаг
диверсификации).

## Декомпозиция

### Sprint P1 — инфраструктура + пилот sputnik8

**Цель спринта**: end-to-end пайплайн работает на одном самом богатом
источнике. 5–10 карточек sputnik8 распарсены, скачаны, провалидированы.
Архитектура проверена; дальше — масштабирование, не проектирование.

Выбор пилота sputnik8 неслучаен: у него максимум полей схемы
(включая `group_size` и `languages`, которых нет у остальных) — если
пайплайн вытащит их корректно, на других источниках будет проще.

**Deliverables P1:**

1. `scripts/parse/lib/` — общие утилиты (см. §«Технический дизайн»).
2. `scripts/parse/harvest-sputnik8.ts` — извлекает URL-кандидаты из
   sitemap.xml с диверсификацией по городам. Выход:
   `datasets/sputnik8/urls.txt`.
3. `scripts/parse/parse-sputnik8.ts` — парсит URL из файла, пишет
   `datasets/sputnik8/cards.raw.jsonl` и
   `datasets/sputnik8/images.raw.jsonl`.
4. `scripts/parse/download-images.ts` — универсальный, читает любой
   `*/images.raw.jsonl` и складывает файлы в `datasets/images/`.
5. `scripts/parse/validate.ts` — универсальный валидатор JSONL против
   схем.
6. `scripts/parse/summary.ts` — печатает таблицу покрытия полей по
   источнику (см. §«Отчёт»).
7. pnpm-скрипты в `package.json`:
   `harvest:sputnik8`, `parse:sputnik8`, `images:download`,
   `parse:validate`, `parse:summary`.

**DoD P1:**

- Минимум **5 карточек** sputnik8 в `cards.raw.jsonl` проходят
  `product_card.schema.json`.
- Для каждой — скачаны cover и 2–3 изображения галереи в
  `datasets/images/`.
- `parse:summary` печатает отчёт: сколько карточек, какие поля
  заполнены / пустые, какие отвалились и почему.
- Нет нарушений `robots.txt`; User-Agent честный; задержка между
  запросами ≥ 2 с.
- `pnpm build` проходит, `tsc --noEmit` чистый.

### Sprint P2 — масштабирование

**Цель**: полный объём 50–70 карточек.

**Deliverables P2:**

1. `parse-pmpoperator.ts` + `harvest-pmpoperator.ts`.
2. `parse-scantour.ts` + `harvest-scantour.ts`.
3. `parse-afisha.ts` + `harvest-afisha.ts` — с учётом, что у афиши
   `product_type: event` и структура тоньше (см. §«Особые требования»).
4. Полный прогон: `pnpm parse:all` последовательно дергает все 4.
5. Обновлённый `parse:summary` по всем источникам.

**DoD P2:**

- Собрано **≥ 50 карточек**, ≥ 90 % проходят схему.
- `reports/parse-<date>.md` — автосгенерированный отчёт по наполнению.
- Карточки, не прошедшие валидацию, лежат в
  `datasets/<source>/cards.rejected.jsonl` с причиной ошибки — не
  выбрасываются молча.

## Технический дизайн

### Структура каталога

```
scripts/parse/
├── lib/
│   ├── http.ts              # polite fetch + disk cache
│   ├── sitemap.ts           # парсинг sitemap.xml/sitemap_index.xml
│   ├── html.ts              # cheerio-хелперы (extractText, extractImages, normaliseUrl)
│   ├── json-ld.ts           # вытаскивает <script type="application/ld+json">
│   ├── schema.ts            # ajv-валидатор product_card + image_case
│   ├── image-id.ts          # генерация стабильных image_id
│   └── polite-queue.ts      # последовательная очередь с Crawl-delay
├── harvest-sputnik8.ts
├── harvest-pmpoperator.ts
├── harvest-scantour.ts
├── harvest-afisha.ts
├── parse-sputnik8.ts
├── parse-pmpoperator.ts
├── parse-scantour.ts
├── parse-afisha.ts
├── download-images.ts
├── validate.ts
└── summary.ts

datasets/
├── sputnik8/
│   ├── urls.txt             # плоский список URL, один на строку
│   ├── html-cache/          # gitignored, сырой HTML для дебага
│   ├── cards.raw.jsonl      # по одному card-объекту на строку
│   ├── cards.rejected.jsonl # не прошедшие валидацию + причина
│   └── images.raw.jsonl
├── pmpoperator/             # аналогично
├── scantour/
├── afisha/
└── images/                  # общая плоская папка, gitignored
    └── <image_id>.{jpg,png}
```

`html-cache/` и `images/` попадают в `.gitignore`.
`cards.raw.jsonl` и `urls.txt` коммитятся.

### Формат `cards.raw.jsonl`

Одна строка = один JSON:

```json
{
  "card": { /* product_card, валидный по product_card.schema.json */ },
  "_meta": {
    "source_site": "sputnik8",
    "source_url": "https://sputnik8.com/ru/moscow/activities/24725-...",
    "fetched_at": "2026-04-25T12:34:56Z",
    "parser_version": "v1",
    "json_ld_found": true
  }
}
```

`_meta` **не проходит схему** — это side-channel. Валидатор смотрит
только на `.card`. `_meta.source_url` понадобится следующему спринту
(разметке) для `notes` в `test_case`.

### Формат `images.raw.jsonl`

Одна строка:

```json
{
  "image_id": "sputnik8_24725_0",
  "linked_card_id": "sputnik8_24725",
  "role": "cover",
  "caption": null,
  "source_url": "https://sputnik8.com/.../image.jpg",
  "file_path": "datasets/images/sputnik8_24725_0.jpg",
  "_meta": {
    "downloaded_at": "2026-04-25T12:35:02Z",
    "content_type": "image/jpeg",
    "size_bytes": 184392
  }
}
```

### `product_card.id` — наименование

Префикс источника + стабильный id из URL:

| Источник       | Шаблон `card.id`                                  |
|----------------|---------------------------------------------------|
| sputnik8       | `sputnik8_<numeric_id>` (напр. `sputnik8_24725`)  |
| pmpoperator    | `pmpoperator_<slug>`                              |
| scantour       | `scantour_<slug>`                                 |
| afisha         | `afisha_<type>_<numeric_id>` (concert/performance)|

`image_id` = `<card.id>_<index>`, index от 0. Cover — всегда `_0`.

### HTTP-клиент (`lib/http.ts`)

- **User-Agent**: `LocaltripBench/1.0 (R&D; contact: lsergio2001@gmail.com)`.
  Честно идентифицироваться — базовая вежливость; некоторые сайты при
  анонимных UA отдают 403.
- **Accept-Language**: `ru,en;q=0.5`.
- **Таймаут**: 30 с.
- **Ретрай**: 2 попытки на 5xx/сетевые ошибки, экспоненциальный бэкофф
  (1 с → 3 с). 4xx не ретраим. Эти правила **совпадают с теми, что уже
  описаны в `CLAUDE.md` §8**, но это другой клиент (parser ≠ LLM-
  provider), так что свой код.
- **Дисковый кэш**: HTML сохраняется в
  `datasets/<source>/html-cache/<sha1(url)>.html` + `.headers.json`.
  Перед новым запросом — проверка кэша (TTL 7 дней). Это позволяет
  итерировать парсер без повторных сетевых запросов и без нагрузки на
  хост.
- **Crawl-delay**: если в `robots.txt` указан `Crawl-delay: N`, ждём N
  секунд; иначе дефолт **2 секунды** между запросами к **одному хосту**.
- **robots.txt**: перед первым запросом к хосту скачиваем и парсим.
  Каждый URL проверяется против правил для нашего User-Agent (и `*`).
  При disallow — пропуск + лог в `datasets/<source>/skipped.txt` с
  причиной. **Не обходим молча.**
- `scantour.ru` серая зона `Disallow: /tours` — по явному решению
  пользователя берём корневые slug-URL, которые под запрет не попадают.
  `lib/http.ts` честно логирует: «robots.txt разрешает URL корневого
  slug, но имя хоста трактует `/tours` как блок» — для аудита.

### Очередь запросов (`lib/polite-queue.ts`)

Последовательная очередь **на хост**. Параллелизм **внутри одного хоста
= 1**, между хостами можно параллелить. Это важно: если разогнать
30 запросов параллельно к одному pmpoperator, сайт либо упадёт, либо нас
забанит.

Реализация: простой `p-queue` с `concurrency: 1` на хост.

### JSON Schema валидация (`lib/schema.ts`)

- ajv 2020 (draft/2020-12), `strict: true`, `allErrors: true`.
- Загружаем обе схемы через `addSchema`, `$ref: "product_card.schema.json"`
  в `test_case.schema.json` резолвится корректно.
- Валидатор возвращает `{ ok: true, card } | { ok: false, errors }`.

### URL harvesting

Каждый `harvest-<site>.ts`:

1. Скачивает `sitemap.xml` (или `sitemap_index.xml` → рекурсивно).
2. Фильтрует по паттерну URL конкретных карточек
   (`/ru/<city>/activities/<id>-<slug>` для sputnik8 и т.п.).
3. Диверсифицирует выборку:
   - sputnik8: по городам пропорционально (40/25/25/10), минимум 2 карточки
     на город. Внутри города — случайная выборка, но с
     фиксированным сидом `RANDOM_SEED=42` для воспроизводимости.
   - afisha: по типу (concert/performance/festival), минимум 2 на тип.
   - pmpoperator / scantour: все карточки малочисленны, берём все из
     sitemap, случайно сужаем до N.
4. Пишет плоский список в `urls.txt` (один URL на строку, комментарии
   `# ...` разрешены).

URL-файл коммитится: это «спецификация» того, какие карточки мы брали
— нужно, чтобы можно было воспроизвести датасет.

### Сохранение `html-cache/`

Скачанный HTML — только для дебага. В `.gitignore`. Имя файла —
`<sha1(url)>.html`, рядом лежит `<sha1(url)>.headers.json` с ответом.
Парсеру достаточно cache-hit, чтобы не ходить в сеть при повторном запуске.

### Валидация и rejects

`validate.ts` проходит `cards.raw.jsonl` построчно:

- `ok=true` → остаётся в файле;
- `ok=false` → перемещается в `cards.rejected.jsonl` с полем
  `_validation_errors: [...]` (массив ajv-errors).

Не молчаливое выбрасывание: каждая отклонённая карточка документирована.
Решение, что с ней делать (доработать парсер, доразметить вручную,
исключить навсегда) — не здесь.

## Особые требования по источникам

### sputnik8.com

- **Sitemap**: `https://www.sputnik8.com/sitemap.xml`.
- **Паттерн URL карточки**: `/ru/<city>/activities/<numeric_id>-<slug>`.
  Фильтр — regex.
- **JSON-LD**: на первой выборке не обнаружен прямо, но один
  WebFetch-проход упомянул Event/LocalBusiness markup. **Проверить в
  парсере**: если `<script type="application/ld+json">` есть, пытаемся
  брать оттуда — это надёжнее, чем DOM-scraping.
- **Поля из DOM** (когда JSON-LD нет):
  - `title`: `h1`.
  - `short_description`: `meta[name="description"]` или первый абзац
    описания.
  - `full_description`: конкатенация блоков описания (конкретные
    селекторы снять с карточек в `html-cache/` на месте — не фиксирую
    здесь, чтобы не ошибиться).
  - `program_items`: секция «что увидите» / «маршрут», по пунктам. Если
    нет точек маршрута — пустой массив.
  - `services`: блоки «что входит / не входит», объединить в один
    массив с коротким описанием.
  - `location.address` + `location.meeting_point_comment`.
  - `schedule.format`: `recurring` (обычно).
  - `schedule.duration_minutes`: парсить из «3 часа», «45 мин» и т.п.
  - `group_size`: regex по «до N человек».
  - `languages`: список из блока «Язык проведения».
  - `age_restriction`: парсится из правил бронирования, не отдельного
    поля — может остаться `null`.
  - `images`: все `<img>` из галереи, `src` или `data-original`.
    Сортировать по порядку в DOM.
- **Город для статистики**: из URL (`/ru/<city>/...`).

### pmpoperator.ru

- **Sitemap**: `https://pmpoperator.ru/sitemap.xml`.
- **Паттерн**: `/tours/<slug>`.
- **JSON-LD**: не обнаружен ни на одной из 3 проверенных карточек. Не
  тратим ветку кода.
- **Поля из DOM**:
  - `product_type`: для `/tours/<slug>` где длительность ≥ 2 дней →
    `tour`, иначе `excursion`. Длительность — из заголовка / программы.
  - `program_items`: секция «День 1 / День 2 / …» — парсим последовательно,
    `order` = номер дня.
  - `services`: из блоков «Входит в стоимость» / «Оплачивается
    отдельно» — объединить, но в `name` пометить, какая группа.
  - `group_size`, `languages`: всегда `null` / `[]` (отсутствуют).
  - `schedule.dates`: **может отсутствовать** в разметке карточки. Если
    не нашли — `dates` не добавляем (по схеме dates необязателен).
  - `age_restriction`: обычно `"с 5 лет"` → нормализовать к `"5+"`.
- **Очистка текста**: типичные повторы «цены уточнять весной 2026 г.»
  оставляем как есть — это часть карточки, и будет сырьём для
  разметки следующего спринта.

### scantour.ru

- **Sitemap**: `https://scantour.ru/sitemap_index.xml` (WordPress-индекс,
  внутри post-sitemap и page-sitemap — нужны post'ы).
- **Паттерн URL карточки**: корневой slug (например
  `/ekskursionnyy-tur-v-ruskealu-na-1-den`). **Исключить** URL под
  `/tours/*` и `/tour_type/*` — запрещены robots.txt.
- **JSON-LD**: не обнаружен, DOM-scraping.
- **Поля**:
  - `program_items`: секция «Программа» с часами и точками — парсить.
  - `services`: блоки «Включено / Не включено».
  - `location`: **две точки сбора** («Площадь Восстания», «Дыбенко»). Класть
    в `location.meeting_point_comment` как объединённый текст.
  - `schedule.dates`: **у scantour они ЕСТЬ** в разметке (80–130+ дат
    в виджете расписания). Распарсить в массив `YYYY-MM-DD`. Если дат
    больше 50 — обрезать до ближайших 50 (размер важен для
    читаемости/токенов).
  - `age_restriction`: как и pmpoperator, `null` если явно не указано.

### afisha.ru

- **Sitemap**: `https://www.afisha.ru/sitemap.xml`.
- **Паттерн URL**: `/concert/<slug>-<id>/`, `/performance/<slug>-<id>/`,
  `/festival/<slug>-<id>/`. Кино и спорт — **исключаем** (не наш домен).
- **JSON-LD**: на спектакле не обнаружен; на концерте-фестивале
  суммаризатор упомянул, но **не проверено**. В парсере: если есть —
  берём `startDate`, `endDate`, `location`, `performer`, `image` из
  markup. Это правильный путь, афиша — каноничный кейс `schema.org/Event`.
- **Особенности**:
  - `product_type`: всегда `event`.
  - `program_items`: если концерт-фестиваль — список артистов
    (`{order, title: "Артист", description: ""}`). Для спектакля —
    оставить пустым массивом или одной записью с длительностью (3 часа).
  - `services`: почти всегда пусто (афиша — агрегатор билетов, сервисов
    нет). Массив `[]` валиден по схеме.
  - `contacts_block.public_comment`: на афише контактов организатора
    нет. Ставим `""` (пустая строка валидна).
  - `schedule.format`: `once` для концертов с одной датой,
    `recurring` для спектаклей с серией показов.
  - `group_size`: `null`.
  - `languages`: `["ru"]` по умолчанию для России.

**Caveat в README источника**: карточки afisha тоньше, чем у Localtrip-
подобных marketplace'ов. Это особенность донора, не баг парсера.

## Скачивание изображений (`download-images.ts`)

- Читает любой `datasets/<source>/images.raw.jsonl`.
- Скачивает каждое `source_url` в `file_path`.
- Если файл уже есть (`file_path` существует на диске) — пропуск.
- Расширение берём по `Content-Type` (image/jpeg → .jpg, image/png →
  .png, image/webp → .webp). Конвертаций не делаем.
- Лимит размера: **5 MB на файл**, больше — пропуск + лог в
  `datasets/<source>/images.oversize.txt`.
- Параллелизм: тот же polite-queue на хост.
- **Не качаем картинки, не связанные с карточками из baseline** (напр.
  аватарки авторов отзывов на sputnik8).

## Отчёт (`summary.ts`)

Печатает в stdout и дублирует в `reports/parse-<YYYY-MM-DD>.md`:

```
Источник       Карточек  Прошли  Rejected  Изображений  Средне полей (/ 13)
sputnik8       27        26      1         142          11.8
pmpoperator    12        12      0         48           9.4
scantour       14        14      0         210          9.7
afisha         7         7       0         28           7.2
──────────────────────────────────────────────────────────────────────────
итого          60        59      1         428

Покрытие полей по источнику (доля карточек с непустым полем):
                  sputnik8  pmpoperator  scantour  afisha
title              100%      100%         100%      100%
short_description   98%      100%         100%      100%
full_description   100%      100%         100%      100%
program_items       95%       95%          100%      60%
services            90%       95%          100%      15%
location           100%      100%         100%      100%
contacts_block.public_comment  60%   30%   30%       10%
schedule.dates      80%       20%         100%      100%
age_restriction     45%       90%          50%       95%
group_size          85%        0%           0%        0%
languages           90%        0%           0%      100%
images             100%       90%         100%      100%
```

Эта таблица напрямую подкармливает следующий спринт (разметку): видно,
где реальные данные тонкие, а где надо симулировать.

## Конвенции кода

1. **TypeScript строгий**, как в `tsconfig.json`. Не отключать
   `noUncheckedIndexedAccess`.
2. **Идентификаторы на английском.** Комментарии и строки данных —
   на русском, если относятся к данным.
3. **pnpm**, никогда npm/yarn. Новые зависимости — в `devDependencies`
   (парсеры — часть dev-пайплайна, не прод). Ожидаемые новые:
   `cheerio`, `p-queue`, `ajv`, `ajv-formats`, `robots-parser`,
   `fast-xml-parser` (для sitemap). Все — популярные, проверенные.
4. **Без секретов в логах.** Содержимое карточек может быть длинным —
   при логировании обрезать до 200 символов.
5. **Идемпотентность.** Повторный запуск любого `parse:<site>` не должен
   повторно качать то, что уже в кэше, и не должен дублировать строки
   в `cards.raw.jsonl` (дедуп по `card.id`).
6. **Один парсер = один файл.** Общая логика — в `lib/`. Не делать
   абстрактный `BaseParser` — три парсера слишком разные, общий
   интерфейс станет прокрустовым ложем.

## Acceptance checklist (для P1)

- [ ] `pnpm install` проходит, новые зависимости зафиксированы.
- [ ] `pnpm harvest:sputnik8` создаёт `datasets/sputnik8/urls.txt`
      с ≥ 30 URL, разнообразных по городам (видно из списка).
- [ ] `pnpm parse:sputnik8` обрабатывает первые 5–10 URL,
      создаёт `cards.raw.jsonl` и `images.raw.jsonl`.
- [ ] `pnpm images:download` скачивает cover + 2–3 gallery на
      каждую карточку в `datasets/images/`.
- [ ] `pnpm parse:validate` подтверждает: все `cards.raw.jsonl`
      проходят `product_card.schema.json`.
- [ ] `pnpm parse:summary` печатает таблицу покрытия.
- [ ] В консоли видны «вежливые» запросы: ≥ 2 с между ними, логируется
      кэш-хит/мисс.
- [ ] `tsc --noEmit` чистый, линтер (если настроен) без ошибок.
- [ ] `git status` не показывает `datasets/sputnik8/html-cache/`,
      `datasets/images/` (в `.gitignore`).

## Открытые вопросы для следующей сессии

1. Если у sputnik8 обнаружится JSON-LD — берём оттуда приоритетно или
   всегда парсим DOM? (Рекомендую: JSON-LD приоритетно, DOM — fallback
   и для полей, которых в JSON-LD нет.)
2. Сколько изображений на карточку скачиваем? (Рекомендую: cover +
   первые 3 gallery = 4 на карточку. На 60 карточек — 240 файлов,
   разумный объём.)
3. Что делать с карточками, у которых `full_description` меньше 100
   символов? (Рекомендую: не отклонять на этапе парсинга — может быть
   валидной короткой афишей; пометить в `_meta.warnings`.)

Ответы на эти вопросы — в начале P1 сессии, не в конце.
