import type { ConsoleRule } from "./console-rules";
import { hashToken } from "./crypto";
import { RISK_TAGS, type RiskTag } from "./tools";

// What the guard needs from the approved console's organisation document, as one message from the web app to
// the gate (POST /internal/orgs/:org/console-sync). The console document is the source of the governance
// configuration (agents, keys, rulebooks, tools and tags, approver groups, the stop); the gate applies it to its
// own tables, idempotently, by the console's ids. Built here so the web app and `pnpm demo --console` send the
// same thing.

/** A console-issued agent key: gk_ (production) or sk_sbx_ (sandbox), and the gate's own gk_ keys. */
export const AGENT_KEY_RE = /^(?:gk_|sk_sbx_)[A-Za-z0-9_-]{32,64}$/;

export interface GuardSyncAgent {
  id: string;
  slug: string;
  name: string;
  description: string;
  ownerId: string;
  riskLevel: "low" | "medium" | "high";
  /** The guard lets it act: its console status is active and no emergency stop covers it. */
  active: boolean;
  /** Paused by an emergency stop (the receipt says so). */
  stopped: boolean;
  tools: string[];
}

export interface GuardSyncKey {
  id: string;
  agentId: string;
  prefix: string;
  label: string;
  environment: "production" | "sandbox";
  /** When it stops working: its lifetime, or the end of a rotation's grace period. */
  expiresAt?: string;
  revoked: boolean;
  /** SHA-256 of the secret, only in the operation that issued it (the secret itself never leaves the web app). */
  keyHash?: string;
}

export interface GuardSyncTool {
  name: string;
  connectorId: string;
  connectorName: string;
  connectorUrl?: string;
  /** A demo connector (or one with no address): the guard answers for it, nothing is sent anywhere. */
  demo: boolean;
  description: string;
  tags: RiskTag[];
  enabled: boolean;
  /** Arguments the rules look at, so the signed rulebook can name them. */
  fields: string[];
}

export interface GuardSyncGroup {
  id: string;
  name: string;
  /** Console user ids. */
  members: string[];
}

export interface GuardSyncRulebook {
  id: string;
  agentId: string;
  /** The version in force (published, signed, not withdrawn); null when none is. */
  version: number | null;
  hash: string | null;
  signedBy?: string;
  rules: ConsoleRule[];
}

export interface GuardSyncStop {
  active: boolean;
  reason?: string;
  by?: string;
  since?: string;
  /** A stop on selected agents; absent for a stop on every agent. */
  agentSlugs?: string[];
}

/** An approval the guard holds (the console shows it from the gate's Approval row). */
export interface GuardSyncApproval {
  id: string;
  status: string;
  approverGroup: string;
  /** Console user ids who may decide it now (its group, the group it was escalated from, …). */
  allowed: string[];
  expiresAt: string;
  decidedBy?: string;
  decisionReason?: string;
  channel?: string;
  /** An owner decided outside the approver group (the console records it as an override). */
  override?: boolean;
}

export interface GuardSyncPayload {
  /** The console user whose operation this is, for the gate's receipts. */
  actor?: string;
  agents: GuardSyncAgent[];
  keys: GuardSyncKey[];
  tools: GuardSyncTool[];
  groups: GuardSyncGroup[];
  lists: Record<string, string[]>;
  rulebooks: GuardSyncRulebook[];
  stop: GuardSyncStop;
  approvals: GuardSyncApproval[];
  /**
   * What the operation behind this message changed (guardSyncChanges); absent for a first save. A rulebook it
   * changed that cannot be applied leaves the guard as it was (the web app then refuses the operation); an agent
   * is resumed only when it is listed here.
   */
  changes?: GuardSyncChanges;
}

// ---- The parts of the console document read here (apps/console/src/types.ts), loosely typed ----

interface DocKey {
  id: string;
  prefix: string;
  label?: string;
  environment?: string;
  expiresAt?: string;
  revoked?: boolean;
  revokeAt?: string;
}

interface DocVersion {
  version: number;
  status: string;
  hash: string;
  signedAt?: string;
  signedBy?: string;
  rules?: ConsoleRule[];
  withdrawn?: { at: string };
}

export interface ConsoleDocView {
  agents: { id: string; slug: string; name: string; description?: string; ownerId: string; riskLevel: string; status: string; tools?: string[]; keys?: DocKey[] }[];
  rulebooks: { id: string; agentId: string; versions: DocVersion[] }[];
  connectors: { id: string; name: string; url?: string; mode?: string; tools: { name: string; description?: string; enabled?: boolean }[] }[];
  stop?: { active?: boolean; reason?: string; by?: string; since?: string; scope?: string; agentSlugs?: string[] };
  approvals?: { id: string; status: string; approverGroup: string; expiresAt: string; decidedBy?: string; decisionReason?: string; channel?: string; override?: unknown; source?: string }[];
}

/** What only the console's own code can work out (effective approver groups, tool tags, named lists). */
export interface ConsoleDomainFacts {
  groups: GuardSyncGroup[];
  /** The organisation's tool catalogue, each with its tags as the console resolves them. */
  tools: { name: string; description?: string; tags: string[]; connector: string }[];
  lists: Record<string, string[]>;
  allowedApprovers(approvalId: string): string[];
}

const isTag = (t: string): t is RiskTag => (RISK_TAGS as readonly string[]).includes(t);
const RISK = new Set(["low", "medium", "high"]);

/** The document's configuration, before the operation's own details (actor, changes) are added. */
export type GuardSyncView = Omit<GuardSyncPayload, "actor" | "changes">;

/** The rulebook version in force at `now`: the last one signed that has not been withdrawn (the console's rulebookAt). */
export function inForceVersion<V extends DocVersion>(versions: readonly V[], now = Date.now()): V | undefined {
  const t = (s: string | undefined) => (s ? new Date(s).getTime() : NaN);
  return versions
    .filter((v) => v.status === "published" && t(v.signedAt) <= now && !(v.withdrawn && t(v.withdrawn.at) <= now))
    .sort((a, b) => a.signedAt!.localeCompare(b.signedAt!))
    .at(-1);
}

/** Does the stop cover this agent (every agent, or one of those it named)? */
function stopCovers(stop: ConsoleDocView["stop"], slug: string): boolean {
  if (!stop?.active) return false;
  return stop.scope !== "selected_agents" || !stop.agentSlugs || stop.agentSlugs.includes(slug);
}

/** Fields a rule's conditions name, for the tool it targets. */
function ruleFields(rule: ConsoleRule): string[] {
  return [...(rule.when ?? []), ...(rule.unless ?? [])].map((c) => (c.op === "to_domain_in" ? "to" : String(c.field)));
}

/** The document's governance configuration, as the gate applies it. */
export function guardSyncPayload(doc: ConsoleDocView, facts: ConsoleDomainFacts, now = Date.now()): GuardSyncView {
  const stop = doc.stop ?? {};
  const agents: GuardSyncAgent[] = doc.agents.map((a) => {
    const stopped = stopCovers(stop, a.slug);
    return {
      id: a.id,
      slug: a.slug,
      name: a.name,
      description: a.description ?? "",
      ownerId: a.ownerId,
      riskLevel: (RISK.has(a.riskLevel) ? a.riskLevel : "high") as GuardSyncAgent["riskLevel"],
      active: a.status === "active" && !stopped,
      stopped: stopped || a.status === "stopped",
      tools: [...(a.tools ?? [])],
    };
  });

  const keys: GuardSyncKey[] = doc.agents.flatMap((a) =>
    (a.keys ?? []).map((k) => {
      // a rotation's old key works until its grace period ends, and never after its own expiry
      const ends = [k.expiresAt, k.revokeAt].filter((x): x is string => !!x).sort();
      return {
        id: k.id,
        agentId: a.id,
        prefix: k.prefix,
        label: k.label ?? "",
        environment: k.environment === "sandbox" ? ("sandbox" as const) : ("production" as const),
        ...(ends[0] ? { expiresAt: ends[0] } : {}),
        revoked: k.revoked === true,
      };
    }),
  );

  const fields = new Map<string, Set<string>>();
  for (const rb of doc.rulebooks) {
    for (const v of rb.versions) {
      for (const r of v.rules ?? []) {
        if (!r.match?.tool) continue;
        const set = fields.get(r.match.tool) ?? new Set<string>();
        for (const f of ruleFields(r)) set.add(f);
        fields.set(r.match.tool, set);
      }
    }
  }
  const tools: GuardSyncTool[] = facts.tools.map((def) => {
    const connector = doc.connectors.find((c) => c.id === def.connector) ?? doc.connectors.find((c) => c.tools.some((t) => t.name === def.name));
    const own = connector?.tools.find((t) => t.name === def.name);
    return {
      name: def.name,
      connectorId: connector?.id ?? def.connector,
      connectorName: connector?.name ?? def.name.split(".")[0]!,
      ...(connector?.url ? { connectorUrl: connector.url } : {}),
      demo: !connector?.url || connector.mode === "demo",
      description: def.description ?? own?.description ?? "",
      tags: def.tags.filter(isTag),
      // a tool switched off on its connector is refused; a catalogue tool on no connector is not switched off
      enabled: own?.enabled ?? true,
      fields: [...(fields.get(def.name) ?? [])].sort(),
    };
  });

  const rulebooks: GuardSyncRulebook[] = doc.rulebooks.map((rb) => {
    const v = inForceVersion(rb.versions, now);
    return { id: rb.id, agentId: rb.agentId, version: v?.version ?? null, hash: v?.hash ?? null, ...(v?.signedBy ? { signedBy: v.signedBy } : {}), rules: v?.rules ?? [] };
  });

  const approvals: GuardSyncApproval[] = (doc.approvals ?? [])
    .filter((a) => a.source === "guard")
    .map((a) => ({
      id: a.id,
      status: a.status,
      approverGroup: a.approverGroup,
      allowed: facts.allowedApprovers(a.id),
      expiresAt: a.expiresAt,
      ...(a.decidedBy ? { decidedBy: a.decidedBy } : {}),
      ...(a.decisionReason ? { decisionReason: a.decisionReason } : {}),
      ...(a.channel ? { channel: a.channel } : {}),
      ...(a.override ? { override: true } : {}),
    }));

  return {
    agents,
    keys,
    tools,
    groups: facts.groups.map((g) => ({ id: g.id, name: g.name, members: [...g.members] })),
    lists: facts.lists,
    rulebooks,
    stop: {
      active: stop.active === true,
      ...(stop.reason ? { reason: stop.reason } : {}),
      ...(stop.by ? { by: stop.by } : {}),
      ...(stop.since ? { since: stop.since } : {}),
      ...(stop.active && stop.scope === "selected_agents" && stop.agentSlugs ? { agentSlugs: [...stop.agentSlugs] } : {}),
    },
    approvals,
  };
}

/** What an operation changed that the guard must accept, or the operation is refused (nothing, for a first save). */
export interface GuardSyncChanges {
  rulebooks: string[];
  keys: string[];
  agents: string[];
  approvals: string[];
  stop: boolean;
}

export function guardSyncChanges(before: GuardSyncView | undefined, after: GuardSyncView): GuardSyncChanges {
  const none: GuardSyncChanges = { rulebooks: [], keys: [], agents: [], approvals: [], stop: false };
  if (!before) return none;
  const by = <T extends { id: string }>(xs: readonly T[]) => new Map(xs.map((x) => [x.id, x]));
  const rb0 = by(before.rulebooks);
  const k0 = by(before.keys);
  const a0 = by(before.agents);
  const ap0 = by(before.approvals);
  return {
    rulebooks: after.rulebooks.filter((r) => rb0.get(r.id)?.version !== r.version || rb0.get(r.id)?.hash !== r.hash).map((r) => r.id),
    keys: after.keys.filter((k) => (!k0.has(k.id) && k.keyHash) || (k.revoked && k0.get(k.id)?.revoked === false)).map((k) => k.id),
    agents: [...after.agents.filter((a) => a0.get(a.id)?.active !== a.active).map((a) => a.id), ...before.agents.filter((a) => !after.agents.some((x) => x.id === a.id)).map((a) => a.id)],
    approvals: after.approvals.filter((a) => {
      const b = ap0.get(a.id);
      return !!b && (b.status !== a.status || b.approverGroup !== a.approverGroup || b.expiresAt !== a.expiresAt);
    }).map((a) => a.id),
    stop: before.stop.active !== after.stop.active,
  };
}

/** The secret an operation's result hands back once (issueKey, rotateKey …), if it has one. */
export function issuedSecret(result: unknown): string | undefined {
  const s = result && typeof result === "object" ? (result as { secret?: unknown }).secret : undefined;
  return typeof s === "string" && AGENT_KEY_RE.test(s) ? s : undefined;
}

/**
 * Attach the hash of a just-issued secret to the key it belongs to: one that is new in this operation and
 * whose prefix the secret starts with. Returns the key's id, or undefined when no key matches.
 */
export function attachIssuedKey(payload: Pick<GuardSyncPayload, "keys">, before: Pick<GuardSyncPayload, "keys"> | undefined, secret: string): string | undefined {
  const known = new Set((before?.keys ?? []).map((k) => k.id));
  const key = payload.keys.find((k) => !known.has(k.id) && !k.revoked && k.prefix.length >= 8 && secret.startsWith(k.prefix));
  if (!key) return undefined;
  key.keyHash = hashToken(secret);
  return key.id;
}
