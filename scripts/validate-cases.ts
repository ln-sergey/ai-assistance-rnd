// Валидатор tест-кейсов в datasets/cases/real-{clean,dirty}/.
// Каждый файл должен соответствовать card_case в datasets/schema/test_case.schema.json
// (через oneOf), а severity внутри expected_violations[] — совпадать с severity
// одноимённого правила в text_rules.yaml / image_rules.yaml.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const SCHEMA_DIR = join(REPO_ROOT, 'datasets/schema');
const CASES_ROOT = join(REPO_ROOT, 'datasets/cases');
const TEXT_RULES_PATH = join(REPO_ROOT, 'text_rules.yaml');
const IMAGE_RULES_PATH = join(REPO_ROOT, 'image_rules.yaml');

type Severity = 'low' | 'medium' | 'high' | 'critical';

interface Violation {
  rule_id: string;
  severity: Severity;
  field_path: string;
  quote: string | null;
  rationale: string;
}

interface CardCase {
  case_id: string;
  kind: 'card_case';
  source: string;
  card: Record<string, unknown>;
  expected_violations: Violation[];
  expected_clean: boolean;
  notes?: string | null;
}

function parseRulesSeverities(yaml: string): Map<string, Severity> {
  const doc = parseYaml(yaml) as { rules?: Array<{ id?: string; severity?: Severity }> };
  const out = new Map<string, Severity>();
  for (const r of doc.rules ?? []) {
    if (r.id && r.severity) out.set(r.id, r.severity);
  }
  return out;
}

async function loadValidator(): Promise<(case_: unknown) => ErrorObject[] | null> {
  const ajv = new Ajv2020({
    strict: true,
    // Условные схемы (if/then) добавляют maxItems/minItems без повтора
    // type: "array" — strictTypes на это ругается, хотя сама схема валидна.
    strictTypes: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  const productCardSchema = JSON.parse(
    await readFile(join(SCHEMA_DIR, 'product_card.schema.json'), 'utf8'),
  );
  const testCaseSchema = JSON.parse(
    await readFile(join(SCHEMA_DIR, 'test_case.schema.json'), 'utf8'),
  );
  ajv.addSchema(productCardSchema);
  const validate = ajv.compile(testCaseSchema);
  return (data: unknown) => (validate(data) ? null : [...(validate.errors ?? [])]);
}

function formatErrors(errors: ErrorObject[]): string {
  return errors
    .map((e) => `${e.instancePath || '(root)'}: ${e.message ?? 'unknown'}`)
    .join('; ');
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => join(dir, e.name))
    .sort();
}

function quoteFoundIn(card: Record<string, unknown>, field_path: string, quote: string): boolean {
  // Резолвим dot-нотацию вида program_items[2].title или contacts_block.public_comment.
  const parts: (string | number)[] = [];
  let buf = '';
  for (let i = 0; i < field_path.length; i += 1) {
    const ch = field_path[i];
    if (ch === '.') {
      if (buf) parts.push(buf);
      buf = '';
    } else if (ch === '[') {
      if (buf) parts.push(buf);
      buf = '';
      const close = field_path.indexOf(']', i);
      const idx = parseInt(field_path.slice(i + 1, close), 10);
      parts.push(idx);
      i = close;
    } else {
      buf += ch;
    }
  }
  if (buf) parts.push(buf);

  let cursor: unknown = card;
  for (const p of parts) {
    if (cursor === null || cursor === undefined) return false;
    if (typeof p === 'number') {
      if (!Array.isArray(cursor)) return false;
      cursor = cursor[p];
    } else {
      if (typeof cursor !== 'object') return false;
      cursor = (cursor as Record<string, unknown>)[p];
    }
  }
  if (typeof cursor !== 'string') return false;
  return cursor.includes(quote);
}

async function main(): Promise<void> {
  const validate = await loadValidator();
  const ruleSeverities = new Map<string, Severity>([
    ...parseRulesSeverities(await readFile(TEXT_RULES_PATH, 'utf8')),
    ...parseRulesSeverities(await readFile(IMAGE_RULES_PATH, 'utf8')),
  ]);

  const cleanFiles = await listJsonFiles(join(CASES_ROOT, 'real-clean'));
  const dirtyFiles = await listJsonFiles(join(CASES_ROOT, 'real-dirty'));
  const allFiles = [
    ...cleanFiles.map((f) => ({ path: f, expectedDirty: false })),
    ...dirtyFiles.map((f) => ({ path: f, expectedDirty: true })),
  ];

  const errors: string[] = [];
  let passed = 0;

  for (const { path, expectedDirty } of allFiles) {
    const data = JSON.parse(await readFile(path, 'utf8')) as CardCase;
    const ajvErrors = validate(data);
    if (ajvErrors) {
      errors.push(`${path}: schema — ${formatErrors(ajvErrors)}`);
      continue;
    }

    if (expectedDirty !== !data.expected_clean) {
      errors.push(
        `${path}: расположение vs expected_clean — файл лежит в ${expectedDirty ? 'real-dirty' : 'real-clean'}, а expected_clean=${data.expected_clean}`,
      );
      continue;
    }

    if (!path.endsWith(`/${data.case_id}.json`)) {
      errors.push(`${path}: имя файла не соответствует case_id=${data.case_id}`);
      continue;
    }

    let localOk = true;
    for (const [i, v] of data.expected_violations.entries()) {
      const expectedSev = ruleSeverities.get(v.rule_id);
      if (!expectedSev) {
        errors.push(
          `${path}: violations[${i}] rule_id=${v.rule_id} нет в text_rules.yaml/image_rules.yaml`,
        );
        localOk = false;
        continue;
      }
      if (v.severity !== expectedSev) {
        const src = v.rule_id.startsWith('TXT-') ? 'text_rules.yaml' : 'image_rules.yaml';
        errors.push(
          `${path}: violations[${i}] severity=${v.severity} ≠ ${src}(${v.rule_id})=${expectedSev}`,
        );
        localOk = false;
      }
      if (v.rule_id.startsWith('TXT-')) {
        if (!v.quote || v.quote.length === 0) {
          errors.push(`${path}: violations[${i}] TXT-правило требует непустой quote`);
          localOk = false;
        } else if (!quoteFoundIn(data.card, v.field_path, v.quote)) {
          errors.push(
            `${path}: violations[${i}] quote не найдена дословно в ${v.field_path}`,
          );
          localOk = false;
        }
      }
    }
    if (localOk) passed += 1;
  }

  console.log(
    `[validate-cases] total=${allFiles.length}, passed=${passed}, errors=${errors.length}`,
  );
  for (const e of errors) console.error('  ✗', e);
  if (errors.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[validate-cases] failure:', err);
  process.exit(1);
});
