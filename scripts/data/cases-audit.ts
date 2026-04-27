// Аудит покрытия правил по карточкам в datasets/cases/.
// Считает hits по rule_id (НЕ карточки): одна dirty-карточка с двумя
// нарушениями по разным правилам даёт hit обоим правилам.
// Сравнивает с целевой квотой из datasets/synthetic-quota.yaml и
// печатает delta = max(0, quota - total). delta > 0 означает «нужно
// сгенерировать синтетику по этому правилу».
//
// Использование:
//   pnpm cases:audit                  — таблица для человека
//   pnpm cases:audit --json           — массив для synth:scaffold --from-audit
//   pnpm cases:audit --source=real    — только реальная выборка
//   pnpm cases:audit --source=synthetic — только синтетика

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const RULES_PATH = join(DATASETS_DIR, 'text_rules.compact.json');
const QUOTA_PATH = join(DATASETS_DIR, 'synthetic-quota.yaml');
const CASES_DIR = join(DATASETS_DIR, 'cases');

type Severity = 'low' | 'medium' | 'high' | 'critical';
type SourceFilter = 'real' | 'synthetic' | null;

interface CompactRule {
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

interface SyntheticQuota {
  version: 1;
  defaults: Record<Severity, number>;
  overrides?: Record<string, number>;
}

interface Violation {
  rule_id: string;
  severity: Severity;
}

interface CardCase {
  case_id: string;
  expected_violations: Violation[];
  expected_clean: boolean;
}

interface AuditRow {
  rule_id: string;
  severity: Severity;
  real: number;
  synthetic: number;
  total: number;
  quota: number;
  delta: number;
}

interface CliArgs {
  json: boolean;
  source: SourceFilter;
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

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
  let json = false;
  let source: SourceFilter = null;
  for (const a of argv) {
    if (a === '--json') {
      json = true;
      continue;
    }
    const m = a.match(/^--source=(real|synthetic)$/);
    if (m?.[1]) {
      source = m[1] as SourceFilter;
      continue;
    }
    bail(`[audit] неизвестный аргумент: ${a}`);
  }
  return { json, source };
}

async function readRules(): Promise<CompactRule[]> {
  const raw = await readFile(RULES_PATH, 'utf8');
  const doc = JSON.parse(raw) as CompactDoc;
  if (!Array.isArray(doc.rules)) bail(`[audit] ${RULES_PATH}: rules не массив`);
  return doc.rules;
}

async function readQuota(): Promise<SyntheticQuota> {
  let raw: string;
  try {
    raw = await readFile(QUOTA_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      bail(`[audit] не найден ${QUOTA_PATH} — создайте файл с дефолтами по severity`);
    }
    throw err;
  }
  const parsed: unknown = parseYaml(raw);
  const validate = getQuotaValidator();
  if (!validate(parsed)) {
    const msg = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '(root)'}: ${e.message ?? 'unknown'}`)
      .join('; ');
    bail(`[audit] ${QUOTA_PATH} невалиден: ${msg}`);
  }
  return parsed;
}

async function readCasesDir(dir: string): Promise<CardCase[]> {
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

function countHits(cases: readonly CardCase[], knownRules: Set<string>): Map<string, number> {
  const hits = new Map<string, number>();
  for (const c of cases) {
    for (const v of c.expected_violations) {
      if (!knownRules.has(v.rule_id)) {
        bail(
          `[audit] кейс ${c.case_id}: rule_id="${v.rule_id}" отсутствует в text_rules.compact.json. ` +
            'Запустите pnpm rules:compact или почините разметку.',
        );
      }
      hits.set(v.rule_id, (hits.get(v.rule_id) ?? 0) + 1);
    }
  }
  return hits;
}

function quotaFor(rule: CompactRule, quota: SyntheticQuota): number {
  const override = quota.overrides?.[rule.id];
  if (override !== undefined) return override;
  return quota.defaults[rule.severity];
}

function buildRows(
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

function pad(s: string, w: number, right = false): string {
  if (s.length >= w) return s;
  return right ? s.padStart(w) : s.padEnd(w);
}

function printTable(rows: readonly AuditRow[], source: SourceFilter): void {
  const showReal = source !== 'synthetic';
  const showSynth = source !== 'real';

  type Col = { label: string; w: number; right: boolean; get: (r: AuditRow) => string };
  const cols: Col[] = [];
  cols.push({ label: 'rule_id', w: 8, right: false, get: (r) => r.rule_id });
  cols.push({ label: 'severity', w: 10, right: false, get: (r) => r.severity });
  if (showReal) cols.push({ label: 'real', w: 6, right: true, get: (r) => String(r.real) });
  if (showSynth)
    cols.push({ label: 'synthetic', w: 11, right: true, get: (r) => String(r.synthetic) });
  cols.push({ label: 'total', w: 7, right: true, get: (r) => String(r.total) });
  cols.push({ label: 'quota', w: 7, right: true, get: (r) => String(r.quota) });
  cols.push({ label: 'delta', w: 7, right: true, get: (r) => String(r.delta) });

  const fmtRow = (vals: readonly string[]): string =>
    cols.map((c, i) => pad(vals[i] ?? '', c.w, c.right)).join(' ');

  console.log(fmtRow(cols.map((c) => c.label)));

  const sorted = [...rows].sort((a, b) => a.rule_id.localeCompare(b.rule_id));
  for (const r of sorted) {
    console.log(fmtRow(cols.map((c) => c.get(r))));
  }

  const totalWidth = cols.reduce((acc, c) => acc + c.w + 1, -1);
  console.log('─'.repeat(Math.max(40, totalWidth)));

  const totalReal = rows.reduce((s, r) => s + r.real, 0);
  const totalSynth = rows.reduce((s, r) => s + r.synthetic, 0);
  const totalAll = rows.reduce((s, r) => s + r.total, 0);
  const totalQuota = rows.reduce((s, r) => s + r.quota, 0);
  const totalDelta = rows.reduce((s, r) => s + r.delta, 0);
  const noCovReal = rows.filter((r) => r.real === 0).length;
  const noCovSynth = rows.filter((r) => r.synthetic === 0).length;
  const noCovTotal = rows.filter((r) => r.total === 0).length;

  const labelW = (cols[0]?.w ?? 0) + 1 + (cols[1]?.w ?? 0);
  const sumLine = (label: string, vReal: number, vSynth: number, vTotal: number, vQuota?: number, vDelta?: number): string => {
    let s = pad(label, labelW, false);
    if (showReal) s += ' ' + pad(String(vReal), 6, true);
    if (showSynth) s += ' ' + pad(String(vSynth), 11, true);
    s += ' ' + pad(String(vTotal), 7, true);
    if (vQuota !== undefined) s += ' ' + pad(String(vQuota), 7, true);
    if (vDelta !== undefined) s += ' ' + pad(String(vDelta), 7, true);
    return s;
  };

  console.log(sumLine('Всего нарушений', totalReal, totalSynth, totalAll, totalQuota, totalDelta));
  console.log(sumLine('Правил без покрытия', noCovReal, noCovSynth, noCovTotal));
  console.log(`Правил всего: ${rows.length}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const rules = await readRules();
  const knownRules = new Set(rules.map((r) => r.id));
  const quota = await readQuota();

  const realCases = [
    ...(await readCasesDir(join(CASES_DIR, 'real-clean'))),
    ...(await readCasesDir(join(CASES_DIR, 'real-dirty'))),
  ];
  const synthCases = [
    ...(await readCasesDir(join(CASES_DIR, 'synthetic-clean'))),
    ...(await readCasesDir(join(CASES_DIR, 'synthetic-dirty'))),
  ];

  const realHits = countHits(realCases, knownRules);
  const synthHits = countHits(synthCases, knownRules);

  const rows = buildRows(rules, realHits, synthHits, quota, args.source);

  if (args.json) {
    const sorted = [...rows].sort((a, b) => {
      if (b.delta !== a.delta) return b.delta - a.delta;
      return a.rule_id.localeCompare(b.rule_id);
    });
    process.stdout.write(JSON.stringify(sorted, null, 2) + '\n');
    return;
  }

  printTable(rows, args.source);
}

main().catch((err) => {
  console.error('[audit] failure:', err);
  process.exit(1);
});
