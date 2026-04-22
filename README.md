# ai-bench

R&D-бенчмарк LLM-провайдеров для модерации пользовательских отзывов
(текст + фото) на маркетплейсе туристических активностей.

Задача, scope, методика и критерии выбора — в [`ARCHITECTURE.md`](ARCHITECTURE.md).
Правила работы в репозитории для Claude Code — в [`CLAUDE.md`](CLAUDE.md).
Таксономия правил модерации — в [`rules.yaml`](rules.yaml).


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
datasets/    тестовые данные (text-reviews.csv, images/)
configs/     Promptfoo-конфиги (по одному на задачу)
scripts/     синтез датасетов, агрегация метрик, конвертеры
reports/     сгенерированные отчёты прогонов
judge/       rubric'и для llm-judge
rules.yaml   единственный источник таксономии
```


## Команды

```bash
# прогон одного конфига
npx promptfoo eval -c configs/text-moderation.yaml

# прогон на подмножестве (первый запуск новой конфигурации)
npx promptfoo eval -c configs/text-moderation.yaml --numTests 10

# несколько повторов для проверки стабильности
npx promptfoo eval -c configs/text-moderation.yaml --repeat 3

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
