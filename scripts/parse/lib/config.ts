// Чтение datasets/sources.config.json + парсинг harvester-CLI-аргументов.
// Источник правды для target_total и seed каждого harvester'а.
//
// Приоритет: CLI > config. Source-specific параметры (SPB_SHARE,
// MIN_PER_TYPE, …) остаются в коде harvester'а — здесь только то, что
// унифицировано между всеми четырьмя источниками.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(here, '../../../datasets/sources.config.json');

export interface SourceConfig {
  target_total: number;
  seed: number;
}

export interface SourcesConfig {
  version: 1;
  sources: Record<string, SourceConfig>;
}

export interface HarvestCliArgs {
  target?: number;
  seed?: number;
}

export interface ResolvedSourceConfig {
  target: number;
  seed: number;
}

const SOURCES_CONFIG_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['version', 'sources'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    sources: {
      type: 'object',
      patternProperties: {
        '^[a-z0-9_-]+$': {
          type: 'object',
          required: ['target_total', 'seed'],
          additionalProperties: false,
          properties: {
            target_total: { type: 'integer', minimum: 1 },
            seed: { type: 'integer', minimum: 0 },
          },
        },
      },
      additionalProperties: false,
    },
  },
} as const;

let cachedValidator: ValidateFunction<SourcesConfig> | null = null;
let cachedConfig: SourcesConfig | null = null;

function getValidator(): ValidateFunction<SourcesConfig> {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  cachedValidator = ajv.compile<SourcesConfig>(SOURCES_CONFIG_SCHEMA);
  return cachedValidator;
}

export async function loadSourcesConfig(): Promise<SourcesConfig> {
  if (cachedConfig) return cachedConfig;
  const raw = await readFile(CONFIG_PATH, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[config] не удалось распарсить ${CONFIG_PATH}: ${(err as Error).message}`,
    );
  }
  const validate = getValidator();
  if (!validate(parsed)) {
    const msg = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '(root)'}: ${e.message ?? 'unknown'}`)
      .join('; ');
    throw new Error(`[config] ${CONFIG_PATH} невалиден: ${msg}`);
  }
  cachedConfig = parsed;
  return parsed;
}

export async function getSourceConfig(
  source: string,
  cli: HarvestCliArgs = {},
): Promise<ResolvedSourceConfig> {
  const cfg = await loadSourcesConfig();
  const entry = cfg.sources[source];
  if (!entry) {
    const known = Object.keys(cfg.sources).join(', ');
    throw new Error(
      `[config] источник "${source}" не найден в datasets/sources.config.json (известные: ${known})`,
    );
  }
  return {
    target: cli.target ?? entry.target_total,
    seed: cli.seed ?? entry.seed,
  };
}

// Парсит --target=N и --seed=N из process.argv. Прочие аргументы игнорирует.
// Поддерживает форму `--target N` тоже — на случай, если кто-то прилетит без `=`.
export function parseHarvestArgs(argv: readonly string[] = process.argv.slice(2)): HarvestCliArgs {
  const out: HarvestCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    const eq = a.indexOf('=');
    let key: string;
    let val: string | undefined;
    if (a.startsWith('--') && eq !== -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      key = a.slice(2);
      val = argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        i++;
      } else {
        val = undefined;
      }
    } else {
      continue;
    }
    if (key !== 'target' && key !== 'seed') continue;
    if (val === undefined) {
      throw new Error(`[config] флаг --${key} требует значения`);
    }
    const n = Number(val);
    if (!Number.isInteger(n) || n < 0 || (key === 'target' && n < 1)) {
      throw new Error(`[config] --${key}=${val} — ожидалось целое число (target ≥ 1, seed ≥ 0)`);
    }
    out[key] = n;
  }
  return out;
}
