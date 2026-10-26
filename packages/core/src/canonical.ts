// Canonical JSON: object keys sorted, no whitespace, undefined object members dropped.
// Only plain JSON values are accepted, so two parties always hash the same bytes.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalize: non-finite number");
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("canonicalize: only plain objects are allowed");
      }
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        if (obj[key] === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${canonicalize(obj[key])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
  }
}

/** Returns a copy of `obj` without the listed keys. */
export function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}
