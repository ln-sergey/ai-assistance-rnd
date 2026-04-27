# Шаблон делегации subagent'у на генерацию синтетики

Один субагент — одна партия pending-файлов.

## Что передать субагенту

1. **Список pending-файлов** (явно, не через glob):
   ```
   datasets/annotations/pending/synth-TXT-XX-NNN.json
   ...
   ```
2. **Rule_id'ы в партии** — перечисли кратко, чтобы субагент сразу
   нашёл real-dirty примеры без лишнего поиска:
   ```
   TXT-XX (severity) — title правила
   ```

Субагент читает `prompts/synthesize-card-vN.txt` (самую свежую версию —
`ls prompts/synthesize-card-v*.txt`). Дальнейшие файловые чтения —
по инструкциям внутри промпта.

## Контрольные параметры (уникальные для этого шаблона)

Длины полей (5-95 перцентиль real-карточек, 2026-04-27):

| поле | min | max |
|------|-----|-----|
| title | 11 | 74 |
| short_description | 60 | 350 |
| full_description | 198 | 1867 |

Пересчитываются динамически в `pnpm synth:validate`.
Не более 1/3 партии на одну тематику.

## Что после

1. `pnpm synth:validate --scope=pending` — длины, blocklist, diversity,
   near-дубликаты. 0 errors — продолжать; есть errors — переписать
   проблемные карточки.
2. Blind re-annotation в локальной сессии: `prompts/annotate-conservative-v1.txt`
   на каждую synth-dirty карточку. Если conservative не ловит target —
   карточка переписывается. Никаких прямых API-вызовов к целевым провайдерам.
3. `pnpm synth:commit` → `pnpm cases:generate` → `pnpm cases:audit`
