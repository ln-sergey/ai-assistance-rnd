# ТЗ — разметка реальных изображений (Sprint P6)

Следующая сессия(и) AI-агента. Документ самодостаточен: читается «с
холода», предполагает только знание `AGENTS.md`, `ARCHITECTURE.md`,
`image_rules.yaml`, JSON Schemas в `datasets/schema/` и трёх предыдущих
ТЗ-файлов (`tz-data-lifecycle.md`, `tz-annotate-pipeline-v2.md`,
`tz-synthetic-cards.md`). Гайды того же стиля — `docs/annotation-guide.md`
и `docs/synthetic-guide.md`.

## Цель

Получить разметку реальных изображений из карточек 4 источников
(`sputnik8`, `pmpoperator`, `scantour`, `afisha`) — встроить её в
существующий `annotate → commit → cases:generate` pipeline без слома
текстовой разметки.

Главное требование — **изображения опциональны для всего пайплайна**.
Карточка без `images[]` или с пустым массивом валидна для текстового
eval'а как раньше. Image-разметка добавляется поверх существующей
text-разметки и активирует image-eval только тогда, когда есть данные.

Бенчмарк проверяет, насколько целевые провайдеры (Yandex / GigaChat)
справляются с **семантическими** IMG-правилами — теми, которые требуют
понимания содержимого фото. Правила, разрешимые детерминированно
(размер, blur, perceptual hash, EXIF, формат, дубликаты и т.п.), R&D
не интересны и **полностью выводятся из scope разметки**.

## Scope / Out of scope

**In scope:**

- Разметка фото 4 реальных источников (`sputnik8`, `pmpoperator`,
  `scantour`, `afisha`).
- AI-разрешимые IMG-правила — подмножество `image_rules.yaml`,
  определяемое в Этапе 0.
- Расширение существующего annotation-store: новые поля
  `image_violations[]` + `expected_image_clean` рядом с `violations[]` +
  `expected_clean`. Один файл `<source>.json` на источник, как сейчас.
- Расширение `card_case` (test_case) аналогично — поверх существующей
  схемы.
- Команды `annotations:list:images`, `annotations:scaffold:images`,
  `annotations:commit` (commit единый — расширяем существующий).
- Партионная whitelist-папка `datasets/images-review/<batch-id>/`
  (gitignored), куда `scaffold:images` копирует фото партии для работы
  локального AI-агента. После `commit` папка партии удаляется.
- Канонический промпт `prompts/annotate-image-conservative-v1.txt` +
  шаблон делегации `docs/annotate-image-subagent-template.md` +
  гайд `docs/image-annotation-guide.md`.
- Расширение `cases:generate` и `cases:audit` для покрытия IMG-правил
  в scope.
- Опциональность фото на уровне схемы и пайплайна (см. раздел
  «Опциональность изображений»).

**Out of scope (явное решение пользователя):**

- **Любые эвристические / детерминированные проверки изображений.**
  R&D не реализует ни perceptual hash, ни blur detection, ни проверку
  размеров / aspect ratio / EXIF / формата / дубликатов. Правила, которые
  закрываются эвристиками, не размечаются и не попадают в промпт
  разметчика — они просто исключаются из scope этого этапа.
- **Генерация синтетических изображений** — отдельный следующий
  спринт. Все synthetic карточки текущего корпуса остаются с
  `images: []`.
- **Эталонная разметка через API.** Ни целевые провайдеры (Yandex /
  GigaChat), ни любые другие эталонные AI через прямые API не
  используются для подготовки image-разметки (hard rule всего проекта,
  см. `AGENTS.md`).
- Двухпроходная разметка (conservative + aggressive) для изображений —
  на v1 только conservative.
- Bbox / координатные аннотации — на v1 только текстовое поле
  `evidence`.
- Eval-фаза. `pnpm eval:image` уже существует, она потребляет
  результат этого спринта и здесь не правится.
- Изменение `image_rules.yaml`, `text_rules.yaml`,
  `product_card.schema.json` (hard rule из `AGENTS.md`).

## Опциональность изображений

Принцип: image-разметка — слой поверх card-разметки. Карточка может
быть в любом из четырёх состояний:

| Состояние | `card.images` | `expected_image_clean` | `image_violations` | Кейс материализуется |
|---|---|---|---|---|
| Без фото | `[]` | `null` (или поле опущено) | `[]` (или опущено) | Да, как text-only кейс. |
| С фото, image-разметки нет | `[…]` | `null` | `[]` | Да, как text-only кейс. `eval:image` его пропускает. |
| С фото, размечена, чистая | `[…]` | `true` | `[]` | Да, кейс участвует и в text-, и в image-eval. |
| С фото, размечена, грязная | `[…]` | `false` | `[…]` | Да, кейс участвует и в text-, и в image-eval. |

Следствия для схемы и кода:

- `expected_image_clean` — `boolean | null`, default `null`.
- `image_violations` — массив, default `[]`. Не `null`, чтобы итерация
  всегда работала.
- `cases:generate` материализует кейс независимо от наличия
  image-разметки.
- Раскладка по директориям: case считается dirty, если
  `expected_clean === false` **или** `expected_image_clean === false`.
  `null` ≠ false (отсутствие image-разметки не делает кейс dirty).
  Решение фиксируется в Этапе 1, точная финальная семантика —
  при реализации.
- `validate-cases.ts` принимает любую из четырёх комбинаций,
  ругается только на внутренние противоречия (например,
  `expected_image_clean === true && image_violations.length > 0`).

## Зафиксированные решения (развилки)

Согласовано с пользователем 2026-05-04:

| ID | Решение |
|----|---------|
| Р1 | **Эвристики полностью out of scope.** Не реализуем ни одной детерминированной проверки изображений в этом R&D. Правила, разрешимые без ИИ, не попадают ни в промпт разметчика, ни в `cases:audit` (чтобы не считать их «непокрытыми» — они просто вне scope). Список AI-only правил формируется в Этапе 0 и хранится в `datasets/image_rules.scope.yaml` (точная форма — в Этапе 0). |
| Р2 | **Изображения опциональны.** Все новые поля схем (`image_violations`, `expected_image_clean`) обратно совместимы. Существующие 122 real-кейса остаются валидными без правок аннотаций. См. раздел «Опциональность изображений». |
| Р3 | **Хранение image-разметки — расширение существующего annotation-store.** Внутрь `datasets/annotations/<source>.json[<card_id>]` добавляются поля `image_violations[]` и `expected_image_clean`. Отдельных image-store'ов не создаём. |
| Р4 | **Идентификация фото в нарушении — `image_id`.** Поле `image_id` (стабильное, из `card.images[].image_id`) — обязательное в каждом элементе `image_violations`. Дополнительно `field_path: "images[<image_id>]"` для совместимости со стилем text-нарушений (опционально, дублирует `image_id`). |
| Р5 | **`evidence` — текстовое описание участка кадра.** Обязательное поле в `image_violations`. Bbox / координаты — позже, по необходимости (на v1 не вводим). |
| Р6 | **Только conservative-v1.** Аналогично текстовой разметке — стартовая итерация одна, парный aggressive-режим докатываем после пилота, если recall окажется низким. |
| Р7 | **Партионная whitelist-папка `datasets/images-review/<batch-id>/`.** `scaffold:images` копирует туда файлы партии (по 5–10 карточек), `commit` после успеха удаляет партию. Папка gitignored. Это снимает Read-deny на `datasets/images/` без точечной правки `.claude/settings.local.json`. |
| Р8 | **Локальный AI-агент в интерактивной сессии** (Claude Code, Codex, Cursor, Aider или совместимый передовой агент). Никаких прямых API-batch-вызовов из скриптов проекта. Идентично Р1 из `tz-synthetic-cards.md`. |
| Р9 | **Раскладка кейсов в `cases/real-{clean,dirty}/`.** Не плодим новые директории. Кейс считается dirty если `expected_clean === false` ИЛИ `expected_image_clean === false`. `null` (image-разметки ещё нет) трактуется как «не влияет на classification» — кейс ложится туда, куда его кладёт текст. |
| Р10 | **Объём первой партии — 5–10 карточек одного источника** (`sputnik8`). Полная разметка всех 4 источников — итеративно после пилота. Идентично Р10 из `tz-synthetic-cards.md`. |

## Текущее состояние (вход)

Снимок на 2026-05-04:

- 122 реальных кейса: 91 clean + 31 dirty (по тексту). Все с
  `expected_image_clean === null` (image-разметки ещё нет).
- 4 реальных источника карточек, у каждого свой `images.raw.jsonl` и
  свой набор бинариков в `datasets/images/<image_id>.<ext>`.
- `image_rules.yaml` — 30 правил `IMG-01..IMG-30` (источник правды).
- `datasets/image_rules.compact.json` — компактная таблица для промптов
  (генерируется `pnpm rules:compact`). Сейчас содержит все 30 правил.
  В Этапе 0 решается, как фильтровать по scope.
- `pnpm eval:image` существует, но фактических кейсов с
  `expected_image_clean !== null` пока нет.
- Pipeline собран и проверен на тексте: `harvest → parse → annotate →
  cases`. Команды `cards:delete` / `annotations:delete` работают по
  source.
- `prompts/annotate-conservative-v1.txt` + `prompts/annotate-aggressive-v1.txt`
  существуют для текста — будут использованы как ориентир при написании
  image-промпта.

## Целевая структура

```
prompts/
├── annotate-conservative-v1.txt              существует (текст)
├── annotate-aggressive-v1.txt                существует (текст)
├── synthesize-card-v{1..7}.txt               существует (текст)
└── annotate-image-conservative-v1.txt        NEW

datasets/
├── image_rules.scope.yaml                    NEW (или эквивалентный конфиг)
├── image_rules.compact.json                  существует (возможно, обновится формат)
├── images-review/                            NEW (gitignored, рабочие партии)
│   └── <batch-id>/                           NEW (создаётся scaffold, удаляется commit'ом)
│       └── <image_id>.<ext>                  NEW (копии файлов из datasets/images/)
├── annotations/
│   ├── sputnik8.json                         UPDATED (поля image_violations, expected_image_clean)
│   ├── pmpoperator.json                      UPDATED
│   ├── scantour.json                         UPDATED
│   ├── afisha.json                           UPDATED
│   ├── synthetic.json                        без изменений (image: [])
│   └── pending/
│       ├── <real_card_id>.json               существует (text-разметка)
│       └── <real_card_id>.images.json        NEW (image-разметка, отдельный pending)
├── cases/
│   ├── real-clean/                           UPDATED (новые поля в JSON)
│   ├── real-dirty/                           UPDATED
│   ├── synthetic-clean/                      без изменений
│   └── synthetic-dirty/                      без изменений
└── schema/
    ├── annotation.schema.json                UPDATED (опциональные image-поля)
    ├── test_case.schema.json                 UPDATED (опциональные image-поля)
    └── product_card.schema.json              без изменений (hard rule)

scripts/data/
├── annotations-list-pending.ts               UPDATED (флаг --mode=images или отдельный список)
├── annotations-scaffold.ts                   UPDATED (подкоманда / флаг --images, копирование партии в images-review/)
├── annotations-commit.ts                     UPDATED (валидация image_violations + удаление партии)
├── annotations-delete.ts                     UPDATED (зачищает image-разметку и батчи)
├── cases-generate.ts                         UPDATED (прокидывает image-поля в case)
├── cases-audit.ts                            UPDATED (отдельная таблица по IMG в scope)
└── build-rules-compact.ts                    UPDATED (фильтр по image_rules.scope.yaml)

docs/
├── tz-image-annotate-pipeline.md             (этот файл)
├── image-annotation-guide.md                 NEW
└── annotate-image-subagent-template.md       NEW
```

Точное название pending-файла для image-разметки (`<card_id>.images.json`
vs `images-<card_id>.json` vs расширение полей в существующем
`<card_id>.json`) фиксируется в Этапе 0. Рекомендация — отдельный файл
`<card_id>.images.json`, чтобы text- и image-разметка двигались по
pipeline независимо и не блокировали друг друга при заполнении.

## Целевой UX

```bash
# 1. Узнать, у каких карточек ещё нет image-разметки
pnpm annotations:list:images
# → блок:
#   [pending images] sputnik8: 60, pmpoperator: 22, scantour: 22, afisha: 18
#   (карточек с непустым images[] и без expected_image_clean)
# Карточки без фото в этот список не попадают.

# 2. Создать партию pending'ов на 5–10 карточек одного источника
pnpm annotations:scaffold:images --source=sputnik8 --limit=10
# → datasets/annotations/pending/sputnik8_<id>.images.json (10 файлов)
# → datasets/images-review/<batch-id>/ — копии файлов всех image_id
#   из этих 10 карточек.
# Печатает batch-id, путь к папке партии и список pending'ов.

# 3. AI-агент в сессии заполняет pending'и:
#    - читает prompts/annotate-image-conservative-v1.txt
#    - читает datasets/image_rules.compact.json (отфильтрованный по scope)
#    - открывает images-review/<batch-id>/<image_id>.<ext> (Read tool,
#      multimodal)
#    - пишет image_violations[] (или []) и expected_image_clean (true/false)
#      в pending-файл

# 4. Закоммитить
pnpm annotations:commit
# → валидирует image_violations против схемы + проверяет image_id ⊂ card.images
# → мержит в datasets/annotations/<source>.json
# → удаляет pending-файл и (для image-pending'ов) папку партии в
#   images-review/, если все pending'и партии закоммичены.

# 5. Материализовать cases
pnpm cases:generate
# → datasets/cases/real-{clean,dirty}/<card_id>.json обновлены
#   (поля expected_image_clean, expected_image_violations)

# 6. Проверить покрытие IMG-правил в scope
pnpm cases:audit --rules=image
# → таблица:
#   rule_id   severity   real   synthetic   total   quota   delta
#   IMG-XX    high         0       0           0      —      —
# (synthetic и quota — пустые в этом спринте, пополняются позже)

tsx scripts/validate-cases.ts
# → real + synthetic кейсы проходят расширенную схему.
```

## Декомпозиция

Один этап = один коммит. Этапы относительно независимы, но рекомендуемый
порядок учитывает зависимости.

### Этап 0 — Decisions, scope и sizing (без кода)

**Цель:** до старта реализации точно знать (а) какие IMG-правила
размечаем, какие отбрасываем как «эвристически разрешимые»;
(б) количественные характеристики image-датасета; (в) точные имена
файлов и команд.

**Deliverables:**

1. **Анализ `image_rules.yaml`.** По каждому из 30 правил `IMG-01..IMG-30`
   проставить классификацию `[ai-only | heuristic-only | hybrid]` с
   1-2 предложениями обоснования. В scope разметки этого спринта —
   только `ai-only` и `hybrid` (если ИИ улучшает качество). Список и
   обоснования — в `docs/image-annotation-design.md`.
2. **`datasets/image_rules.scope.yaml`** (или эквивалентный JSON) —
   простой список `id` AI-разрешимых правил. Без правок source-of-truth
   `image_rules.yaml`. Формат:
   ```yaml
   version: 1
   # Подмножество image_rules.yaml, размечаемое в R&D. Эвристически
   # разрешимые правила выведены за scope (out of scope Sprint P6).
   in_scope:
     - IMG-XX
     - IMG-YY
     # ...
   out_of_scope:
     - IMG-ZZ   # причина: blur detection покрывается sharp
   ```
3. **Размер датасета.** Снять цифры по
   `datasets/<source>/images.raw.jsonl`:
   - всего изображений на источник;
   - среднее на карточку, медиана;
   - распределение по `role` (cover / gallery).
   Записать в `docs/image-annotation-design.md` как раздел
   «Текущее состояние изображений».
4. **Финализация имён.** Зафиксировать:
   - имя pending-файла: `<card_id>.images.json` (рекомендация);
   - алиасы команд: `annotations:list:images`,
     `annotations:scaffold:images` (рекомендация — подкоманды, а не
     флаги);
   - имя batch-id: `YYYYMMDD-<source>-<seq>` (рекомендация);
   - семантика `expected_image_clean === null` в `cases:generate` и
     `cases:audit`.
5. **`docs/image-annotation-design.md`** — итоговая записка по этапу,
   вход для всех последующих этапов.

**Acceptance:**

- `docs/image-annotation-design.md` существует и закрывает все 5
  пунктов.
- `datasets/image_rules.scope.yaml` существует и валиден как YAML.
- Никаких изменений в коде, схемах и `image_rules.yaml`.

### Этап 1 — Расширение схем + валидаторов

**Цель:** все существующие text-кейсы остаются валидными, новые
image-поля поддержаны на уровне ajv и `validate-cases.ts`.

**Deliverables:**

1. `datasets/schema/annotation.schema.json` (UPDATE):
   ```jsonc
   {
     "expected_clean":      "boolean",
     "violations":          "array (text)",
     "expected_image_clean": "boolean | null  (default null, optional)",
     "image_violations":     {
       "type": "array (default [])",
       "items": {
         "rule_id":   "string (IMG-NN)",
         "severity":  "low|medium|high|critical",
         "image_id":  "string (должен быть в card.images[].image_id)",
         "evidence":  "string (1-2 предложения, что именно на фото)",
         "rationale": "string (почему это нарушение)",
         "field_path": "string (опционально, для симметрии с text-нарушениями)"
       }
     },
     "annotated_at": "...",
     "annotator":    "..."
   }
   ```
   Не ломать существующие записи — все image-поля nullable / default.
2. `datasets/schema/test_case.schema.json` (UPDATE) — аналогично:
   `expected_image_clean`, `expected_image_violations` (поверх
   существующих text-полей).
3. `scripts/validate-cases.ts` (UPDATE):
   - проверка ссылочной целостности: каждое
     `image_violations[].image_id` ∈ `card.images[].image_id`;
   - проверка `rule_id` ∈ `image_rules.yaml` (всех 30, не только scope —
     scope-фильтрация это отдельная история);
   - проверка непротиворечивости:
     `expected_image_clean === true && image_violations.length > 0` →
     ошибка;
     `expected_image_clean === false && image_violations.length === 0` →
     ошибка.
4. `scripts/data/annotations-commit.ts` (UPDATE) — те же проверки
   на уровне commit (раньше fail).
5. **Прогон на текущих данных.** `pnpm cases:generate` +
   `tsx scripts/validate-cases.ts` — должны быть зелёные на 122 real
   и существующих synthetic-кейсах без правок аннотаций.

**Acceptance:**

- Все существующие 122 real-кейса проходят `validate-cases` без
  изменений в `datasets/annotations/*.json` и `datasets/cases/`.
- Создание тестового pending'а с `image_violations` валидируется
  правильно (unit-проверка через ad-hoc fixture).
- `pnpm typecheck` чистый.

### Этап 2 — Scaffold/list/commit для image-разметки

**Цель:** командный UX, описанный в разделе «Целевой UX». Партии
изображений изолированы в `datasets/images-review/<batch-id>/`,
автоматически очищаются после commit.

**Deliverables:**

1. `scripts/data/annotations-list-pending.ts` (UPDATE):
   - подкоманда / флаг `--mode=images` (точное имя — из Этапа 0);
   - выводит карточки, у которых `card.images.length > 0` и
     `expected_image_clean === null` в annotation-store;
   - вывод по образцу text-варианта, с разделением по `<source>`.
2. `scripts/data/annotations-scaffold.ts` (UPDATE):
   - флаги: `--source=<X>`, `--limit=<N>`, `--card-id=<id>` (опционально),
     `--batch-id=<id>` (опционально, default — авто-генерация);
   - режим images (точная форма — из Этапа 0):
     - выбирает карточки источника без image-разметки (`limit` штук);
     - создаёт `datasets/annotations/pending/<card_id>.images.json`
       (формат — см. ниже);
     - копирует физические файлы для всех `image_id` карточек партии в
       `datasets/images-review/<batch-id>/`. Именование копии — точно
       исходное (`<image_id>.<ext>`);
     - печатает batch-id и инструкцию для агента.
   - идемпотентен: повторный запуск с теми же параметрами skip'ает
     уже существующие pending'и партии.
3. **Формат pending'а** (`<card_id>.images.json`):
   ```jsonc
   {
     "case_id": "sputnik8_57480",
     "kind": "image_annotation_pending",
     "batch_id": "20260504-sputnik8-001",
     "images": [
       { "image_id": "sputnik8_57480_0", "role": "cover",   "file_path": "datasets/images-review/20260504-sputnik8-001/sputnik8_57480_0.jpg" },
       { "image_id": "sputnik8_57480_1", "role": "gallery", "file_path": "..." }
     ],
     "expected_image_clean": null,
     "image_violations": [],
     "annotator": null,
     "annotated_at": null,
     "_help": {
       "prompt_path": "prompts/annotate-image-conservative-v1.txt",
       "rules_path":  "datasets/image_rules.compact.json",
       "schema_path": "datasets/schema/annotation.schema.json",
       "instruction": "Прочитай prompts/annotate-image-conservative-v1.txt. Открой каждое фото из images[].file_path (Read multimodal). Заполни expected_image_clean (true/false) и, если false — image_violations[]. По завершении: pnpm annotations:commit."
     }
   }
   ```
4. `scripts/data/annotations-commit.ts` (UPDATE):
   - распознаёт pending'и c `kind: "image_annotation_pending"`;
   - валидирует JSON Schema + проверки из Этапа 1 + ссылочная
     целостность `image_id ⊂ card.images[].image_id`;
   - мержит в `datasets/annotations/<source>.json[<card_id>]` поля
     `expected_image_clean` и `image_violations` (не трогая
     `expected_clean` / `violations`);
   - после успеха удаляет pending-файл;
   - если все pending'и из `batch_id` закоммичены и в
     `datasets/images-review/<batch-id>/` нет других файлов —
     удаляет папку партии целиком.
5. `scripts/data/annotations-delete.ts` (UPDATE):
   - флаг `--scope=images` (или эквивалентный) — удаляет только
     image-поля из `<source>.json` (не трогая текстовую разметку), а
     также все `*.images.json` pending'и и партии в `images-review/`.
   - флаг `--scope=all` (default) — как сейчас, плюс зачистка
     image-полей и partitions.
6. `package.json` (UPDATE) — добавить алиасы:
   ```json
   "annotations:list:images":     "tsx scripts/data/annotations-list-pending.ts --mode=images",
   "annotations:scaffold:images": "tsx scripts/data/annotations-scaffold.ts --mode=images"
   ```
   Точные имена — из Этапа 0.
7. `.gitignore` — убедиться, что `datasets/images-review/` игнорируется.

**Acceptance:**

- `pnpm annotations:list:images` показывает все 4 источника с числом
  непомеченных карточек.
- `pnpm annotations:scaffold:images --source=sputnik8 --limit=3`
  создаёт ровно 3 pending'а и партию в `datasets/images-review/`,
  печатает batch-id.
- Заполнить один pending руками (минимально: `expected_image_clean: true`,
  `image_violations: []`) → `pnpm annotations:commit` мержит в
  `<source>.json`, удаляет pending-файл.
- После commit'а трёх pending'ов одной партии папка
  `images-review/<batch-id>/` исчезает.
- `pnpm annotations:delete --source=sputnik8 --scope=images --yes`
  очищает image-поля у sputnik8 и не трогает text-разметку (количество
  text-violations не меняется).
- `pnpm cases:generate` после всего этого работает.

### Этап 3 — Промпт + гайд + subagent template

**Цель:** один источник правды для image-разметчика и удобная
делегация одной партии одному субагенту.

**Deliverables:**

1. `prompts/annotate-image-conservative-v1.txt`. Структура:
   - Шапка с diff-нотой («v1: первая итерация. Conservative —
     сомневаешься → clean. Размечаются только AI-разрешимые правила
     из image_rules.scope.yaml, эвристические — out of scope»).
   - **Роль.** «Ты — модератор изображений в карточках туристических
     активностей. Цель — найти нарушения по правилам IMG-XX из
     поданного списка. Если сомневаешься — карточка clean.»
   - **Вход.** Перечислить, что агент получает: pending-файл,
     `image_rules.compact.json` (отфильтрованный по scope), физические
     файлы фото в `images-review/<batch-id>/`.
   - **Что вернуть.** Жёсткий формат: заполнить `expected_image_clean`
     и `image_violations[]` в pending-файле. Каждое нарушение
     обязательно с полями `rule_id`, `image_id`, `evidence`, `rationale`,
     `severity` (берётся из `image_rules.compact.json` по `rule_id`).
   - **Поле `evidence`.** Описать кратко: «1–2 предложения, что
     именно на кадре указывает на нарушение. Координаты не нужны —
     достаточно ориентиров типа „левый нижний угол“, „центральная
     часть кадра“, „на майке справа“.»
   - **Связка с текстом.** Часть IMG-правил завязана на соответствие
     описания и фото (например, тур обещает горы, на фото — пляж).
     Карточка передаётся целиком (`card`-объект); агент при
     необходимости читает `title`/`description` для проверки соответствия.
   - **Запрет.** Не размечать правила вне scope. Не выдумывать
     `image_id`, не описывать общее впечатление от фото без привязки
     к конкретному правилу.
   - **Дисклеймер.** «Сомневаешься → clean (массив `image_violations`
     пустой, `expected_image_clean = true`).»
2. `prompts/CHANGELOG.md` — запись о новом промпте.
3. `docs/image-annotation-guide.md` (~80–100 строк) — клон
   `docs/annotation-guide.md`, адаптированный под изображения:
   - workflow (5 шагов: `list:images → scaffold:images → fill →
     commit → cases:generate`);
   - как работать с `images-review/<batch-id>/`;
   - формат `image_violations` с примером;
   - дисклеймеры;
   - что делать, если попалось правило вне scope (не размечать,
     отметить в `notes` карточки);
   - версионирование промптов (новая итерация → `v2`, не
     перезаписывать).
4. `docs/annotate-image-subagent-template.md` (≤ 80 строк) —
   шаблон делегации для одной партии. По образцу
   `docs/annotate-subagent-template.md` /
   `docs/synthesize-subagent-template.md`.
5. `scripts/data/build-rules-compact.ts` (UPDATE) — фильтрация
   `image_rules.compact.json` по `datasets/image_rules.scope.yaml`.
   Если scope-конфиг отсутствует — fallback на все 30 правил
   (обратная совместимость).

**Acceptance:**

- `prompts/annotate-image-conservative-v1.txt` существует с шапкой
  и разделами 1–7.
- `pnpm rules:compact` после Этапа 0 даёт `image_rules.compact.json`,
  содержащий только AI-only правила.
- `docs/image-annotation-guide.md` ≤ 100 строк, читается «с холода».
- `docs/annotate-image-subagent-template.md` ≤ 80 строк.
- На пробной партии 1 карточки агент по гайду + промпту корректно
  заполняет pending без уточняющих вопросов.

### Этап 4 — Cases-generate + audit

**Цель:** материализованные `card_case` несут image-поля; `cases:audit`
показывает покрытие IMG-правил в scope.

**Deliverables:**

1. `scripts/data/cases-generate.ts` (UPDATE):
   - читает `expected_image_clean` и `image_violations` из
     `<source>.json`;
   - копирует их в materialized case как
     `expected_image_clean` и `expected_image_violations`;
   - пересматривает classification clean/dirty по правилу Р9:
     `expected_clean === false || expected_image_clean === false →
     real-dirty/`, иначе `real-clean/` (включая случаи с
     `expected_image_clean === null`);
   - идемпотентность сохраняется: повторный прогон не должен править
     mtime неизменённых кейсов.
2. `scripts/data/cases-audit.ts` (UPDATE):
   - флаг `--rules=text|image|all` (default `all` — две таблицы подряд);
   - таблица по IMG-правилам считает только правила из
     `image_rules.scope.yaml` (правила out of scope не показываются);
   - формат строки идентичен text-таблице:
     `rule_id | severity | real | synthetic | total | quota | delta`.
3. `datasets/synthetic-quota.images.yaml` — **создавать пустым**
   (только `version: 1`, `defaults: {}`, `overrides: {}`). Заполнение —
   следующий спринт (synthetic images). В скрипте audit'а если файл
   пуст — все `quota` показываются как `—` и `delta = —`.
4. **Прогон на текущих данных.** До разметки image-кейсов
   `pnpm cases:audit --rules=image` показывает 0 hits по всем
   правилам в scope. После пилота (Этап 5) — нулевые → ненулевые.

**Acceptance:**

- `pnpm cases:audit --rules=text` — поведение прежнее, числа не
  меняются.
- `pnpm cases:audit --rules=image` — таблица по AI-only IMG-правилам,
  все строки `real=0, synthetic=0`.
- `pnpm cases:audit --rules=all` — обе таблицы подряд.
- После материализации одного image-dirty кейса — соответствующее
  правило получает `real=1`.
- `tsx scripts/validate-cases.ts` зелёный.

### Этап 5 — Pilot smoke (5–10 карточек sputnik8)

**Цель:** прогнать полный цикл руками на маленькой партии, найти
шероховатости, поправить промпт/гайд до начала массовой разметки.

**Сценарий:**

1. `pnpm annotations:list:images --source=sputnik8` — фиксируем
   стартовые числа.
2. `pnpm annotations:scaffold:images --source=sputnik8 --limit=10`
   — создаёт 10 pending'ов и партию `images-review/<batch-id>/`.
3. Агент читает `docs/annotate-image-subagent-template.md`,
   `prompts/annotate-image-conservative-v1.txt`,
   `datasets/image_rules.compact.json` (отфильтрованный по scope) и
   заполняет 10 pending'ов через `Read` (multimodal) для каждого
   фото.
4. `pnpm annotations:commit` — все 10 коммитятся, папка партии
   удаляется.
5. `pnpm cases:generate` — кейсы перематериализуются, часть может
   переехать из `real-clean/` в `real-dirty/` (это нормально).
6. `tsx scripts/validate-cases.ts` — зелёный.
7. `pnpm cases:audit --rules=image` — впервые ненулевые числа.

**Что фиксировать:**

- Сколько из 10 карточек оказались image-dirty, по каким правилам.
- Какие правила вызвали неоднозначность у агента (оставить в notes
  карточки) — кандидаты на уточнение в `v2` промпта.
- Любые UX-затыки в pipeline (имена команд, формат pending,
  партионная папка) — сразу bug-fix перед Этапом 6.

**Acceptance:**

- 10 image-pending'ов закоммичены, папка партии удалена,
  `<source>.json` содержит image-поля для 10 карточек.
- Список «известных грабель» добавлен в
  `docs/image-annotation-guide.md` отдельным разделом.
- `pnpm typecheck` чистый.

### Этап 6 — Полная разметка реальных источников

**Цель:** разметить все 4 источника партиями по 5–10 карточек.

**План:**

- Порядок: `sputnik8` (60) → `pmpoperator` (22) → `scantour` (22) →
  `afisha` (18). Всего ~122 карточки, но только те из них, у которых
  `card.images.length > 0` (точное число — после Этапа 0).
- Партии — по 5–10 карточек на сессию субагента, чтобы держать
  фокус и не раздувать контекст агента.
- После каждого источника — `pnpm cases:audit --rules=image` +
  короткая записка в `docs/image-annotation-guide.md` о найденных
  паттернах нарушений (для калибровки `v2` промпта).
- При обнаружении систематической ошибки промпта — стоп массовой
  разметки, новая итерация `prompts/annotate-image-conservative-v2.txt`
  (append-only, по конвенции `AGENTS.md`), проверка на 5 уже
  размеченных карточках, продолжение.

**Acceptance:**

- Все карточки 4 источников с непустым `images[]` имеют
  `expected_image_clean !== null`.
- `pnpm cases:audit --rules=image` показывает финальное распределение
  по AI-only правилам.
- `tsx scripts/validate-cases.ts` зелёный.
- `docs/image-annotation-guide.md` пополнен разделом «Известные
  грабли».

## Главные риски

1. **Дрейф рулбука / scope.** Если состав AI-only правил меняется
   (например, новое правило IMG-31 или старое переклассифицируется),
   часть разметки может оказаться вне scope, или появятся «дыры».
   Митигация: версия `image_rules.scope.yaml` (`version: 1`); при
   изменении состава — обновление scope-конфига и повторный прогон
   `cases:audit`.

2. **Качество conservative-разметки на тонких правилах.** Recall
   conservative-агента может оказаться низким на нюансных правилах
   (например, соответствие фото описанию). Митигация: после Этапа 6
   — короткая ретроспектива; если recall < 80 % на самопроверке,
   докатить парный aggressive-режим (Sprint P7) по образцу
   `tz-annotate-pipeline-v2.md`.

3. **Утечка subject-под-тестом в ground truth.** Hard rule всего
   проекта: ни Yandex / GigaChat, ни эталонные AI через прямые API
   не используются для подготовки данных. Митигация: ни в одном
   image-скрипте нет импортов `providers/`; разметка — только в
   локальной сессии. Линт-проверка (grep на `providers/` в
   `scripts/data/*.ts`) — опциональная безопасная сетка.

## Hard rules — что не делать

- Не реализовывать никакие эвристические проверки изображений в
  scope этого спринта (Р1). Это R&D-исследование AI-разметки, а не
  product-grade модерация.
- Не редактировать `image_rules.yaml`, `text_rules.yaml`,
  `product_card.schema.json` (hard rule из `AGENTS.md`).
- Не использовать `annotate-image-conservative-v1.txt` после первого
  commit'а как «черновик» — для итерации создавать v2, v3 (правило
  «Правила работы с промптами» в `AGENTS.md`).
- **Не вызывать целевых провайдеров (Yandex / GigaChat) и любых
  эталонных AI через прямые API для подготовки image-разметки.**
  Только локальный AI-агент в интерактивной сессии.
- Не делать bbox / координатные аннотации в `image_violations` (v1).
- Не плодить новые директории `cases/real-image-{clean,dirty}/` —
  идём в существующие `real-clean/` / `real-dirty/` по правилу Р9.
- Не снимать Read-deny на `datasets/images/` точечно в
  `.claude/settings.local.json` — работаем через
  `datasets/images-review/<batch-id>/` (Р7).
- Не использовать npm/yarn — только pnpm.
- Не добавлять новые npm-зависимости. ajv, ajv-formats, yaml уже
  есть; для копирования файлов хватает `node:fs/promises`.

## Acceptance checklist (итоговый)

- [ ] `docs/image-annotation-design.md` — записка по Этапу 0.
- [ ] `datasets/image_rules.scope.yaml` — список AI-only правил.
- [ ] `datasets/schema/annotation.schema.json` — image-поля
      опциональны, обратная совместимость.
- [ ] `datasets/schema/test_case.schema.json` — image-поля
      опциональны.
- [ ] `scripts/validate-cases.ts` — поддержка image-полей и проверка
      непротиворечивости.
- [ ] `scripts/data/build-rules-compact.ts` — фильтр по
      `image_rules.scope.yaml`.
- [ ] `scripts/data/annotations-list-pending.ts` — режим images.
- [ ] `scripts/data/annotations-scaffold.ts` — режим images +
      копирование партии в `datasets/images-review/<batch-id>/`.
- [ ] `scripts/data/annotations-commit.ts` — валидация
      image-нарушений + удаление партии.
- [ ] `scripts/data/annotations-delete.ts` — `--scope=images`.
- [ ] `scripts/data/cases-generate.ts` — image-поля в case +
      classification по Р9.
- [ ] `scripts/data/cases-audit.ts` — `--rules=image`.
- [ ] `prompts/annotate-image-conservative-v1.txt` + запись в
      `prompts/CHANGELOG.md`.
- [ ] `docs/image-annotation-guide.md`.
- [ ] `docs/annotate-image-subagent-template.md` ≤ 80 строк.
- [ ] `package.json` — алиасы `annotations:list:images`,
      `annotations:scaffold:images`.
- [ ] `.gitignore` — `datasets/images-review/`.
- [ ] Pilot smoke 5–10 карточек sputnik8 прошёл, кейсы видны в
      `cases:audit --rules=image`.
- [ ] `pnpm typecheck` чистый.
- [ ] Все 4 источника размечены, `cases:audit --rules=image`
      финальный.
- [ ] Sprint P6 разбит на 6 коммитов (этапы 1–6, Этап 0 — это
      записка без кода, идёт отдельным коммитом).

## Что осталось на потом (не в этом спринте)

- **Synthetic images.** Аналог `synth:scaffold/validate/commit` для
  изображений. Промпты-генераторы фото пока не определены; вероятно,
  hand-crafted + ИИ-генерация. Отдельный спринт P7 / P8.
- **Двухпроходная разметка** (conservative + aggressive) для
  изображений. По итогам пилота, если recall < 80 %.
- **Bbox / координатные аннотации.** Если text-evidence окажется
  недостаточен для воспроизводимости.
- **Расширение `synthetic-quota.images.yaml`.** Заполняется
  одновременно с Sprint synthetic-images.
- **Eval-фаза** для image-кейсов — `pnpm eval:image` уже существует,
  доводится после первого реального покрытия.
