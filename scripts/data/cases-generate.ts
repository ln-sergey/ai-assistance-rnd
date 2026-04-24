// Материализатор card_case-файлов из cards.raw.jsonl + datasets/annotations/<source>.json.
// Заменяет scripts/generate-real-cases.ts: разметка теперь живёт отдельно от кода.
//
// Логика:
//   1) собираем все source из datasets/sources.config.json
//   2) для каждого source читаем cards.raw.jsonl + annotations/<source>.json
//   3) для каждой карточки с записью в annotations — материализуем card_case
//      в datasets/cases/real-{clean,dirty}/<case_id>.json
//   4) карточки без annotations — pending (репортим в конце)
//   5) защита от рассинхрона: если карточка переехала clean↔dirty, удаляем
//      её файл из противоположной директории

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSourcesConfig } from '../parse/lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const ANNOTATIONS_DIR = join(DATASETS_DIR, 'annotations');
const CASES_DIR = join(DATASETS_DIR, 'cases');
const CLEAN_DIR = join(CASES_DIR, 'real-clean');
const DIRTY_DIR = join(CASES_DIR, 'real-dirty');

const TODAY = '2026-04-25';

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

interface CardRecord {
  card: Record<string, unknown> & { id: string };
  _meta?: unknown;
}

interface CardCase {
  case_id: string;
  kind: 'card_case';
  source: 'production';
  generator: { model: null; prompt_version: null; date: string };
  card: Record<string, unknown>;
  expected_violations: Violation[];
  expected_clean: boolean;
  notes: string | null;
}

async function readJsonl(path: string): Promise<CardRecord[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CardRecord);
}

async function readAnnotations(source: string): Promise<AnnotationStore | null> {
  const path = join(ANNOTATIONS_DIR, `${source}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as AnnotationStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function rmIfExists(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

function buildCase(card: Record<string, unknown> & { id: string }, ann: Annotation): CardCase {
  return {
    case_id: card.id,
    kind: 'card_case',
    source: 'production',
    generator: { model: null, prompt_version: null, date: TODAY },
    card,
    expected_violations: ann.violations,
    expected_clean: ann.expected_clean,
    notes: ann.notes,
  };
}

async function main(): Promise<void> {
  await mkdir(CLEAN_DIR, { recursive: true });
  await mkdir(DIRTY_DIR, { recursive: true });

  const cfg = await loadSourcesConfig();
  const sources = Object.keys(cfg.sources).sort();

  let totalWritten = 0;
  let totalClean = 0;
  let totalDirty = 0;
  const pending: string[] = [];

  for (const source of sources) {
    const cards = await readJsonl(join(DATASETS_DIR, source, 'cards.raw.jsonl'));
    const cardIds = new Set(cards.map((r) => r.card.id));

    const store = await readAnnotations(source);
    const annotations = store?.annotations ?? {};

    const orphans = Object.keys(annotations).filter((id) => !cardIds.has(id));
    if (orphans.length > 0) {
      throw new Error(
        `[generate] ${source}: annotations содержит id, отсутствующие в cards.raw.jsonl: ${orphans.join(', ')}`,
      );
    }

    for (const rec of cards) {
      const id = rec.card.id;
      const ann = annotations[id];
      if (!ann) {
        pending.push(id);
        continue;
      }
      const c = buildCase(rec.card, ann);
      const targetDir = c.expected_clean ? CLEAN_DIR : DIRTY_DIR;
      const oppositeDir = c.expected_clean ? DIRTY_DIR : CLEAN_DIR;
      const targetPath = join(targetDir, `${id}.json`);
      const oppositePath = join(oppositeDir, `${id}.json`);
      await rmIfExists(oppositePath);
      await writeFile(targetPath, JSON.stringify(c, null, 2) + '\n', 'utf8');
      totalWritten += 1;
      if (c.expected_clean) totalClean += 1;
      else totalDirty += 1;
    }
  }

  console.log(
    `[generate] written=${totalWritten}, clean=${totalClean}, dirty=${totalDirty}`,
  );
  if (pending.length > 0) {
    const head = pending.slice(0, 5).join(', ');
    const tail = pending.length > 5 ? `, …+${pending.length - 5}` : '';
    console.log(`[generate] pending: ${pending.length} (${head}${tail})`);
  } else {
    console.log('[generate] pending: 0');
  }
}

main().catch((err) => {
  console.error('[generate] failure:', err);
  process.exit(1);
});
