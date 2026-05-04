// Общая логика аудита покрытия правил тестовыми кейсами.
// Используется в:
//   - scripts/data/cases-audit.ts — CLI-обёртка для пользователя/агента.
//   - scripts/data/synthesize-scaffold.ts — для --from-audit (массовое
//     создание pending'ов по delta).
//
// Считает hits (НЕ карточки) по rule_id: одна dirty-карточка с двумя
// нарушениями по разным правилам даёт hit обоим правилам. Сравнивает
// с целевой квотой из datasets/synthetic-quota.yaml (text) или
// datasets/synthetic-quota.images.yaml (image).
//
// Image-режим (Sprint P6 Этап 4): отдельная таблица по AI-only
// IMG-правилам (compact уже отфильтрован по image_rules.scope.yaml).
// Image-quota файл может быть пустым (defaults: {}, overrides: {}) —
// в этом случае quota / delta показываются как null (CLI печатает
// '—'), потому что синтетика по фото в этом спринте не считается.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../..');
export const DATASETS_DIR = join(REPO_ROOT, 'datasets');
export const RULES_PATH = join(DATASETS_DIR, 'text_rules.compact.json');
export const IMAGE_RULES_PATH = join(DATASETS_DIR, 'image_rules.compact.json');
export const QUOTA_PATH = join(DATASETS_DIR, 'synthetic-quota.yaml');
export const IMAGE_QUOTA_PATH = join(DATASETS_DIR, 'synthetic-quota.images.yaml');
export const CASES_DIR = join(DATASETS_DIR, 'cases');

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type SourceFilter = 'real' | 'synthetic' | null;

export interface CompactRule {
  id: string;
  severity: Severity;
  title: string;
  desc: string;
}

interface CompactDoc {
  version: 1;
  kind: 'text' | 'image';
  rules: CompactRule[];
}

export interface SyntheticQuota {
  version: 1;
  defaults: Record<Severity, number>;
  overrides?: Record<string, number>;
}

// Image quota: defaults и overrides могут быть пустыми, потому что
// синтетика по фото — отдельный будущий спринт. Если defaults пуст и
// override на правило отсутствует — quota/delta для этого правила
// возвращаются как null (CLI печатает '—').
export interface SyntheticImageQuota {
  version: 1;
  defaults: Partial<Record<Severity, number>>;
  overrides?: Record<string, number>;
}

interface Violation {
  rule_id: string;
}

interface ImageViolation {
  rule_id: string;
}

interface CardCase {
  case_id: string;
  expected_violations: Violation[];
  expected_image_violations?: ImageViolation[];
}

export interface AuditRow {
  rule_id: string;
  severity: Severity;
  real: number;
  synthetic: number;
  total: number;
  quota: number;
  delta: number;
}

// Image-аудит — отдельный тип, потому что image quota на v1 опциональна
// (defaults может быть пустым). quota/delta = null означают «целевая
// квота не задана»; CLI печатает '—'.
export interface ImageAuditRow {
  rule_id: string;
  severity: Severity;
  real: number;
  synthetic: number;
  total: number;
  quota: number | null;
  delta: number | null;
}

const QUOTA_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['version', 'defaults'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    defaults: {
      type: 'object',
      required: ['low', 'medium', 'high', 'critical'],
      additionalProperties: false,
      properties: {
        low: { type: 'integer', minimum: 0 },
        medium: { type: 'integer', minimum: 0 },
        high: { type: 'integer', minimum: 0 },
        critical: { type: 'integer', minimum: 0 },
      },
    },
    overrides: {
      type: 'object',
      patternProperties: {
        '^TXT-\\d{2}$': { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
} as const;

const IMAGE_QUOTA_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['version', 'defaults'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    defaults: {
      type: 'object',
      // Все ключи опциональны: image-quota может быть пуста на v1
      // (synthetic images — отдельный спринт).
      additionalProperties: false,
      properties: {
        low: { type: 'integer', minimum: 0 },
        medium: { type: 'integer', minimum: 0 },
        high: { type: 'integer', minimum: 0 },
        critical: { type: 'integer', minimum: 0 },
      },
    },
    overrides: {
      type: 'object',
      patternProperties: {
        '^IMG-\\d{2}$': { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
} as const;

let cachedQuotaValidator: ValidateFunction<SyntheticQuota> | null = null;
let cachedImageQuotaValidator: ValidateFunction<SyntheticImageQuota> | null = null;

function getQuotaValidator(): ValidateFunction<SyntheticQuota> {
  if (cachedQuotaValidator) return cachedQuotaValidator;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  cachedQuotaValidator = ajv.compile<SyntheticQuota>(QUOTA_SCHEMA);
  return cachedQuotaValidator;
}

function getImageQuotaValidator(): ValidateFunction<SyntheticImageQuota> {
  if (cachedImageQuotaValidator) return cachedImageQuotaValidator;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  cachedImageQuotaValidator = ajv.compile<SyntheticImageQuota>(IMAGE_QUOTA_SCHEMA);
  return cachedImageQuotaValidator;
}

export async function readRules(): Promise<CompactRule[]> {
  const raw = await readFile(RULES_PATH, 'utf8');
  const doc = JSON.parse(raw) as CompactDoc;
  if (!Array.isArray(doc.rules)) {
    throw new Error(`[audit-lib] ${RULES_PATH}: rules не массив`);
  }
  return doc.rules;
}

// Image-правила в compact уже отфильтрованы по datasets/image_rules.scope.yaml
// (Sprint P6 Этап 3) — здесь именно они и нужны: out-of-scope правила
// не должны попадать в IMG-таблицу аудита.
export async function readImageRules(): Promise<CompactRule[]> {
  const raw = await readFile(IMAGE_RULES_PATH, 'utf8');
  const doc = JSON.parse(raw) as CompactDoc;
  if (!Array.isArray(doc.rules)) {
    throw new Error(`[audit-lib] ${IMAGE_RULES_PATH}: rules не массив`);
  }
  return doc.rules;
}

export async function readQuota(): Promise<SyntheticQuota> {
  let raw: string;
  try {
    raw = await readFile(QUOTA_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`[audit-lib] не найден ${QUOTA_PATH}`);
    }
    throw err;
  }
  const parsed: unknown = parseYaml(raw);
  const validate = getQuotaValidator();
  if (!validate(parsed)) {
    const msg = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '(root)'}: ${e.message ?? 'unknown'}`)
      .join('; ');
    throw new Error(`[audit-lib] ${QUOTA_PATH} невалиден: ${msg}`);
  }
  return parsed;
}

export async function readImageQuota(): Promise<SyntheticImageQuota> {
  let raw: string;
  try {
    raw = await readFile(IMAGE_QUOTA_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Файл может отсутствовать до Sprint P7; считаем как пустую квоту.
      return { version: 1, defaults: {}, overrides: {} };
    }
    throw err;
  }
  const parsed: unknown = parseYaml(raw);
  const validate = getImageQuotaValidator();
  if (!validate(parsed)) {
    const msg = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '(root)'}: ${e.message ?? 'unknown'}`)
      .join('; ');
    throw new Error(`[audit-lib] ${IMAGE_QUOTA_PATH} невалиден: ${msg}`);
  }
  return parsed;
}

export async function readCasesDir(dir: string): Promise<CardCase[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: CardCase[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const raw = await readFile(join(dir, name), 'utf8');
    out.push(JSON.parse(raw) as CardCase);
  }
  return out;
}

export async function readAllCases(): Promise<{ real: CardCase[]; synthetic: CardCase[] }> {
  const real = [
    ...(await readCasesDir(join(CASES_DIR, 'real-clean'))),
    ...(await readCasesDir(join(CASES_DIR, 'real-dirty'))),
  ];
  const synthetic = [
    ...(await readCasesDir(join(CASES_DIR, 'synthetic-clean'))),
    ...(await readCasesDir(join(CASES_DIR, 'synthetic-dirty'))),
  ];
  return { real, synthetic };
}

export function countHits(
  cases: readonly CardCase[],
  knownRules: ReadonlySet<string>,
): Map<string, number> {
  const hits = new Map<string, number>();
  for (const c of cases) {
    for (const v of c.expected_violations) {
      if (!knownRules.has(v.rule_id)) {
        throw new Error(
          `[audit-lib] кейс ${c.case_id}: rule_id="${v.rule_id}" отсутствует в text_rules.compact.json. ` +
            'Запустите pnpm rules:compact или почините разметку.',
        );
      }
      hits.set(v.rule_id, (hits.get(v.rule_id) ?? 0) + 1);
    }
  }
  return hits;
}

// Image-hits: пробегает по expected_image_violations[]. Правила вне scope
// (out-of-scope из image_rules.scope.yaml) в knownRules отсутствуют — для
// них кидаем явную ошибку, чтобы не молчать о возможном дрейфе scope-
// конфига и compact-таблицы.
export function countImageHits(
  cases: readonly CardCase[],
  knownRules: ReadonlySet<string>,
): Map<string, number> {
  const hits = new Map<string, number>();
  for (const c of cases) {
    const violations = c.expected_image_violations ?? [];
    for (const v of violations) {
      if (!knownRules.has(v.rule_id)) {
        throw new Error(
          `[audit-lib] кейс ${c.case_id}: image rule_id="${v.rule_id}" отсутствует в image_rules.compact.json. ` +
            'Возможно, правило вне scope (image_rules.scope.yaml) или нужен pnpm rules:compact.',
        );
      }
      hits.set(v.rule_id, (hits.get(v.rule_id) ?? 0) + 1);
    }
  }
  return hits;
}

export function quotaFor(rule: CompactRule, quota: SyntheticQuota): number {
  const override = quota.overrides?.[rule.id];
  if (override !== undefined) return override;
  return quota.defaults[rule.severity];
}

// Image quota опциональна: если ни override на rule_id, ни default по
// severity не заданы — целевая квота не определена, возвращаем null.
// CLI печатает '—' и не считает delta.
export function quotaForImage(
  rule: CompactRule,
  quota: SyntheticImageQuota,
): number | null {
  const override = quota.overrides?.[rule.id];
  if (override !== undefined) return override;
  const def = quota.defaults[rule.severity];
  return def ?? null;
}

export function buildRows(
  rules: readonly CompactRule[],
  realHits: Map<string, number>,
  synthHits: Map<string, number>,
  quota: SyntheticQuota,
  source: SourceFilter,
): AuditRow[] {
  return rules.map((r) => {
    const realRaw = realHits.get(r.id) ?? 0;
    const synthRaw = synthHits.get(r.id) ?? 0;
    const real = source === 'synthetic' ? 0 : realRaw;
    const synthetic = source === 'real' ? 0 : synthRaw;
    const total =
      source === null ? real + synthetic : source === 'real' ? real : synthetic;
    const ruleQuota = quotaFor(r, quota);
    const delta = Math.max(0, ruleQuota - total);
    return {
      rule_id: r.id,
      severity: r.severity,
      real,
      synthetic,
      total,
      quota: ruleQuota,
      delta,
    };
  });
}

// Высокоуровневый хелпер — собирает строки аудита по текущему состоянию.
export async function computeAudit(source: SourceFilter = null): Promise<AuditRow[]> {
  const rules = await readRules();
  const known = new Set(rules.map((r) => r.id));
  const quota = await readQuota();
  const { real, synthetic } = await readAllCases();
  const realHits = countHits(real, known);
  const synthHits = countHits(synthetic, known);
  return buildRows(rules, realHits, synthHits, quota, source);
}

export function buildImageRows(
  rules: readonly CompactRule[],
  realHits: Map<string, number>,
  synthHits: Map<string, number>,
  quota: SyntheticImageQuota,
  source: SourceFilter,
): ImageAuditRow[] {
  return rules.map((r) => {
    const realRaw = realHits.get(r.id) ?? 0;
    const synthRaw = synthHits.get(r.id) ?? 0;
    const real = source === 'synthetic' ? 0 : realRaw;
    const synthetic = source === 'real' ? 0 : synthRaw;
    const total =
      source === null ? real + synthetic : source === 'real' ? real : synthetic;
    const ruleQuota = quotaForImage(r, quota);
    const delta = ruleQuota === null ? null : Math.max(0, ruleQuota - total);
    return {
      rule_id: r.id,
      severity: r.severity,
      real,
      synthetic,
      total,
      quota: ruleQuota,
      delta,
    };
  });
}

export async function computeImageAudit(source: SourceFilter = null): Promise<ImageAuditRow[]> {
  const rules = await readImageRules();
  const known = new Set(rules.map((r) => r.id));
  const quota = await readImageQuota();
  const { real, synthetic } = await readAllCases();
  const realHits = countImageHits(real, known);
  const synthHits = countImageHits(synthetic, known);
  return buildImageRows(rules, realHits, synthHits, quota, source);
}
