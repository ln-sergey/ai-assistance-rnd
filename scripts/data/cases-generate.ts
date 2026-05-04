// Материализатор card_case-файлов из cards.raw.jsonl + datasets/annotations/<source>.json.
//
// Логика:
//   1) собираем все source из datasets/sources.config.json
//   2) для каждого source читаем cards.raw.jsonl + annotations/<source>.json
//   3) для каждой карточки с записью в annotations — материализуем card_case
//        - real:      datasets/cases/real-{clean,dirty}/<case_id>.json
//        - synthetic: datasets/cases/synthetic-{clean,dirty}/<case_id>.json
//      Image-разметка прокидывается опционально: expected_image_clean (boolean
//      или null) и expected_image_violations[]. Если в annotation поля нет —
//      кейс получает expected_image_clean: null, expected_image_violations: [].
//   4) карточки без annotations — pending (репортим в конце)
//   5) classification (Р9 ТЗ Sprint P6): кейс dirty если
//        expected_clean === false ИЛИ expected_image_clean === false.
//      expected_image_clean === null не делает кейс dirty (не размечено).
//   6) защита от рассинхрона: если карточка переехала clean↔dirty, удаляем
//      её файл из противоположной директории.
//   7) идемпотентность: если новый JSON совпадает с существующим — не
//      перезаписываем (mtime неизменённых кейсов остаётся прежним).

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSourcesConfig, sourceKind } from '../parse/lib/config.js';
import type { SourceKind } from '../parse/lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const ANNOTATIONS_DIR = join(DATASETS_DIR, 'annotations');
const CASES_DIR = join(DATASETS_DIR, 'cases');

const TODAY = new Date().toISOString().slice(0, 10);

type Severity = 'low' | 'medium' | 'high' | 'critical';

interface Violation {
  rule_id: string;
  severity: Severity;
  field_path: string;
  quote: string | null;
  rationale: string;
}

interface ImageViolation {
  rule_id: string;
  severity: Severity;
  image_id: string;
  evidence: string;
  rationale: string;
  field_path?: string;
}

interface Annotation {
  expected_clean: boolean;
  violations: Violation[];
  notes: string | null;
  annotated_at: string;
  annotator: string;
  expected_image_clean?: boolean | null;
  image_violations?: ImageViolation[];
}

interface AnnotationStore {
  version: 1;
  annotations: Record<string, Annotation>;
}

interface SynthMeta {
  generator_model?: string | null;
  prompt_version?: string | null;
}

interface CardRecord {
  card: Record<string, unknown> & { id: string };
  _meta?: SynthMeta;
}

type CaseSource = 'production' | 'synthetic';

interface Generator {
  model: string | null;
  prompt_version: string | null;
  date: string;
}

interface CardCase {
  case_id: string;
  kind: 'card_case';
  source: CaseSource;
  generator: Generator;
  card: Record<string, unknown>;
  expected_violations: Violation[];
  expected_clean: boolean;
  expected_image_clean: boolean | null;
  expected_image_violations: ImageViolation[];
  notes: string | null;
}

interface DirSet {
  clean: string;
  dirty: string;
}

const REAL_DIRS: DirSet = {
  clean: join(CASES_DIR, 'real-clean'),
  dirty: join(CASES_DIR, 'real-dirty'),
};
const SYNTH_DIRS: DirSet = {
  clean: join(CASES_DIR, 'synthetic-clean'),
  dirty: join(CASES_DIR, 'synthetic-dirty'),
};

function dirsForKind(kind: SourceKind): DirSet {
  return kind === 'synthetic' ? SYNTH_DIRS : REAL_DIRS;
}

function caseSourceForKind(kind: SourceKind): CaseSource {
  return kind === 'synthetic' ? 'synthetic' : 'production';
}

async function readJsonl(path: string): Promise<CardRecord[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CardRecord);
}

async function readAnnotations(path: string): Promise<AnnotationStore | null> {
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

function buildCase(
  rec: CardRecord,
  ann: Annotation,
  kind: SourceKind,
): CardCase {
  const generator: Generator =
    kind === 'synthetic'
      ? {
          model: rec._meta?.generator_model ?? null,
          prompt_version: rec._meta?.prompt_version ?? null,
          date: TODAY,
        }
      : { model: null, prompt_version: null, date: TODAY };
  const expectedImageClean =
    ann.expected_image_clean === undefined ? null : ann.expected_image_clean;
  const expectedImageViolations = ann.image_violations ?? [];
  return {
    case_id: rec.card.id,
    kind: 'card_case',
    source: caseSourceForKind(kind),
    generator,
    card: rec.card,
    expected_violations: ann.violations,
    expected_clean: ann.expected_clean,
    expected_image_clean: expectedImageClean,
    expected_image_violations: expectedImageViolations,
    notes: ann.notes,
  };
}

// Идемпотентность: пишем только если payload отличается от того, что
// сейчас на диске. Иначе mtime неизменённых кейсов оставляем прежним —
// это важно для последующих инкрементальных пайплайнов и diff'ов.
async function writeIfChanged(path: string, payload: string): Promise<boolean> {
  try {
    const existing = await readFile(path, 'utf8');
    if (existing === payload) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await writeFile(path, payload, 'utf8');
  return true;
}

async function main(): Promise<void> {
  await mkdir(REAL_DIRS.clean, { recursive: true });
  await mkdir(REAL_DIRS.dirty, { recursive: true });
  await mkdir(SYNTH_DIRS.clean, { recursive: true });
  await mkdir(SYNTH_DIRS.dirty, { recursive: true });

  const cfg = await loadSourcesConfig();
  const sources = Object.keys(cfg.sources).sort();

  let totalWritten = 0;
  let totalUnchanged = 0;
  let totalClean = 0;
  let totalDirty = 0;
  const pending: string[] = [];

  for (const source of sources) {
    const entry = cfg.sources[source];
    if (!entry) continue;
    const kind = sourceKind(entry);
    const dirs = dirsForKind(kind);

    const cardsPath = join(DATASETS_DIR, source, 'cards.raw.jsonl');
    const annotationsPath = join(ANNOTATIONS_DIR, `${source}.json`);
    let cards: CardRecord[];
    try {
      cards = await readJsonl(cardsPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Synthetic-источник до первого synth:commit может не иметь файла —
        // это не ошибка.
        continue;
      }
      throw err;
    }
    const cardIds = new Set(cards.map((r) => r.card.id));

    const store = await readAnnotations(annotationsPath);
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
      const c = buildCase(rec, ann, kind);
      // classification по правилу Р9 (Sprint P6): кейс dirty, если хотя бы
      // одна из разметок (текст или фото) помечена как нарушение.
      const isDirty = !c.expected_clean || c.expected_image_clean === false;
      const targetDir = isDirty ? dirs.dirty : dirs.clean;
      const oppositeDir = isDirty ? dirs.clean : dirs.dirty;
      const targetPath = join(targetDir, `${id}.json`);
      const oppositePath = join(oppositeDir, `${id}.json`);
      await rmIfExists(oppositePath);
      const payload = JSON.stringify(c, null, 2) + '\n';
      const changed = await writeIfChanged(targetPath, payload);
      if (changed) totalWritten += 1;
      else totalUnchanged += 1;
      if (isDirty) totalDirty += 1;
      else totalClean += 1;
    }
  }

  console.log(
    `[generate] written=${totalWritten}, unchanged=${totalUnchanged}, clean=${totalClean}, dirty=${totalDirty}`,
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
