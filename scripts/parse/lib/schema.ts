// Ajv-валидатор для product_card.schema.json (P1 использует только его).
// Загружаем обе схемы через addSchema, чтобы $ref между ними резолвился.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(here, '../../../datasets/schema');

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ErrorObject[] };

let cachedProductCardValidator: ValidateFunction | null = null;

async function loadValidator(): Promise<ValidateFunction> {
  if (cachedProductCardValidator) return cachedProductCardValidator;
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);

  const productCardSchema = JSON.parse(
    await readFile(resolve(SCHEMA_DIR, 'product_card.schema.json'), 'utf8'),
  );
  const testCaseSchema = JSON.parse(
    await readFile(resolve(SCHEMA_DIR, 'test_case.schema.json'), 'utf8'),
  );
  ajv.addSchema(productCardSchema);
  ajv.addSchema(testCaseSchema);

  const validator = ajv.getSchema('product_card.schema.json');
  if (!validator) {
    throw new Error('product_card.schema.json не зарегистрирована в ajv');
  }
  cachedProductCardValidator = validator;
  return validator;
}

export async function validateProductCard<T>(
  card: unknown,
): Promise<ValidationResult<T>> {
  const validator = await loadValidator();
  const ok = validator(card);
  if (ok) {
    return { ok: true, value: card as T };
  }
  return { ok: false, errors: [...(validator.errors ?? [])] };
}

export function formatAjvErrors(errors: ErrorObject[]): string {
  return errors
    .map((e) => `${e.instancePath || '(root)'}: ${e.message ?? 'unknown'}`)
    .join('; ');
}
