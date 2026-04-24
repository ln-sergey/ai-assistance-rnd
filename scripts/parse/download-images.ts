// Универсальный загрузчик изображений. Читает любой
// datasets/<source>/images.raw.jsonl и складывает файлы в datasets/images/.
// Расширение — по Content-Type; конвертаций нет. Лимит 5 MB на файл.
//
// Идемпотентность: если file_path уже существует (с любым расширением) —
// пропуск.

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { appendFile, readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpClient } from './lib/http.js';
import { extensionFromContentType } from './lib/image-id.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const IMAGES_DIR = join(DATASETS_DIR, 'images');
const MAX_BYTES = 5 * 1024 * 1024;

interface ImageRecord {
  image_id: string;
  linked_card_id: string;
  role: string;
  caption: string | null;
  source_url: string;
  file_path: string;
}

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
    if (!e.isDirectory()) continue;
    if (e.name === 'images' || e.name === 'schema') continue;
    const path = join(DATASETS_DIR, e.name, 'images.raw.jsonl');
    if (existsSync(path)) out.push(e.name);
  }
  return out;
}

async function readImageRecords(path: string): Promise<ImageRecord[]> {
  const raw = await readFile(path, 'utf8');
  const out: ImageRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ImageRecord);
    } catch (err) {
      console.warn(`[download] битая строка: ${(err as Error).message}`);
    }
  }
  return out;
}

function existingFileFor(imageId: string): string | null {
  for (const ext of ['jpg', 'png', 'webp', 'gif']) {
    const candidate = join(IMAGES_DIR, `${imageId}.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function logOversize(source: string, record: ImageRecord, size: number): Promise<void> {
  const file = join(DATASETS_DIR, source, 'images.oversize.txt');
  await appendFile(
    file,
    `${record.image_id}\t${size}\t${record.source_url}\n`,
    'utf8',
  );
}

async function processSource(source: string): Promise<{
  total: number;
  downloaded: number;
  cached: number;
  skipped: number;
  failed: number;
  oversize: number;
}> {
  const imagesJsonl = join(DATASETS_DIR, source, 'images.raw.jsonl');
  const records = await readImageRecords(imagesJsonl);
  const http = new HttpClient({ source, datasetsDir: DATASETS_DIR });
  await mkdir(IMAGES_DIR, { recursive: true });

  const stats = { total: records.length, downloaded: 0, cached: 0, skipped: 0, failed: 0, oversize: 0 };

  for (const record of records) {
    const existing = existingFileFor(record.image_id);
    if (existing) {
      stats.cached++;
      continue;
    }
    try {
      const res = await http.fetchBinary(record.source_url);
      if (res.status !== 200) {
        console.warn(
          `[download] ${record.image_id}: HTTP ${res.status}, пропуск`,
        );
        stats.skipped++;
        continue;
      }
      if (res.bytes.byteLength > MAX_BYTES) {
        console.warn(
          `[download] ${record.image_id}: ${res.bytes.byteLength} B > 5 MB, пропуск`,
        );
        await logOversize(source, record, res.bytes.byteLength);
        stats.oversize++;
        continue;
      }
      const ext = extensionFromContentType(res.contentType) || 'jpg';
      const outPath = join(IMAGES_DIR, `${record.image_id}.${ext}`);
      await writeFile(outPath, res.bytes);
      stats.downloaded++;
      console.log(
        `[download] ${record.image_id}.${ext}: ${res.bytes.byteLength} B`,
      );
    } catch (err) {
      console.error(
        `[download] ${record.image_id}: ${(err as Error).message}`,
      );
      stats.failed++;
    }
  }
  return stats;
}

async function main(): Promise<void> {
  // ensure IMAGES_DIR.stat(): touching it to suppress unused-import warning
  if (!existsSync(IMAGES_DIR)) {
    await mkdir(IMAGES_DIR, { recursive: true });
  } else {
    await stat(IMAGES_DIR);
  }
  const { source: onlySource } = parseArgs();
  const sources = await findSources(onlySource);
  if (sources.length === 0) {
    console.log('[download] нет источников с images.raw.jsonl');
    return;
  }
  const totals = { total: 0, downloaded: 0, cached: 0, skipped: 0, failed: 0, oversize: 0 };
  for (const s of sources) {
    console.log(`[download] обрабатываем источник: ${s}`);
    const r = await processSource(s);
    totals.total += r.total;
    totals.downloaded += r.downloaded;
    totals.cached += r.cached;
    totals.skipped += r.skipped;
    totals.failed += r.failed;
    totals.oversize += r.oversize;
    console.log(
      `[download] ${s}: total=${r.total}, downloaded=${r.downloaded}, cached=${r.cached}, skipped=${r.skipped}, failed=${r.failed}, oversize=${r.oversize}`,
    );
  }
  console.log(
    `[download] итого: total=${totals.total}, downloaded=${totals.downloaded}, cached=${totals.cached}, skipped=${totals.skipped}, failed=${totals.failed}, oversize=${totals.oversize}`,
  );
}

main().catch((err) => {
  console.error('[download] failure:', err);
  process.exit(1);
});
