# Synthetic Guide

Гайд для локального AI-агента в интерактивной сессии (Claude Code,
Codex, Cursor, Aider или любой совместимый передовой агент), который
генерирует синтетические `product_card`-карточки под целевые
TXT-правила. Цель — закрыть дыры покрытия, которые реальная выборка
не пробила (см. [`real-cards-audit.md`](real-cards-audit.md)).
Контекст спринта и зафиксированные решения — [`tz-synthetic-cards.md`](tz-synthetic-cards.md).

Pipeline-инвариант: целевые провайдеры (Yandex / GigaChat) и любые
эталонные AI через прямые API не вызываются. Карточки заполняет агент
в текущей интерактивной сессии — он сам читает промпт и пишет в
pending-файлы. Hard rule — [`AGENTS.md`](../AGENTS.md).

## Хранение

- `datasets/synthetic/cards.raw.jsonl` — карточки append-only.
  `_meta.prompt_version` фиксирует версию промпта на момент генерации.
- `datasets/annotations/synthetic.json` — разметка (один store на
  весь synthetic-источник).
- `datasets/cases/synthetic-{clean,dirty}/` — материализованные cases
  (`pnpm cases:generate`).

## Workflow (6 шагов)

1. **`pnpm cases:audit`** — распределение нарушений по `rule_id` и
   дельта от квоты ([`synthetic-quota.yaml`](../datasets/synthetic-quota.yaml)).
   `--json` (вход для `synth:scaffold --from-audit`),
   `--source=real|synthetic` (фильтр).
2. **`pnpm synth:scaffold`** — pending'и в
   `datasets/annotations/pending/synth-<rule_lc>-<NNN>.json`.
   Флаги: `--rule TXT-XX --count N`, `--from-audit`,
   `--clean-control N`, `--topic <slug>` (default — round-robin).
   Идемпотентно: существующие pending'и не перезаписываются.
3. **Заполнить pending'и.** Открыть актуальный
   `prompts/synthesize-card-vN.txt` (на 2026-04-29 — `v7`), читать
   целиком, заполнить `card` (`id == case_id`, `images: []`) и
   `violations[]` (для clean-control — `[]`). История версий —
   [`prompts/CHANGELOG.md`](../prompts/CHANGELOG.md). При делегации
   субагенту — [`synthesize-subagent-template.md`](synthesize-subagent-template.md).
4. **`pnpm synth:validate`** — длины полей в реальном диапазоне,
   разнообразие тематик, blocklist
   ([`synthetic-blocklist.txt`](../datasets/synthetic-blocklist.txt)),
   near-дубликаты (Jaccard 5-грамм > 0.7). Network-free. Exit 1 на
   errors. `--scope=pending|committed|all` (default `all`),
   `--warn-only` снижает errors до warnings.
5. **Blind re-annotation** для dirty (см. ниже) — НЕ скрипт, шаг
   workflow. Между `synth:validate` и `synth:commit`.
6. **`pnpm synth:commit`** — pending → `cards.raw.jsonl` (append) +
   `synthetic.json` (merge). Валидация product_card + annotation
   схем + дословная проверка `quote`. `--dry-run` — только проверки.
7. **`pnpm cases:generate`** — материализовать в
   `synthetic-{clean,dirty}/`. Финальный sanity —
   `tsx scripts/validate-cases.ts`.

После — `pnpm cases:audit` показывает уменьшившуюся дельту, синтетика
участвует в общем пуле кейсов наравне с real.

## Критерии натуральности

Главный риск — «учебный пример нарушения», который conservative-аннотатор
ловит ровно потому, что нарушение бросается в глаза. Такая синтетика
завышает recall модели и непригодна как ground truth. Полный список
требований — в актуальном `prompts/synthesize-card-vN.txt`. Кратко:

- Длины полей в 5–95 перцентиле real-карточек (динамически в
  `synth:validate`; конкретные цифры — в шаблоне субагента).
- ≤ 1/3 партии в одну тематику. 12 разрешённых тематик — в §2 промпта.
- Blocklist — `synthetic-blocklist.txt`. Любое срабатывание = error.
- Нарушение органично вплетено в осмысленный текст; карточка
  остаётся валидной по схеме после удаления нарушающего фрагмента.
- Голос организатора, не «признание», три архетипа: наивный / эвфемизирующий /
  нишевой.

## Blind re-annotation

Шаг между `synth:validate` и `synth:commit`. Не скрипт.

1. Открыть [`prompts/annotate-conservative-v1.txt`](../prompts/annotate-conservative-v1.txt)
   и каждый заполненный synth-pending (только dirty; для clean-control
   re-annotation не нужен).
2. Применить как обычную разметку (тот же агент в текущей сессии
   тем же способом — см. [`annotation-guide.md`](annotation-guide.md)).
3. Сравнить результат с `target_rule_id`:
   - Поймал ровно target → карточка проходит.
   - НЕ поймал target → пере-генерить с более явным нарушением (Р11
     ТЗ). Pending можно перезаписать.
   - Поймал target + дополнительное реальное нарушение → добавить
     второе в `violations[]` (см. «Конфликты»).
4. Все dirty прошли — `pnpm synth:commit`.

Прямые API-вызовы к целевым провайдерам и эталонным AI запрещены:
ground truth не должен опираться на ответ subject-под-тестом.

## Версионирование промптов

`prompts/synthesize-card-vN.txt` append-only (правило 1 «Правила работы
с промптами» в `AGENTS.md`). При изменении anti-clickbait требований,
списка тематик, формата вывода или когнитивной модели — новый файл
`vN+1` с заметкой в [`prompts/CHANGELOG.md`](../prompts/CHANGELOG.md).
`scripts/data/synthesize-scaffold.ts` (`PROMPT_PATH`) и
`synthesize-commit.ts` (`PROMPT_VERSION_FALLBACK`) — обновлять
синхронно с выпуском новой версии.

Уже закоммиченная синтетика НЕ регенерируется автоматически —
`_meta.prompt_version` в `cards.raw.jsonl` фиксирует, какой версией
сделана карточка. Перегенерация только при критически плохой
натуральности (массовое срабатывание blocklist'а post-factum или
системный дефект — например, «нарушения-признания», устранённые в v5).

## Конфликты

Карточка нарушает дополнительное правило помимо target — добавить
второе в `violations[]`, не выбрасывать. Реальные dirty карточки часто
несут несколько нарушений сразу; синтетика с двумя органичными ближе
к продакшену. Условие — оба прошли anti-clickbait. Если второе
нарушение — артефакт синтетических маркеров (CAPS, рекламная
патетика), переписать карточку, а не подкрашивать аннотацию.

Две модели разметили карточку по-разному — у нас один store, последний
`synth:commit` побеждает. История — git; происхождение разметки —
поле `annotator`.

## Удаление и регенерация

```bash
# убрать synthetic-разметку и cases (cards.raw.jsonl остаётся)
pnpm annotations:delete --source=synthetic --yes

# убрать сами synthetic-карточки
pnpm cards:delete --source=synthetic --yes

# заскаффолдить заново под текущую дельту
pnpm synth:scaffold --from-audit
```

С `--keep-cases` `annotations:delete` оставит cases — полезно при
перепрогоне разметки без полной регенерации артефактов.
