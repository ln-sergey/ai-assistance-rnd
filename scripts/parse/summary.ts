// Печатает таблицу покрытия полей по всем источникам и общий счётчик.
// Дублирует вывод в reports/parse-<YYYY-MM-DD>.md.

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const REPORTS_DIR = join(REPO_ROOT, 'reports');

const FIELD_PATHS: Array<{ label: string; probe: (card: Card) => boolean }> = [
  { label: 'title', probe: (c) => !!c.title && c.title.trim().length > 0 },
  { label: 'short_description', probe: (c) => !!c.short_description && c.short_description.trim().length > 0 },
  { label: 'full_description', probe: (c) => !!c.full_description && c.full_description.trim().length > 0 },
  { label: 'program_items', probe: (c) => Array.isArray(c.program_items) && c.program_items.length > 0 },
  { label: 'services', probe: (c) => Array.isArray(c.services) && c.services.length > 0 },
  { label: 'location.address', probe: (c) => !!c.location?.address && c.location.address.trim().length > 0 },
  { label: 'location.meeting', probe: (c) => !!c.location?.meeting_point_comment && c.location.meeting_point_comment.trim().length > 0 },
  { label: 'contacts_block', probe: (c) => !!c.contacts_block?.public_comment && c.contacts_block.public_comment.trim().length > 0 },
  { label: 'schedule.dates', probe: (c) => Array.isArray(c.schedule?.dates) && (c.schedule.dates?.length ?? 0) > 0 },
  { label: 'duration_min', probe: (c) => typeof c.schedule?.duration_minutes === 'number' },
  { label: 'age_restriction', probe: (c) => typeof c.age_restriction === 'string' && c.age_restriction.length > 0 },
  { label: 'group_size', probe: (c) => !!c.group_size && (c.group_size.min !== undefined || c.group_size.max !== undefined) },
  { label: 'languages', probe: (c) => Array.isArray(c.languages) && c.languages.length > 0 },
  { label: 'images', probe: (c) => Array.isArray(c.images) && c.images.length > 0 },
];

interface Card {
  title?: string;
  short_description?: string;
  full_description?: string;
  program_items?: unknown[];
  services?: unknown[];
  location?: { address?: string; meeting_point_comment?: string };
  contacts_block?: { public_comment?: string };
  schedule?: { format?: string; dates?: string[]; duration_minutes?: number };
  age_restriction?: string | null;
  group_size?: { min?: number; max?: number } | null;
  languages?: string[];
  images?: unknown[];
}

interface SourceStats {
  source: string;
  total: number;
  passed: number;
  rejected: number;
  images: number;
  fieldCoverage: Map<string, number>;
}

async function findSources(): Promise<string[]> {
  const entries = await readdir(DATASETS_DIR, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'images' || e.name === 'schema') continue;
    const path = join(DATASETS_DIR, e.name, 'cards.raw.jsonl');
    if (existsSync(path)) out.push(e.name);
  }
  return out.sort();
}

async function countLines(path: string): Promise<number> {
  if (!existsSync(path)) return 0;
  const raw = await readFile(path, 'utf8');
  return raw.split('\n').filter((l) => l.trim().length > 0).length;
}

async function collectStats(source: string): Promise<SourceStats> {
  const cardsPath = join(DATASETS_DIR, source, 'cards.raw.jsonl');
  const rejectedPath = join(DATASETS_DIR, source, 'cards.rejected.jsonl');
  const imagesPath = join(DATASETS_DIR, source, 'images.raw.jsonl');

  const passed = await countLines(cardsPath);
  const rejected = await countLines(rejectedPath);
  const imagesCount = await countLines(imagesPath);

  const fieldCoverage = new Map<string, number>();
  for (const f of FIELD_PATHS) fieldCoverage.set(f.label, 0);

  if (existsSync(cardsPath)) {
    const raw = await readFile(cardsPath, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as { card?: Card };
        const card = rec.card;
        if (!card) continue;
        for (const f of FIELD_PATHS) {
          if (f.probe(card)) {
            fieldCoverage.set(f.label, (fieldCoverage.get(f.label) ?? 0) + 1);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return {
    source,
    total: passed + rejected,
    passed,
    rejected,
    images: imagesCount,
    fieldCoverage,
  };
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}
function padLeft(s: string, len: number): string {
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

function renderTotals(stats: SourceStats[]): string {
  const nameW = Math.max(14, ...stats.map((s) => s.source.length));
  const cols = ['Источник', 'Карточек', 'Прошли', 'Rejected', 'Изображений', 'Полей (/ 14)'];
  const rows: string[] = [];
  rows.push(
    [
      padRight(cols[0]!, nameW),
      padLeft(cols[1]!, 9),
      padLeft(cols[2]!, 7),
      padLeft(cols[3]!, 9),
      padLeft(cols[4]!, 12),
      padLeft(cols[5]!, 14),
    ].join('  '),
  );
  rows.push('-'.repeat(nameW + 9 + 7 + 9 + 12 + 14 + 5 * 2));

  const aggregate = {
    total: 0,
    passed: 0,
    rejected: 0,
    images: 0,
  };

  for (const s of stats) {
    const avgFields =
      s.passed === 0
        ? 0
        : [...s.fieldCoverage.values()].reduce((a, b) => a + b, 0) / s.passed;
    rows.push(
      [
        padRight(s.source, nameW),
        padLeft(String(s.total), 9),
        padLeft(String(s.passed), 7),
        padLeft(String(s.rejected), 9),
        padLeft(String(s.images), 12),
        padLeft(avgFields.toFixed(1), 14),
      ].join('  '),
    );
    aggregate.total += s.total;
    aggregate.passed += s.passed;
    aggregate.rejected += s.rejected;
    aggregate.images += s.images;
  }

  rows.push('-'.repeat(nameW + 9 + 7 + 9 + 12 + 14 + 5 * 2));
  rows.push(
    [
      padRight('итого', nameW),
      padLeft(String(aggregate.total), 9),
      padLeft(String(aggregate.passed), 7),
      padLeft(String(aggregate.rejected), 9),
      padLeft(String(aggregate.images), 12),
      padLeft('', 14),
    ].join('  '),
  );
  return rows.join('\n');
}

function renderFieldCoverage(stats: SourceStats[]): string {
  const labelW = Math.max(
    20,
    ...FIELD_PATHS.map((f) => f.label.length),
  );
  const nameW = Math.max(10, ...stats.map((s) => s.source.length));
  const header =
    padRight('', labelW) +
    '  ' +
    stats.map((s) => padLeft(s.source, nameW)).join('  ');
  const rows: string[] = [header];
  for (const f of FIELD_PATHS) {
    const cells = stats.map((s) => {
      if (s.passed === 0) return padLeft('—', nameW);
      const n = s.fieldCoverage.get(f.label) ?? 0;
      const pct = Math.round((n / s.passed) * 100);
      return padLeft(`${pct}%`, nameW);
    });
    rows.push(padRight(f.label, labelW) + '  ' + cells.join('  '));
  }
  return rows.join('\n');
}

function today(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main(): Promise<void> {
  const sources = await findSources();
  if (sources.length === 0) {
    console.log('[summary] нет источников для отчёта');
    return;
  }
  const stats: SourceStats[] = [];
  for (const s of sources) stats.push(await collectStats(s));

  const totalsBlock = renderTotals(stats);
  const coverageBlock = renderFieldCoverage(stats);

  const text = [
    'Parse summary',
    `date: ${today()}`,
    '',
    totalsBlock,
    '',
    'Покрытие полей по источнику (доля карточек с непустым полем):',
    '',
    coverageBlock,
    '',
  ].join('\n');

  console.log(text);

  await mkdir(REPORTS_DIR, { recursive: true });
  const outPath = join(REPORTS_DIR, `parse-${today()}.md`);
  const md = [
    `# Parse summary — ${today()}`,
    '',
    '```',
    totalsBlock,
    '```',
    '',
    '## Покрытие полей',
    '',
    '```',
    coverageBlock,
    '```',
    '',
  ].join('\n');
  await writeFile(outPath, md, 'utf8');
  console.log(`[summary] записано ${outPath}`);
}

main().catch((err) => {
  console.error('[summary] failure:', err);
  process.exit(1);
});
