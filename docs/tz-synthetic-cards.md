# ТЗ — синтетические карточки + аудит покрытия правил (Sprint P5)

Следующая сессия(и) AI-агента. Документ самодостаточен: читается «с
холода», предполагает только знание `AGENTS.md`, `ARCHITECTURE.md`,
`text_rules.yaml` + `image_rules.yaml`, двух JSON Schema в
`datasets/schema/` и трёх предыдущих ТЗ-файлов
(`tz-baseline-audit.md`, `tz-data-lifecycle.md`,
`tz-annotate-pipeline-v2.md`). Отчёт по реальной выборке —
`docs/real-cards-audit.md`.

## Цель

Получить синтетический корпус карточек, который **закрывает дыры в
покрытии 35 текстовых правил** TXT-01..TXT-35, не пробитые реальной
выборкой (29 из 35 правил — без единого реального примера).
Главное требование к синтетике — **натуральность**: карточка должна
выглядеть как реальная попытка продавца протащить нарушение, а не как
«учебный пример нарушения». Если простой
`prompts/annotate-conservative-v1.txt` ловит нарушение, потому что
оно «бросается в глаза», — это плохая синтетика, она искусственно
завышает recall модели.

Сделать генерацию синтетики **столь же удобной**, как ручной аудит
реальных карточек: агент (Claude Code в локальной сессии) запускает
скрипт, видит дельту покрытия, заполняет pending-файлы из шаблона по
канонизированному промпту, коммитит, материализует cases.

## Scope / Out of scope

**In scope:**

- Скрипт `cases:audit` — распределение нарушений по `rule_id` + дельта
  от целевой квоты, формат отчёта совместим с `docs/real-cards-audit.md`.
- Файл квоты `datasets/synthetic-quota.yaml` — целевое число примеров
  на каждое правило (override + дефолт по severity).
- Канонический промпт `prompts/synthesize-card-v1.txt` с жёсткими
  anti-clickbait требованиями.
- Synthetic store: `datasets/synthetic/cards.raw.jsonl` +
  `datasets/annotations/synthetic.json`. Структуры идентичны
  существующим (один источник, один файл аннотаций).
- Команды `synth:scaffold`, `synth:commit`, `synth:validate`. Поведение
  по образцу `annotations:scaffold` / `annotations:commit`
  (Sprint P4 / pipeline v2).
- Метрики натуральности (`synth:validate`): длины полей в реальном
  распределении, разнообразие тематик, чёрный список маркеров
  синтетики, дубликаты.
- Расширение `cases-generate.ts` для подхвата synthetic-источника.
  Материализация в `datasets/cases/synthetic-{clean,dirty}/`.
- Шаблон делегации субагенту `docs/synthesize-subagent-template.md`
  (≤ 80 строк, по образцу `docs/annotate-subagent-template.md`).
- Гайд `docs/synthetic-guide.md` (workflow + критерии натуральности).
- Обновления `AGENTS.md` (раздел «Команды» / «Lifecycle тестовых данных»).

**Out of scope (явное решение пользователя):**

- Синтетика для IMG-правил (фото) — отдельный спринт. Все synthetic
  карточки этого спринта `images: []`.
- Автоматизация генерации через провайдера (Yandex / GigaChat batch) —
  отложено. Этот спринт — только Claude-Code-в-сессии flow.
- Изменение `text_rules.yaml` / `image_rules.yaml`,
  `product_card.schema.json`, `test_case.schema.json`,
  `annotation.schema.json` (hard rule из `AGENTS.md`).
- Переразметка существующих 67 реальных кейсов.
- Не вводить новый kind в `test_case.schema.json` — synthetic-кейсы
  ложатся в тот же `card_case`, отличие только в полях
  `source: "synthetic"` и заполненных `generator.{model,prompt_version,date}`.

## Зафиксированные решения (развилки)

Согласовано с пользователем 2026-04-27:

| ID | Решение |
|----|---------|
| Р1 | Локальный AI-агент = Claude Code в текущей сессии. Никаких API-batch-вызовов через провайдеров; pipeline идентичен существующему `annotations:scaffold → fill → commit` (см. Sprint P4 + pipeline v2). |
| Р2 | Synthetic-кейсы материализуются в `datasets/cases/synthetic-{clean,dirty}/`. `synthetic-clean/` — карточки, которые специально написаны как чистые (контрольная группа против ложных срабатываний). |
| Р3 | Целевая квота — явный `datasets/synthetic-quota.yaml` (override per rule_id) + дефолт по severity (critical=10, high=7, medium=5, low=3). Override прибит к rule_id, не к severity. |
| Р4 | Pipeline v2 (compact JSON, conservative+aggressive промпты, шаблон субагента) переиспользуем максимально. Промпт `synthesize-card-v1.txt` — новый файл, но по конвенциям из этапа 6 pipeline v2. |
| Р5 | Anti-clickbait критерии (предпроверка `synth:validate` перед коммитом большой партии): длины полей в 5-95 перцентиле распределения real-карточек; ≥ 40 % уникальных категорий активностей в партии; чёрный список маркеров синтетики («лучший в мире», «100 % гарантия», «уникальная экскурсия», «не имеющий аналогов» и т.п.); отсутствие near-дубликатов внутри synthetic-корпуса (shingling по 5-граммам). |

## Текущее состояние (вход)

На 2026-04-27 (см. `docs/real-cards-audit.md`):

- 67 размеченных реальных карточек, 51 clean + 16 dirty + 17 нарушений
  на 6 правилах (TXT-19, TXT-20, TXT-21, TXT-22, TXT-23, TXT-26).
- 29 правил из 35 — без единого реального примера. Все critical-правила
  (TXT-05, TXT-07, TXT-08, TXT-09, TXT-11, TXT-14, TXT-15, TXT-16, TXT-17)
  — без покрытия. Большинство high-правил (TXT-01, TXT-02, TXT-06, TXT-10,
  TXT-12, TXT-31, TXT-34, TXT-35) — без покрытия.
- Pipeline собран и проверен: `harvest → parse → annotate → cases`,
  команды `cards:delete` / `annotations:delete` работают по source.
- `prompts/annotate-conservative-v1.txt` + `prompts/annotate-aggressive-v1.txt`
  существуют — будут использованы как «слепой re-annotation» в
  `synth:validate`.
- `datasets/text_rules.compact.json` (12.8 KB) — компактная таблица для
  промптов синтезатора.

## Целевая структура

```
prompts/
├── annotate-conservative-v1.txt              существует
├── annotate-aggressive-v1.txt                существует
└── synthesize-card-v1.txt                    NEW

datasets/
├── synthetic-quota.yaml                      NEW
├── synthetic/                                NEW
│   ├── cards.raw.jsonl                       NEW (append-only)
│   └── cards.rejected.jsonl                  NEW (если synth:commit отверг)
├── annotations/
│   ├── sputnik8.json                         существует
│   ├── pmpoperator.json                      существует
│   ├── scantour.json                         существует
│   ├── afisha.json                           существует
│   ├── synthetic.json                        NEW
│   └── pending/
│       ├── <real_case_id>.json               существует (real-разметка)
│       └── synth-<rule_lc>-<NNN>.json        NEW (синтетический pending)
├── cases/
│   ├── real-clean/                           существует
│   ├── real-dirty/                           существует
│   ├── synthetic-clean/                      NEW
│   └── synthetic-dirty/                      NEW
└── sources.config.json                       UPDATED (синтетика как kind)

scripts/data/
├── cards-delete.ts                           UPDATED (поддержка synthetic)
├── annotations-delete.ts                     UPDATED (поддержка synthetic)
├── annotations-list-pending.ts               UPDATED (различает real vs synth pending)
├── annotations-scaffold.ts                   без изменений
├── annotations-commit.ts                     без изменений
├── cases-generate.ts                         UPDATED (подхват synthetic source)
├── cases-audit.ts                            NEW
├── synthesize-scaffold.ts                    NEW
├── synthesize-commit.ts                      NEW
└── synthesize-validate.ts                    NEW

docs/
├── tz-synthetic-cards.md                     (этот файл)
├── synthetic-guide.md                        NEW
└── synthesize-subagent-template.md           NEW
```

## Целевой UX

```bash
# 1. Узнать, чего не хватает
pnpm cases:audit
# → таблица: rule_id | severity | real | synthetic | total | quota | delta
# Формат вывода в стиле блока «Распределение нарушений по rule_id»
# из docs/real-cards-audit.md.

pnpm cases:audit --json
# → машиночитаемый вывод для synth:scaffold --from-audit.

# 2. Создать pending'и под недостающие
pnpm synth:scaffold --rule TXT-05 --count 3
# или массово по дельте:
pnpm synth:scaffold --from-audit
# → datasets/annotations/pending/synth-txt05-001.json … synth-txt05-003.json

# 3. AI-агент в сессии заполняет pending'и:
#    - читает prompts/synthesize-card-v1.txt
#    - читает datasets/text_rules.compact.json
#    - при необходимости — 2-3 примера реальных нарушений из cases/real-dirty/
#    - пишет card + violations в pending-файл

# 4. Проверить натуральность пакетно
pnpm synth:validate
# → метрики разнообразия + список «подозрительно шаблонных» pending'ов.
# Падает (exit 1), если есть критические нарушения. С --warn-only —
# только печатает.

# 5. Закоммитить
pnpm synth:commit
# → splitting pending → datasets/synthetic/cards.raw.jsonl (append)
#   + datasets/annotations/synthetic.json (merge)
# → удаляет pending-файл при успехе.

# 6. Материализовать cases
pnpm cases:generate
# → datasets/cases/synthetic-{clean,dirty}/ обновлены.

# 7. Проверить итог
pnpm cases:audit
# → дельта уменьшилась.
tsx scripts/validate-cases.ts
# → real + synthetic кейсы проходят схему.
```

## Декомпозиция

Один этап = один коммит. Этапы относительно независимы, но рекомендуемый
порядок учитывает зависимости.

### Этап 1 — `cases:audit` + `synthetic-quota.yaml`

**Цель:** видеть распределение нарушений по rule_id с разбивкой
real / synthetic / quota / delta. Без этой видимости синтетика
генерируется наугад.

**Deliverables:**

1. `datasets/synthetic-quota.yaml`:
   ```yaml
   version: 1
   # Дефолт по severity. Применяется ко всем TXT-правилам, для которых
   # нет override.
   defaults:
     critical: 10
     high:      7
     medium:    5
     low:       3
   # Override per rule_id. Опционально — если по правилу нужен другой
   # объём (например, TXT-20 уже закрыт реальной выборкой и синтетика
   # не нужна).
   overrides:
     TXT-20: 0   # 10 real-примеров от scantour, добавлять не нужно
     # TXT-XX: N
   ```

2. `scripts/data/cases-audit.ts`:
   - Читает `datasets/cases/real-{clean,dirty}/*.json` и
     `datasets/cases/synthetic-{clean,dirty}/*.json` (если есть).
   - Читает `datasets/text_rules.compact.json` (для severity).
   - Читает `datasets/synthetic-quota.yaml` (для целевой квоты).
   - Считает по каждому rule_id: `real_hits`, `synthetic_hits`, `total`.
     Применяет квоту: `delta = max(0, quota - total)`.
   - **Считает hits, а не cards.** Одна dirty-карточка с двумя нарушениями
     по разным правилам даёт hit обоим правилам.
   - Печатает таблицу:
     ```
     rule_id   severity   real   synthetic   total   quota   delta
     TXT-01    high         0       0           0      7      7
     TXT-05    critical     0       0           0     10     10
     TXT-19    medium       3       0           3      5      2
     TXT-20    high        10       0          10      0      0
     ...
     ──────────────────────────────────────────────────────────
     Всего нарушений               17       0          17    ...
     Правил без покрытия            29       0          29    ...
     ```
   - С `--json`: массив объектов, поле `delta` отсортирован убыванием —
     удобный вход для `synth:scaffold --from-audit`.
   - С `--source=real|synthetic` — фильтр.

3. `package.json`:
   ```json
   "cases:audit": "tsx scripts/data/cases-audit.ts"
   ```

**Acceptance:**

- `pnpm cases:audit` на текущем состоянии (0 synthetic): итоги
  совпадают с блоком «Распределение нарушений по rule_id» из
  `docs/real-cards-audit.md`. 17 hits, 6 правил с реальными примерами,
  29 без.
- `pnpm cases:audit --json | jq '.[] | select(.delta > 0)'` отдаёт
  список правил для генерации.
- Изменение `synthetic-quota.yaml` (например, `overrides: { TXT-19: 0 }`)
  немедленно меняет `delta` для TXT-19 на следующем прогоне.
- `pnpm typecheck` чистый.

### Этап 2 — Канонический промпт `prompts/synthesize-card-v1.txt`

**Цель:** один источник правды для генерации. По конвенции
«Правила работы с промптами» (`AGENTS.md`) — отдельный файл, версионируется.

**Содержание промпта (черновик, финал в коммите):**

В шапке — diff-нотка: «v1: первая итерация. Цель — карточка-имитация
реальной попытки продавца протащить нарушение по target rule_id.
Anti-clickbait критерии в теле».

Тело:

1. **Роль.** «Ты пишешь карточку активности для маркетплейса
   туристических активностей от лица продавца (организатора).
   Цель — карточка должна выглядеть как реальная заявка, в которую
   продавец *незаметно* вплёл одно нарушение по правилу `<target_rule_id>`.»

2. **Вход.** В шаблон агент подставит:
   - `target_rule_id` + полная запись из `text_rules.compact.json`
     (id, severity, title, desc).
   - 2–3 реальных примера нарушений по этому правилу из
     `datasets/cases/real-dirty/` (если есть; для 29 правил без
     реальных примеров — раздел отсутствует, агент опирается только
     на `desc`).
   - Желаемая тематика активности (выбрать из списка реальных тематик —
     см. ниже).
   - Желаемый `expected_clean` (true/false). Для большинства rule_id —
     false (мы хотим dirty-кейс с этим нарушением). Для null-кейсов
     (контрольная группа в `synthetic-clean/`) — true.

3. **Жёсткие требования к формату.** Карточка должна:
   - Иметь поля по `product_card.schema.json`: `id` (заполнит скрипт,
     не агент), `product_type`, `title`, `short_description`,
     `full_description`, `program_items`, `services`, `location`,
     `contacts_block`, `schedule`, `images: []`, `group_size`,
     `languages`, `age_restriction`.
   - **Тематика не из шаблонной выборки.** Список разрешённых тематик
     (для разнообразия): пешая экскурсия, гастрономический тур, тур на
     природу/в горы, водная экскурсия, автобусный тур, мастер-класс,
     спектакль/концерт (event), корпоративный тимбилдинг, экскурсия
     с гидом-экспертом, тур по индустриальным/промышленным объектам,
     детская экскурсия, исторический квест. **Не более 1/3 партии в
     одной тематике.**
   - Длины полей: `title` 30–80 символов, `short_description` 80–200,
     `full_description` 400–1500. Конкретные пороги — из 5-95 перцентиля
     real-карточек (рассчитать в `synth:validate`, см. этап 4).
   - Стиль — нейтрально-деловой или дружелюбно-описательный, без
     рекламной патетики.

4. **Anti-clickbait — список запрещённого.**
   - Запрещены фразы: «лучший в мире», «лучший в России», «лучший в
     <город>», «уникальная экскурсия», «не имеющий аналогов»,
     «100 % гарантия», «эксклюзивная программа», «секретный маршрут»,
     «только у нас», «непревзойдённый», «легендарный».
   - Запрещён CAPS LOCK > 5 % символов в любом поле (исключение —
     если target rule_id = TXT-28, которое именно этим нарушением и
     является).
   - Запрещены эмодзи в `title`. В `short_description` /
     `full_description` — не более 2 эмодзи на 1000 символов.
     Исключение — TXT-29.
   - Запрещены повторяющиеся восклицательные знаки («!!», «!!!»).
   - Запрещены превосходные степени без основания (тот же шаблон, что
     TXT-19, который мы и так маркируем как нарушение, — но синтезатор
     не должен «случайно» ставить TXT-19 туда, где целевое правило
     другое).

5. **Само нарушение должно быть органично вплетено.**
   - Не выделяй нарушение отдельным пунктом / абзацем. Оно должно
     быть встроено в осмысленный текст как естественная фраза
     организатора.
   - Не повторяй формулировки из `description` правила или из
     `example`. Они даны как ориентир, не как шаблон.
   - Карточка должна оставаться валидной по схеме `product_card`
     даже после удаления нарушающего фрагмента.

6. **Что вернуть.** Один JSON-объект:
   ```json
   {
     "card": { /* полный product_card */ },
     "violations": [
       {
         "rule_id": "<target_rule_id>",
         "severity": "<из text_rules.compact.json>",
         "field_path": "full_description",
         "quote": "<дословный фрагмент из card>",
         "rationale": "1-2 предложения, почему именно это нарушение"
       }
     ]
   }
   ```
   Если `expected_clean=true` (контрольный clean-кейс) — `violations: []`.

7. **Запрет.** Не добавлять «нечаянных» нарушений по другим правилам
   (особенно TXT-19 / TXT-25, в которые легко скатиться). Если в
   процессе понимаешь, что текст уехал в нарушение TXT-Y — переписать.

**Acceptance:**

- `prompts/synthesize-card-v1.txt` существует, содержит шапку с
  diff-ноткой, разделы 1–7.
- На пилоте (5 пробных карточек по разным правилам, заполненных
  агентом) проверка `synth:validate` (этап 4) проходит.

### Этап 3 — Synthetic store + scaffold/commit

**Цель:** `synth:scaffold` создаёт pending'и, агент заполняет,
`synth:commit` распиливает на (card, annotation) и сохраняет в store.

**Deliverables:**

1. `datasets/synthetic/cards.raw.jsonl` — пустой файл (commit-нуть
   с одним переводом строки или вовсе создавать на первом
   `synth:commit`).

2. `datasets/annotations/synthetic.json`:
   ```json
   {
     "version": 1,
     "annotations": {}
   }
   ```
   Эта структура совместима с `annotation.schema.json` без изменений
   схемы. Не комитить пустой — создаётся на первом коммите синтетики.

3. `scripts/data/synthesize-scaffold.ts`:
   - Аргументы:
     - `--rule TXT-XX` + `--count N` — N pending'ов под одно правило.
     - `--from-audit` — массово, читает `cases:audit --json`,
       создаёт по `delta` pending'ов на каждое правило с `delta > 0`.
     - `--clean-control N` — N контрольных clean-кейсов (без
       нарушений). Топик/тематика выбирается равномерно.
     - `--topic <slug>` — опционально, фиксирует тематику. По умолчанию
       — round-robin из списка тематик в промпте.
   - Создаёт `datasets/annotations/pending/synth-<rule_lc>-<NNN>.json`,
     где `NNN` — следующий свободный номер на это правило (поиск
     по существующим pending'ам и по `synthetic.json`).
   - Pending-формат:
     ```json
     {
       "case_id": "synth_txt05_001",
       "kind": "synthetic_pending",
       "target_rule_id": "TXT-05",
       "target_severity": "critical",
       "target_clean": false,
       "topic_hint": "пешая экскурсия",
       "card": null,
       "violations": [],
       "annotator": null,
       "annotated_at": null,
       "_help": {
         "prompt_path": "prompts/synthesize-card-v1.txt",
         "rules_path": "datasets/text_rules.compact.json",
         "schema_path": "datasets/schema/product_card.schema.json",
         "instruction": "Прочитай prompts/synthesize-card-v1.txt. Заполни поле card (валидный product_card) и violations[] (если target_clean=false). Соблюдай anti-clickbait критерии. По завершении: pnpm synth:validate (опционально) → pnpm synth:commit."
       }
     }
     ```
   - `case_id = synth_<rule_lc>_<NNN>` (например, `synth_txt05_001`,
     `synth_txt-05_001` тоже допустим — выбрать стабильный формат).
     Для clean-control: `synth_clean_<NNN>`.
   - Идемпотентен: если pending с таким `case_id` уже есть — не
     перезаписывает, печатает skip.

4. `scripts/data/synthesize-commit.ts`:
   - Аргументы: `--yes`, `--dry-run`.
   - Обходит `datasets/annotations/pending/synth-*.json`. Для каждого:
     - Если `card === null` или `target_clean === false &&
       violations.length === 0` → SKIP.
     - Валидирует `card` против `product_card.schema.json` (ajv strict).
       При ошибке — оставляет pending, печатает диагностику.
     - Проверяет: `card.id === case_id`. Если нет — нормализует
       (присваивает) либо ругается; решение в коде — присваивать
       автоматически (агент мог не заполнить).
     - Проставляет `card._meta`-аналог в общий wrapper:
       ```json
       {
         "card": { /* product_card */ },
         "_meta": {
           "source_site": "synthetic",
           "source_url": null,
           "fetched_at": "<timestamp>",
           "parser_version": null,
           "json_ld_found": false,
           "warnings": [],
           "target_rule_id": "TXT-05",
           "generator_model": "claude-opus-4.7-session",
           "prompt_version": "synthesize-card-v1"
         }
       }
       ```
     - Append в `datasets/synthetic/cards.raw.jsonl`. Дедуп по
       `card.id` (если уже есть — перезаписать строку или ругнуться;
       решение — ругнуться, так дешевле).
     - Merge разметки в `datasets/annotations/synthetic.json`:
       ```json
       {
         "expected_clean": <target_clean>,
         "violations": [...],
         "notes": null,
         "annotated_at": "<today>",
         "annotator": "claude-opus-4.7-session"
       }
       ```
       Валидирует через `annotation.schema.json` + дополнительная
       проверка `quoteFoundIn` (как в `validate-cases.ts`).
     - При успехе — удаляет pending.
     - При ошибке — оставляет pending, накапливает счётчик ошибок,
       по завершении `process.exit(1)` если ошибок > 0.
   - Атомарность: запись в `synthetic.json` и `cards.raw.jsonl` — через
     tmp + rename (по образцу `parse/validate.ts`).
   - С `--dry-run`: только проверки, без записи.

5. `scripts/data/cases-generate.ts` (UPDATE):
   - Читает дополнительно `datasets/synthetic/cards.raw.jsonl` и
     `datasets/annotations/synthetic.json`.
   - Для каждой synthetic-карточки с аннотацией собирает `card_case`:
     ```ts
     {
       case_id: card.id,
       kind: 'card_case',
       source: 'synthetic',
       generator: {
         model: meta.generator_model,
         prompt_version: meta.prompt_version,
         date: TODAY
       },
       card,
       expected_violations: annotation.violations,
       expected_clean: annotation.expected_clean,
       notes: annotation.notes
     }
     ```
   - Раскладывает в `datasets/cases/synthetic-clean/` или
     `datasets/cases/synthetic-dirty/` по `expected_clean`.
   - Защита от рассинхрона: при перемещении clean↔dirty удалять старый
     файл из противоположной директории (как уже сделано для real).
   - Идемпотентность сохраняется.

6. `scripts/data/cards-delete.ts` (UPDATE):
   - Поддержка `--source=synthetic`: удаляет
     `datasets/synthetic/cards.raw.jsonl` и
     `datasets/synthetic/cards.rejected.jsonl` (если есть).
     `--all` теперь чистит и synthetic.
   - Картинок у synthetic нет (`images: []`), глоб не нужен.

7. `scripts/data/annotations-delete.ts` (UPDATE):
   - Поддержка `--source=synthetic`: удаляет
     `datasets/annotations/synthetic.json`,
     `datasets/annotations/pending/synth-*.json`,
     `datasets/cases/synthetic-{clean,dirty}/synth_*.json`
     (если не `--keep-cases`).

8. `scripts/data/annotations-list-pending.ts` (UPDATE):
   - Различает real-pending (`<source>_<id>.json`) и synth-pending
     (`synth-<rule>-<NNN>.json`). В выводе — отдельные блоки:
     ```
     [pending real]      sputnik8: 0, pmpoperator: 0, scantour: 0, afisha: 0
     [pending synthetic] TXT-05: 3, TXT-07: 5, TXT-14: 2 (всего: 10)
     ```

9. `package.json`:
   ```json
   "synth:scaffold": "tsx scripts/data/synthesize-scaffold.ts",
   "synth:commit":   "tsx scripts/data/synthesize-commit.ts"
   ```

10. `datasets/sources.config.json` (UPDATE) — добавить запись `synthetic`
    с явным `kind: "synthetic"` (или похожим), чтобы массовые операции
    `--all` его подхватывали. Альтернатива — оставить config только для
    real-источников и захардкодить synthetic в коде; решить при
    реализации.

**Acceptance:**

- `pnpm synth:scaffold --rule TXT-05 --count 3` создаёт 3 файла:
  `synth-txt05-001.json`, `synth-txt05-002.json`, `synth-txt05-003.json`,
  все с `card: null`.
- Заполнить один pending вручную (smoke) → `pnpm synth:commit --dry-run`
  валидирует без ошибок → `pnpm synth:commit` записывает в
  `cards.raw.jsonl` и `synthetic.json`, удаляет pending.
- `pnpm cases:generate` подхватывает synthetic, материализует в
  `synthetic-{clean,dirty}/`. Total cases = 67 (real) + N (synthetic).
- `tsx scripts/validate-cases.ts` чисто.
- `pnpm cards:delete --source=synthetic --yes` чистит synthetic-
  cards.raw.jsonl, не трогает annotations и real-источники.
- `pnpm annotations:delete --source=synthetic --yes` чистит
  `synthetic.json` + cases. После этого `pnpm cases:generate` не
  падает (просто 0 synthetic cases).

### Этап 4 — Валидация натуральности

**Цель:** автоматически отлавливать «учебные примеры» до коммита
большой партии. Без этого этапа риск 1 (натуральность) реализуется
тихо.

**Deliverables:**

1. `scripts/data/synthesize-validate.ts`:
   - Читает все pending-файлы `synth-*.json` с `card !== null` и/или
     все коммитнутые synthetic-карточки (`--scope=pending|committed|all`,
     по умолчанию `all`).
   - Считает метрики:
     - **Длины полей.** Пороги — 5-95 перцентиль распределения по
       real-карточкам (реально вычисляется из `cards/real-{clean,dirty}/`
       в самом скрипте; не хардкодим). Поля: `title`, `short_description`,
       `full_description`. Для каждой synth-карточки — флаг, если поле
       вне диапазона.
     - **Разнообразие тематик.** Если в наборе синтетики < 40 %
       уникальных категорий (определяется по `product_type` +
       первой N-граммы `title`) — warn.
     - **Чёрный список фраз.** Регулярка по списку из этапа 2 +
       расширения (см. ниже). Любое срабатывание = error на этой
       карточке.
     - **Дубликаты / near-дубликаты.** Shingling по 5-граммам слов в
       `full_description`, сходство Jaccard > 0.7 = warn (две похожие
       карточки в одной партии).
     - **Слепой re-annotation (опционально, флаг
       `--blind-reannotate`).** Прогоняет `prompts/annotate-conservative-v1.txt`
       через провайдера на synth-dirty карточках. Если conservative
       ловит target_rule_id — карточка ОК. Если ловит дополнительные
       правила — warn (синтетика «грязнее» чем должна). Если НЕ ловит
       target — критический warn (синтетика не нарушает правило).
       Флаг `--blind-reannotate` дорогой (вызывает LLM), по умолчанию
       выключен. Если включён — какой провайдер использовать
       (Yandex/GigaChat) — параметр `--provider`. См. открытый вопрос.
   - Вывод:
     - Пер-карточный отчёт с найденными проблемами.
     - Сводка: сколько pending'ов прошли, сколько с warning'ами,
       сколько с error'ами.
   - Exit code: 0 если только warnings; 1 если errors. Флаг
     `--warn-only` снижает errors до warnings (для итеративной отладки).

2. Чёрный список фраз — отдельный файл `datasets/synthetic-blocklist.txt`
   (одна фраза на строку, регистронезависимо). Стартовый набор — из
   этапа 2; пополняется по мере обнаружения повторяющихся маркеров.

3. `package.json`:
   ```json
   "synth:validate": "tsx scripts/data/synthesize-validate.ts"
   ```

**Acceptance:**

- На пустой synthetic — `pnpm synth:validate` чисто (0 ошибок,
  0 warning'ов).
- На пилоте из 10 synth-карточек, где одна имеет фразу «лучший в
  мире» — error, exit 1.
- На пилоте, где 8 карточек одной тематики «пешая экскурсия в Питере» —
  warn по разнообразию.
- Длины полей: можно прогнать на real-карточках — все 67 должны
  попасть в свой 5-95 перцентиль (по построению, sanity-check).

### Этап 5 — Subagent template + интеграция

**Цель:** удобная делегация генерации одному субагенту (по образцу
`docs/annotate-subagent-template.md`).

**Deliverables:**

1. `docs/synthesize-subagent-template.md` (≤ 80 строк):
   ```markdown
   # Шаблон делегации subagent'у на генерацию синтетики

   Задача: сгенерировать N синтетических карточек по списку
   pending-файлов.

   ## Канонические артефакты (читать в первую очередь)
   - prompts/synthesize-card-v1.txt — основной промпт
   - datasets/text_rules.compact.json — таблица TXT-правил
   - datasets/schema/product_card.schema.json — целевой формат
   - docs/synthetic-guide.md — workflow и критерии натуральности

   ## Файлы для заполнения
   <список pending-файлов>

   ## Целевые rule_id (указать severity и краткое содержание правила)
   <список>

   ## Тематический бюджет
   - не более 1/3 партии на одну тематику
   - запрещённые фразы — datasets/synthetic-blocklist.txt
   - длины полей — в реальном диапазоне (см. синонимы в промпте)

   ## Что вернуть
   - перезаписать каждый pending-файл (Write) с заполненным
     полем `card` и (для dirty) `violations[]`.
   - в финальном сообщении: total / by rule_id / by topic / любые
     pending'и, для которых не получилось соблюсти критерии (с
     указанием причины).
   ```

2. `synthesize-scaffold.ts --from-audit --print-template` — печатает
   готовый текст делегации с заполненным списком pending'ов и
   rule_id. Опционально, не блокер.

3. `cases-generate.ts` интеграция уже сделана в этапе 3.

4. Smoke-прогон 10 synth-карточек:
   - 3× TXT-05 (critical, без реальных примеров),
   - 3× TXT-07 (critical, без реальных примеров),
   - 2× TXT-19 (medium, есть реальные примеры — для калибровки),
   - 2× clean-control.

   Прогнать через `synth:validate`, ожидаемое: 0 errors. Если есть —
   откатить и обновить промпт (новый файл `synthesize-card-v2.txt`,
   не редактировать v1 — конвенция AGENTS.md).

**Acceptance:**

- `docs/synthesize-subagent-template.md` ≤ 80 строк.
- 10-карточный smoke прошёл, кейсы видны в `cases:audit` как
  synthetic.

### Этап 6 — Документация + финальный smoke

**Deliverables:**

1. `docs/synthetic-guide.md` (~100 строк):
   - **Workflow** (6 шагов: `cases:audit → synth:scaffold → fill →
     synth:validate → synth:commit → cases:generate`).
   - **Критерии натуральности** — пересказ anti-clickbait правил из
     промпта + ссылка на `synthetic-blocklist.txt`.
   - **Когда нужен blind re-annotation** — раздел про дорогую проверку
     через провайдер. Пока опциональная, включается флагом.
   - **Версионирование промптов**: при изменении правил генерации —
     новый файл `synthesize-card-vN.txt`. Уже коммитнутая синтетика не
     перегенерируется (если только её натуральность не критически
     плоха).
   - **Что делать с конфликтами** (например, агент сгенерировал
     карточку, которая нарушает дополнительное правило): добавить
     второе нарушение в `violations[]`, не выбрасывать карточку.
     Это делает её «грязнее», но реалистичнее — реальные dirty
     карточки часто нарушают несколько правил сразу.
   - **Удаление и регенерация**: `annotations:delete --source=synthetic`,
     потом скаффолд заново.

2. `AGENTS.md` (UPDATE раздел `## Команды` + блок «Lifecycle тестовых
   данных»): добавить новые `pnpm`-скрипты + краткое описание
   синтетического pipeline'а. По образцу того, как Sprint P4 туда
   добавил `pnpm cases:generate`.

3. `docs/real-cards-audit.md` (UPDATE): в конце раздела «Правила без
   реальных примеров» — отметка «Покрытие закрывается синтетикой,
   см. `docs/tz-synthetic-cards.md` и `docs/synthetic-guide.md`».

4. **Финальный smoke сценарий:**
   - `pnpm cases:audit` — фиксируем дельту до.
   - Сгенерировать N pending'ов (по дефолтным квотам — около
     29 правил × среднее 6 ≈ 175 кейсов; первый прогон сократить
     до 30 на самые приоритетные).
   - Заполнить через субагента (или несколько параллельных).
   - `pnpm synth:validate`.
   - `pnpm synth:commit`.
   - `pnpm cases:generate`.
   - `tsx scripts/validate-cases.ts` чисто.
   - `pnpm cases:audit` — дельта закрыта.

5. Финальный коммит-метка «Sprint P5 ready» если всё зелёное.

**Acceptance:**

- Новый разработчик/агент по `docs/synthetic-guide.md` от старта до
  закоммиченной synth-карточки доходит без вопросов.
- `git status` в конце спринта чист (никаких pending'ов в индексе,
  никаких staged артефактов вне scope).
- `cases:audit` показывает покрытие ≥ 90 % квоты по rule_id (допустимо
  пропустить часть low-severity).
- Все три риска из секции «Главные риски» имеют документированные
  митигации.

## Главные риски (подтверждено пользователем)

1. **Натуральность.** Если упустим, синтетика будет искусственно
   занижать ошибки модели. Митигация: этап 4 (валидация натуральности),
   опциональный blind re-annotation, чёрный список маркеров,
   итеративный пересмотр промпта (`synthesize-card-vN.txt`).

2. **Дрейф рулбука.** Если `text_rules.yaml` поменяется, часть
   синтетики устареет. Митигация: метаданные `target_rule_id` +
   `prompt_version` в `_meta` каждой synth-карточки. `cases:audit`
   подсветит расхождения. При смене severity / удалении правила —
   `annotations:delete --source=synthetic` + регенерация.

## Hard rules — что не делать

- Не редактировать `text_rules.yaml`, `image_rules.yaml`,
  `product_card.schema.json`, `test_case.schema.json`,
  `annotation.schema.json` (hard rule из `AGENTS.md`).
- Не использовать `synthesize-card-v1.txt` после первого commit'а как
  «черновик» — для итерации создавать v2, v3 (правило 1 «Правила работы
  с промптами» в `AGENTS.md`).
- Не вызывать провайдеров (Yandex / GigaChat) автоматически в
  `synth:commit` или `synth:scaffold`. Единственная точка вызова
  провайдера — опциональный `synth:validate --blind-reannotate`,
  и то с явным согласием пользователя.
- Не генерировать synthetic IMG-карточки (out of scope).
- Не «починять» real-карточки в процессе генерации синтетики.
- Не использовать npm/yarn — только pnpm.
- Не добавлять новые npm-зависимости. `yaml@2.8.3`, `ajv`,
  `ajv-formats` уже есть.
- Не вводить новый `kind` в `test_case.schema.json` для synthetic.
  Поле `source: "synthetic"` уже описано в схеме.

## Acceptance checklist (итоговый)

- [ ] `datasets/synthetic-quota.yaml` создан (defaults + overrides).
- [ ] `scripts/data/cases-audit.ts` + `pnpm cases:audit` работает,
      на пустой synthetic совпадает с `docs/real-cards-audit.md`.
- [ ] `prompts/synthesize-card-v1.txt` создан, содержит шапку с
      diff-нотой и разделы 1-7.
- [ ] `datasets/synthetic/cards.raw.jsonl` инициализирован.
- [ ] `datasets/annotations/synthetic.json` инициализирован.
- [ ] `scripts/data/synthesize-scaffold.ts` + `pnpm synth:scaffold`.
- [ ] `scripts/data/synthesize-commit.ts` + `pnpm synth:commit`.
- [ ] `scripts/data/synthesize-validate.ts` + `pnpm synth:validate`.
- [ ] `scripts/data/cases-generate.ts` подхватывает synthetic.
- [ ] `scripts/data/cards-delete.ts` поддерживает `--source=synthetic`.
- [ ] `scripts/data/annotations-delete.ts` поддерживает
      `--source=synthetic`.
- [ ] `scripts/data/annotations-list-pending.ts` различает real vs
      synth-pending.
- [ ] `datasets/synthetic-blocklist.txt` создан.
- [ ] `docs/synthesize-subagent-template.md` ≤ 80 строк.
- [ ] `docs/synthetic-guide.md` создан.
- [ ] `AGENTS.md` обновлён (команды + lifecycle).
- [ ] `docs/real-cards-audit.md` дополнен ссылкой на synthetic.
- [ ] Smoke 10 synth-карточек прошёл, видны в `cases:audit`.
- [ ] `pnpm typecheck` чистый.
- [ ] Sprint P5 разбит на 6 коммитов (этапы 1–6).

## Открытые вопросы для начала сессии

1. **`datasets/sources.config.json` — добавлять synthetic или нет?**
   Variant A: добавить с `kind: "synthetic"` и пустыми
   `target_total`/`seed`. Тогда массовые операции `--all` подхватят
   автоматически. Variant B: оставить config для real-only, а synthetic
   обрабатывать отдельной веткой в коде. Рекомендую A — единообразнее.

2. **Формат `case_id` для synthetic.** Variant A: `synth_txt05_001`
   (без дефиса в rule_id). Variant B: `synth_txt-05_001` (с дефисом
   как в YAML). Рекомендую A — стабильнее под glob.

3. **Blind re-annotation в `synth:validate`.** Стоит ли делать на этом
   спринте или вынести в Sprint P6? Если делать — какой провайдер
   и как считать стоимость (10 кейсов × 35 правил × 2 прохода —
   неблоьшие токены, но всё равно). Рекомендую: реализовать как
   опциональный флаг (по умолчанию off), не запускать в smoke этого
   спринта.

4. **Тематика clean-control карточек.** Variant A: распределить
   равномерно по тем же тематикам, что и dirty. Variant B: специально
   взять «пограничные» темы, на которых легко скатиться в нарушение
   (детская экскурсия — TXT-09/16, экстрим — TXT-15). Рекомендую A на
   пилоте, B на втором витке.

5. **Объём первого прогона.** Полная квота даёт ~175 synth-кейсов
   (29 правил × 6 в среднем). Это много для одной сессии. Рекомендую:
   первый прогон — 30 кейсов (по 2-3 на самые критические правила),
   проверить весь pipeline и натуральность, потом масштабировать.

6. **Что делать, если `synth:validate --blind-reannotate` показывает,
   что conservative-аннотатор НЕ ловит синтетику?** Это значит
   нарушение слишком «спрятано» и не годится как ground truth для
   бенчмарка. Variant A: пере-генерить с более явным нарушением.
   Variant B: оставить как «hard case» для отдельной метрики (recall на
   tonkih нарушениях). Рекомендую A на пилоте; B — отдельный скоп
   позже.

Ответы — в начале сессии, до того как агент начнёт массово
генерировать.
