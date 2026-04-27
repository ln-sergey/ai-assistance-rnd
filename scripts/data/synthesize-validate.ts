// Проверка натуральности synthetic-карточек до коммита большой партии.
// Без сетевых вызовов: всё локально, по pending'ам и/или коммитнутому
// синт-store.
//
// API-вызовы к целевым провайдерам и эталонным AI запрещены для
// подготовки/валидации тестовых данных (см. AGENTS.md / docs/tz-
// synthetic-cards.md, hard rule). Blind re-annotation выполняется
// отдельным workflow в локальной сессии (Р8 ТЗ).
//
// Метрики:
//   1. Длины полей title / short_description / full_description —
//      пороги вычисляются как 5-95 перцентиль распределения по
//      datasets/cases/real-{clean,dirty}/. Поле вне диапазона = warning.
//   2. Чёрный список паттернов из datasets/synthetic-blocklist.txt
//      (regex, флаги /iu) применяется ко всем строковым полям карточки
//      рекурсивно. Любое срабатывание = error.
//   3. Разнообразие тематик: уникальность ключа topic_hint
//      (или продукта product_type + первые 3 слова title в lc-форме);
//      < 40 % уникальных в партии = warning.
//   4. Near-дубликаты: Jaccard-сходство по 5-граммам слов
//      full_description; > 0.7 = warning на каждой паре.
//
// Использование:
//   pnpm synth:validate                       # scope=all
//   pnpm synth:validate -- --scope=pending    # только заполненные pending'и
//   pnpm synth:validate -- --scope=committed  # только коммитнутый store
//   pnpm synth:validate -- --warn-only        # errors → warnings (exit 0)

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const PENDING_DIR = join(DATASETS_DIR, 'annotations', 'pending');
const SYNTH_CARDS_JSONL = join(DATASETS_DIR, 'synthetic', 'cards.raw.jsonl');
const REAL_CLEAN = join(DATASETS_DIR, 'cases', 'real-clean');
const REAL_DIRTY = join(DATASETS_DIR, 'cases', 'real-dirty');
const BLOCKLIST_PATH = join(DATASETS_DIR, 'synthetic-blocklist.txt');

const FIELDS_FOR_LENGTH = ['title', 'short_description', 'full_description'] as const;
type LengthField = (typeof FIELDS_FOR_LENGTH)[number];

const DIVERSITY_THRESHOLD = 0.4;
const JACCARD_THRESHOLD = 0.7;
const SHINGLE_SIZE = 5;

type Scope = 'pending' | 'committed' | 'all';

interface CliArgs {
  scope: Scope;
  warnOnly: boolean;
}

interface ProductCard {
  id: string;
  product_type: string;
  title: string;
  short_description: string;
  full_description: string;
  [k: string]: unknown;
}

interface SynthItem {
  case_id: string;
  origin: 'pending' | 'committed';
  card: ProductCard;
  topic_hint: string | null;
}

interface RealCase {
  card: ProductCard;
}

interface PendingFile {
  case_id?: unknown;
  topic_hint?: unknown;
  card?: unknown;
}

interface SynthCardRecord {
  card: ProductCard;
  _meta?: { topic_hint?: string | null };
}

interface Bounds {
  min: number;
  max: number;
}

type FieldBounds = Record<LengthField, Bounds>;

interface ItemIssue {
  level: 'error' | 'warning';
  message: string;
}

interface ItemReport {
  case_id: string;
  origin: 'pending' | 'committed';
  issues: ItemIssue[];
}

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
  let scope: Scope = 'all';
  let warnOnly = false;
  for (const a of argv) {
    if (a === '--warn-only') {
      warnOnly = true;
      continue;
    }
    const m = a.match(/^--scope=(pending|committed|all)$/);
    if (m?.[1]) {
      scope = m[1] as Scope;
      continue;
    }
    bail(`[validate] неизвестный аргумент: ${a}`);
  }
  return { scope, warnOnly };
}

async function readJsonDir(dir: string): Promise<RealCase[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: RealCase[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const raw = await readFile(join(dir, name), 'utf8');
    out.push(JSON.parse(raw) as RealCase);
  }
  return out;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx] ?? 0;
}

async function computeFieldBounds(): Promise<FieldBounds> {
  const realCases = [
    ...(await readJsonDir(REAL_CLEAN)),
    ...(await readJsonDir(REAL_DIRTY)),
  ];
  if (realCases.length === 0) {
    bail(
      '[validate] datasets/cases/real-* пусто — нет базы для расчёта 5-95 перцентилей. ' +
        'Запусти pnpm cases:generate.',
    );
  }
  const bounds = {} as FieldBounds;
  for (const f of FIELDS_FOR_LENGTH) {
    const lengths = realCases
      .map((r) => (typeof r.card[f] === 'string' ? (r.card[f] as string).length : 0))
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    bounds[f] = {
      min: percentile(lengths, 0.05),
      max: percentile(lengths, 0.95),
    };
  }
  return bounds;
}

async function loadPendingItems(): Promise<SynthItem[]> {
  if (!existsSync(PENDING_DIR)) return [];
  const names = (await readdir(PENDING_DIR))
    .filter((n) => n.startsWith('synth-') && n.endsWith('.json'))
    .sort();
  const out: SynthItem[] = [];
  for (const name of names) {
    const raw = await readFile(join(PENDING_DIR, name), 'utf8');
    const doc = JSON.parse(raw) as PendingFile;
    if (doc.card === null || doc.card === undefined) continue;
    if (typeof doc.case_id !== 'string') continue;
    out.push({
      case_id: doc.case_id,
      origin: 'pending',
      card: doc.card as ProductCard,
      topic_hint: typeof doc.topic_hint === 'string' ? doc.topic_hint : null,
    });
  }
  return out;
}

async function loadCommittedItems(): Promise<SynthItem[]> {
  try {
    const raw = await readFile(SYNTH_CARDS_JSONL, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as SynthCardRecord)
      .map((rec) => ({
        case_id: rec.card.id,
        origin: 'committed' as const,
        card: rec.card,
        topic_hint:
          typeof rec._meta?.topic_hint === 'string' ? rec._meta.topic_hint : null,
      }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function loadSynthItems(scope: Scope): Promise<SynthItem[]> {
  const items: SynthItem[] = [];
  if (scope === 'pending' || scope === 'all') items.push(...(await loadPendingItems()));
  if (scope === 'committed' || scope === 'all')
    items.push(...(await loadCommittedItems()));
  return items;
}

async function loadBlocklist(): Promise<RegExp[]> {
  let raw: string;
  try {
    raw = await readFile(BLOCKLIST_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: RegExp[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    try {
      out.push(new RegExp(trimmed, 'iu'));
    } catch (err) {
      bail(`[validate] невалидная регулярка в blocklist: "${trimmed}" — ${(err as Error).message}`);
    }
  }
  return out;
}

function* allStringFields(
  obj: unknown,
  path = '',
): Generator<{ path: string; text: string }> {
  if (typeof obj === 'string') {
    if (path) yield { path, text: obj };
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i += 1) {
      yield* allStringFields(obj[i], `${path}[${i}]`);
    }
    return;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      yield* allStringFields(v, path ? `${path}.${k}` : k);
    }
  }
}

function checkLengths(item: SynthItem, bounds: FieldBounds): ItemIssue[] {
  const issues: ItemIssue[] = [];
  for (const f of FIELDS_FOR_LENGTH) {
    const v = item.card[f];
    if (typeof v !== 'string') continue;
    const len = v.length;
    const b = bounds[f];
    if (len < b.min || len > b.max) {
      issues.push({
        level: 'warning',
        message: `${f}: length=${len} вне real-диапазона [${b.min}..${b.max}]`,
      });
    }
  }
  return issues;
}

function checkBlocklist(item: SynthItem, blocklist: readonly RegExp[]): ItemIssue[] {
  const issues: ItemIssue[] = [];
  for (const { path, text } of allStringFields(item.card)) {
    for (const re of blocklist) {
      const m = text.match(re);
      if (m) {
        issues.push({
          level: 'error',
          message: `blocklist: ${path} содержит "${m[0]}" (паттерн ${re.source})`,
        });
      }
    }
  }
  return issues;
}

function topicKey(item: SynthItem): string {
  if (item.topic_hint) return item.topic_hint.toLowerCase().trim();
  const titlePrefix = item.card.title
    .toLowerCase()
    .split(/\s+/)
    .slice(0, 3)
    .join(' ');
  return `${item.card.product_type}:${titlePrefix}`;
}

interface DiversityResult {
  unique: number;
  total: number;
  ratio: number;
  warning: string | null;
}

function checkDiversity(items: readonly SynthItem[]): DiversityResult {
  if (items.length < 5) {
    return { unique: items.length, total: items.length, ratio: 1, warning: null };
  }
  const keys = new Set(items.map((i) => topicKey(i)));
  const ratio = keys.size / items.length;
  const warning =
    ratio < DIVERSITY_THRESHOLD
      ? `< ${(DIVERSITY_THRESHOLD * 100).toFixed(0)} % уникальных тематик: ${keys.size}/${items.length} (${(ratio * 100).toFixed(0)} %)`
      : null;
  return { unique: keys.size, total: items.length, ratio, warning };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function shingles(tokens: readonly string[], k: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + k <= tokens.length; i += 1) {
    out.add(tokens.slice(i, i + k).join(' '));
  }
  return out;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

interface DupPair {
  a: string;
  b: string;
  similarity: number;
}

function checkDuplicates(items: readonly SynthItem[]): DupPair[] {
  if (items.length < 2) return [];
  const sigs = items.map((it) => ({
    case_id: it.case_id,
    set: shingles(tokenize(it.card.full_description), SHINGLE_SIZE),
  }));
  const out: DupPair[] = [];
  for (let i = 0; i < sigs.length; i += 1) {
    for (let j = i + 1; j < sigs.length; j += 1) {
      const a = sigs[i];
      const b = sigs[j];
      if (!a || !b) continue;
      const s = jaccard(a.set, b.set);
      if (s > JACCARD_THRESHOLD) {
        out.push({ a: a.case_id, b: b.case_id, similarity: s });
      }
    }
  }
  return out;
}

function applyWarnOnly(reports: ItemReport[]): void {
  for (const r of reports) {
    for (const issue of r.issues) {
      if (issue.level === 'error') issue.level = 'warning';
    }
  }
}

function printReport(
  bounds: FieldBounds,
  reports: readonly ItemReport[],
  diversity: DiversityResult,
  duplicates: readonly DupPair[],
  warnOnly: boolean,
): { errors: number; warnings: number } {
  console.log(
    `[validate] real-перцентили (5..95): ` +
      FIELDS_FOR_LENGTH.map((f) => `${f}=${bounds[f].min}..${bounds[f].max}`).join(', '),
  );

  if (reports.length === 0) {
    console.log('[validate] synth-карточек нет — проверка пропущена');
    return { errors: 0, warnings: 0 };
  }

  let errs = 0;
  let warns = 0;
  for (const r of reports) {
    if (r.issues.length === 0) {
      console.log(`[ok]   ${r.case_id} (${r.origin})`);
      continue;
    }
    for (const issue of r.issues) {
      const tag = issue.level === 'error' ? '[ERR]' : '[warn]';
      console.log(`${tag} ${r.case_id}: ${issue.message}`);
      if (issue.level === 'error') errs += 1;
      else warns += 1;
    }
  }

  if (diversity.warning) {
    console.log(`[warn] diversity: ${diversity.warning}`);
    warns += 1;
  } else {
    console.log(
      `[ok]   diversity: ${diversity.unique}/${diversity.total} уникальных тематик (${(diversity.ratio * 100).toFixed(0)} %)`,
    );
  }

  if (duplicates.length > 0) {
    for (const d of duplicates) {
      console.log(
        `[warn] near-duplicate: ${d.a} ↔ ${d.b}, jaccard=${d.similarity.toFixed(2)}`,
      );
    }
    warns += duplicates.length;
  } else {
    console.log('[ok]   near-duplicates: нет пар с jaccard > ' + JACCARD_THRESHOLD);
  }

  console.log(
    `[validate] всего: items=${reports.length}, errors=${errs}, warnings=${warns}` +
      (warnOnly ? ' (warn-only)' : ''),
  );
  return { errors: errs, warnings: warns };
}

async function main(): Promise<void> {
  const args = parseArgs();

  const bounds = await computeFieldBounds();
  const items = await loadSynthItems(args.scope);
  const blocklist = await loadBlocklist();

  const reports: ItemReport[] = items.map((item) => ({
    case_id: item.case_id,
    origin: item.origin,
    issues: [...checkLengths(item, bounds), ...checkBlocklist(item, blocklist)],
  }));

  if (args.warnOnly) applyWarnOnly(reports);

  const diversity = checkDiversity(items);
  const duplicates = checkDuplicates(items);

  const { errors } = printReport(bounds, reports, diversity, duplicates, args.warnOnly);

  if (errors > 0 && !args.warnOnly) process.exit(1);
}

main().catch((err) => {
  console.error('[validate] failure:', err);
  process.exit(1);
});
