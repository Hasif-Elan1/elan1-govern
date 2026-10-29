import { BlockList, isIP } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultClient } from "./client";
import { forOrg } from "./tenant";

// The one egress gate. Every outbound connection Elan1 Govern makes (webhooks, upstream MCP
// servers, Slack and WhatsApp, SMTP, OIDC, the Gmail and Zoho connectors) asks `check` after its
// own URL and SSRF checks and before it connects; those checks still run. Standard profile:
// everything is allowed and recorded. Sovereign profile (GATE_PROFILE=sovereign): deny-all,
// except the deployment's EGRESS_ALLOW list and the organisation's own EgressRule rows. Every
// decision, allowed or blocked, is written to EgressLog. It lives here because both apps import
// @gate/db and the rules and the log are tables; it is Node-only, which packages/db already is.

export const GATE_PROFILES = ["standard", "sovereign"] as const;
export type GateProfile = (typeof GATE_PROFILES)[number];

/** What an outbound connection is for. `tsa` is reserved for the timestamping client. */
export const EGRESS_PURPOSES = ["webhook", "upstream-mcp", "chat-slack", "chat-whatsapp", "connector", "oidc", "smtp", "tsa"] as const;
export type EgressPurpose = (typeof EGRESS_PURPOSES)[number];

/** One EGRESS_ALLOW entry: `host`, `host:port`, `*.zone` or `*.zone:port` (IPv6 as `[addr]:port`). */
export interface AllowEntry {
  host: string;
  /** `*.zone` matches any name under zone, never the zone itself. */
  wildcard: boolean;
  port: number | null;
}

export const DEFAULT_PORTS: Readonly<Record<string, number>> = { "http:": 80, "https:": 443, "smtp:": 25, "smtps:": 465 };

/** Name suffixes that never resolve on the public internet (RFC 6761/6762/8375 and common private zones). */
const INTERNAL_SUFFIXES = ["internal", "local", "localhost", "lan", "home.arpa", "intranet", "corp"];

const INTERNAL_IPS = new BlockList();
for (const [net, prefix] of [["10.0.0.0", 8], ["127.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) INTERNAL_IPS.addSubnet(net, prefix, "ipv4");
INTERNAL_IPS.addAddress("::1", "ipv6");
INTERNAL_IPS.addSubnet("fc00::", 7, "ipv6");

const LABEL = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)$/;

/** Lower case, no IPv6 brackets, no trailing dot. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function validName(host: string): boolean {
  if (isIP(host)) return true;
  return host.length > 0 && host.length <= 253 && host.split(".").every((l) => LABEL.test(l));
}

function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : null;
}

/** Splits `host`, `host:port`, `[v6]` and `[v6]:port`. A bare IPv6 address has no port. */
function splitHostPort(raw: string): { host: string; port: string | null } | null {
  const t = raw.trim();
  if (t.startsWith("[")) {
    const end = t.indexOf("]");
    if (end < 0) return null;
    const rest = t.slice(end + 1);
    if (rest && !rest.startsWith(":")) return null;
    return { host: t.slice(1, end), port: rest ? rest.slice(1) : null };
  }
  const colons = t.split(":").length - 1;
  if (colons === 1) {
    const i = t.indexOf(":");
    return { host: t.slice(0, i), port: t.slice(i + 1) };
  }
  return { host: t, port: null };
}

export function parseAllowEntry(raw: string): AllowEntry | null {
  const parts = splitHostPort(raw);
  if (!parts) return null;
  const port = parts.port === null ? null : parsePort(parts.port);
  if (parts.port !== null && port === null) return null;
  let host = normalizeHost(parts.host);
  const wildcard = host.startsWith("*.");
  if (wildcard) host = host.slice(2);
  if (!host || host.includes("*") || !validName(host) || (wildcard && isIP(host))) return null;
  return { host, wildcard, port };
}

/** EGRESS_ALLOW, comma or space separated. Entries that do not parse are reported, never ignored. */
export function parseAllowList(raw: string | undefined): { entries: AllowEntry[]; errors: string[] } {
  const entries: AllowEntry[] = [];
  const errors: string[] = [];
  for (const item of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    const e = parseAllowEntry(item);
    if (e) entries.push(e);
    else errors.push(`"${item}" is not a host, host:port or *.zone entry`);
  }
  return { entries, errors };
}

export function matchesEntry(e: AllowEntry, host: string, port: number): boolean {
  if (e.port !== null && e.port !== port) return false;
  const h = normalizeHost(host);
  return e.wildcard ? h.endsWith(`.${e.host}`) : h === e.host;
}

/** Comma-separated extra internal zones (EGRESS_INTERNAL_DOMAINS), e.g. `corp.deccanbank.co.in`. */
export function parseDomains(raw: string | undefined): string[] {
  return (raw ?? "").split(/[\s,]+/).map(normalizeHost).filter((d) => d && validName(d) && !isIP(d) && d.includes("."));
}

function inZone(host: string, zone: string): boolean {
  return host === zone || host.endsWith(`.${zone}`);
}

/** A zone that cannot be on the public internet: an internal suffix or one of the operator's own internal domains. */
export function isInternalZone(zone: string, internalDomains: readonly string[] = []): boolean {
  const z = normalizeHost(zone);
  return INTERNAL_SUFFIXES.some((s) => inZone(z, s)) || internalDomains.some((d) => inZone(z, d));
}

/**
 * Inside the organisation's own network: a private or loopback address, a single-label name
 * (resolved through the local search domains), or a name in an internal zone. Link-local and
 * CGNAT addresses are not "internal services" here (cloud metadata lives on link-local).
 */
export function isInternalHost(host: string, internalDomains: readonly string[] = []): boolean {
  const h = normalizeHost(host);
  const v = isIP(h);
  if (v) return INTERNAL_IPS.check(h, v === 4 ? "ipv4" : "ipv6");
  if (!validName(h)) return false;
  return !h.includes(".") || isInternalZone(h, internalDomains);
}

function entryIsInternal(e: AllowEntry, internalDomains: readonly string[]): boolean {
  return e.wildcard ? isInternalZone(e.host, internalDomains) : isInternalHost(e.host, internalDomains);
}

export type EgressTarget = string | URL | { host: string; port: number };

/** Host and port of a URL (`https://h/x`, `smtp://h:25`) or of `host:port`. */
export function targetOf(target: EgressTarget): { host: string; port: number } {
  if (typeof target === "object" && !(target instanceof URL)) return { host: normalizeHost(target.host), port: target.port };
  const raw = String(target);
  if (target instanceof URL || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const u = target instanceof URL ? target : new URL(raw);
    const port = u.port ? Number(u.port) : DEFAULT_PORTS[u.protocol];
    if (!port) throw new Error(`no default port for ${u.protocol}`);
    return { host: normalizeHost(u.hostname), port };
  }
  const parts = splitHostPort(raw);
  const port = parts?.port ? parsePort(parts.port) : null;
  if (!parts || !port) throw new Error("an egress target needs a host and a port");
  return { host: normalizeHost(parts.host), port };
}

export interface EgressDecision {
  allowed: boolean;
  host: string;
  port: number;
  purpose: string;
  orgId: string | null;
  profile: GateProfile;
  reason?: string;
  actor?: string;
  /** The EgressLog row, when it could be written. */
  logId?: string;
}

/** Thrown by `check` when the profile denies a connection. Nothing was sent. */
export class EgressBlocked extends Error {
  constructor(readonly decision: EgressDecision) {
    super(`Egress denied: ${decision.host}:${decision.port} is not on this deployment's egress allow-list, so Elan1 Govern did not connect.`);
  }
}

export interface EgressCheckOptions {
  /** The organisation the connection is for; null for platform-level connections (the SMTP relay). */
  orgId?: string | null;
  /** A person who caused the attempt (adding a webhook, testing an issuer); system attempts leave it out. */
  actor?: string;
}

export interface EgressConfig {
  profile: GateProfile;
  /** EGRESS_ALLOW */
  allow?: string;
  /** EGRESS_INTERNAL_DOMAINS */
  internalDomains?: string;
}

export interface EgressHooks {
  client?: PrismaClient;
  /**
   * Called for a blocked connection: a person's attempt every time, a system attempt at most once
   * per organisation, host, port and purpose per hour. The app writes an `egress.blocked` receipt
   * (or, with no organisation, a health alert) and returns the receipt's seq.
   */
  onBlocked?: (d: EgressDecision) => Promise<{ receiptSeq?: number } | void>;
  warn?: (message: string, data: Record<string, unknown>) => void;
}

export interface Egress {
  readonly profile: GateProfile;
  /** The decision, recorded in EgressLog. Never throws for a blocked connection. */
  decide(target: EgressTarget, purpose: string, opts?: EgressCheckOptions): Promise<EgressDecision>;
  /** As decide, but throws EgressBlocked when the connection is denied. */
  check(target: EgressTarget, purpose: string, opts?: EgressCheckOptions): Promise<EgressDecision>;
}

/** A system attempt raises at most one receipt or alert per org, host, port and purpose in this window. */
export const EGRESS_ALERT_WINDOW_MS = 3_600_000;

export function createEgress(cfg: EgressConfig, hooks: EgressHooks = {}): Egress {
  const client = hooks.client ?? defaultClient;
  const { entries } = parseAllowList(cfg.allow);
  const domains = parseDomains(cfg.internalDomains);
  const warn = hooks.warn ?? (() => undefined);
  // Org rows go through forOrg like any tenant table; platform rows (no org) use the plain client.
  const logs = (orgId: string | null) => (orgId ? forOrg(orgId, client).egressLog : client.egressLog) as unknown as PrismaClient["egressLog"];

  async function orgRuleAllows(orgId: string, host: string, port: number, purpose: string): Promise<boolean> {
    const rules = await forOrg(orgId, client).egressRule.findMany({
      where: { host, AND: [{ OR: [{ port: null }, { port }] }, { OR: [{ purpose: null }, { purpose }] }] },
      select: { host: true },
    });
    // A row written around addEgressRule still has to name an internal host.
    return rules.some((r) => isInternalHost(r.host, domains));
  }

  async function alertDue(d: EgressDecision): Promise<boolean> {
    if (d.actor) return true;
    const since = new Date(Date.now() - EGRESS_ALERT_WINDOW_MS);
    const recent = await logs(d.orgId).findFirst({ where: { orgId: d.orgId, host: d.host, port: d.port, purpose: d.purpose, decision: "blocked", alerted: true, at: { gte: since } }, select: { id: true } });
    return !recent;
  }

  async function decide(target: EgressTarget, purpose: string, opts: EgressCheckOptions = {}): Promise<EgressDecision> {
    const orgId = opts.orgId || null;
    const base = { purpose, orgId, profile: cfg.profile, ...(opts.actor ? { actor: opts.actor } : {}) };
    let host: string;
    let port: number;
    try {
      ({ host, port } = targetOf(target));
    } catch {
      // Not a URL we can name a host for: never allowed in sovereign mode, and nothing to log.
      return { ...base, host: "", port: 0, allowed: cfg.profile !== "sovereign", reason: "the destination has no host and port" };
    }
    let allowed = true;
    let reason: string | undefined;
    if (cfg.profile === "sovereign") {
      try {
        allowed = entries.some((e) => matchesEntry(e, host, port)) || (orgId !== null && (await orgRuleAllows(orgId, host, port, purpose)));
        if (!allowed) reason = "not on the egress allow-list";
      } catch {
        allowed = false; // fail closed: the allow-list could not be read
        reason = "the organisation's egress rules could not be read";
      }
    }
    const d: EgressDecision = { ...base, host, port, allowed, ...(reason ? { reason } : {}) };
    try {
      const row = await logs(orgId).create({ data: { orgId, host, port, purpose, decision: allowed ? "allowed" : "blocked", profile: cfg.profile, reason: reason ?? null, actor: opts.actor ?? null }, select: { id: true } });
      d.logId = row.id;
    } catch (e) {
      warn("egress decision not logged", { host, port, purpose, orgId, err: (e as Error).message });
    }
    if (!allowed && hooks.onBlocked) {
      try {
        if (await alertDue(d)) {
          const out = await hooks.onBlocked(d);
          if (d.logId) await logs(orgId).updateMany({ where: { id: d.logId }, data: { alerted: true, receiptSeq: out?.receiptSeq ?? null } });
        }
      } catch (e) {
        warn("egress block not reported", { host, port, purpose, orgId, err: (e as Error).message });
      }
    }
    return d;
  }

  return {
    profile: cfg.profile,
    decide,
    async check(target, purpose, opts) {
      const d = await decide(target, purpose, opts);
      if (!d.allowed) throw new EgressBlocked(d);
      return d;
    },
  };
}

/**
 * A fetch that asks the egress gate before every request. In the sovereign profile redirects are
 * refused (unless the caller handles them itself), so a redirect cannot lead past the allow-list.
 */
export function egressFetch(egress: Egress, purpose: string, opts: EgressCheckOptions, base: typeof fetch = fetch): typeof fetch {
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    await egress.check(url, purpose, opts);
    const redirect = egress.profile === "sovereign" && init.redirect !== "manual" ? "error" : init.redirect;
    return base(input, { ...init, ...(redirect ? { redirect } : {}) });
  };
}

/** Start-up problems for the sovereign profile: an allow-list that reaches the internet, or a configured endpoint outside it. */
export function sovereignProblems(cfg: { allow?: string; internalDomains?: string }, endpoints: { name: string; target: EgressTarget }[]): { name: string; message: string }[] {
  const out: { name: string; message: string }[] = [];
  const { entries, errors } = parseAllowList(cfg.allow);
  const domains = parseDomains(cfg.internalDomains);
  for (const message of errors) out.push({ name: "EGRESS_ALLOW", message });
  for (const e of entries) {
    if (!entryIsInternal(e, domains)) out.push({ name: "EGRESS_ALLOW", message: `${e.wildcard ? "*." : ""}${e.host} is a public name; a sovereign allow-list takes internal hosts only (private addresses, .internal and similar zones, or EGRESS_INTERNAL_DOMAINS)` });
  }
  for (const ep of endpoints) {
    let t: { host: string; port: number };
    try {
      t = targetOf(ep.target);
    } catch {
      out.push({ name: ep.name, message: "has no host and port" });
      continue;
    }
    if (!isInternalHost(t.host, domains)) out.push({ name: ep.name, message: `${t.host} is a public endpoint; the sovereign profile only connects inside the network` });
    else if (!entries.some((e) => matchesEntry(e, t.host, t.port))) out.push({ name: ep.name, message: `${t.host}:${t.port} is not on EGRESS_ALLOW` });
  }
  return out;
}

/** Why an organisation's own allow-list entry is refused, or null when it is fine: exact internal hosts only. */
export function egressRuleProblem(host: string, port: number | null, internalDomains?: string): string | null {
  const h = normalizeHost(host);
  if (!h || h.includes("*")) return "Give one host name or private address; wildcards are set by the deployment operator.";
  if (!validName(h)) return "That is not a host name or IP address.";
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return "The port must be between 1 and 65535.";
  if (!isInternalHost(h, parseDomains(internalDomains))) return `${h} is not inside your network. The allow-list takes internal names and private addresses only; the internet stays denied.`;
  return null;
}

/** Retention for every org at once (and platform rows): drop decisions older than `before`. */
export async function purgeEgressLog(before: Date, client: PrismaClient = defaultClient): Promise<number> {
  return (await client.egressLog.deleteMany({ where: { at: { lt: before } } })).count;
}
