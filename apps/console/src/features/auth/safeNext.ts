/**
 * A `?next=` value is followed only when it is a path on this site. Anything else returns undefined:
 * protocol-relative '//host', '/\host' (browsers read the backslash as a slash), control characters
 * (a tab or newline is stripped by the URL parser, so '/\t/host' becomes '//host'), encoded backslashes,
 * and anything whose resolved origin is not this one. The result is the normalised path, search and hash.
 */
export function safeNext(next: string | null | undefined): string | undefined {
  if (!next) return undefined;
  if (!/^\/(?![/\\])/.test(next)) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(next)) return undefined;
  let decoded = next;
  try { decoded = decodeURIComponent(next); } catch { return undefined; }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(decoded) || /^\/[/\\]/.test(decoded)) return undefined;
  try {
    const here = window.location.origin;
    const u = new URL(next, here);
    if (u.origin !== here) return undefined;
    const path = u.pathname + u.search + u.hash;
    return path.startsWith('//') ? undefined : path;
  } catch {
    return undefined;
  }
}
