// Универсальный валидатор JSONL для cards.raw.jsonl.
// Прошедшие схему остаются в cards.raw.jsonl, провалившиеся — переезжают
// в cards.rejected.jsonl с полем _validation_errors. Атомарная запись
// через tmp + rename.

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatAjvErrors, validateProductCard } from './lib/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');

function parseArgs(): { source: string | null } {
  let source: string | null = null;
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--source=(.+)$/);
    if (m?.[1]) source = m[1];
  }
  return { source };
}

async function findSources(onlySource: string | null): Promise<string[]> {
  if (onlySource) return [onlySource];
  const entries = await readdir(DATASETS_DIR, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'images' || e.name === 'schema') continue;
    const path = join(DATASETS_DIR, e.name, 'cards.raw.jsonl');
    if (existsSync(path)) out.push(e.name);
  }
  return out;
}

interface CardRecord {
  card: unknown;
  _meta?: unknown;
}

async function validateSource(source: string): Promise<{
  total: number;
  passed: number;
  rejected: number;
}> {
  const inPath = join(DATASETS_DIR, source, 'cards.raw.jsonl');
  const rejectedPath = join(DATASETS_DIR, source, 'cards.rejected.jsonl');
  const raw = await readFile(inPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  const passed: string[] = [];
  const rejected: string[] = [];

  for (const line of lines) {
    let parsed: CardRecord;
    try {
      parsed = JSON.parse(line) as CardRecord;
    } catch (err) {
      rejected.push(
        JSON.stringify({
          _raw: line.slice(0, 500),
          _validation_errors: [
            { type: 'json-parse', message: (err as Error).message },
          ],
        }),
      );
      continue;
    }

    const result = await validateProductCard(parsed.card);
    if (result.ok) {
      passed.push(line);
    } else {
      const asObject =
        typeof parsed === 'object' && parsed !== null ? parsed : { card: parsed };
      rejected.push(
        JSON.stringify({
          ...asObject,
          _validation_errors: result.errors,
        }),
      );
      console.warn(
        `[validate] ${source}: reject — ${formatAjvErrors(result.errors)}`,
      );
    }
  }

  const inTmp = inPath + '.tmp';
  const rejTmp = rejectedPath + '.tmp';
  await writeFile(inTmp, passed.length > 0 ? passed.join('\n') + '\n' : '', 'utf8');
  await rename(inTmp, inPath);
  if (rejected.length > 0) {
    await writeFile(rejTmp, rejected.join('\n') + '\n', 'utf8');
    await rename(rejTmp, rejectedPath);
  }

  console.log(
    `[validate] ${source}: total=${lines.length}, passed=${passed.length}, rejected=${rejected.length}`,
  );
  return { total: lines.length, passed: passed.length, rejected: rejected.length };
}

async function main(): Promise<void> {
  const { source: onlySource } = parseArgs();
  const sources = await findSources(onlySource);
  if (sources.length === 0) {
    console.log('[validate] нет источников с cards.raw.jsonl');
    return;
  }
  const totals = { total: 0, passed: 0, rejected: 0 };
  for (const s of sources) {
    const r = await validateSource(s);
    totals.total += r.total;
    totals.passed += r.passed;
    totals.rejected += r.rejected;
  }
  console.log(
    `[validate] итого: total=${totals.total}, passed=${totals.passed}, rejected=${totals.rejected}`,
  );
  if (totals.rejected > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[validate] failure:', err);
  process.exit(1);
});
