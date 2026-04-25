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

## Промпты для LLM-агента

Канонические промпты лежат в `prompts/`:

- [`prompts/annotate-conservative-v1.txt`](../prompts/annotate-conservative-v1.txt) —
  **default**. Один проход, установка «сомневаешься — clean». Использовать
  для штатной разметки, когда recall-чувствительность не критична.
- [`prompts/annotate-aggressive-v1.txt`](../prompts/annotate-aggressive-v1.txt) —
  парный. Один проход, установка «лучше FP, чем FN». Использовать **только
  как второй проход** в двухпроходной схеме (см. ниже), не как замену
  conservative — без последующей фильтрации aggressive захламляет store
  ложными нарушениями.

Промпт передавать LLM вместе с содержимым `pending/<case_id>.json`
и компактной таблицей правил (`datasets/text_rules.compact.json` для
текста или `datasets/image_rules.compact.json` для фото). Полные YAML
с категориями и примерами — только если требуется углубление.

Ожидаемый ответ — JSON с полями `expected_clean`, `violations`,
`notes`, `annotator`, `annotated_at` (формат описан в самих промптах).
Поле `annotator` агент заполняет своим model-id, конкретная модель в
промптах не зашита.

При делегации к субагенту (Task / Agent) использовать
[`docs/annotate-subagent-template.md`](annotate-subagent-template.md) —
короткий шаблон вместо повторения промпта целиком.

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
5. **Фильтрация**: human-review слитого pending'а или LLM-judge (тоже
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
сомнительные).

Контрольная проверка на 5 dirty-кейсах из текущего store
(afisha/pmpoperator/scantour×2/sputnik8) — TXT-19 (внешняя ссылка),
TXT-20 ×2 (бронирование вне платформы), TXT-22 (день 7 в 5-дневном
туре), TXT-23 (карточка-аренда), TXT-26 (HTML-тег в описании). Все
violations conservative прошли по жёстким критериям формата (rule_id
из таблицы, severity по таблице, непустой дословный quote) и были
«явно подпадающими». Aggressive с более низким порогом («может
подпадать») по построению тоже их помечает. Полная эмпирическая
re-разметка теми же моделями отложена до первой двухпроходной сессии.

### Будущая работа

Автоматизация отложена — текущий датасет (122 кейса) разметим вручную,
а до обкатки workflow нет смысла фиксировать API:

- `pnpm annotations:scaffold-two-pass` — генерит `.cons.json` +
  `.aggr.json` пары, чтобы агент видел сразу оба слота.
- `pnpm annotations:merge-passes` — union violations с тегом
  `_pass: "cons" | "aggr" | "both"` в каждой violation.
- LLM-judge — скрипт-арбитр (модель на выбор: Claude / GPT), читает слитый pending и решает, какие violations
  оставлять. Конкретная модель — параметр конфигурации, не вшивается.

## Что делать с конфликтами

Если две модели разметили одну и ту же карточку по-разному — у нас один
store, последний `annotations:commit` побеждает. Историю предыдущих
разметок хранит git, происхождение текущей — поле `annotator`. Полное
версионирование (хранить параллельно несколько разметок одной карточки)
вне scope текущего спринта.
