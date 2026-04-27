# Synthetic Guide — генерация синтетических карточек

Гайд для локального AI-агента в интерактивной сессии (Claude Code,
Codex, Cursor, Aider или любой совместимый передовой агент), который
генерирует синтетические `product_card`-карточки под целевые правила
`text_rules.yaml`. Цель — закрыть дыры покрытия по правилам, которые
реальная выборка не пробила (см. [`real-cards-audit.md`](real-cards-audit.md)).
Контекст и решения — [`tz-synthetic-cards.md`](tz-synthetic-cards.md).

Синтетика живёт отдельно: карточки — `datasets/synthetic/cards.raw.jsonl`
(append-only), разметка — `datasets/annotations/synthetic.json`, cases —
`datasets/cases/synthetic-{clean,dirty}/`. Целевые провайдеры (Yandex /
GigaChat) и любые эталонные AI через прямые API-вызовы запрещены для
подготовки и валидации тестовых данных — hard rule проекта (см.
[`AGENTS.md`](../AGENTS.md)). Pipeline идёт через локальный AI-агент
в интерактивной сессии: агент сам читает промпты и заполняет файлы,
никаких batch-вызовов из скриптов проекта.

## Workflow (6 шагов)

1. **`pnpm cases:audit`** — распределение нарушений по `rule_id` и
   дельта от целевой квоты ([`synthetic-quota.yaml`](../datasets/synthetic-quota.yaml)).
   `--json` — машинный вывод для `synth:scaffold --from-audit`,
   `--source=real|synthetic` — фильтр.
2. **`pnpm synth:scaffold`** — pending'и в
   `datasets/annotations/pending/synth-<rule_lc>-<NNN>.json`.
   - `--rule TXT-XX --count N` — N pending'ов под одно правило.
   - `--from-audit` — массово, по дельте.
   - `--clean-control N` — N контрольных clean-кейсов
     (`synth_clean_<NNN>`, `target_clean: true`).
   - `--topic <slug>` — фиксирует тематику (default — round-robin).
   - Идемпотентно: существующие pending'и не перезаписываются.
3. **Заполнить pending'и.** Открыть самую свежую
   `prompts/synthesize-card-vN.txt` (на 2026-04-27 — `v4`),
   читать целиком, заполнять `card` (валидный `product_card`,
   `id == case_id`, `images: []`) и `violations[]` для dirty
   (clean-control — `violations: []`). История версий и связанные
   артефакты — [`prompts/CHANGELOG.md`](../prompts/CHANGELOG.md).
   При делегации одному субагенту — шаблон
   [`synthesize-subagent-template.md`](synthesize-subagent-template.md).
4. **`pnpm synth:validate`** — длины полей в реальном диапазоне,
   разнообразие тематик, blocklist
   ([`synthetic-blocklist.txt`](../datasets/synthetic-blocklist.txt)),
   near-дубликаты (Jaccard 5-грамм > 0.7). Network-free, не вызывает
   LLM. Exit 1 на errors; `--warn-only` снижает errors до warnings;
   `--scope=pending|committed|all` (default `all`).
5. **`pnpm synth:commit`** — pending → `cards.raw.jsonl` (append с
   `_meta`) + `synthetic.json` (merge). Валидация `product_card` +
   `annotation` схем + дословная проверка `quote`. С `--dry-run` —
   только проверки.
6. **`pnpm cases:generate`** — материализовать в
   `datasets/cases/synthetic-{clean,dirty}/`. Финальная проверка —
   `tsx scripts/validate-cases.ts`.

После — `pnpm cases:audit` показывает уменьшившуюся дельту, синтетика
участвует в общем пуле кейсов наравне с real.

## Критерии натуральности

Главный риск — «учебный пример нарушения», который conservative-аннотатор
ловит ровно потому, что нарушение бросается в глаза. Такая синтетика
завышает recall модели и непригодна как ground truth. Полный список
требований — раздел 4 актуального `prompts/synthesize-card-vN.txt`;
кратко:

- Длины полей в 5-95 перцентиле real-карточек (на 2026-04-27: title
  11..74, short_description 60..350, full_description 198..1867;
  пересчитываются динамически в `synth:validate`).
- Не более 1/3 партии в одну тематику (12 разрешённых в разделе 3
  промпта). `synth:validate` warn'ит при < 40 % уникальных.
- Чёрный список фраз — `synthetic-blocklist.txt` (regex /iu). Любое
  срабатывание = error.
- Нарушение органично вплетено в осмысленный текст; карточка остаётся
  валидной по схеме после удаления нарушающего фрагмента.
- Никаких побочных нарушений — особенно TXT-19 (сторонние
  ссылки/контакты) и TXT-33 (неподтверждённые заявления о
  статусе/качестве), в которые легко скатиться.

## Blind re-annotation

Отдельный шаг между `synth:validate` и `synth:commit` (НЕ скрипт — Р8
ТЗ). Цель — убедиться, что conservative-аннотатор ловит target_rule_id
и не обогащает карточку ложными нарушениями.

1. Открыть [`prompts/annotate-conservative-v1.txt`](../prompts/annotate-conservative-v1.txt)
   и каждый заполненный synth-pending (только dirty; для clean-control
   re-annotation не нужен).
2. Применить как обычную разметку (см. [`annotation-guide.md`](annotation-guide.md)) —
   тот же локальный AI-агент в интерактивной сессии, тем же способом.
3. Сравнить с `target_rule_id`:
   - Поймал ровно target — карточка проходит.
   - НЕ поймал target — пере-генерить с более явным нарушением
     (Р11 ТЗ). Pending можно перезаписать.
   - Поймал target + ещё одно реальное нарушение — добавить второе
     в `violations[]` (см. «Конфликты»).
4. Когда все dirty прошли blind re-annotation — `pnpm synth:commit`.

Прямые API-вызовы к целевым провайдерам и эталонным AI запрещены: ground
truth не должен опираться на ответ subject-под-тестом.

## Версионирование промптов

`prompts/synthesize-card-vN.txt` append-only (правило 1 «Правила работы
с промптами» в `AGENTS.md`). При изменении anti-clickbait требований,
списка тематик или формата вывода — новый файл `vN+1` с diff-ноткой в
шапке. Уже закоммиченная синтетика НЕ регенерируется автоматически:
`_meta.prompt_version` в `cards.raw.jsonl` фиксирует, какой версией
сделана карточка. Перегенерация — только при критически плохой
натуральности (например, массовое срабатывание blocklist'а post-factum).

## Что делать с конфликтами

Если карточка нарушает дополнительное правило помимо target — добавить
второе в `violations[]`, не выбрасывать. Реальные dirty-карточки часто
несут несколько нарушений сразу; синтетика с двумя органичными
нарушениями ближе к продакшену, чем стерильная «одна карточка = одно
нарушение». Условие — оба нарушения проходят anti-clickbait критерии.
Если второе вылезло из-за синтетических маркеров (CAPS, восклицательные
знаки, рекламная патетика) — переписать карточку, а не подкрашивать
аннотацию.

Две модели разметили карточку по-разному — у нас один store, последний
`synth:commit` побеждает. История — git; происхождение разметки — поле
`annotator`.

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
быстром перепрогоне разметки без полной регенерации артефактов.
