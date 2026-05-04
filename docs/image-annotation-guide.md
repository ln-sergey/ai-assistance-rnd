# Image Annotation Guide — разметка реальных изображений

Гайд для локального AI-агента, размечающего фото в карточках реальных
источников (`sputnik8`, `pmpoperator`, `scantour`, `afisha`). Image-
разметка живёт поверх текстовой в том же `datasets/annotations/<source>.json`:
поля `expected_image_clean` и `image_violations` мёрджатся в существующую
запись, не трогая `expected_clean` / `violations`. Контекст спринта —
[`docs/tz-image-annotate-pipeline.md`](tz-image-annotate-pipeline.md).

## Workflow (5 шагов)

1. **`pnpm annotations:list:images`** — какие карточки ещё не размечены
   по фото. С `--source=X` фильтруется по источнику; с `--json` —
   машинно-читаемый вывод. Карточки без `card.images[]` не показываются.
2. **`pnpm annotations:scaffold:images --source=<X> --limit=<N>`** —
   создаёт партию: `<card_id>.images.json` в pending'ах + копии файлов
   фото в `datasets/images-review/<batch-id>/`. Batch-id формата
   `YYYYMMDD-<source>-NNN` генерится автоматически (можно зафиксировать
   через `--batch-id=...`). Партия 5–10 карточек на сессию субагента.
3. **Заполнить pending'и.** На каждый pending — открыть указанные
   фото из `images-review/<batch-id>/` (multimodal Read), прочитать
   `prompts/annotate-image-conservative-v1.txt` и
   `datasets/image_rules.compact.json`, проставить `expected_image_clean`
   и `image_violations`. Поле `_help` нормализуется при commit'е, можно
   не трогать.
4. **`pnpm annotations:commit`** — переносит заполненные image-pending'и
   в общий store, мёрджит в существующую text-запись. Pending с
   `expected_image_clean: null` пропускается. После успешного коммита
   всех pending'ов партии — папка `images-review/<batch-id>/` удаляется
   автоматически (если в ней не появилось посторонних файлов).
   Поддерживает `--dry-run`.
5. **`pnpm cases:generate`** — пересборка кейсов в `cases/real-{clean,dirty}/`.
   Затем `tsx scripts/validate-cases.ts` для финальной проверки схем.

## Работа с `datasets/images-review/<batch-id>/`

Папка партионная и gitignored: scaffold кладёт туда копии файлов
(оригиналы в `datasets/images/` нетронуты), commit удаляет её после
успеха. Это снимает Read-deny на `datasets/images/` без точечных
правок `.claude/settings.local.json` (Р7 ТЗ Sprint P6). Не складывай
туда посторонние файлы — commit не удалит партию, если обнаружит
что-то помимо ожидаемых копий.

## Формат `image_violations`

Каждый элемент — JSON следующего вида:

```jsonc
{
  "rule_id": "IMG-04",
  "severity": "high",
  "image_id": "sputnik8_57480_2",
  "evidence": "На третьем фото галереи виден интерьер ресторана, который не упомянут в описании активности.",
  "rationale": "IMG-04: фото вводит в заблуждение — обещанный 'тур по парку' включает услугу, которой нет в карточке."
}
```

Жёсткие правила:

- `rule_id` — только из `datasets/image_rules.compact.json` (25 AI-only
  правил, отфильтровано по `datasets/image_rules.scope.yaml`). Свои
  идентификаторы и правила вне scope — запрещены.
- `severity` — берётся ровно из compact-таблицы по `rule_id`.
- `image_id` — обязательно один из `card.images[].image_id`. Не
  придумывать новые id, не использовать имена файлов или индексы.
- `evidence` — 1–2 предложения с словесным ориентиром участка кадра
  («левый нижний угол», «на майке справа»). Координаты / bbox не нужны.
- Опциональное `field_path` — формат `images[<image_id>]`.

## Дисклеймеры

- Этот цикл — conservative-проход. Установка «сомневаешься → clean»:
  лучше пропустить граничный кейс, чем разметить ложное нарушение.
  Aggressive-режим не реализован на v1 (см. ТЗ §«Главные риски»).
- Bbox / координатные аннотации — out of scope v1. Только текстовый
  `evidence`.
- Прямые API-вызовы к целевым провайдерам (Yandex / GigaChat) или
  любым эталонным AI **запрещены** для подготовки разметки. Только
  локальный AI-агент в интерактивной сессии (см. `AGENTS.md`).

## Правила вне scope

Если на кадре заметна проблема, попадающая под heuristic-разрешимое
правило (IMG-01 — blur, IMG-02 — обрезано, IMG-13 — много текста,
IMG-15 — aspect, IMG-26 — дубликат), **не** добавлять её в
`image_violations`. Эти правила Sprint P6 не размечает: их закрывают
детерминированные проверки в будущих спринтах. Если кейс вопиющий и
важно сохранить контекст, оставь короткую заметку в `notes` карточки
(в `<source>.json` после commit'а), не в pending'е.

## Версионирование промптов и делегация

Промпт `prompts/annotate-image-conservative-v1.txt` append-only: правки —
как `v2`, `v3` (правило из `AGENTS.md`). Текущая активная версия и
история — в `prompts/CHANGELOG.md`. Партия 5–10 карточек удобно
делегируется одному субагенту через
[`docs/annotate-image-subagent-template.md`](annotate-image-subagent-template.md).
