const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return slug || 'article';
}

export function assertSafeSlug(value: string): string {
  if (!SLUG_PATTERN.test(value) || value.length > 100) {
    throw new Error(`Invalid article slug: ${value}`);
  }
  return value;
}
