//The nine OAuth tables store bounded scope/membership/metadata snapshots
//as TEXT columns (storage.md: "Use JSON fields for bounded scope/
//membership/metadata snapshots... with ordinary indexed lookup columns").
//These helpers are the only place that (de)serializes them, so every
//store method round-trips the same way.

export function toJsonColumn(value: unknown): string {
  return JSON.stringify(value);
}

export function fromJsonArray(value: unknown): string[] {
  if (value === null || typeof value === 'undefined') {
    return [];
  }
  if (Array.isArray(value)) {
    return value as string[];
  }
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

export function fromJsonHash(value: unknown): Record<string, unknown> {
  if (value === null || typeof value === 'undefined') {
    return {};
  }
  if (typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}
