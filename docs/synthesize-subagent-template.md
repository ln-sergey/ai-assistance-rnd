# Шаблон делегации subagent'у на генерацию синтетики

Используй этот шаблон, когда хочешь делегировать одному субагенту
заполнение партии synth-pending'ов. Целевой объём — 5-30 карточек за
сессию субагента; больше — разбивай на партии, чтобы контекст не
переполнялся.

## Канонические артефакты (читать в первую очередь)

- `prompts/synthesize-card-v4.txt` — основной промпт-генератор
  (читать целиком). Если в репо появилась `vN+1` — брать самую
  свежую (см. `ls prompts/synthesize-card-v*.txt`).
  История версий и связанные артефакты — `prompts/CHANGELOG.md`.
- `datasets/text_rules.compact.json` — единственный источник правды
  по rule_id, severity и desc (id, severity, title, desc; 35 TXT-).
- `datasets/schema/product_card.schema.json` — целевая схема
  карточки (`additionalProperties: false`, все required-поля).
- `datasets/synthetic-blocklist.txt` — чёрный список фраз/паттернов
  (regex /iu).
- `docs/synthetic-guide.md` — workflow и критерии натуральности
  (если файл отсутствует — этап 6 ещё не закрыт, читать ТЗ).

## Файлы для заполнения

Список pending-файлов передаётся субагенту явно — `ls
datasets/annotations/pending/synth-*.json` или явный inline-список.
Каждый файл уже содержит `case_id`, `target_rule_id`,
`target_severity`, `target_clean`, `topic_hint`, пустой `card: null`
и пустой `violations: []`.

## Целевые rule_id (с severity и кратким описанием)

Перечисли в делегации, чтобы агент не открывал отдельно
`text_rules.compact.json` при каждой карточке. Формат:

- `TXT-XX (severity) — title правила, кратко desc`

## Тематический бюджет и натуральность

- Не более 1/3 партии на одну тематику (12 разрешённых — список в
  разделе 3 промпта).
- Запрещённые фразы — `datasets/synthetic-blocklist.txt`
  (применяются к любым строковым полям карточки, рекурсивно).
- Длины полей в реальном диапазоне: title 11..74,
  short_description 60..350, full_description 198..1867
  (5-95 перцентиль real-карточек на 2026-04-27; пересчитываются
  динамически в `pnpm synth:validate`).
- Нарушение должно быть органично вплетено и оставаться единственным
  по rule_id из таксономии.

## Что вернуть

1. Перезаписать каждый pending-файл (Write) с заполненным `card`
   (валидный product_card, `id == case_id`, `images: []`) и
   `violations[]` для dirty (для clean-control — `violations: []`).
2. В финальном сообщении — сводка:
   - total / by rule_id / by topic_hint;
   - pending'и, для которых не получилось соблюсти критерии
     (короткая карточка, неуместное нарушение, конфликт с blocklist'ом),
     с краткой причиной;
   - оценка self-check: сколько карточек, по мнению агента, переживут
     blind re-annotation prompts/annotate-conservative-v1.txt
     (target_rule_id ловится, побочных нарушений нет).

## Что после

Тот, кто делегировал, прогоняет:
1. `pnpm synth:validate --scope=pending` — длины, blocklist,
   diversity, near-дубликаты. 0 errors — продолжать; есть errors —
   откатить (новый файл `synthesize-card-vN+1.txt`, не редактировать
   текущую версию — конвенция AGENTS.md).
2. blind re-annotation в локальной сессии:
   `prompts/annotate-conservative-v1.txt` применяется к каждой
   synth-dirty карточке (см. workflow в `docs/synthetic-guide.md`).
   Если conservative не ловит target — карточка переписывается
   (Р11 ТЗ). Никаких прямых API-вызовов: целевые провайдеры и
   эталонные AI через API запрещены для подготовки тестовых данных.
3. `pnpm synth:commit` → `pnpm cases:generate` →
   `pnpm cases:audit` (delta уменьшилась).
