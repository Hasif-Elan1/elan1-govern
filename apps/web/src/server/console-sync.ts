import "server-only";
import {
  attachIssuedKey,
  guardSyncChanges,
  guardSyncPayload,
  issuedSecret,
  type ConsoleDocView,
  type ConsoleDomainFacts,
  type GuardSyncChanges,
  type GuardSyncPayload,
  type GuardSyncView,
} from "@gate/core";
import { HttpError } from "./api";
import { gate } from "./gate";
import { log } from "./log";

/*
 * The console's governance configuration drives the real guard (guardsync). After a console operation has saved
 * its documents, and before its transaction commits, each saved organisation's agents, keys, rulebooks, tools,
 * approver groups, emergency stop and the approvals the guard holds are sent to the gate, which applies them
 * (apps/gate/src/console-sync.ts). What the guard refuses is refused here too, so nothing is saved that the guard
 * does not do:
 *  - a rulebook version the guard cannot express or sign ("This version was not published: …");
 *  - a key that could not be made real (its secret is shown once, so it must work);
 *  - a decision on a held call the guard does not accept (not an approver there, already decided, expired);
 *  - any of these, a pause or the stop when the gate cannot be reached.
 * Changes nobody asked for in this operation (a first save, a lazy seed) are best effort: logged, never refused.
 * The plain secret of an issued key stays in the operation's result for the person who issued it; only its
 * SHA-256 goes to the gate. Approvals come back the other way: the gate writes the ones the guard holds into the
 * document (apps/gate/src/console-approvals.ts).
 *
 * Off when CONSOLE_GUARD_SYNC=off (and in tests unless it is "on").
 */

type Domain = typeof import("@gate/console/server");

interface GateResult {
  rulebooks: Record<string, { ok: true; version: number | null } | { ok: false; errors: string[] }>;
  approvals: Record<string, { ok: true; status: string } | { ok: false; code: string; error: string }>;
  keys: { created: string[]; unbacked: string[] };
  problems: string[];
  error?: string;
}

/** The last configuration this process applied, per organisation, so an unchanged one is not sent again. */
const applied = new Map<string, string>();

export function guardSyncOn(): boolean {
  const v = process.env.CONSOLE_GUARD_SYNC;
  return v ? v === "on" : process.env.NODE_ENV !== "test";
}

/** For tests: forget what this process applied, as a fresh process would. */
export function forgetGuardSync() {
  applied.clear();
}

/** What only the console's own code knows: effective approver groups, tool tags, named lists, who may decide. */
function factsOf(domain: Domain, orgId: string): ConsoleDomainFacts {
  const api = domain.api as { approverGroups(orgId: string): { id: string; name: string; members: string[] }[]; allowedApprovers(orgId: string, id: string): string[] };
  const db = domain.db as unknown as { getDB(orgId: string): unknown; orgToolDefs(orgId: string): { name: string; description?: string; tags: string[]; connector: string }[]; toolTagsIn(d: unknown, tool: string): string[] | undefined };
  const work = domain.work as { namedLists(orgId: string): Record<string, string[]> };
  const d = db.getDB(orgId);
  return {
    groups: api.approverGroups(orgId).map((g) => ({ id: g.id, name: g.name, members: [...g.members] })),
    tools: db.orgToolDefs(orgId).map((t) => ({ name: t.name, description: t.description, tags: db.toolTagsIn(d, t.name) ?? t.tags, connector: t.connector })),
    lists: work.namedLists(orgId),
    allowedApprovers: (id) => api.allowedApprovers(orgId, id),
  };
}

/** The person whose operation this is: the actor of the newest receipt it wrote (the server set it to the session user). */
function actorOf(before: { receipts?: { seq: number }[] } | undefined, after: { receipts?: { seq: number; actor?: string }[] }): string | undefined {
  const top = Math.max(0, ...(before?.receipts ?? []).map((r) => r.seq));
  return (after.receipts ?? []).filter((r) => r.seq > top && r.actor && r.actor !== "system").at(-1)?.actor;
}

const asked = (c: GuardSyncChanges) => c.rulebooks.length + c.keys.length + c.agents.length + c.approvals.length > 0 || c.stop;

/** Why the guard did not take what this operation asked for, in sentences, or nothing. */
function refusals(r: GateResult, c: GuardSyncChanges, issuedKey: string | undefined): string[] {
  const out: string[] = [];
  for (const id of c.rulebooks) {
    const x = r.rulebooks[id];
    if (x && !x.ok) out.push(`This version was not published: the guard cannot apply it. ${x.errors.join(" ")}`);
  }
  for (const id of c.approvals) {
    const x = r.approvals[id];
    // an expiry the console saw a moment before the guard's clock did: the guard expires it itself within a minute
    if (x && !x.ok && x.code !== "not_due") out.push(`The guard did not accept this: ${x.error}`);
  }
  if (issuedKey && !r.keys.created.includes(issuedKey)) out.push(`The key could not be registered with the guard, so it was not issued. ${r.problems.join(" ")}`.trim());
  return out;
}

/** Apply one organisation's document. Returns whether the issued secret (if any) belongs to one of its keys. */
async function syncOrg(domain: Domain, orgId: string, beforeJson: string | undefined, secret: string | undefined): Promise<boolean> {
  const doc = domain.db.peekDB(orgId) as unknown as (ConsoleDocView & { receipts?: { seq: number; actor?: string }[] }) | undefined;
  if (!doc) return false;
  const facts = factsOf(domain, orgId);
  const after: GuardSyncView = guardSyncPayload(doc, facts);
  const fingerprint = JSON.stringify(after);
  if (!secret && applied.get(orgId) === fingerprint) return false;
  const beforeDoc = beforeJson ? (JSON.parse(beforeJson) as ConsoleDocView & { receipts?: { seq: number }[] }) : undefined;
  const before = beforeDoc ? guardSyncPayload(beforeDoc, { ...facts, allowedApprovers: () => [] }) : undefined;
  const issuedKey = secret ? attachIssuedKey(after, before, secret) : undefined;
  const changes = guardSyncChanges(before, after);
  const strict = asked(changes);
  const payload: GuardSyncPayload = { ...after, ...(actorOf(beforeDoc, doc) ? { actor: actorOf(beforeDoc, doc) } : {}), changes };

  let res: { status: number; data: GateResult };
  try {
    res = await gate<GateResult>("POST", `/internal/orgs/${encodeURIComponent(orgId)}/console-sync`, payload);
  } catch (e) {
    if (strict) throw new HttpError(503, "Elan1 Govern could not reach the guard to apply this, so nothing was changed. Try again in a moment.");
    log("warn", "console.guard_sync", { orgId, err: (e as Error).message });
    return !!issuedKey;
  }
  // an organisation only the console knows (not in the gate's tables): nothing to apply it to
  if (res.status === 404) return !!issuedKey;
  if (res.status !== 200) {
    if (strict) throw new HttpError(502, `The guard did not accept this change${res.data.error ? ` (${res.data.error})` : ""}. Nothing was changed.`);
    log("warn", "console.guard_sync", { orgId, status: res.status, err: res.data.error });
    return !!issuedKey;
  }
  const refused = refusals(res.data, changes, issuedKey);
  if (refused.length) throw new HttpError(422, refused.join(" "));
  if (res.data.problems.length) log("info", "console.guard_sync_problems", { orgId, problems: res.data.problems.slice(0, 10).join(" | ") });
  // with a key's hash in it the message differs from the next one, which is then sent again (and changes nothing)
  applied.set(orgId, fingerprint);
  return !!issuedKey;
}

/**
 * The hook console-domain.ts calls inside each operation's transaction, after its documents are saved: `before`
 * holds each organisation's document as it was, `commits` the ones just saved, `result` the operation's result.
 * Throws an HttpError when the guard refused part of what the operation asked for (the transaction then rolls back).
 */
export async function syncAfterOp(input: { domain: Domain; before: ReadonlyMap<string, { json: string }>; commits: readonly { orgId: string }[]; result: unknown }) {
  if (!guardSyncOn()) return;
  const secret = issuedSecret(input.result);
  let claimed = false;
  for (const c of input.commits) claimed = (await syncOrg(input.domain, c.orgId, input.before.get(c.orgId)?.json, secret)) || claimed;
  // a secret shown once must be a key the guard knows
  if (secret && !claimed) throw new HttpError(500, "The new key could not be matched to its agent, so it was not issued. Nothing was changed.");
}
