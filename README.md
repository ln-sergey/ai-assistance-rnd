# ai-bench

R&D-бенчмарк LLM-провайдеров для модерации карточек продуктов (активностей —
событий, экскурсий, туров): текст карточки и фото галереи, на маркетплейсе
туристических активностей.

Модерация пользовательских отзывов — Out of scope, перенесена на следующие
итерации.

Задача, scope, методика и критерии выбора — в [`ARCHITECTURE.md`](ARCHITECTURE.md).
Правила работы в репозитории для Claude Code — в [`CLAUDE.md`](CLAUDE.md).
Таксономия правил модерации — в [`text_rules.yaml`](text_rules.yaml) +
[`image_rules.yaml`](image_rules.yaml).


## Требования

- Node.js 20+
- pnpm 9+ (никогда не использовать `npm` или `yarn`)


## Установка

```bash
pnpm install
cp .env.example .env
# заполнить ключи в .env — см. .env.example
```


## Структура

```
providers/   custom providers для Promptfoo (по одному на провайдера)
prompts/     версионированные промпты — не перезаписывать
datasets/    тестовые данные (product-cards.csv, images/)
configs/     Promptfoo-конфиги (по одному на задачу)
scripts/     синтез датасетов, агрегация метрик, конвертеры
reports/     сгенерированные отчёты прогонов
judge/       rubric'и для llm-judge
text_rules.yaml    35 текстовых правил TXT-01..TXT-35
image_rules.yaml   30 фото-правил IMG-01..IMG-30
```


## Команды

```bash
# прогон одного конфига
npx promptfoo eval -c configs/card-text-moderation.yaml

# прогон на подмножестве (первый запуск новой конфигурации)
npx promptfoo eval -c configs/card-text-moderation.yaml --numTests 10

# несколько повторов для проверки стабильности
npx promptfoo eval -c configs/card-text-moderation.yaml --repeat 3

# веб-UI с результатами
npx promptfoo view

# проверка типов
pnpm typecheck
```


## Провайдеры

Активны: **Yandex** (`YANDEX_API_KEY` + `YANDEX_FOLDER_ID`), **GigaChat**
(`GIGACHAT_AUTH_KEY` + `GIGACHAT_SCOPE`).

**Qwen** отложен — не подключать без явного разрешения (см. `CLAUDE.md`).


## Эксперименты

- Одна переменная за прогон (промпт ИЛИ модель ИЛИ температура ИЛИ датасет).
- Первый прогон новой конфигурации — всегда на подмножестве (10–20 кейсов).
- Перед финальными выводами — 3 повторных прогона для проверки стабильности.
- Новая версия промпта — всегда новый файл `*-vN.txt`, не перезаписывать.

Подробнее — в `ARCHITECTURE.md`, раздел 9 и `CLAUDE.md`.
