// Создаёт pending-файлы для синтетических карточек в
// datasets/annotations/pending/synth-<rule_lc>-<NNN>.json. Дальше
// локальный AI-агент в интерактивной сессии (Claude Code, Codex,
// Cursor, Aider или любой совместимый передовой агент) заполняет
// поля card + violations по канонической версии промпта
// (PROMPT_PATH ниже). После заполнения — pnpm synth:commit.
//
// Не вызывает никаких LLM/API — только подготовка слотов.
// Прямые API-вызовы к целевым провайдерам или эталонным AI запрещены
// для подготовки тестовых данных (см. AGENTS.md / docs/tz-synthetic-cards.md).
//
// Использование:
//   pnpm synth:scaffold -- --rule=TXT-05 --count=3
//   pnpm synth:scaffold -- --from-audit
//   pnpm synth:scaffold -- --clean-control=5
//   pnpm synth:scaffold -- --rule=TXT-05 --count=3 --topic="пешая экскурсия"
//   pnpm synth:scaffold -- --from-audit --max=30   # ограничить общее число

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeAudit, readRules } from './lib/audit.js';
import type { CompactRule, Severity } from './lib/audit.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const ANNOTATIONS_DIR = join(DATASETS_DIR, 'annotations');
const PENDING_DIR = join(ANNOTATIONS_DIR, 'pending');
const SYNTH_STORE = join(ANNOTATIONS_DIR, 'synthetic.json');
const SYNTH_CARDS_JSONL = join(DATASETS_DIR, 'synthetic', 'cards.raw.jsonl');
const PROMPT_PATH = 'prompts/synthesize-card-v7.txt';

// Разрешённые тематики из prompts/synthesize-card-v1.txt. Round-robin
// для разнообразия в партии. При --topic — fixed.
const TOPICS = [
  'пешая экскурсия',
  'гастрономический тур',
  'тур на природу/в горы',
  'водная экскурсия',
  'автобусный тур',
  'мастер-класс',
  'спектакль/концерт',
  'корпоративный тимбилдинг',
  'экскурсия с гидом-экспертом',
  'тур по индустриальным/промышленным объектам',
  'детская экскурсия',
  'исторический квест',
] as const;

type Topic = (typeof TOPICS)[number];

interface CliArgs {
  rule: string | null;
  count: number | null;
  fromAudit: boolean;
  cleanControl: number | null;
  topic: Topic | null;
  max: number | null;
}

interface SynthPendingFile {
  case_id: string;
  kind: 'synthetic_pending';
  target_rule_id: string | null;
  target_severity: Severity | null;
  target_clean: boolean;
  topic_hint: Topic;
  card: null;
  violations: [];
  annotator: null;
  annotated_at: null;
  _help: {
    prompt_path: string;
    rules_path: string;
    schema_path: string;
    instruction: string;
  };
}

interface AnnotationStore {
  version: 1;
  annotations: Record<string, unknown>;
}

interface CardRecord {
  card: { id: string };
}

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
  let rule: string | null = null;
  let count: number | null = null;
  let fromAudit = false;
  let cleanControl: number | null = null;
  let topic: Topic | null = null;
  let max: number | null = null;
  for (const a of argv) {
    if (a === '--from-audit') {
      fromAudit = true;
      continue;
    }
    const m = a.match(/^--([a-z-]+)=(.+)$/);
    if (!m) bail(`[scaffold] неизвестный аргумент: ${a} (форматы: --key=value)`);
    const [, key, val] = m;
    if (val === undefined) bail(`[scaffold] пустое значение для --${key}`);
    switch (key) {
      case 'rule':
        if (!/^TXT-\d{2}$/.test(val)) bail(`[scaffold] --rule=${val} — ожидался формат TXT-NN`);
        rule = val;
        break;
      case 'count': {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) bail(`[scaffold] --count=${val} — целое ≥ 1`);
        count = n;
        break;
      }
      case 'clean-control': {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) bail(`[scaffold] --clean-control=${val} — целое ≥ 1`);
        cleanControl = n;
        break;
      }
      case 'topic':
        if (!(TOPICS as readonly string[]).includes(val)) {
          bail(`[scaffold] --topic="${val}" не из списка: ${TOPICS.join(' | ')}`);
        }
        topic = val as Topic;
        break;
      case 'max': {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) bail(`[scaffold] --max=${val} — целое ≥ 1`);
        max = n;
        break;
      }
      default:
        bail(`[scaffold] неизвестный флаг --${key}`);
    }
  }
  return { rule, count, fromAudit, cleanControl, topic, max };
}

function ruleLc(ruleId: string): string {
  return ruleId.replace(/^TXT-/, 'txt').toLowerCase();
}

async function readSynthStoreKeys(): Promise<Set<string>> {
  try {
    const raw = await readFile(SYNTH_STORE, 'utf8');
    const store = JSON.parse(raw) as AnnotationStore;
    return new Set(Object.keys(store.annotations ?? {}));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
}

async function readSynthCardIds(): Promise<Set<string>> {
  try {
    const raw = await readFile(SYNTH_CARDS_JSONL, 'utf8');
    const ids = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as CardRecord).card.id);
    return new Set(ids);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
}

async function readPendingNamesForRule(ruleLcKey: string): Promise<string[]> {
  if (!existsSync(PENDING_DIR)) return [];
  const all = await readdir(PENDING_DIR);
  return all.filter((n) => n.startsWith(`synth-${ruleLcKey}-`) && n.endsWith('.json'));
}

// Следующий свободный NNN для случая ruleLcKey ('txt05' или 'clean'),
// сканируя pending + синт-store + cards.raw.jsonl.
async function nextNnn(
  ruleLcKey: string,
  storeKeys: ReadonlySet<string>,
  cardIds: ReadonlySet<string>,
): Promise<number> {
  let max = 0;
  const pending = await readPendingNamesForRule(ruleLcKey);
  const fileRe = new RegExp(`^synth-${ruleLcKey}-(\\d{3})\\.json$`);
  for (const n of pending) {
    const m = n.match(fileRe);
    if (m?.[1]) max = Math.max(max, parseInt(m[1], 10));
  }
  const idRe = new RegExp(`^synth_${ruleLcKey}_(\\d{3})$`);
  const allIds = [...storeKeys, ...cardIds];
  for (const id of allIds) {
    const m = id.match(idRe);
    if (m?.[1]) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

const HELP_INSTRUCTION = `Читай ${PROMPT_PATH}.`;

function buildPending(
  caseId: string,
  ruleId: string | null,
  severity: Severity | null,
  targetClean: boolean,
  topic: Topic,
): SynthPendingFile {
  return {
    case_id: caseId,
    kind: 'synthetic_pending',
    target_rule_id: ruleId,
    target_severity: severity,
    target_clean: targetClean,
    topic_hint: topic,
    card: null,
    violations: [],
    annotator: null,
    annotated_at: null,
    _help: {
      prompt_path: PROMPT_PATH,
      rules_path: 'datasets/text_rules.compact.json',
      schema_path: 'datasets/schema/product_card.schema.json',
      instruction: HELP_INSTRUCTION,
    },
  };
}

interface PlanItem {
  ruleLcKey: string; // 'txt05' or 'clean'
  ruleId: string | null;
  severity: Severity | null;
  targetClean: boolean;
  count: number;
}

async function buildPlan(args: CliArgs, rules: readonly CompactRule[]): Promise<PlanItem[]> {
  const ruleById = new Map(rules.map((r) => [r.id, r] as const));
  const plan: PlanItem[] = [];

  if (args.rule && args.count) {
    const r = ruleById.get(args.rule);
    if (!r) bail(`[scaffold] правило ${args.rule} нет в text_rules.compact.json`);
    plan.push({
      ruleLcKey: ruleLc(args.rule),
      ruleId: args.rule,
      severity: r.severity,
      targetClean: false,
      count: args.count,
    });
  } else if (args.rule || args.count) {
    bail('[scaffold] --rule и --count указываются совместно');
  }

  if (args.fromAudit) {
    const rows = await computeAudit();
    const rowsWithDelta = rows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta);
    let allocated = 0;
    for (const row of rowsWithDelta) {
      let take = row.delta;
      if (args.max !== null) {
        const room = args.max - allocated;
        if (room <= 0) break;
        take = Math.min(take, room);
      }
      plan.push({
        ruleLcKey: ruleLc(row.rule_id),
        ruleId: row.rule_id,
        severity: row.severity,
        targetClean: false,
        count: take,
      });
      allocated += take;
    }
  }

  if (args.cleanControl !== null) {
    plan.push({
      ruleLcKey: 'clean',
      ruleId: null,
      severity: null,
      targetClean: true,
      count: args.cleanControl,
    });
  }

  if (plan.length === 0) {
    bail('[scaffold] требуется указать --rule + --count, --from-audit или --clean-control');
  }
  return plan;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const rules = await readRules();
  const plan = await buildPlan(args, rules);

  await mkdir(PENDING_DIR, { recursive: true });

  const storeKeys = await readSynthStoreKeys();
  const cardIds = await readSynthCardIds();

  let topicCursor = 0;
  function nextTopic(): Topic {
    if (args.topic) return args.topic;
    const topic = TOPICS[topicCursor % TOPICS.length] as Topic;
    topicCursor += 1;
    return topic;
  }

  let createdTotal = 0;
  let skippedExisting = 0;

  for (const item of plan) {
    let nnn = await nextNnn(item.ruleLcKey, storeKeys, cardIds);
    let createdHere = 0;
    for (let i = 0; i < item.count; i += 1) {
      const nnnStr = String(nnn).padStart(3, '0');
      const fileName = `synth-${item.ruleLcKey}-${nnnStr}.json`;
      const caseId = `synth_${item.ruleLcKey}_${nnnStr}`;
      const target = join(PENDING_DIR, fileName);
      if (existsSync(target)) {
        skippedExisting += 1;
        nnn += 1;
        continue;
      }
      const pending = buildPending(caseId, item.ruleId, item.severity, item.targetClean, nextTopic());
      await writeFile(target, JSON.stringify(pending, null, 2) + '\n', 'utf8');
      createdHere += 1;
      createdTotal += 1;
      nnn += 1;
    }
    const label = item.ruleId ?? '<clean-control>';
    console.log(`[scaffold] ${label}: создано ${createdHere}/${item.count}`);
  }

  console.log(
    `[scaffold] итого: created=${createdTotal}, skipped_existing=${skippedExisting}`,
  );
  if (createdTotal > 0) {
    console.log(`[scaffold] заполни pending-файлы по ${PROMPT_PATH} и запусти \`pnpm synth:commit\``);
  }
}

main().catch((err) => {
  console.error('[scaffold] failure:', err);
  process.exit(1);
});
