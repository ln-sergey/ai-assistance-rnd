// Переносит заполненные synth-pending'и в synthetic-store:
//   datasets/synthetic/cards.raw.jsonl   (append, обёртка { card, _meta })
//   datasets/annotations/synthetic.json  (merge по case_id)
//
// Каждый pending-файл synth-*.json:
//   1) валидируется как наполненный (card !== null, для dirty —
//      violations.length >= 1);
//   2) card.id нормализуется до case_id pending'а (если агент не заполнил
//      или заполнил неправильно);
//   3) card валидируется против product_card.schema.json (ajv strict);
//   4) annotation-обёртка валидируется против annotation.schema.json + для
//      TXT-нарушений quote дословно ищется в card по field_path;
//   5) при успехе запись добавляется в cards.raw.jsonl и synthetic.json,
//      pending удаляется. При ошибке pending остаётся, накапливается
//      счётчик; commit падает с exit 1, если ошибок > 0.
//
// Атомарность: cards.raw.jsonl и synthetic.json пишутся через tmp+rename.
//
// Использование:
//   pnpm synth:commit
//   pnpm synth:commit -- --dry-run
//   pnpm synth:commit -- --yes

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const SCHEMA_DIR = join(DATASETS_DIR, 'schema');
const ANNOTATIONS_DIR = join(DATASETS_DIR, 'annotations');
const PENDING_DIR = join(ANNOTATIONS_DIR, 'pending');
const SYNTH_DIR = join(DATASETS_DIR, 'synthetic');
const SYNTH_CARDS_JSONL = join(SYNTH_DIR, 'cards.raw.jsonl');
const SYNTH_ANNOTATIONS = join(ANNOTATIONS_DIR, 'synthetic.json');

const GENERATOR_MODEL = 'claude-opus-4.7-session';
const PROMPT_VERSION = 'synthesize-card-v2';
const ANNOTATOR_LABEL = 'claude-opus-4.7-session';
const TODAY = new Date().toISOString().slice(0, 10);

type Severity = 'low' | 'medium' | 'high' | 'critical';

interface Violation {
  rule_id: string;
  severity: Severity;
  field_path: string;
  quote: string | null;
  rationale: string;
}

interface Annotation {
  expected_clean: boolean;
  violations: Violation[];
  notes: string | null;
  annotated_at: string;
  annotator: string;
}

interface AnnotationStore {
  version: 1;
  annotations: Record<string, Annotation>;
}

interface SynthPendingRaw {
  case_id?: unknown;
  kind?: unknown;
  target_rule_id?: unknown;
  target_severity?: unknown;
  target_clean?: unknown;
  topic_hint?: unknown;
  card?: unknown;
  violations?: unknown;
  annotator?: unknown;
  annotated_at?: unknown;
  _help?: unknown;
}

interface SynthMeta {
  source_site: 'synthetic';
  source_url: null;
  fetched_at: string;
  parser_version: null;
  json_ld_found: false;
  warnings: [];
  target_rule_id: string | null;
  topic_hint: string | null;
  generator_model: string;
  prompt_version: string;
}

interface SynthCardRecord {
  card: Record<string, unknown> & { id: string };
  _meta: SynthMeta;
}

interface CliArgs {
  dryRun: boolean;
  yes: boolean;
}

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
  let dryRun = false;
  let yes = false;
  for (const a of argv) {
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a === '--yes') {
      yes = true;
      continue;
    }
    bail(`[synth:commit] неизвестный аргумент: ${a}`);
  }
  return { dryRun, yes };
}

interface Validators {
  validateCard: ValidateFunction;
  validateAnnotation: ValidateFunction<Annotation>;
}

async function loadValidators(): Promise<Validators> {
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  const productCardSchema = JSON.parse(
    await readFile(join(SCHEMA_DIR, 'product_card.schema.json'), 'utf8'),
  );
  ajv.addSchema(productCardSchema);
  ajv.addSchema(
    JSON.parse(await readFile(join(SCHEMA_DIR, 'test_case.schema.json'), 'utf8')),
  );
  ajv.addSchema(
    JSON.parse(await readFile(join(SCHEMA_DIR, 'annotation.schema.json'), 'utf8')),
  );
  return {
    validateCard: ajv.compile(productCardSchema),
    validateAnnotation: ajv.compile<Annotation>({
      $ref: 'annotation.schema.json#/$defs/annotation',
    }),
  };
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return '(no error info)';
  return errors
    .map((e) => `${e.instancePath || '(root)'}: ${e.message ?? 'unknown'}`)
    .join('; ');
}

function quoteFoundIn(
  card: Record<string, unknown>,
  field_path: string,
  quote: string,
): boolean {
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

async function readSynthCards(): Promise<SynthCardRecord[]> {
  try {
    const raw = await readFile(SYNTH_CARDS_JSONL, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as SynthCardRecord);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readSynthStore(): Promise<AnnotationStore> {
  try {
    const raw = await readFile(SYNTH_ANNOTATIONS, 'utf8');
    return JSON.parse(raw) as AnnotationStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, annotations: {} };
    }
    throw err;
  }
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const tmp = target + '.tmp';
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);
}

interface ProcessedItem {
  pendingPath: string;
  caseId: string;
  card: Record<string, unknown> & { id: string };
  meta: SynthMeta;
  annotation: Annotation;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!existsSync(PENDING_DIR)) {
    console.log('[synth:commit] datasets/annotations/pending/ нет — нечего коммитить');
    return;
  }

  const entries = (await readdir(PENDING_DIR))
    .filter((n) => n.startsWith('synth-') && n.endsWith('.json'))
    .sort();
  if (entries.length === 0) {
    console.log('[synth:commit] synth-pending пусто');
    return;
  }

  const { validateCard, validateAnnotation } = await loadValidators();

  const existingCards = await readSynthCards();
  const existingIds = new Set(existingCards.map((r) => r.card.id));
  const store = await readSynthStore();

  const errors: string[] = [];
  const processed: ProcessedItem[] = [];
  const seenInBatch = new Set<string>();
  let skipped = 0;

  for (const name of entries) {
    const path = join(PENDING_DIR, name);
    let raw: SynthPendingRaw;
    try {
      raw = JSON.parse(await readFile(path, 'utf8')) as SynthPendingRaw;
    } catch (err) {
      errors.push(`${name}: невалидный JSON — ${(err as Error).message}`);
      continue;
    }

    if (raw.kind !== 'synthetic_pending') {
      errors.push(`${name}: kind ожидался "synthetic_pending", получено ${JSON.stringify(raw.kind)}`);
      continue;
    }
    const caseId = typeof raw.case_id === 'string' ? raw.case_id : null;
    if (!caseId || !/^synth_[a-z0-9]+_\d{3}$/.test(caseId)) {
      errors.push(`${name}: case_id "${caseId}" не соответствует synth_<rule_lc>_<NNN>`);
      continue;
    }

    const targetClean = raw.target_clean === true;
    const targetRuleId = typeof raw.target_rule_id === 'string' ? raw.target_rule_id : null;
    const topicHint = typeof raw.topic_hint === 'string' ? raw.topic_hint : null;

    if (raw.card === null || raw.card === undefined) {
      console.log(`[skip] ${caseId}: card не заполнен`);
      skipped += 1;
      continue;
    }

    const violations = Array.isArray(raw.violations) ? (raw.violations as Violation[]) : [];
    if (!targetClean && violations.length === 0) {
      console.log(`[skip] ${caseId}: target_clean=false, но violations пустой`);
      skipped += 1;
      continue;
    }
    if (targetClean && violations.length > 0) {
      errors.push(`${caseId}: target_clean=true, но violations не пустой (${violations.length})`);
      continue;
    }

    // Нормализация: card.id ← case_id (агент мог не заполнить или ошибиться).
    const cardObj = raw.card as Record<string, unknown>;
    if (typeof cardObj.id !== 'string' || cardObj.id !== caseId) {
      cardObj.id = caseId;
    }
    const card = cardObj as Record<string, unknown> & { id: string };

    const okCard = validateCard(card);
    if (!okCard) {
      errors.push(`${caseId}: card schema — ${formatErrors(validateCard.errors)}`);
      continue;
    }

    if (existingIds.has(caseId) || seenInBatch.has(caseId)) {
      errors.push(`${caseId}: дубль — id уже есть в synthetic-store или в текущей партии`);
      continue;
    }

    const annotation: Annotation = {
      expected_clean: targetClean,
      violations,
      notes: null,
      annotated_at: TODAY,
      annotator: ANNOTATOR_LABEL,
    };

    const okAnn = validateAnnotation(annotation);
    if (!okAnn) {
      errors.push(`${caseId}: annotation schema — ${formatErrors(validateAnnotation.errors)}`);
      continue;
    }

    let txtOk = true;
    for (const [i, v] of annotation.violations.entries()) {
      if (!v.rule_id.startsWith('TXT-')) continue;
      if (!v.quote || v.quote.length === 0) {
        errors.push(`${caseId}: violations[${i}] TXT-правило требует непустой quote`);
        txtOk = false;
        continue;
      }
      if (!quoteFoundIn(card, v.field_path, v.quote)) {
        errors.push(
          `${caseId}: violations[${i}] quote не найдена дословно в ${v.field_path}`,
        );
        txtOk = false;
      }
    }
    if (!txtOk) continue;

    if (targetRuleId !== null && annotation.violations[0]?.rule_id !== targetRuleId) {
      // Не критично, но указывает на расхождение между скаффолдом и
      // содержимым; пишем warn в stdout (не в errors), чтобы не блокировать.
      console.log(
        `[warn] ${caseId}: target_rule_id=${targetRuleId}, но violations[0].rule_id=${annotation.violations[0]?.rule_id ?? '<empty>'}`,
      );
    }

    const meta: SynthMeta = {
      source_site: 'synthetic',
      source_url: null,
      fetched_at: new Date().toISOString(),
      parser_version: null,
      json_ld_found: false,
      warnings: [],
      target_rule_id: targetRuleId,
      topic_hint: topicHint,
      generator_model: GENERATOR_MODEL,
      prompt_version: PROMPT_VERSION,
    };

    processed.push({ pendingPath: path, caseId, card, meta, annotation });
    seenInBatch.add(caseId);
    console.log(`[ok] ${caseId} → synthetic/cards.raw.jsonl + annotations/synthetic.json`);
  }

  console.log(
    `[synth:commit] processed=${processed.length}, skipped=${skipped}, errors=${errors.length}` +
      (args.dryRun ? ' (dry-run)' : ''),
  );
  for (const e of errors) console.error('  ✗', e);

  if (args.dryRun) {
    console.log('[synth:commit] dry-run: store не записан, pending не удалён');
    if (errors.length > 0) process.exit(1);
    return;
  }

  if (errors.length > 0) {
    console.error('[synth:commit] есть ошибки — store не обновлён');
    process.exit(1);
  }

  if (processed.length === 0) {
    console.log('[synth:commit] нет валидных pending для записи');
    return;
  }

  await mkdir(SYNTH_DIR, { recursive: true });

  // Append-write cards.raw.jsonl (rewrite целиком + tmp/rename для атомарности).
  const newCards: SynthCardRecord[] = [
    ...existingCards,
    ...processed.map((p) => ({ card: p.card, _meta: p.meta })),
  ];
  const cardsContent = newCards.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeAtomic(SYNTH_CARDS_JSONL, cardsContent);

  for (const p of processed) {
    store.annotations[p.caseId] = p.annotation;
  }
  await writeAtomic(
    SYNTH_ANNOTATIONS,
    JSON.stringify({ version: 1, annotations: store.annotations }, null, 2) + '\n',
  );

  for (const p of processed) {
    await rm(p.pendingPath, { force: true });
  }

  console.log(
    `[synth:commit] записано: ${processed.length} карточек в synthetic-store; pending очищен`,
  );

  void args.yes;
}

main().catch((err) => {
  console.error('[synth:commit] failure:', err);
  process.exit(1);
});
