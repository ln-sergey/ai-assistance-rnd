// Общие JSONL-хелперы: чтение urls.txt и подсчёт уже записанных id.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export async function readUrlsFile(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

// Читает существующий JSONL и возвращает множество id, уже присутствующих в файле.
// key='card.id' — спец-случай: id лежит внутри .card. Иначе — верхнего уровня.
export async function readJsonlIds(path: string, key: string): Promise<Set<string>> {
  const known = new Set<string>();
  if (!existsSync(path)) return known;
  const raw = await readFile(path, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const idCandidate =
        key === 'card.id'
          ? ((parsed.card as { id?: string } | undefined)?.id)
          : (parsed[key] as string | undefined);
      if (typeof idCandidate === 'string') known.add(idCandidate);
    } catch {
      // битая строка — ок, следующий прогон перепишет
    }
  }
  return known;
}

export function parseLimitArg(fallback = 10): number {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--limit=(\d+)$/);
    if (m?.[1]) return Number(m[1]);
  }
  return fallback;
}
