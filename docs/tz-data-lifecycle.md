# ТЗ — управление жизненным циклом тестовых данных (Sprint P4)

Следующая сессия(и) Claude Code. Документ самодостаточен: читается «с
холода», предполагает только знание `CLAUDE.md`, `ARCHITECTURE.md`,
`text_rules.yaml` + `image_rules.yaml`, двух JSON Schema в
`datasets/schema/` и трёх предыдущих ТЗ-файлов (`tz-parsing.md`,
`tz-baseline-audit.md`, `docs/real-cards-audit.md` — отчёт P3).

## Цель

Сделать пайплайн `harvest → parse → annotate → cases` управляемым:

1. **Configurable per-source counts + опциональный seed** — без
   правки кода harvester'ов.
2. **Спаршеные карточки и разметка не удаляются автоматически** —
   отдельные команды CRUD на удаление по источнику или всего сразу.
3. **Разметка отделена от кода** — TS-словарь `DIRTY` в
   `scripts/generate-real-cases.ts` переезжает в JSON-store. Любой
   локальный агент (человек, Claude, ChatGPT, GigaChat) может разметить
   неразмеченные карточки через JSON-скаффолды, без привязки к
   конкретной модели.

## Scope / Out of scope

**In scope:**

- Новый файл `datasets/sources.config.json` (target/seed по источнику).
- Refactor четырёх harvester'ов на чтение конфига + CLI-оверрайды.
- Миграция разметки из `scripts/generate-real-cases.ts` в
  `datasets/annotations/<source>.json`.
- Новая директория `scripts/data/` с утилитами CRUD/annotation.
- `scripts/data/cases-generate.ts` (вместо `generate-real-cases.ts`)
  — материализует `card_case` из `cards.raw.jsonl` + annotations.
- Новые `pnpm`-скрипты: `cards:delete`, `annotations:delete`,
  `annotations:list`, `annotations:scaffold`, `annotations:commit`,
  `cases:generate`.
- Новая JSON Schema `datasets/schema/annotation.schema.json`.
- Краткий гайд `docs/annotation-guide.md` для разметчика-агента.
- Обновление `CLAUDE.md` + `datasets/README.md`.

**Out of scope:**

- Не редактировать `text_rules.yaml` / `image_rules.yaml`,
  `product_card.schema.json`, `test_case.schema.json` (это hard rule,
  см. `CLAUDE.md`).
- Не менять логику парсеров (`scripts/parse/parse-*.ts`,
  `scripts/parse/download-images.ts`, `scripts/parse/validate.ts`,
  `scripts/parse/summary.ts`) — только источник конфигов в harvest-.
- Не менять `scripts/validate-cases.ts`.
- Не вводить новых источников, провайдеров, моделей, зависимостей.
- Не делать generic «base parser class» / «base scaffold» — каждый
  source остаётся со своим harvest-/parse-файлом, как сейчас.
- Не переименовывать существующие `pnpm harvest:*` / `pnpm parse:*`.

## Зафиксированные решения (развилки)

Согласовано с пользователем 2026-04-25:

| ID | Решение |
|----|---------|
| Р1 | Разметка хранится **отдельно** от case-файлов (`datasets/annotations/<source>.json`). Cases — материализованный артефакт, регенерится. |
| Р2 | В `sources.config.json` только `target_total` + `seed` per source. Source-specific shares (`SPB_SHARE`, `MIN_PER_TYPE`, …) остаются в коде harvester'ов. |
| Р3 | `cards:delete --source=X` сносит `cards.raw.jsonl`, `images.raw.jsonl`, `cards.rejected.jsonl`, `images.oversize.txt`, `html-cache/`, и `datasets/images/<source>_*.{jpg,png,webp,gif}`. **Не трогает** `urls.txt` и annotations. |
| Р4 | Annotation flow через JSON-скаффолды + commit. Никакой LLM-привязки в коде — агент работает с файлами. |
| Р5 | Опасные операции по умолчанию печатают план + `Продолжить? [y/N]`. Флаг `--yes` минует подтверждение. `--dry-run` опционально (только план). |

## Текущее состояние (что переписывается / удаляется)

- `scripts/generate-real-cases.ts` — содержит хардкоженный словарь
  `DIRTY` (16 карточек, строки ~33–223) и пустой `REVIEWS`. После
  миграции **удаляется**. Это единственный источник правды для
  миграции — пере-классификация карточек запрещена.
- `scripts/parse/harvest-{sputnik8,pmpoperator,scantour,afisha}.ts` —
  каждый имеет константы `RANDOM_SEED = 42` и `TARGET_TOTAL = N`
  (sputnik8: 40, pmpoperator: 14, scantour: 14, afisha: 9). Источник
  правды переезжает в config, константы удаляются.
- `package.json` `scripts` — все `harvest:*`, `parse:*`, `images:download`,
  `parse:validate`, `parse:summary` остаются. Добавляются 6 новых.

Состояние данных на момент начала спринта: **67 карточек размечено**
(51 clean + 16 dirty). Полный реестр — в `docs/real-cards-audit.md`.
По источникам: sputnik8 30 (29c+1d), pmpoperator 14 (12c+2d),
scantour 14 (4c+10d), afisha 9 (6c+3d).

## Целевая структура

```
datasets/
├── sources.config.json                       NEW
├── annotations/                               NEW
│   ├── sputnik8.json                          NEW
│   ├── pmpoperator.json                       NEW
│   ├── scantour.json                          NEW
│   ├── afisha.json                            NEW
│   └── pending/                               NEW (gitignored)
│       └── <case_id>.json                     рабочие скаффолды
├── schema/
│   ├── product_card.schema.json               без изменений
│   ├── test_case.schema.json                  без изменений
│   └── annotation.schema.json                 NEW
├── cases/real-{clean,dirty}/                  существует, регенерится
├── images/                                    существует
└── <source>/                                  без изменений
    ├── urls.txt
    ├── cards.raw.jsonl
    ├── images.raw.jsonl
    └── html-cache/

scripts/
├── parse/
│   ├── harvest-*.ts                           REWRITE (читают config)
│   ├── parse-*.ts                             без изменений
│   ├── download-images.ts                     без изменений
│   ├── validate.ts                            без изменений
│   ├── summary.ts                             без изменений
│   └── lib/
│       ├── (existing)
│       └── config.ts                          NEW
├── data/                                      NEW
│   ├── cards-delete.ts                        NEW
│   ├── annotations-delete.ts                  NEW
│   ├── annotations-list-pending.ts            NEW
│   ├── annotations-scaffold.ts                NEW
│   ├── annotations-commit.ts                  NEW
│   └── cases-generate.ts                      MIGRATE из generate-real-cases.ts
├── generate-real-cases.ts                     DELETE после миграции
├── validate-cases.ts                          без изменений
└── smoke-test.ts                              без изменений

docs/
├── tz-data-lifecycle.md                       (этот файл)
└── annotation-guide.md                        NEW
```

## Декомпозиция

### Этап 1 — Configurable harvesters

**Цель:** убрать хардкоды `RANDOM_SEED`/`TARGET_TOTAL` из четырёх
harvester'ов, унифицировать через `datasets/sources.config.json` и
CLI-оверрайды.

**Deliverables:**

1. `datasets/sources.config.json`:
   ```json
   {
     "version": 1,
     "sources": {
       "sputnik8":    { "target_total": 40, "seed": 42 },
       "pmpoperator": { "target_total": 14, "seed": 42 },
       "scantour":    { "target_total": 14, "seed": 42 },
       "afisha":      { "target_total":  9, "seed": 42 }
     }
   }
   ```

   Числа взяты из текущих хардкодов. **Внимание:** sputnik8 имеет
   `TARGET_TOTAL = 40`, но на диске лежит только 30 карточек — это
   нормально, harvester отдаёт максимум 40 URL, парсер берёт сколько
   получилось распарсить. Менять не нужно.

2. `scripts/parse/lib/config.ts`:
   - `loadSourcesConfig()` — читает JSON, валидирует ajv.
   - `getSourceConfig(source: string, cli: { target?: number; seed?: number })`
     — возвращает `{ target: number; seed: number }` с приоритетом
     CLI > config. Падает если source отсутствует в конфиге.
   - `parseHarvestArgs()` — парсит `--target=N`, `--seed=N`, отдаёт
     `{ target?: number; seed?: number }`. Игнорирует прочие
     аргументы.

3. Refactor `scripts/parse/harvest-*.ts` (×4):
   - Удалить `const RANDOM_SEED = 42` и `const TARGET_TOTAL = N`.
   - В `main()`: `const { target, seed } = getSourceConfig('sputnik8', parseHarvestArgs())`.
   - Использовать `seed` в `mulberry32(seed)`, `target` вместо
     `TARGET_TOTAL`.
   - Source-specific константы (`SPB_SHARE`, `MSK_SHARE`,
     `MIN_PER_CITY`, `MIN_PER_TYPE`, `SPB_CITIES`, `MSK_CITIES`,
     `EVENT_RE`, `CARD_PATTERN`, `EXCLUDED_PATH_RE`, `AFISHA_COOKIES`)
     **остаются в коде**.

4. Acceptance:
   - `pnpm harvest:sputnik8` без флагов даёт тот же результат, что и
     до рефакторинга (target=40, seed=42, тот же `urls.txt`).
   - `pnpm harvest:sputnik8 -- --target=5` (или
     `tsx scripts/parse/harvest-sputnik8.ts --target=5` напрямую) даёт
     5 URL.
   - `pnpm typecheck` чистый.
   - `git diff datasets/sputnik8/urls.txt` после повторного прогона
     `pnpm harvest:sputnik8` — пустой (детерминизм сохранён).

### Этап 2 — Storage аннотаций + миграция

**Цель:** перенести 16 dirty-разметок из TS-кода в
`datasets/annotations/<source>.json`, переписать генератор cases на
чтение этого store. Acceptance — `git diff datasets/cases/` пустой
после миграции.

**Deliverables:**

1. `datasets/schema/annotation.schema.json`:
   ```json
   {
     "$schema": "https://json-schema.org/draft/2020-12/schema",
     "$id": "annotation.schema.json",
     "title": "AnnotationStore",
     "description": "Карта case_id → разметка нарушений на этой карточке. Один файл на источник.",
     "type": "object",
     "required": ["version", "annotations"],
     "additionalProperties": false,
     "properties": {
       "version": { "const": 1 },
       "annotations": {
         "type": "object",
         "patternProperties": {
           "^[a-z0-9_-]+$": { "$ref": "#/$defs/annotation" }
         },
         "additionalProperties": false
       }
     },
     "$defs": {
       "annotation": {
         "type": "object",
         "required": ["expected_clean", "violations", "annotated_at", "annotator"],
         "additionalProperties": false,
         "properties": {
           "expected_clean": { "type": "boolean" },
           "violations": {
             "type": "array",
             "items": { "$ref": "test_case.schema.json#/$defs/violation_card" }
           },
           "notes":        { "type": ["string", "null"] },
           "annotated_at": { "type": "string", "format": "date" },
           "annotator": {
             "type": "string",
             "minLength": 1,
             "description": "Свободная метка происхождения разметки: 'manual:sergio', 'claude-opus-4.7', 'gpt-5', 'gigachat-max-2.5'. Используется для трассировки."
           }
         },
         "allOf": [
           {
             "if": { "properties": { "expected_clean": { "const": true } }, "required": ["expected_clean"] },
             "then": { "properties": { "violations": { "maxItems": 0 } } }
           },
           {
             "if": { "properties": { "expected_clean": { "const": false } }, "required": ["expected_clean"] },
             "then": { "properties": { "violations": { "minItems": 1 } } }
           }
         ]
       }
     }
   }
   ```

   `violation_card` берётся через `$ref` на `test_case.schema.json` —
   формат нарушения тот же, что и в card_case. ajv должен загрузить
   обе схемы (`addSchema`).

2. `datasets/annotations/{sputnik8,pmpoperator,scantour,afisha}.json`
   — каждый со структурой:
   ```json
   {
     "version": 1,
     "annotations": {
       "<case_id>": {
         "expected_clean": true|false,
         "violations": [...],
         "notes": null,
         "annotated_at": "2026-04-25",
         "annotator": "manual:sergio"
       }
     }
   }
   ```

   Миграция:
   - **51 clean карточка**: `expected_clean: true`, `violations: []`,
     `notes: null`, `annotator: "manual:sergio"`,
     `annotated_at: "2026-04-25"`.
   - **16 dirty карточек**: violations 1:1 из `DIRTY` в
     `scripts/generate-real-cases.ts:33-223`. Те же поля. Severity и
     quote копируются дословно.

   Распределение dirty по источникам:
   - sputnik8: 1 (sputnik8_57480 — TXT-23)
   - pmpoperator: 2 (TXT-21, TXT-22)
   - scantour: 10 (все TXT-20)
   - afisha: 3 (TXT-19 ×3, плюс TXT-26 на одной — итого 4 violations)

3. `scripts/data/cases-generate.ts`:
   - Читает все `datasets/<source>/cards.raw.jsonl`.
   - Читает все `datasets/annotations/<source>.json`.
   - Для каждой карточки, у которой ЕСТЬ запись в annotations:
     собирает `card_case` (см. `test_case.schema.json#/$defs/card_case`):
     ```ts
     {
       case_id: card.id,
       kind: 'card_case',
       source: 'production',
       generator: { model: null, prompt_version: null, date: TODAY },
       card,
       expected_violations: annotation.violations,
       expected_clean: annotation.expected_clean,
       notes: annotation.notes
     }
     ```
   - Пишет в `datasets/cases/real-clean/<case_id>.json` или
     `real-dirty/<case_id>.json` в зависимости от `expected_clean`.
   - **Защита от рассинхрона**: перед записью удаляет файл этой
     карточки из противоположной директории, если он там есть
     (например, карточка была clean, стала dirty).
   - Карточки без аннотаций — пропускает, в конце печатает
     `[generate] pending: <count>` со списком первых 5 case_id.
   - Идемпотентен: повторный прогон даёт ровно тот же набор файлов.
   - Защита: если annotations содержат orphan'ы (case_id, которых нет
     в `cards.raw.jsonl`) — `throw` с явной ошибкой (как сейчас в
     `generate-real-cases.ts:326`).

4. После успешной миграции — удалить `scripts/generate-real-cases.ts`.

5. `package.json`:
   ```json
   "cases:generate": "tsx scripts/data/cases-generate.ts"
   ```

**Acceptance:**

- `pnpm cases:generate` создаёт ровно 67 файлов: 51 в `real-clean/` +
  16 в `real-dirty/`.
- `pnpm parse:validate-cases` (`tsx scripts/validate-cases.ts`):
  total=67, passed=67, errors=0.
- `git diff datasets/cases/` после миграции пустой (содержимое
  case-файлов идентично pre-миграции).
- `pnpm typecheck` чистый.
- `scripts/generate-real-cases.ts` удалён.

### Этап 3 — Команды удаления

**Deliverables:**

1. `scripts/data/cards-delete.ts`:
   - Аргументы: `--source=X` **или** `--all` (взаимоисключающие).
     Флаги: `--yes` (без подтверждения), `--dry-run` (план без
     удаления).
   - Удаляет per source (Р3):
     - `datasets/<source>/cards.raw.jsonl`
     - `datasets/<source>/cards.rejected.jsonl`
     - `datasets/<source>/images.raw.jsonl`
     - `datasets/<source>/images.oversize.txt`
     - `datasets/<source>/html-cache/` (рекурсивно)
     - `datasets/images/<source>_*.{jpg,png,webp,gif}` —
       glob по `image_id` (см. `scripts/parse/lib/image-id.ts`:
       `image_id = <card.id>_<index>`, а `card.id` всегда
       начинается с `<source>_`).
   - **Не трогает**: `urls.txt`, `datasets/annotations/`,
     `datasets/cases/`.
   - Поведение по умолчанию: печатает список путей и количество
     файлов, ждёт `Продолжить? [y/N]`. С `--yes` — сразу удаляет.
     С `--dry-run` — только план, удалений нет.
   - `--all` применяется ко всем source из `sources.config.json`.
   - Если source не в конфиге — error с code=2.

2. `scripts/data/annotations-delete.ts`:
   - Аргументы: `--source=X` или `--all`. Флаги: `--yes`,
     `--dry-run`, `--keep-cases` (не удалять материализованные
     case-файлы — на случай дебага).
   - Удаляет per source:
     - `datasets/annotations/<source>.json` (полностью, не оставляет
       пустую структуру).
     - `datasets/annotations/pending/<source>_*.json` (если есть).
     - `datasets/cases/real-clean/<source>_*.json` и
       `datasets/cases/real-dirty/<source>_*.json` (если не
       `--keep-cases`).
   - **Не трогает**: `cards.raw.jsonl`, `images.raw.jsonl`, картинки.
   - Поведение и подтверждение — как у `cards-delete`.

3. `package.json`:
   ```json
   "cards:delete":       "tsx scripts/data/cards-delete.ts",
   "annotations:delete": "tsx scripts/data/annotations-delete.ts"
   ```

**Acceptance:**

- `pnpm cards:delete --source=afisha --dry-run` печатает план
  (~9 cards.raw + ~9 images.raw + ~36 image-файлов + ~382 html-cache)
  и не удаляет ничего.
- `pnpm cards:delete --source=afisha --yes` удаляет всё перечисленное;
  `pnpm parse:summary` показывает 0 для afisha.
- `datasets/annotations/afisha.json` после этого ещё на месте.
- `pnpm annotations:delete --source=afisha --yes` удаляет
  `annotations/afisha.json` и 9 case-файлов (6 clean + 3 dirty).
  `cards.raw.jsonl` уже отсутствует, ошибки нет.
- Без `--yes` команда печатает план и интерактивно ждёт ответа.

### Этап 4 — Annotation workflow

**Deliverables:**

1. `scripts/data/annotations-list-pending.ts`:
   - Аргументы: `--source=X` (опционально), `--json` (опционально).
   - Читает все `cards.raw.jsonl` и все `annotations/<source>.json`.
   - Печатает case_id'ы без аннотации, сгруппированные по source:
     ```
     [pending] sputnik8: 0
     [pending] pmpoperator: 0
     [pending] scantour: 0
     [pending] afisha: 9
       afisha_concert_xxx
       afisha_performance_yyy
       ...
     [pending] всего: 9
     ```
   - С `--json`: `[{case_id: "...", source: "..."}, ...]`.

2. `scripts/data/annotations-scaffold.ts`:
   - Аргументы: `--source=X` (опционально).
   - Для каждой неразмеченной карточки создаёт
     `datasets/annotations/pending/<case_id>.json`:
     ```json
     {
       "case_id": "sputnik8_22635",
       "source": "sputnik8",
       "card_excerpt": {
         "id": "sputnik8_22635",
         "product_type": "excursion",
         "title": "...",
         "short_description": "...",
         "full_description": "...",
         "program_items": [...],
         "services": [...],
         "location": {...},
         "contacts_block": {...}
       },
       "expected_clean": null,
       "violations": [],
       "notes": null,
       "annotator": null,
       "annotated_at": null,
       "_help": {
         "rules_path": "text_rules.yaml + image_rules.yaml",
         "schema_path": "datasets/schema/annotation.schema.json",
         "instruction": "Заполни expected_clean (true/false), violations при dirty, annotator, annotated_at. Для TXT-* нарушений quote должна дословно встречаться в card_excerpt по field_path. Подробности — docs/annotation-guide.md."
       }
     }
     ```
   - `card_excerpt` — копия карточки **без** `images`, `schedule`,
     `age_restriction`, `group_size`, `languages` (текстовая разметка
     этих полей не касается; чтобы не раздувать файл).
   - Идемпотентен: если pending-файл уже есть — не перезаписывает.
   - Если в `annotations/<source>.json` уже есть финальная запись —
     pending не создаётся.
   - Печатает количество созданных + ссылку на `docs/annotation-guide.md`.

3. `scripts/data/annotations-commit.ts`:
   - Аргументы: `--yes`, `--dry-run`.
   - Обходит `datasets/annotations/pending/*.json`. Для каждого:
     - Если `expected_clean === null` → SKIP, печатает
       `[skip] <case_id>: not annotated`.
     - Иначе нормализует: убирает `_help`, `card_excerpt`, `source`,
       `case_id` — оставляет только поля из `annotation.schema.json`
       (`expected_clean`, `violations`, `notes`, `annotated_at`,
       `annotator`).
     - Валидирует через `annotation.schema.json` + ajv.
     - Дополнительно: для каждого TXT-violation проверяет, что
       `quote` дословно встречается в исходной карточке по
       `field_path` (логика из `validate-cases.ts:quoteFoundIn`).
       Карточка читается из `cards.raw.jsonl` источника, к которому
       относится `case_id` (определяется по префиксу).
     - При успехе мёрджит запись в
       `datasets/annotations/<source>.json` (создаёт файл с
       `version: 1` если нет; добавляет/перезаписывает
       `annotations[case_id]`).
     - При успехе удаляет pending-файл.
     - При ошибке — печатает диагностику, оставляет pending,
       `process.exit(1)` в конце.
   - Идемпотентен: повторный коммит уже-коммитнутого файла —
     no-op (pending'а нет).
   - С `--dry-run` — только проверки, ни одной записи.

4. `package.json`:
   ```json
   "annotations:list":     "tsx scripts/data/annotations-list-pending.ts",
   "annotations:scaffold": "tsx scripts/data/annotations-scaffold.ts",
   "annotations:commit":   "tsx scripts/data/annotations-commit.ts"
   ```

5. `.gitignore`: добавить строку `datasets/annotations/pending/` —
   рабочая директория, не комитим.

6. `docs/annotation-guide.md` — ~80 строк, разделы:
   - **Workflow**: 6 шагов (`list → scaffold → fill → commit →
     cases:generate → validate-cases`).
   - **Шаблон промпта** для LLM-агента (вставка card_excerpt +
     text_rules.yaml / image_rules.yaml + инструкция, что вернуть).
     С пунктами:
     1. rule_id только из text_rules.yaml / image_rules.yaml.
     2. severity точно как в text_rules.yaml / image_rules.yaml.
     3. Для TXT-* — quote дословно из card_excerpt по field_path.
     4. expected_clean=true ⟺ violations=[].
     5. Не выдумывать, помечать только явные нарушения.
     6. Контактные данные — в quote, не в rationale.
   - **Что делать с конфликтами**: если две модели разметили
     одинаковый case_id по-разному — у нас один store, последний
     `annotations:commit` побеждает; дубль через `annotator`
     отслеживается отдельно (явно говорим, что версионирование
     out of scope этого спринта).

7. Update `CLAUDE.md` (раздел `## Команды`) — добавить новые
   `pnpm`-скрипты блоком, без изменения существующего.

8. Update `datasets/README.md` — раздел «Жизненный цикл данных»:
   `harvest → parse → annotate → cases`. Краткое описание с указанием
   команд.

**Acceptance:**

- На свежем репо (после `pnpm annotations:delete --all --yes`):
  - `pnpm annotations:list` показывает 67 неразмеченных по 4 source.
  - `pnpm annotations:scaffold` создаёт 67 pending-файлов.
  - Если вручную заполнить один pending (или скриптом для smoke) —
    `pnpm annotations:commit` переносит запись в `<source>.json`,
    pending уменьшается до 66.
  - `pnpm cases:generate` материализует ровно 1 case-файл.
  - `pnpm parse:validate-cases` чист.
- `datasets/annotations/pending/` в `.gitignore`.
- `pnpm typecheck` чистый.

### Этап 5 — Verification + commit

1. **Полный smoke сценарий** (после этапов 1–4):
   - До: 67 cases, разметка в JSON-store.
   - `pnpm cards:delete --source=afisha --yes` →
     `cards.raw.jsonl` afisha исчез, картинки afisha удалены, html-cache
     пуст. annotations afisha не тронуты.
   - `pnpm annotations:delete --source=afisha --yes` →
     `annotations/afisha.json` удалён, 9 case-файлов afisha исчезли.
   - `pnpm harvest:afisha && pnpm parse:afisha` → 9 карточек снова в
     `cards.raw.jsonl`, 0 cases.
   - `pnpm annotations:list` → 9 pending у afisha.
   - `pnpm annotations:scaffold` → 9 файлов в `pending/`.
   - (опционально) автоматическое заполнение или ручное → `commit` →
     `cases:generate` → `validate-cases` чисто.

2. **Финальный `git status`**: только новые/изменённые файлы из ТЗ,
   никаких `datasets/<source>/html-cache/`,
   `datasets/annotations/pending/`, `datasets/images/*` в индексе.

3. **Commit message** (формат как у P1–P3):
   ```
   feat: Sprint P4 — управляемый lifecycle тестовых данных

   - Configurable harvesters: target/seed в datasets/sources.config.json + CLI overrides.
   - Annotation store: разметка переехала из TS-кода в datasets/annotations/<source>.json.
   - CRUD-команды: cards:delete, annotations:delete, annotations:scaffold, annotations:commit.
   - cases-generate.ts материализует cases из cards + annotations (заменяет generate-real-cases.ts).
   - Полная миграция 67 кейсов 1:1 (51 clean + 16 dirty).
   ```

## Hard rules — что не делать

- Не редактировать `text_rules.yaml` / `image_rules.yaml`,
  `product_card.schema.json`, `test_case.schema.json` (это hard rule
  из `CLAUDE.md`).
- Не менять логику парсеров и `validate-cases.ts` (только источник
  конфига в harvest-).
- Не выкидывать `scripts/generate-real-cases.ts` до того, как
  `pnpm cases:generate && pnpm parse:validate-cases` пройдут чисто на
  новом store (защита от потери разметки).
- Не пере-классифицировать карточки во время миграции. DIRTY-словарь
  в `scripts/generate-real-cases.ts:33-223` — единственный источник
  правды для 16 dirty-кейсов.
- Не использовать npm/yarn — только pnpm.
- Не добавлять новые npm-зависимости. Всё нужное (ajv, ajv-formats,
  cheerio, …) уже есть в `package.json`.
- Не переименовывать существующие команды `pnpm harvest:*`,
  `pnpm parse:*`, `pnpm parse:validate`, `pnpm parse:summary`.
- Не делать generic «base parser class» / «base scaffold» — каждый
  source = свой harvest-/parse-файл, как сейчас.
- Не генерить документацию/README/планы кроме перечисленных в
  Deliverables (`tz-data-lifecycle.md` сам, `annotation-guide.md`,
  обновления `CLAUDE.md` + `datasets/README.md`).

## Acceptance checklist (итоговый)

- [x] `datasets/sources.config.json` создан, harvester'ы читают из
      него.
- [x] `pnpm harvest:sputnik8 -- --target=5 --seed=7` отдаёт 5 URL с
      детерминированным shuffle.
- [x] `datasets/schema/annotation.schema.json` создан, валидируется
      ajv strict.
- [x] `datasets/annotations/{sputnik8,pmpoperator,scantour,afisha}.json`
      созданы; в сумме 67 записей (51 clean + 16 dirty).
- [x] `scripts/data/cases-generate.ts` создан;
      `pnpm cases:generate` → 67 case-файлов.
- [x] `tsx scripts/validate-cases.ts` → total=67, passed=67, errors=0.
- [x] `git diff datasets/cases/` после миграции пустой (1:1 с
      pre-миграцией).
- [x] `scripts/generate-real-cases.ts` удалён.
- [x] `pnpm cards:delete`, `pnpm annotations:delete`,
      `pnpm annotations:list`, `pnpm annotations:scaffold`,
      `pnpm annotations:commit` работают согласно Acceptance этапов
      3–4.
- [x] `--dry-run` и `--yes` поведение для деструктивных команд.
- [x] `datasets/annotations/pending/` в `.gitignore`.
- [x] `docs/annotation-guide.md` создан (~80 строк, шаблон промпта +
      6-шаговый workflow).
- [x] `CLAUDE.md` и `datasets/README.md` обновлены: новые команды
      перечислены, lifecycle описан.
- [x] `pnpm typecheck` чистый.
- [x] Sprint P4 разбит на 5 коммитов (этапы 1–4 + verification).

## Sprint P4 — статус

Завершён 2026-04-25. Stages 1–5 закоммичены отдельно:

- этап 1 — `7cec01a feat: Sprint P4 этап 1 — configurable harvesters`
- этап 2 — `71404c1 feat: Sprint P4 этап 2 — annotation store + cases-generate`
- этап 3 — `cf970c2 feat: Sprint P4 этап 3 — команды удаления cards/annotations`
- этап 4 — `c56e888 feat: Sprint P4 этап 4 — annotation workflow + lifecycle docs`
- этап 5 — verification smoke (этот коммит)

Smoke прогон на afisha: `cards:delete` → `annotations:delete` →
`harvest:afisha` (9/9 URL детерминированы) → `parse:afisha` (9/9
карточек) → `annotations:list` (9 pending) → `annotations:scaffold`
(9 файлов) → restore annotations + `cases:generate` (67 cases) →
`validate-cases` (67/67 passed). Все шаги pipeline'а отработали.

## Открытые вопросы для начала сессии

1. **Glob по картинкам в `cards-delete`.** Имена картинок имеют
   префикс `<source>_<id>_<idx>` (sputnik8_57480_0 и т.п.). Простой
   glob `datasets/images/<source>_*.{jpg,png,webp,gif}` корректен —
   `card.id` всегда начинается на `<source>_` (см.
   `parse-sputnik8.ts:322`, `parse-pmpoperator.ts`, …). Если в
   процессе обнаружится исключение — сужать до перечня image_id из
   `images.raw.jsonl`.

2. **Что делать, если `annotations-commit` находит pending с
   `expected_clean: null`?** SKIP, не падать. Это нормальный кейс:
   агент в процессе, не закончил.

3. **Совместимость с удалённым `_help` блоком в pending-файле.** Агент
   может удалить `_help` при заполнении. `commit` нормализует JSON
   перед валидацией — лишние поля убираются, отсутствующие
   обязательные → ошибка валидации.

4. **Поведение `cases-generate` если карточка clean → стала dirty
   (или наоборот) при повторной разметке.** Перед записью удалять
   старый файл из противоположной директории, потом писать новый.

5. **Атомарность записи в `<source>.json`.** Писать через `tmp +
   rename` (как уже сделано в `scripts/parse/validate.ts:91-94`),
   чтобы при крэше не оставить битый JSON.
