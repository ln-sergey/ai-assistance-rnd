// Общий CLI-каркас для деструктивных команд scripts/data/*-delete.ts.
// Парсит --source/--all/--yes/--dry-run + опциональные доп-флаги,
// резолвит список source'ов через sources.config.json, печатает план
// и спрашивает подтверждение в интерактивном режиме.

import { createInterface } from 'node:readline/promises';

import type { SourcesConfig } from '../../parse/lib/config.js';

export interface DeleteCliArgs {
  source: string | null;
  all: boolean;
  yes: boolean;
  dryRun: boolean;
  flags: ReadonlySet<string>;
}

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

export function parseDeleteCli(
  allowedExtra: readonly string[] = [],
  argv: readonly string[] = process.argv.slice(2),
): DeleteCliArgs {
  let source: string | null = null;
  let all = false;
  let yes = false;
  let dryRun = false;
  const flags = new Set<string>();
  for (const a of argv) {
    const m = a.match(/^--source=(.+)$/);
    if (m?.[1]) {
      source = m[1];
      continue;
    }
    if (a === '--all') {
      all = true;
      continue;
    }
    if (a === '--yes') {
      yes = true;
      continue;
    }
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (allowedExtra.includes(key)) {
        flags.add(key);
        continue;
      }
      bail(`[delete] неизвестный флаг: ${a}`);
    }
    bail(`[delete] неизвестный аргумент: ${a}`);
  }
  if (source && all) bail('[delete] --source и --all взаимоисключающие');
  if (!source && !all) bail('[delete] требуется --source=X или --all');
  return { source, all, yes, dryRun, flags };
}

export function resolveSources(args: DeleteCliArgs, cfg: SourcesConfig): string[] {
  if (args.all) return Object.keys(cfg.sources).sort();
  const s = args.source;
  if (!s) bail('[delete] internal: source отсутствует');
  if (!cfg.sources[s]) {
    const known = Object.keys(cfg.sources).join(', ');
    bail(`[delete] источник "${s}" не найден в datasets/sources.config.json (известные: ${known})`);
  }
  return [s];
}

export async function confirmInteractive(prompt = 'Продолжить? [y/N] '): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error('[delete] требуется TTY для подтверждения; используй --yes или --dry-run');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
