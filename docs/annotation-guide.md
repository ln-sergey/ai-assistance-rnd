# Annotation Guide — разметка реальных карточек

Гайд для локального агента (человек, Claude, ChatGPT, GigaChat), который
размечает спаршеные карточки. Разметка живёт отдельно от кода:
`datasets/annotations/<source>.json`. Cases в `datasets/cases/real-*` —
материализованный артефакт, регенерится из cards + annotations.

## Workflow (6 шагов)

1. **`pnpm annotations:list`** — посмотреть, какие карточки ещё не
   размечены. С `--source=X` фильтруется по источнику; с `--json` —
   машинно-читаемый вывод.
2. **`pnpm annotations:scaffold`** — создать рабочие файлы в
   `datasets/annotations/pending/<case_id>.json`. По одному на каждую
   неразмеченную карточку. Идемпотентно: уже существующие pending'и не
   перезаписываются.
3. **Заполнить pending-файлы.** Открыть каждый в редакторе или передать
   агенту-LLM (см. промпт ниже). Заполнить `expected_clean`, `violations`
   при dirty, `annotator`, `annotated_at`. Поле `_help` можно не удалять —
   `commit` его всё равно нормализует.
4. **`pnpm annotations:commit`** — перенести заполненные pending'и в
   общий store `datasets/annotations/<source>.json`. Pending с
   `expected_clean: null` пропускаются (агент в процессе). Валидация:
   JSON Schema + проверка дословной встречаемости `quote` в карточке по
   `field_path`. С `--dry-run` — только проверить, ничего не записывать.
5. **`pnpm cases:generate`** — материализовать `card_case` в
   `datasets/cases/real-{clean,dirty}/`. Идемпотентно.
6. **`tsx scripts/validate-cases.ts`** — финальная проверка кейсов
   (схема + severity из `text_rules.yaml` / `image_rules.yaml` +
   dual-check quote'ов).

## Шаблон промпта для LLM-агента

Передавать вместе с содержимым `pending/<case_id>.json` и (по требованию)
выдержкой из `text_rules.yaml` / `image_rules.yaml`. Ожидаемый ответ —
JSON с полями `expected_clean`, `violations`, `notes` (и опционально
`annotator`, `annotated_at`).

```
Ты — модератор карточек туристических активностей. Прочитай карточку в
поле card_excerpt и определи, нарушает ли она правила из
text_rules.yaml / image_rules.yaml.

Жёсткие требования:

1. rule_id — ТОЛЬКО из text_rules.yaml (TXT-01..TXT-35) или
   image_rules.yaml (IMG-01..IMG-30). Своих идентификаторов не выдумывать.
2. severity — точно как в text_rules.yaml / image_rules.yaml для этого
   rule_id (low | medium | high | critical).
3. Для TXT-* нарушений quote — ДОСЛОВНЫЙ фрагмент из card_excerpt по
   указанному field_path. Без перефразирования, без многоточий.
4. expected_clean=true ⟺ violations=[]. Если хоть одно нарушение —
   expected_clean=false.
5. Не выдумывать нарушения. Помечать только то, что явно подпадает под
   формулировку правила. Сомневаешься — оставь clean.
6. Контактные данные (телефон, telegram, e-mail, ссылки) попадают в
   quote, не в rationale. Не маскировать.
7. field_path — дот-нотация: full_description, program_items[2].title,
   contacts_block.public_comment.

Верни JSON ровно такого вида (без обёрток ```json):

{
  "expected_clean": <bool>,
  "violations": [
    {
      "rule_id": "TXT-NN",
      "severity": "low|medium|high|critical",
      "field_path": "...",
      "quote": "...",
      "rationale": "1–2 предложения по-русски"
    }
  ],
  "notes": null,
  "annotator": "claude-opus-4.7",
  "annotated_at": "YYYY-MM-DD"
}
```

## Двухпроходная разметка

Базовый workflow выше — это conservative-проход: один агент, установка
«сомневаешься — clean». Высокая precision, но recall может проседать
(на sputnik8 в первой сессии 28/30 кейсов оказались clean — часть могла
быть упущена).

Двухпроходная схема: тот же набор pending'ов размечается двумя
независимыми проходами с инвертированными установками, результаты
объединяются и фильтруются.

Канонические промпты:

- `prompts/annotate-conservative-v1.txt` — установка «сомневаешься — clean».
- `prompts/annotate-aggressive-v1.txt` — установка «помечай всё, что
  может подпадать; лучше FP, чем FN». Формат вывода идентичен.

### Workflow

1. `pnpm annotations:scaffold` — создать pending как обычно (или
   `scaffold-two-pass` — см. «Будущая работа»).
2. **Conservative-проход**: каждый pending передать LLM-агенту вместе
   с `prompts/annotate-conservative-v1.txt`. Сохранить результат в
   `pending/<case_id>.cons.json`.
3. **Aggressive-проход**: тот же pending, но с
   `prompts/annotate-aggressive-v1.txt`. Сохранить в
   `pending/<case_id>.aggr.json`.
4. **Merge**: `pnpm annotations:merge-passes` (см. «Будущая работа») —
   union violations с тегированием прохода. Пока скрипта нет — слить
   вручную в один pending: union по `{rule_id, field_path, quote}`.
5. **Фильтрация**: human-review слитого pending'а или Opus-judge (тоже
   отложено). Очевидные FP из aggressive-прохода удалить.
6. `pnpm annotations:commit` — как обычно, в общий store.

### Когда применять

- **Только conservative** (один проход) — для recall-нечувствительных
  задач или когда стоимость FN ниже стоимости FP. Это default-режим
  workflow в начале гайда.
- **Двухпроходный** — когда важен recall (бенчмарк качества модерации,
  поиск редких нарушений). Цена — 2× вызовов LLM плюс ручная фильтрация.

### Гарантия `aggressive ⊇ conservative`

Conservative-промпт п. 6: «Сомневаешься — оставь clean». Aggressive-
промпт п. 6: «Помечай ВСЕ фрагменты, которые могут подпадать под
правило, даже если сомневаешься». Формат вывода (rule_id, severity,
quote, field_path, rationale) и список доступных правил совпадают.
Логически: всё, что conservative помечает как нарушение, aggressive
тоже помечает (он не отказывается от уверенных кейсов, только добавляет
сомнительные). Эмпирическая проверка на 5+ реальных кейсах — отдельная
задача после первой двухпроходной сессии.

### Будущая работа

Автоматизация отложена — текущий датасет (122 кейса) разметим вручную,
а до обкатки workflow нет смысла фиксировать API:

- `pnpm annotations:scaffold-two-pass` — генерит `.cons.json` +
  `.aggr.json` пары, чтобы агент видел сразу оба слота.
- `pnpm annotations:merge-passes` — union violations с тегом
  `_pass: "cons" | "aggr" | "both"` в каждой violation.
- Opus-judge — скрипт-арбитр на Claude Opus, читает слитый pending и
  решает, какие violations оставлять.

## Что делать с конфликтами

Если две модели разметили одну и ту же карточку по-разному — у нас один
store, последний `annotations:commit` побеждает. Историю предыдущих
разметок хранит git, происхождение текущей — поле `annotator`. Полное
версионирование (хранить параллельно несколько разметок одной карточки)
вне scope текущего спринта.
