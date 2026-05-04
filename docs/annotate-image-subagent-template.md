# Шаблон делегации субагенту на разметку изображений

Короткий промпт-шаблон для запуска субагента (Task / Agent) на партию
image-pending'ов. Канон не дублируется — субагент читает его по
ссылкам ниже. Аналог [`annotate-subagent-template.md`](annotate-subagent-template.md).

## Когда использовать

- Партия 5–10 image-pending'ов одного source — массовая разметка одной
  партии одним субагентом.
- Параллельные субагенты на независимые партии (разные `batch_id`),
  чтобы не превышать контекст одной сессии.

Для одиночной разметки одной карточки в текущей сессии шаблон
избыточен — открой pending руками и скорми его LLM напрямую с
`prompts/annotate-image-conservative-v1.txt`.

## Шаблон

````markdown
Задача: разметить image-pending'и партии <batch-id> по правилам.
Режим: conservative (только этот режим есть на v1).

## Канонические артефакты — читать в первую очередь

- `prompts/annotate-image-conservative-v1.txt` — основной промпт
  (актуальная версия — `prompts/CHANGELOG.md`).
- `datasets/image_rules.compact.json` — таблица AI-only IMG-правил
  (отфильтрована по `datasets/image_rules.scope.yaml`; правила вне
  scope — IMG-01/02/13/15/26 — в файле отсутствуют и помечать их
  нельзя).
- `docs/image-annotation-guide.md` — workflow, формат `image_violations`,
  дисклеймеры, что делать с правилами вне scope.
- `datasets/schema/annotation.schema.json` — JSON Schema разметки;
  image-блок — `expected_image_clean` + `image_violations`.

## Файлы для разметки

- batch_id: <YYYYMMDD-source-NNN>
- pending'и: `datasets/annotations/pending/<card_id>.images.json` (5–10
  штук одного source).
- фото партии: `datasets/images-review/<batch-id>/<image_id>.<ext>` —
  открывать каждое мультимодальным Read.

## Контекст карточек (для правил-связок IMG-03/04/25/28)

- Полный объект `card` лежит в `datasets/<source>/cards.raw.jsonl`.
  Найти по `case_id` (он же `card.id`). Прочитать `title`,
  `short_description`, `full_description`, при необходимости
  `program_items[].title` — для сверки «обещано в тексте» vs «на фото».

## Что вернуть

- Перезаписать каждый pending-файл (Write): заполнить
  `expected_image_clean` (true/false), `image_violations` при dirty
  (минимум одно нарушение со всеми обязательными полями), `annotator`
  (твой model-id), `annotated_at` (YYYY-MM-DD). Поле `_help` можно
  не трогать — нормализуется при commit'е.
- В финальном сообщении — компактная сводка: total / clean / dirty /
  нарушения по rule_id и любые pending'и, где не получилось решить
  (с причиной — например, файл не открылся).
- НЕ вызывать `pnpm annotations:commit` — это шаг основного агента
  после ревью.
````

## Что НЕ должен делать субагент

- Не размечать правила вне scope (IMG-01/02/13/15/26). Если кадр явно
  размытый/дублирующий — заметку отдать основному агенту, не писать
  в pending.
- Не выходить за `rule_id` из `image_rules.compact.json` и не выдумывать
  `image_id` (только из `card.images[].image_id`).
- Не править `image_rules.yaml` / `image_rules.scope.yaml` / compact-
  таблицы — таксономия и scope только под явный запрос пользователя
  (`AGENTS.md`).
- Не запускать `pnpm annotations:commit` / `pnpm cases:generate` —
  это шаг основного агента после ревью.
- Не звать Yandex / GigaChat и любые эталонные AI через прямые API —
  hard rule (`AGENTS.md`).
