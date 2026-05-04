// Печатает что осталось разметить:
//
// Режим text (default, --mode=text):
//   1) для real-источников — case_id'ы из cards.raw.jsonl без записи
//      в datasets/annotations/<source>.json;
//   2) для synthetic — pending-файлы datasets/annotations/pending/synth-*.json,
//      сгруппированные по target_rule_id.
//
// Режим images (--mode=images):
//   Только real-источники. Карточка попадает в pending list, если у неё
//   card.images.length > 0 и в annotations[<source>.json][<card_id>] поле
//   expected_image_clean отсутствует или равно null. Карточки без фото
//   image-разметки не требуют — не показываются. Также печатает
//   существующие pending-файлы datasets/annotations/pending/*.images.json
//   (отдельные от текстовых *.json — см. дизайн-doc Этапа 0).
//
// Использование:
//   pnpm annotations:list
//   pnpm annotations:list -- --source=afisha
//   pnpm annotations:list -- --json
//   pnpm annotations:list:images
//   pnpm annotations:list:images -- --source=sputnik8

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSourcesConfig, realSources } from '../parse/lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const ANNOTATIONS_DIR = join(DATASETS_DIR, 'annotations');
const PENDING_DIR = join(ANNOTATIONS_DIR, 'pending');

type Mode = 'text' | 'images';

interface CliArgs {
  source: string | null;
  json: boolean;
  mode: Mode;
}

interface PendingItem {
  case_id: string;
  source: string;
}

interface SynthPendingItem {
  case_id: string;
  target_rule_id: string;
  filled: boolean;
}

interface ImagePendingFileItem {
  case_id: string;
  source: string;
  batch_id: string | null;
  filled: boolean;
}

interface CardRecord {
  card: { id: string; images?: unknown };
}

interface AnnotationStore {
  version: 1;
  annotations: Record<string, unknown>;
}

interface SynthPendingFile {
  case_id?: unknown;
  target_rule_id?: unknown;
  card?: unknown;
}

interface ImagePendingFile {
  case_id?: unknown;
  source?: unknown;
  batch_id?: unknown;
  expected_image_clean?: unknown;
  kind?: unknown;
}

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
  let source: string | null = null;
  let json = false;
  let mode: Mode = 'text';
  for (const a of argv) {
    const m = a.match(/^--source=(.+)$/);
    if (m?.[1]) {
      source = m[1];
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    const modeMatch = a.match(/^--mode=(.+)$/);
    if (modeMatch?.[1]) {
      const v = modeMatch[1];
      if (v !== 'text' && v !== 'images') {
        bail(`[list] --mode=${v} не поддерживается (text|images)`);
      }
      mode = v;
      continue;
    }
    bail(`[list] неизвестный аргумент: ${a}`);
  }
  return { source, json, mode };
}

async function readCards(path: string): Promise<CardRecord[]> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as CardRecord);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readAnnotationStore(source: string): Promise<AnnotationStore> {
  const path = join(ANNOTATIONS_DIR, `${source}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as AnnotationStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, annotations: {} };
    }
    throw err;
  }
}

async function readSynthPendings(): Promise<SynthPendingItem[]> {
  if (!existsSync(PENDING_DIR)) return [];
  const names = (await readdir(PENDING_DIR))
    .filter((n) => n.startsWith('synth-') && n.endsWith('.json'))
    .sort();
  const out: SynthPendingItem[] = [];
  for (const name of names) {
    const raw = await readFile(join(PENDING_DIR, name), 'utf8');
    const doc = JSON.parse(raw) as SynthPendingFile;
    const caseId = typeof doc.case_id === 'string' ? doc.case_id : name.replace(/\.json$/, '');
    const ruleId =
      typeof doc.target_rule_id === 'string' ? doc.target_rule_id : '<unknown>';
    out.push({ case_id: caseId, target_rule_id: ruleId, filled: doc.card != null });
  }
  return out;
}

async function readImagePendings(): Promise<ImagePendingFileItem[]> {
  if (!existsSync(PENDING_DIR)) return [];
  const names = (await readdir(PENDING_DIR))
    .filter((n) => n.endsWith('.images.json'))
    .sort();
  const out: ImagePendingFileItem[] = [];
  for (const name of names) {
    const raw = await readFile(join(PENDING_DIR, name), 'utf8');
    const doc = JSON.parse(raw) as ImagePendingFile;
    const caseId =
      typeof doc.case_id === 'string' ? doc.case_id : name.replace(/\.images\.json$/, '');
    const source = typeof doc.source === 'string' ? doc.source : '<unknown>';
    const batchId = typeof doc.batch_id === 'string' ? doc.batch_id : null;
    // filled = агент уже проставил expected_image_clean (true/false).
    const filled =
      typeof doc.expected_image_clean === 'boolean';
    out.push({ case_id: caseId, source, batch_id: batchId, filled });
  }
  return out;
}

function groupSynthByRule(items: readonly SynthPendingItem[]): Map<string, SynthPendingItem[]> {
  const m = new Map<string, SynthPendingItem[]>();
  for (const it of items) {
    const arr = m.get(it.target_rule_id) ?? [];
    arr.push(it);
    m.set(it.target_rule_id, arr);
  }
  return m;
}

function hasImages(card: CardRecord): boolean {
  const imgs = card.card.images;
  return Array.isArray(imgs) && imgs.length > 0;
}

function hasImageAnnotation(record: unknown): boolean {
  if (!record || typeof record !== 'object') return false;
  const v = (record as Record<string, unknown>)['expected_image_clean'];
  return typeof v === 'boolean';
}

async function runText(args: CliArgs): Promise<void> {
  const cfg = await loadSourcesConfig();
  const allReal = realSources(cfg);
  if (args.source && !cfg.sources[args.source]) {
    const known = Object.keys(cfg.sources).join(', ');
    bail(`[list] источник "${args.source}" не найден (известные: ${known})`);
  }

  const realFilter =
    args.source && allReal.includes(args.source) ? [args.source] : allReal;
  const realPending: PendingItem[] = [];
  const perSource: Record<string, string[]> = {};

  if (!args.source || allReal.includes(args.source)) {
    for (const source of realFilter) {
      const cards = await readCards(join(DATASETS_DIR, source, 'cards.raw.jsonl'));
      const store = await readAnnotationStore(source);
      const annotated = new Set(Object.keys(store.annotations ?? {}));
      const missing = cards
        .map((c) => c.card.id)
        .filter((id) => !annotated.has(id))
        .sort();
      perSource[source] = missing;
      for (const id of missing) realPending.push({ case_id: id, source });
    }
  }

  const showSynth = !args.source || args.source === 'synthetic';
  const synthPending = showSynth ? await readSynthPendings() : [];

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ real: realPending, synthetic: synthPending }, null, 2) + '\n',
    );
    return;
  }

  if (!args.source || args.source !== 'synthetic') {
    for (const source of realFilter) {
      const list = perSource[source] ?? [];
      console.log(`[pending real] ${source}: ${list.length}`);
      for (const id of list) console.log(`  ${id}`);
    }
    console.log(`[pending real] всего: ${realPending.length}`);
  }

  if (showSynth) {
    const byRule = groupSynthByRule(synthPending);
    const ruleIds = [...byRule.keys()].sort();
    if (synthPending.length === 0) {
      console.log('[pending synthetic] всего: 0');
    } else {
      const filled = synthPending.filter((p) => p.filled).length;
      const empty = synthPending.length - filled;
      const breakdown = ruleIds
        .map((r) => `${r}: ${byRule.get(r)?.length ?? 0}`)
        .join(', ');
      console.log(`[pending synthetic] ${breakdown} (всего: ${synthPending.length}, заполнено: ${filled}, пусто: ${empty})`);
      for (const r of ruleIds) {
        for (const it of byRule.get(r) ?? []) {
          const mark = it.filled ? '●' : '○';
          console.log(`  ${mark} ${it.case_id}`);
        }
      }
    }
  }
}

async function runImages(args: CliArgs): Promise<void> {
  const cfg = await loadSourcesConfig();
  const allReal = realSources(cfg);
  if (args.source && !allReal.includes(args.source)) {
    bail(
      `[list] image-режим: источник "${args.source}" не real (известные real: ${allReal.join(', ')})`,
    );
  }
  const sources = args.source ? [args.source] : allReal;

  const realPending: PendingItem[] = [];
  const perSource: Record<string, string[]> = {};
  for (const source of sources) {
    const cards = await readCards(join(DATASETS_DIR, source, 'cards.raw.jsonl'));
    const store = await readAnnotationStore(source);
    const annotations = store.annotations ?? {};
    const missing: string[] = [];
    for (const c of cards) {
      if (!hasImages(c)) continue;
      if (hasImageAnnotation(annotations[c.card.id])) continue;
      missing.push(c.card.id);
    }
    missing.sort();
    perSource[source] = missing;
    for (const id of missing) realPending.push({ case_id: id, source });
  }

  const pendingFiles = await readImagePendings();
  const pendingFilesFiltered = args.source
    ? pendingFiles.filter((p) => p.source === args.source)
    : pendingFiles;

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        { mode: 'images', real: realPending, pending_files: pendingFilesFiltered },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  for (const source of sources) {
    const list = perSource[source] ?? [];
    console.log(`[pending images] ${source}: ${list.length}`);
    for (const id of list) console.log(`  ${id}`);
  }
  console.log(`[pending images] всего: ${realPending.length}`);

  if (pendingFilesFiltered.length > 0) {
    const filled = pendingFilesFiltered.filter((p) => p.filled).length;
    const empty = pendingFilesFiltered.length - filled;
    console.log(
      `[pending images files] всего: ${pendingFilesFiltered.length}, заполнено: ${filled}, пусто: ${empty}`,
    );
    for (const it of pendingFilesFiltered) {
      const mark = it.filled ? '●' : '○';
      const batch = it.batch_id ? ` [${it.batch_id}]` : '';
      console.log(`  ${mark} ${it.case_id} (${it.source})${batch}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.mode === 'images') {
    await runImages(args);
  } else {
    await runText(args);
  }
}

main().catch((err) => {
  console.error('[list] failure:', err);
  process.exit(1);
});
