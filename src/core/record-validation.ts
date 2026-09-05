import { readFile, readdir } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats, { type FormatsPlugin } from 'ajv-formats';
import type { ValidateFunction } from 'ajv';

const SCHEMA_BASE = 'https://github.com/revazi/pi-reads/schemas/v1/';
let validators: Promise<Ajv2020> | undefined;
async function loadValidators(): Promise<Ajv2020> {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: false });
  (addFormats as unknown as FormatsPlugin)(ajv);
  const directory = new URL('../../schemas/v1/', import.meta.url);
  for (const name of await readdir(directory)) {
    if (name.endsWith('.schema.json')) ajv.addSchema(JSON.parse(await readFile(new URL(name, directory), 'utf8')));
  }
  return ajv;
}

/** Schema diagnostics never echo untrusted record values or article prose. */
export async function validateRecord<T>(name: string, value: unknown): Promise<T> {
  validators ??= loadValidators();
  const validate: ValidateFunction | undefined = (await validators).getSchema(`${SCHEMA_BASE}${name}.schema.json`);
  if (!validate) throw new Error('Unknown record schema');
  if (!validate(value)) throw new Error(`Invalid ${name} schema (${validate.errors?.[0]?.keyword ?? 'validation'})`);
  return value as T;
}
