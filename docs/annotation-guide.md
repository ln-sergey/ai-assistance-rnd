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
   (схема + severity из `rules.yaml` + dual-check quote'ов).

## Шаблон промпта для LLM-агента

Передавать вместе с содержимым `pending/<case_id>.json` и (по требованию)
выдержкой из `rules.yaml`. Ожидаемый ответ — JSON с полями
`expected_clean`, `violations`, `notes` (и опционально `annotator`,
`annotated_at`).

```
Ты — модератор карточек туристических активностей. Прочитай карточку в
поле card_excerpt и определи, нарушает ли она правила из rules.yaml.

Жёсткие требования:

1. rule_id — ТОЛЬКО из rules.yaml (TXT-01..TXT-35, IMG-01..IMG-30).
   Своих идентификаторов не выдумывать.
2. severity — точно как в rules.yaml для этого rule_id (low | medium |
   high | critical).
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

## Что делать с конфликтами

Если две модели разметили одну и ту же карточку по-разному — у нас один
store, последний `annotations:commit` побеждает. Историю предыдущих
разметок хранит git, происхождение текущей — поле `annotator`. Полное
версионирование (хранить параллельно несколько разметок одной карточки)
вне scope текущего спринта.
