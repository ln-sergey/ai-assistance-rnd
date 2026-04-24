# Datasets — тест-кейсы модерации карточек

Здесь живут датасеты для бенчмарка `ai-bench`. Таксономия правил, по которым
оценивается модерация — в корневом [`rules.yaml`](../rules.yaml). Общая картина
и методика — в [`ARCHITECTURE.md`](../ARCHITECTURE.md).

## Структура

```
datasets/
├── sources.config.json            # target_total/seed для каждого harvester'а
├── schema/
│   ├── product_card.schema.json   # JSON Schema карточки активности
│   ├── test_case.schema.json      # JSON Schema тест-кейса (card_case | image_case)
│   └── annotation.schema.json     # JSON Schema разметки нарушений
├── annotations/
│   ├── <source>.json              # карта case_id → разметка (источник правды)
│   └── pending/                   # рабочие скаффолды (gitignored)
├── cases/
│   ├── real-clean/                # материализованные card_case (expected_clean=true)
│   └── real-dirty/                # материализованные card_case (expected_clean=false)
├── images/                        # бинарные файлы фото, имя = <image_id>.jpg|.png
└── <source>/                      # сырьё одного источника (sputnik8, pmpoperator, …)
    ├── urls.txt                   # точка входа harvester'а
    ├── cards.raw.jsonl            # спаршеные карточки
    ├── images.raw.jsonl           # ссылки на картинки
    └── html-cache/                # gitignored
```

Тест-кейсы в `cases/real-*` — это материализованный артефакт: они
регенерятся командой `pnpm cases:generate` из `cards.raw.jsonl` +
`annotations/<source>.json`. Источник правды для разметки — JSON-store,
не сами case-файлы.

## Жизненный цикл данных

```
harvest → parse → annotate → cases
```

| Шаг      | Команда                                                | Что делает                                                                            |
|----------|--------------------------------------------------------|---------------------------------------------------------------------------------------|
| harvest  | `pnpm harvest:<source>`                                 | Выкачивает HTML, формирует `<source>/urls.txt`. Параметры — `sources.config.json` + CLI. |
| parse    | `pnpm parse:<source>` → `parse:validate` → `parse:summary` | Парсит HTML в `cards.raw.jsonl` + `images.raw.jsonl`.                                  |
| annotate | `pnpm annotations:list` → `:scaffold` → fill → `:commit` | Локальный агент размечает pending'и; commit мёрджит в `<source>.json`. См. `docs/annotation-guide.md`. |
| cases    | `pnpm cases:generate`                                   | Материализует `card_case` в `real-clean/` и `real-dirty/`.                            |

Для удаления — `pnpm cards:delete --source=X` (сырьё) и
`pnpm annotations:delete --source=X` (разметка + cases). Они независимы:
можно перепарсить карточки, не теряя разметки, и наоборот.

## Два вида кейсов

### `card_case` — карточка целиком

Используется для текстовой модерации (`configs/card-text-moderation.yaml`) и
для IMG-правил, на которые достаточно метаданных карточки (`images[i]` с
`image_id` — сам бинарник подтягивается из `datasets/images/`).

Обязательные поля:

| Поле                  | Назначение                                                                  |
|-----------------------|-----------------------------------------------------------------------------|
| `case_id`             | Стабильный id кейса.                                                        |
| `kind`                | `"card_case"`.                                                              |
| `source`              | `production` / `synthetic` / `hybrid`.                                      |
| `generator`           | `{ model?, prompt_version?, date }` — откуда кейс.                          |
| `card`                | Объект `product_card` (см. ниже).                                           |
| `expected_violations` | Массив эталонных нарушений; для каждого — `rule_id`, `severity`, `field_path`, `quote?`, `rationale`. |
| `expected_clean`      | `true`, если нарушений нет; `false` — есть. Согласовано с массивом.         |
| `notes?`              | Свободная заметка.                                                          |

### `image_case` — одиночное фото в контексте карточки

Используется для фото-модерации (`configs/card-image-moderation.yaml`), когда
нужно прогнать отдельное изображение вне контекста текста. `linked_card_id`
обязателен: IMG-03, IMG-04, IMG-25 осмысленны только в связке с описанием.

Обязательные поля:

| Поле                  | Назначение                                                                   |
|-----------------------|------------------------------------------------------------------------------|
| `case_id`             | Стабильный id кейса.                                                         |
| `kind`                | `"image_case"`.                                                              |
| `image_id`            | Совпадает с `product_card.images[].image_id` привязанной карточки.           |
| `file_path`           | Относительный путь, `datasets/images/<image_id>.jpg`.                        |
| `linked_card_id`      | `product_card.id` привязанной карточки.                                      |
| `role`                | `cover` / `gallery`.                                                         |
| `source`, `generator` | Как в card_case.                                                             |
| `expected_violations` | Только `IMG-NN`, `field_path` = `images[0]`.                                 |
| `expected_clean`      | Как в card_case.                                                             |
| `notes?`              | Свободная заметка.                                                           |

## `product_card` — поля карточки

Все поля обязательные, даже если содержимое пустое (`""`, `[]`): форма
карточки постоянна, отсутствие поля = баг датасета.

| Поле                    | Тип                                                          | Зачем модерации                                   |
|-------------------------|--------------------------------------------------------------|---------------------------------------------------|
| `id`                    | string                                                       | стабильный идентификатор                          |
| `product_type`          | `tour` / `excursion` / `event`                               | TXT-21 (несоответствие типу)                      |
| `title`                 | string                                                       | TXT-01                                            |
| `short_description`     | string                                                       | TXT-04, TXT-25                                    |
| `full_description`      | string                                                       | основное поле для большинства TXT-правил          |
| `program_items[]`       | `{ order, title, description }`                              | TXT-02, TXT-19, TXT-20 внутри пунктов программы   |
| `services[]`            | `{ name, description }`                                      | TXT-02, TXT-31                                    |
| `location`              | `{ address, route_comment, meeting_point_comment }`          | TXT-22, TXT-31                                    |
| `contacts_block`        | `{ public_comment }`                                         | TXT-07, TXT-19, TXT-20                            |
| `schedule`              | `{ format, dates?, duration_minutes? }`                      | TXT-22 (несоответствие параметрам)                |
| `age_restriction`       | string / null, напр. `"12+"`                                 | TXT-22                                            |
| `group_size`            | `{ min, max }` / null                                        | TXT-22                                            |
| `languages`             | string[] (ISO-639-1)                                         | TXT-30                                            |
| `images[]`              | `{ image_id, role: cover\|gallery, caption? }`               | метаданные для сопоставления с `datasets/images/` |

## Правила для `expected_violations`

- `rule_id` — только идентификаторы из `rules.yaml`: `TXT-01..TXT-35`,
  `IMG-01..IMG-30`. Схема проверяет формат; существование и осмысленность —
  на разметчике.
- `severity` должна **совпадать** с значением в `rules.yaml`. Это отдельной
  JS-валидацией в ассершенах Promptfoo, не в JSON Schema.
- `field_path` — дот-нотация до конкретного места: `full_description`,
  `program_items[2].description`, `contacts_block.public_comment`,
  `images[0]`.
- `quote` — **обязателен для TXT-правил**: фрагмент исходного текста, где
  зафиксировано нарушение (антигаллюцинационный якорь). Для IMG-правил —
  только если нарушает читаемый на фото текст.
- `rationale` — 1–2 предложения на русском: зачем это именно это правило.

## Примеры валидных кейсов

### Пример 1 — чистая карточка (`expected_clean: true`)

```json
{
  "case_id": "case-clean-001",
  "kind": "card_case",
  "source": "synthetic",
  "generator": {
    "model": "claude-opus-4-5",
    "prompt_version": "card-gen-v1",
    "date": "2026-04-24"
  },
  "card": {
    "id": "card-0001",
    "product_type": "excursion",
    "title": "Пешеходная экскурсия по старому Тбилиси",
    "short_description": "Прогулка 3 часа по Абанотубани и Нарикале с лицензированным гидом.",
    "full_description": "Начинаем у площади Мейдан, проходим серные бани, поднимаемся к крепости Нарикала на канатной дороге (билет включён), спускаемся в Сололаки. Группа до 8 человек, темп умеренный, нужна удобная обувь.",
    "program_items": [
      { "order": 1, "title": "Площадь Мейдан", "description": "Сбор группы, короткий рассказ об истории района." },
      { "order": 2, "title": "Серные бани Абанотубани", "description": "Осмотр снаружи, история квартала." },
      { "order": 3, "title": "Крепость Нарикала", "description": "Подъём на канатной дороге, панорама города." }
    ],
    "services": [
      { "name": "Канатная дорога", "description": "Билет туда-обратно включён в стоимость." },
      { "name": "Сопровождение гида", "description": "Русскоязычный лицензированный гид на весь маршрут." }
    ],
    "location": {
      "address": "Грузия, Тбилиси, площадь Мейдан",
      "route_comment": "Маршрут включает подъёмы и спуски по мощёным улицам, нужна удобная обувь.",
      "meeting_point_comment": "У фонтана на площади Мейдан."
    },
    "contacts_block": {
      "public_comment": "Связь с гидом — через чат Localtrip после бронирования."
    },
    "schedule": {
      "format": "recurring",
      "dates": ["2026-05-01", "2026-05-08", "2026-05-15"],
      "duration_minutes": 180
    },
    "age_restriction": "6+",
    "group_size": { "min": 2, "max": 8 },
    "languages": ["ru", "en"],
    "images": [
      { "image_id": "img-0001", "role": "cover", "caption": "Вид на Нарикалу с канатной дороги" },
      { "image_id": "img-0002", "role": "gallery", "caption": null }
    ]
  },
  "expected_violations": [],
  "expected_clean": true,
  "notes": "Референсный чистый кейс для проверки precision: модель не должна генерировать ложных нарушений."
}
```

### Пример 2 — карточка с двумя нарушениями (`TXT-07` + `TXT-20`)

```json
{
  "case_id": "case-pii-offplatform-001",
  "kind": "card_case",
  "source": "synthetic",
  "generator": {
    "model": "claude-opus-4-5",
    "prompt_version": "card-gen-v1",
    "date": "2026-04-24"
  },
  "card": {
    "id": "card-0002",
    "product_type": "tour",
    "title": "Выходные в Казани",
    "short_description": "Двухдневный тур в Казань с проживанием и экскурсиями.",
    "full_description": "Едем в Казань на выходные. По любым вопросам пишите напрямую организатору: +7 921 555-12-34, telegram @kazan_tours_guide — так быстрее.",
    "program_items": [
      { "order": 1, "title": "Обзорная экскурсия", "description": "Кремль, Баумана, Кул-Шариф. Подробная программа и бронь у организатора в Telegram: https://t.me/kazan_tours_guide." },
      { "order": 2, "title": "Свияжск", "description": "Выезд на остров-град, обед в местном кафе." }
    ],
    "services": [
      { "name": "Проживание", "description": "Гостиница 3*, двухместные номера." },
      { "name": "Трансфер", "description": "Автобус туда-обратно от вокзала." }
    ],
    "location": {
      "address": "Казань, сбор у железнодорожного вокзала",
      "route_comment": "Поездка по городу и выезд на Свияжск.",
      "meeting_point_comment": "Главный вход железнодорожного вокзала."
    },
    "contacts_block": {
      "public_comment": "Все контакты для бронирования — в описании программы."
    },
    "schedule": {
      "format": "recurring",
      "dates": ["2026-05-10", "2026-05-24"],
      "duration_minutes": 2880
    },
    "age_restriction": "12+",
    "group_size": { "min": 4, "max": 20 },
    "languages": ["ru"],
    "images": [
      { "image_id": "img-0010", "role": "cover", "caption": null }
    ]
  },
  "expected_violations": [
    {
      "rule_id": "TXT-07",
      "severity": "critical",
      "field_path": "full_description",
      "quote": "+7 921 555-12-34, telegram @kazan_tours_guide",
      "rationale": "В описании опубликованы личный телефон и Telegram-ник организатора — прямая публикация персональных данных в карточке."
    },
    {
      "rule_id": "TXT-20",
      "severity": "high",
      "field_path": "program_items[0].description",
      "quote": "Подробная программа и бронь у организатора в Telegram: https://t.me/kazan_tours_guide",
      "rationale": "Прямой призыв согласовывать бронирование вне Localtrip через внешний Telegram-канал."
    }
  ],
  "expected_clean": false,
  "notes": "Композитный кейс: ПДн в описании + увод коммуникации вне платформы."
}
```
