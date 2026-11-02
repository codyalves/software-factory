/**
 * Deterministic JSON for audit payloads: object keys sorted by code point,
 * no whitespace. The canonical text is exactly what gets hashed and stored.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Re-serializes existing JSON text into canonical form. */
export function canonicalize(json: string): string {
  return canonicalJson(JSON.parse(json));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        sorted[key] = sortKeys(child);
      }
    }
    return sorted;
  }
  return value;
}
