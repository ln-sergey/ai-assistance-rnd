# Шаблон делегации субагенту на генерацию синтетики

Короткий промпт для запуска субагента (Task / Agent) на партию
synth-pending'ов. Канон не дублируется — субагент читает его по
ссылкам. Аналог [`annotate-subagent-template.md`](annotate-subagent-template.md).

## Когда использовать

- Партия 5+ pending'ов — массовая генерация одним субагентом.
- Несколько параллельных субагентов на независимые подмножества:
  5–15 карточек на агента. Больше — у субагента деградирует
  тематическое разнообразие, начинаются повторы.

На 1–2 карточки шаблон избыточен — заполни pending в текущей сессии
напрямую по `prompts/synthesize-card-vN.txt`.

## Шаблон

````markdown
Задача: сгенерировать карточки в перечисленных synth-pending'ах.

## Канонические артефакты — читать в первую очередь

- `prompts/synthesize-card-v7.txt` — основной промпт (актуальная
  версия на 2026-04-29; при обновлении — `prompts/CHANGELOG.md`).
- `datasets/text_rules.compact.json` — таблица TXT-правил.
- `datasets/schema/product_card.schema.json` — целевая схема карточки.
- `datasets/synthetic-blocklist.txt` — запрещённые маркеры синтетики.
- `datasets/cases/real-dirty/` — 2-3 примера на target_rule_id для
  стиля (не копировать формулировки).

## Файлы для заполнения

<список pending-файлов: datasets/annotations/pending/synth-txt05-001.json, ...>

## Целевые правила в партии

- TXT-XX (severity) — title правила
- ...

## Длины полей (5–95 перцентиль real-карточек, обновляются `synth:validate`)

| поле | min | max |
|------|-----|-----|
| title | 11 | 74 |
| short_description | 60 | 350 |
| full_description | 198 | 1867 |

## Тематический бюджет

- 12 разрешённых тематик — в §2 промпта.
- ≤ 1/3 партии на одну тематику (иначе `synth:validate` warn'ит
  по diversity).

## Что вернуть

- Перезаписать каждый pending (Write): заполнить `card` (полный
  product_card по схеме, `id == case_id`, `images: []`) и
  `violations[]` (для dirty — одно нарушение по target_rule_id с
  дословной `quote`; clean-control → `[]`).
- В финальном сообщении: total / by rule_id / by topic + любые
  pending'и, где не получилось соблюсти критерии (с причиной).
- НЕ вызывать `pnpm synth:commit` / `pnpm cases:generate` — это шаги
  основного агента после blind re-annotation.
````

## Что НЕ должен делать субагент

- Не редактировать `text_rules.yaml`, схему карточки, blocklist —
  только под явный запрос пользователя (см. `AGENTS.md`).
- Не запускать `pnpm synth:commit` / `pnpm cases:generate` —
  материализация после ревью основного агента.
- Не звать целевых провайдеров (Yandex / GigaChat) и любые эталонные
  AI через прямые API — hard rule (см. `AGENTS.md`).
- Не выходить за `rule_id` из compact-таблицы — своих идентификаторов
  не выдумывать.
