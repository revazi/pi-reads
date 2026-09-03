export function assertJsonObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
}

export function assertOptionalString(value: unknown, name: string): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

export function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${name} contains unsupported property ${unknown}`);
}

export function parseStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} must contain non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${name} must not contain duplicates`);
  return value;
}

export function definedProperties<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

export function assertEnvironmentName(value: unknown, name: string): asserts value is string | undefined {
  assertOptionalString(value, name);
  if (value !== undefined && !/^[A-Z_][A-Z0-9_]*$/u.test(value)) {
    throw new Error(`${name} must be an uppercase environment variable name`);
  }
}
