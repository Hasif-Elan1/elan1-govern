/** Checks on an upstream MCP server's address, and the slug its tools are named with. Used by the screens and by connectors/ops.ts. */

/* ── URL checks: https, no credentials in the URL; private ranges refused on hosted deployments.
 * On a Sovereign deployment upstream servers live on the customer's own network, so private hosts are
 * allowed when an admin has put them on the internal allow-list (host, *.domain, IPv4 or CIDR). Loopback
 * and link-local stay refused everywhere. ── */

const ipv4 = (h: string) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) ? h.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0 : undefined);

/** true when the host matches an allow-list entry. */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase();
  const ip = ipv4(h);
  return allow.some((raw) => {
    const e = raw.trim().toLowerCase();
    if (!e) return false;
    if (e.startsWith('*.')) return h.endsWith(e.slice(1));
    if (e.includes('/')) {
      const [base, bits] = e.split('/');
      const b = ipv4(base);
      const n = Number(bits);
      if (ip === undefined || b === undefined || !(n >= 0 && n <= 32)) return false;
      const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
      return ((ip & mask) >>> 0) === ((b & mask) >>> 0);
    }
    return h === e;
  });
}

export interface UpstreamUrlOpts { sovereign?: boolean; allow?: string[]; /** the organisation's own domain: its hosts are inside the network at Sovereign */ domain?: string }

const isPrivateHost = (h: string) => {
  const v6 = h.includes(':');
  return h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || (v6 && (/^f[cd][0-9a-f]{0,2}:/.test(h) || /^::ffff:(a[0-9a-f]{2}|c0a8|ac1[0-9a-f]):/.test(h))) ||
    /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
};

const hostOfUrl = (raw: string) => { try { return new URL(raw.trim()).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return undefined; } };

/**
 * Sovereign deny-all egress: true when the address is a public host outside the organisation's network (not .internal,
 * .local or .lan, not a private address, not the organisation's own domain, not on the internal allow-list). Such an
 * address is refused, and the attempt is recorded as egress.blocked (mock/sovereign.ts guardDestination).
 */
export function outsideNetwork(raw: string, opts: UpstreamUrlOpts = {}): boolean {
  if (!opts.sovereign) return false;
  const h = hostOfUrl(raw);
  if (!h || h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || /^169\.254\./.test(h)) return false;
  if (h.includes(':') && (h === '::1' || h === '::' || /^fe[89ab][0-9a-f]?:/.test(h) || /^::ffff:(7f[0-9a-f]{2}|a9fe):/.test(h))) return false;
  if (isPrivateHost(h)) return false;
  const own = (opts.domain ?? '').toLowerCase();
  if (own && (h === own || h.endsWith(`.${own}`))) return false;
  return !hostAllowed(h, opts.allow ?? []);
}

/** What is wrong with an upstream address, if anything; `egress` marks a public host refused under Sovereign deny-all egress. */
export function upstreamUrlProblem(raw: string, opts: UpstreamUrlOpts = {}): { message: string; egress?: boolean } | undefined {
  const message = checkUpstreamUrl(raw, opts);
  if (!message) return undefined;
  // an egress refusal is the last check, so any earlier problem (scheme, credentials, loopback, a private host) wins
  return { message, egress: message.startsWith(EGRESS_DENIED) };
}

const EGRESS_DENIED = 'Egress is denied on your Sovereign deployment';

export function checkUpstreamUrl(raw: string, opts: UpstreamUrlOpts = {}): string | undefined {
  const s = raw.trim();
  if (!s) return 'Enter the server address.';
  let u: URL;
  try { u = new URL(s); } catch { return 'This is not a valid address. It should look like https://mcp.example.com/mcp'; }
  if (u.protocol !== 'https:') return 'Use https. Plain http is refused.';
  if (u.username || u.password) return 'Do not put credentials in the address. Use the authentication header below.';
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // IPv6 prefixes apply only to IPv6 literals: a DNS name such as fdic-mcp.example.com is a public host
  const v6 = h.includes(':');
  const loop = h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || (v6 && (h === '::1' || h === '::' || /^fe[89ab][0-9a-f]?:/.test(h) || /^::ffff:(7f[0-9a-f]{2}|a9fe):/.test(h))) || /^127\./.test(h) || /^169\.254\./.test(h);
  if (loop) return 'Loopback and link-local addresses are refused on every deployment.';
  if (isPrivateHost(h)) {
    if (!opts.sovereign) return 'Private network addresses are refused on the hosted service. On a Sovereign deployment an admin can allow internal hosts.';
    if (!hostAllowed(h, opts.allow ?? [])) return `${h} is a private address that is not on your internal allow-list. An owner or admin adds it under Connectors › Internal hosts.`;
  }
  if (outsideNetwork(s, opts)) return `${EGRESS_DENIED}: ${h} is outside your network, so Elan1 Govern cannot reach it. Use an MCP server inside your network (.internal, .local, .lan, a private address or your own domain). Trying it anyway is refused and recorded.`;
  return undefined;
}

export const serverSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
