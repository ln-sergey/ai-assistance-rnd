# ТЗ — annotate-pipeline v2 + разделение rules.yaml

После разметки 55 pending-карточек (сессия 2026-04-25) выявлены узкие места.
Этот документ — поэтапное ТЗ для следующей сессии. Каждый этап — отдельный
коммит, проверяемый критериями завершения.

## Цели

1. Разделить `rules.yaml` на `text_rules.yaml` + `image_rules.yaml` —
   облегчить контекст агентам при текстовой/фото-разметке.
2. Усилить pre-validation в JSON Schema (`quote` minLength=1) — ловить
   ошибки до `commit`, а не на финальной фазе.
3. Сгенерировать `text_rules.compact.json` + `image_rules.compact.json`
   для промптов — компактные таблицы `id+severity+title+desc`, чтобы не
   передавать весь YAML.
4. Обновить `_help.instruction` в scaffold — частые ошибки сразу на виду.
5. Ввести двухпроходную разметку (conservative + aggressive + consensus) —
   поднять recall за счёт второго прохода в aggressive-режиме.
6. Канонизировать промпт annotation-guide.md в `prompts/`, переиспользовать
   в субагентах через короткий шаблон делегации.

## Out of scope

- Автоматизированный API-скрипт `pnpm annotations:auto` (отклонено пользователем).
- Изменение количества параллельных агентов / размер батча (отклонено).
- Перепрогон существующих 122 кейсов задним числом.

## Статус

- Этап 1 — ✅ выполнено (commit `5255316`).
- Этап 2 — ✅ выполнено (commit `0b3a7f5`).
- Этап 3 — ✅ выполнено с отклонениями от плана (commit `61d0690`):
  один общий `rules.compact.json` заменён на два файла
  `text_rules.compact.json` + `image_rules.compact.json` (мотив тот же,
  что и у split'а на этапе 1: текстовый агент не должен видеть
  IMG-правила и наоборот). Дополнительно: добавлен `yaml@2.8.3` в
  devDeps; самописный regex-парсер YAML заменён на `yaml.parse()` в
  `build-rules-compact.ts` и `validate-cases.ts`. Размер `<10 KB`
  оказался недостижим из-за UTF-8-кириллицы (×2 байта на символ): фактически
  text=12.8 KB, image=10.7 KB; целиться ниже без потери `desc` нельзя.
- Этап 4 — ✅ выполнено (commit `664b742`).
- Этап 5 — ✅ выполнено (commit `a072a68`): conservative + aggressive
  промпты в `prompts/`, раздел «Двухпроходная разметка» в
  `annotation-guide.md`. Эмпирическая проверка `aggressive ⊇ conservative`
  выполнена на 5 dirty-кейсах при работе над этапом 6.
- Этап 6 — ✅ выполнено: канонические промпты вынесены ещё на этапе 5
  (`annotate-conservative-v1.txt` + `annotate-aggressive-v1.txt`), на
  этапе 6 — заменён inline-блок промпта в `annotation-guide.md` на
  ссылку, добавлен `docs/annotate-subagent-template.md` (≤80 строк),
  сняты привязки к конкретной модели в обоих промптах (`<твой-model-id>`
  как плейсхолдер с примерами).

## Порядок выполнения

Этапы относительно независимы, но рекомендуемый порядок учитывает
зависимости:

1. **Этап 1** — rules split (фундамент, влияет на 3, 4, 6).
2. **Этап 2** — schema `quote` minLength=1 (быстрый фикс, независим).
3. **Этап 3** — `text/image_rules.compact.json` (зависит от 1).
4. **Этап 4** — `_help.instruction` в scaffold (зависит от 3).
5. **Этап 6** — canonical prompt в `prompts/` (зависит от 1, 3).
6. **Этап 5** — двухпроходный workflow (самый объёмный, в конце).

Один этап = один коммит. После каждого этапа прогнать
`pnpm parse:validate` (если задеты parse-схемы) и `tsx scripts/validate-cases.ts`
(всегда) — проверить, что 122 существующих кейса не сломались.

---

## Этап 1 — Разделить `rules.yaml` на `text_rules.yaml` + `image_rules.yaml` (✅ выполнено)

### Цель
Чтобы агент текстовой модерации не получал IMG-правила и наоборот. Сейчас
один файл с 65 правилами раздувает контекст и провоцирует путаницу
(агент случайно ставит IMG-rule_id на текстовое нарушение).

### Что делать

1. Создать `text_rules.yaml`:
   ```yaml
   version: 1
   last_updated: '2026-04-25'
   severity_scale:
     low: Низкая
     medium: Средняя
     high: Высокая
     critical: Критическая
   rules:
     - id: TXT-01
       category: Достоверность
       title: ...
       ...
   ```
   Корневой ключ — `rules`, не `text_rules` (в этом файле уже понятно
   что они текстовые).

2. Создать `image_rules.yaml` по тому же принципу с IMG-01..IMG-30.

3. Удалить корневой `rules.yaml`.

4. Обновить ссылки во всех 14 файлах, где встречается `rules.yaml`:
   - `AGENTS.md`, `README.md`, `ARCHITECTURE.md`
   - `datasets/README.md`, `docs/annotation-guide.md`, `docs/data-sources.md`,
     `docs/real-cards-audit.md`, `docs/tz-baseline-audit.md`,
     `docs/tz-data-lifecycle.md`, `docs/tz-parsing.md`
   - `scripts/data/annotations-scaffold.ts`, `scripts/validate-cases.ts`
   - `datasets/schema/test_case.schema.json`,
     `datasets/schema/product_card.schema.json`

   Контекстно: где упоминается «правила TXT-* или IMG-*» — указывать
   соответствующий файл; где «таксономия в целом» — оба файла или
   фразу «`text_rules.yaml` + `image_rules.yaml`».

5. В `validate-cases.ts` — читать оба YAML и объединять для severity-check.

### Критерии завершения

- [ ] `rules.yaml` удалён.
- [ ] `text_rules.yaml` содержит ровно 35 правил TXT-01..TXT-35.
- [ ] `image_rules.yaml` содержит ровно 30 правил IMG-01..IMG-30.
- [ ] `tsx scripts/validate-cases.ts` проходит без ошибок (122/122).
- [ ] `pnpm annotations:list` и `pnpm annotations:scaffold` работают.
- [ ] `grep -r "rules.yaml"` по проекту даёт 0 результатов (или все —
  в этом ТЗ-файле как ссылка на старое имя).

---

## Этап 2 — JSON Schema: `quote` `minLength: 1` (✅ выполнено)

### Цель
В текущей сессии ошибка «TXT-правило требует непустой quote» всплыла
только на `pnpm annotations:commit`. Один pending пришлось править вручную.
Хочу, чтобы валидатор схемы ловил это сразу, до commit.

### Что делать

1. Найти определение `violation_card` (или эквивалент, где описано поле
   `quote`). По grep — вероятно в `datasets/schema/test_case.schema.json`
   или `product_card.schema.json`.
2. Добавить к свойству `quote`:
   ```json
   "quote": {
     "type": "string",
     "minLength": 1,
     "description": "Дословный непрерывный фрагмент из card_excerpt по field_path. Для TXT-правил обязателен и непустой."
   }
   ```
3. Если есть отдельный `violation_image` (для IMG) — оставить `quote`
   опциональным там (по гайду IMG-quote только при читаемом тексте на фото).
4. Проверить, что валидация в `annotations-commit.ts` подхватит
   schema-ошибку с понятным сообщением (не просто `"" too short`,
   а с указанием на пустую quote).

### Критерии завершения

- [ ] Schema падает на пустой quote с осмысленным сообщением.
- [ ] Существующие 122 кейса проходят `tsx scripts/validate-cases.ts`.
- [ ] `pnpm annotations:commit --dry-run` на текущих сторе — `errors=0`.
- [ ] Тест: создать pending с пустой quote → `commit --dry-run` падает
  до собственной runtime-проверки `annotations-commit.ts`, на схеме.

---

## Этап 3 — `text/image_rules.compact.json` для промптов (✅ выполнено)

### Цель
Сократить токены в промптах annotate-агентов. Раньше агент читал
`rules.yaml` целиком (~470 строк). Нужно компактные JSON-таблицы с тем,
что реально требуется для разметки: `id`, `severity`, `title`, краткий
`desc`. Текст и фото — отдельными файлами, чтобы текстовый агент не
видел IMG-правила и наоборот.

### Что сделано

1. Скрипт `scripts/data/build-rules-compact.ts` читает
   `text_rules.yaml` + `image_rules.yaml` через `yaml.parse()` (пакет
   `yaml@2.8.3` добавлен в devDeps) и генерирует **два независимых файла**:

   ```json
   // datasets/text_rules.compact.json (12.8 KB)
   {
     "version": 1,
     "kind": "text",
     "generated_at": "2026-04-25",
     "severity_scale": { "low": "Низкая", ... },
     "rules": [
       { "id": "TXT-01", "severity": "high", "title": "...", "desc": "≤ 200 chars" }
     ]
   }

   // datasets/image_rules.compact.json (10.7 KB) — аналогично, kind: "image"
   ```

   `desc` — первая строка `description` или вся description, если она
   ≤ 200 символов; иначе обрезается по словам до 200.

2. Команда `pnpm rules:compact` в `package.json`.

3. Оба `.compact.json` коммитятся (артефакт пайплайна, нужен агентам).
   Регенерация идемпотентна: `generated_at = last_updated` из YAML, а не
   «сейчас», поэтому при тех же входах вывод побайтово стабилен.

4. Шапка `text_rules.yaml` / `image_rules.yaml`:
   «Источник правды. После любых правок: `pnpm rules:compact`».

5. Сопутствующие фиксы:
   - `validate-cases.ts` — самописный regex-парсер YAML заменён на
     `yaml.parse()` (теперь и там, и в build-rules-compact одна
     зависимость).
   - 5 строк `example` в `text_rules.yaml` / `image_rules.yaml`,
     где одинарные кавычки внутри значения не экранировались, починены
     обёртыванием в двойные кавычки. Семантика правил не изменилась —
     синтаксический фикс под строгий YAML-парсер.

### Отличия от исходного плана

- Один общий `datasets/rules.compact.json` с массивами `text` и `image`
  заменён на **два независимых файла**. Мотив — мотив этапа 1 — текстовый
  агент не должен видеть IMG-правила и наоборот; склейка их обратно в один
  файл нарушала бы этот контракт.
- Размер `<10 KB` оказался недостижим: UTF-8-кириллица — 2 байта на
  символ, и порог изначально оценили в латинице. Фактический размер
  text=12.8 KB, image=10.7 KB — ниже только обнулением `desc`, что
  ломает структуру (`title` без `desc` не различает близкие правила вроде
  TXT-19 vs TXT-20).

### Критерии завершения

- [x] `pnpm rules:compact` создаёт оба файла.
- [x] Структура валидна: `rules` массив длины 35 в `text_rules.compact.json`,
  длины 30 в `image_rules.compact.json`.
- [x] Все `severity` совпадают с YAML.
- [x] Размер каждого файла ≤ ~13 KB (порог `<10 KB` ослаблен — см. отличия).

---

## Этап 4 — Обновить `_help.instruction` в scaffold

### Цель
Чтобы LLM-агент, открывая pending-файл, сразу видел самые частые ошибки
из реального опыта.

### Что делать

В `scripts/data/annotations-scaffold.ts` обновить поле `_help.instruction`.
Финальный текст (черновик):

> Заполни `expected_clean` (true/false), `violations` при dirty,
> `annotator`, `annotated_at`. Жёсткие правила:
>
> 1. `rule_id` — только из `datasets/text_rules.compact.json`. Своих не
>    выдумывать. (Скаффолд текстовой разметки IMG-правила не использует —
>    они в отдельном файле `image_rules.compact.json`.)
> 2. `severity` — точно как в `text_rules.compact.json` для этого `rule_id`.
> 3. `quote` — ДОСЛОВНЫЙ непрерывный фрагмент из `card_excerpt` по
>    указанному `field_path`. **Минимум 1 символ.** Никаких многоточий
>    и склеек.
> 4. Для TXT-24 / TXT-26 при полностью пустом поле — это поле НЕ может
>    быть `field_path`. Найти другое поле с проблемой или другое
>    правило (например, TXT-23 — карточка как форма заявок).
> 5. `expected_clean=true` ⟺ `violations=[]`.
> 6. Сомневаешься — clean.
>
> Подробности — `docs/annotation-guide.md` и
> `prompts/annotate-conservative-v1.txt`.

Также обновить `_help.rules_path`: вместо `text_rules.yaml + image_rules.yaml`
указывать `datasets/text_rules.compact.json` (текущий scaffold размечает
только текст; при появлении image-scaffold у того будет своя
`_help.rules_path = datasets/image_rules.compact.json`).
Поле `schema_path` оставить как есть.

### Критерии завершения

- [ ] Новый `pnpm annotations:scaffold` создаёт pending с обновлённым `_help`.
- [ ] Текст инструкции содержит явный запрет пустых quote.
- [ ] Существующие annotation store не сломаны (commit не нормализует то,
  чего нет).

---

## Этап 5 — Двухпроходная разметка (conservative + aggressive + consensus)

### Цель
В текущей сессии все 5 субагентов получили инструкцию «сомневаешься — clean».
На sputnik8 это дало 28/30 clean — recall, вероятно, низкий.
Двухпроходная разметка: первый pass — conservative (как сейчас), второй —
aggressive (помечай всё подозрительное), затем consensus.

### Что делать

1. Канонизировать **conservative**-промпт (см. этап 6) в
   `prompts/annotate-conservative-v1.txt`.

2. Создать **aggressive**-промпт `prompts/annotate-aggressive-v1.txt`:
   - те же жёсткие требования к формату (rule_id, severity, quote, field_path);
   - изменённая установка: «помечай ВСЕ фрагменты, которые могут
     подпадать под правило, даже если сомневаешься. Лучше false
     positive, чем false negative — на следующем шаге будет фильтрация».

3. Описать в `docs/annotation-guide.md` workflow:
   ```
   1. pnpm annotations:scaffold-two-pass        # см. ниже
   2. fill: pending/<case_id>.cons.json (conservative-промпт)
   3. fill: pending/<case_id>.aggr.json (aggressive-промпт)
   4. pnpm annotations:merge-passes             # union violations,
                                                  тегирует source
   5. human-review (или LLM-judge) merged'а
   6. pnpm annotations:commit
   ```

4. **Скриптовая часть — отложить отдельной задачей.** В этом этапе
   достаточно:
   - оба промпта в `prompts/`;
   - workflow задокументирован в `annotation-guide.md`;
   - на контрольной выборке (5 случайных pending'ов) проверено вручную:
     `aggressive ⊇ conservative` по violations.

   Полную автоматизацию (`scaffold-two-pass`, `merge-passes`) описать в
   отдельной секции «Будущая работа» того же гайда.

### Критерии завершения

- [ ] `prompts/annotate-conservative-v1.txt` и
  `prompts/annotate-aggressive-v1.txt` существуют.
- [ ] В `docs/annotation-guide.md` есть раздел «Двухпроходная разметка».
- [ ] Ручная проверка на 5 кейсах: aggressive не теряет ни одного
  violation из conservative.

---

## Этап 6 — Канонизировать промпт + шаблон делегации

### Цель
Сейчас при делегации к субагентам пишется ~200-строчный промпт каждому.
Это дублирование, риск drift, лишние токены. Канонический промпт лежит
в `annotation-guide.md`, но не вынесен в отдельный файл и не используется
напрямую.

### Что делать

1. Вынести промпт из `docs/annotation-guide.md` (текущий блок «Шаблон
   промпта для LLM-агента») в `prompts/annotate-conservative-v1.txt`.
   В заголовке файла — короткая diff-нотка по конвенции AGENTS.md
   (правило 1 «Правила работы с промптами»).

2. В `annotation-guide.md` оставить ссылку на канонический файл +
   обоснование, когда какой режим (conservative / aggressive) применять.

3. Создать `docs/annotate-subagent-template.md` — короткий (≤80 строк)
   шаблон делегации к субагенту:
   ```markdown
   # Шаблон делегации subagent'у на разметку

   Задача: разметить pending-файлы из <source> по правилам.

   ## Канонические артефакты (читать в первую очередь)
   - prompts/annotate-conservative-v1.txt — основной промпт
   - datasets/text_rules.compact.json — таблица TXT-правил
     (для image-разметки — datasets/image_rules.compact.json)
   - docs/annotation-guide.md — workflow и формат

   ## Файлы для разметки
   <список case_id>

   ## Специфика источника <source>
   <2-3 пункта характерных нарушений по опыту>

   ## Что вернуть
   - перезаписать каждый pending-файл (Write)
   - в финальном сообщении: total / clean / dirty / нарушения по rule_id
   ```

4. Этот шаблон использовать при следующей разметке (вместо 200-строчных
   промптов).

### Критерии завершения

- [ ] `prompts/annotate-conservative-v1.txt` существует.
- [ ] `docs/annotation-guide.md` содержит ссылку на канонический промпт.
- [ ] `docs/annotate-subagent-template.md` ≤ 80 строк.
- [ ] Старый длинный промпт в `annotation-guide.md` удалён или заменён
  ссылкой.

---

## Контрольный прогон после всех этапов

После последнего коммита:

```bash
pnpm rules:compact                    # этап 3
pnpm annotations:list                 # должен показать 0 pending
tsx scripts/validate-cases.ts         # 122/122 passed
pnpm annotations:commit --dry-run     # errors=0
```

Если всё зелёное — обновить `MEMORY.md` (если применимо) и закоммитить
финальный пустой коммит-метку «pipeline v2 ready», либо отложить отметку
до следующего использования pipeline.
