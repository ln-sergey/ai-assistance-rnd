// Разрешение тарифа по имени модели и расчёт стоимости.
// Логика общая: таблица в коде + возможность частичного/полного override
// через config.pricing в YAML-конфиге Promptfoo. source в возвращаемом
// объекте позволяет отчёту честно сказать, откуда взята цена.

import type { PerTokenPricing, PricingSource, ResolvedPricing } from './types.js';

/**
 * Находит в таблице longest-prefix-матч по имени модели с учётом списка
 * разделителей. Сепараторы у провайдеров разные:
 *   * GigaChat (`-`, `:`): `GigaChat-2-Max:2.0.28.2` → `GigaChat-2-Max`,
 *     `GigaChat-2-Max-preview` → `GigaChat-2-Max`.
 *   * Yandex (`/`, `:`): `yandexgpt/latest` → `yandexgpt`, `yandexgpt/rc` →
 *     `yandexgpt/rc` (длиннее, longest-prefix забирает). `-` для Yandex не
 *     сепаратор: `yandexgpt-lite` и `yandexgpt` — разные модели.
 */
export function findTableKeyByPrefix(
  table: Record<string, unknown>,
  model: string,
  separators: readonly string[] = ['-', ':', '/'],
): string | undefined {
  return Object.keys(table)
    .filter((k) => model === k || separators.some((sep) => model.startsWith(`${k}${sep}`)))
    .sort((a, b) => b.length - a.length)[0];
}

export interface ResolvePricingInput<P extends Record<string, number>> {
  table: Record<string, P>;
  model: string;
  override?: Partial<P>;
  /** Значения по умолчанию, когда нет ни таблицы, ни полного override. */
  zeroValues: P;
  /** Сепараторы для longest-prefix матчинга. Default: ['-', ':', '/']. */
  separators?: readonly string[];
}

/**
 * Универсальный резолвер тарифа. Параметризован формой P — подходит и для
 * {promptPer1k, completionPer1k}, и для {perImage} (Vision).
 *
 *   * override заполняет ВСЕ поля P → source=config (таблица игнорируется)
 *   * таблица попалась + override отсутствует → source=default-table
 *   * таблица попалась + частичный override → source=merged
 *   * таблицы нет, override частичный → source=merged, недозаполненные поля = 0
 *   * таблицы нет, override нет → source=none, всё по нулям
 */
export function resolvePricingByTable<P extends Record<string, number>>(
  input: ResolvePricingInput<P>,
): ResolvedPricing<P> {
  const { table, model, override, zeroValues, separators } = input;
  const tableKey = findTableKeyByPrefix(table, model, separators);
  const fromTable = tableKey ? table[tableKey] : undefined;

  const overrideEntries = Object.entries(override ?? {}).filter(([, v]) => v !== undefined);
  const allKeys = Object.keys(zeroValues);
  const hasAnyOverride = overrideEntries.length > 0;
  const hasAllOverrides =
    override !== undefined &&
    allKeys.every((k) => (override as Record<string, number | undefined>)[k] !== undefined);

  let source: PricingSource;
  let pricing: P;

  if (hasAllOverrides) {
    source = 'config';
    pricing = { ...zeroValues, ...(override as P) };
  } else if (fromTable) {
    source = hasAnyOverride ? 'merged' : 'default-table';
    pricing = { ...fromTable, ...(override ?? {}) } as P;
  } else {
    source = hasAnyOverride ? 'merged' : 'none';
    pricing = { ...zeroValues, ...(override ?? {}) } as P;
  }

  return {
    pricing,
    source,
    ...(tableKey !== undefined && { tableKey }),
  };
}

/** prompt/completion per 1k → рублей. */
export function computePer1kCost(
  tokens: { prompt: number; completion: number },
  pricing: PerTokenPricing,
): number {
  return (tokens.prompt * pricing.promptPer1k + tokens.completion * pricing.completionPer1k) / 1000;
}
