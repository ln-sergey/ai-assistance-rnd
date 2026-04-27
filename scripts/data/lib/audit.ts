// Общая логика аудита покрытия правил тестовыми кейсами.
// Используется в:
//   - scripts/data/cases-audit.ts — CLI-обёртка для пользователя/агента.
//   - scripts/data/synthesize-scaffold.ts — для --from-audit (массовое
//     создание pending'ов по delta).
//
// Считает hits (НЕ карточки) по rule_id: одна dirty-карточка с двумя
// нарушениями по разным правилам даёт hit обоим правилам. Сравнивает
// с целевой квотой из datasets/synthetic-quota.yaml.

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
export const QUOTA_PATH = join(DATASETS_DIR, 'synthetic-quota.yaml');
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
  kind: 'text';
  rules: CompactRule[];
}

export interface SyntheticQuota {
  version: 1;
  defaults: Record<Severity, number>;
  overrides?: Record<string, number>;
}

interface Violation {
  rule_id: string;
}

interface CardCase {
  case_id: string;
  expected_violations: Violation[];
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

let cachedQuotaValidator: ValidateFunction<SyntheticQuota> | null = null;

function getQuotaValidator(): ValidateFunction<SyntheticQuota> {
  if (cachedQuotaValidator) return cachedQuotaValidator;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  cachedQuotaValidator = ajv.compile<SyntheticQuota>(QUOTA_SCHEMA);
  return cachedQuotaValidator;
}

export async function readRules(): Promise<CompactRule[]> {
  const raw = await readFile(RULES_PATH, 'utf8');
  const doc = JSON.parse(raw) as CompactDoc;
  if (!Array.isArray(doc.rules)) {
    throw new Error(`[audit-lib] ${RULES_PATH}: rules не массив`);
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

export function quotaFor(rule: CompactRule, quota: SyntheticQuota): number {
  const override = quota.overrides?.[rule.id];
  if (override !== undefined) return override;
  return quota.defaults[rule.severity];
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
