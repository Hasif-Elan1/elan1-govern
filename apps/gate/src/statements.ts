import { hashCanonical, KeyRing, omit, type KeyInput } from "@gate/core";
import { forOrg, signWithKey } from "@gate/db";
import { adminEvent } from "./admin";
import { orgKey, type Deps } from "./deps";
import { activeChainKey } from "./keys";

// Signed statements a sovereign deployment hands to Elan1 on media (nothing is sent): the usage
// counts for a period, or where the chain stands. Signed with the organisation's own key, the
// same way checkpoints are (Ed25519 over the SHA-256 of the canonical JSON), so anyone with the
// org's public keys checks one with @gate/core alone (see verifyStatement). Each one is receipted.

export const STATEMENT_FORMAT = "elan1.statement.v1";
export type StatementKind = "usage" | "chain-head";

export interface ChainHeadRef {
  seq: number;
  hash: string;
  ts: string;
}

export interface UsageCounts {
  receipts: number;
  decisions: number;
  allowed: number;
  refused: number;
  asked: number;
  approvals: number;
  outcomes: number;
  admin: number;
}

export interface SignedStatement {
  format: typeof STATEMENT_FORMAT;
  kind: StatementKind;
  org: string;
  orgName: string;
  issuedAt: string;
  /** The receipt the statement stands on: the chain head now, or the last receipt of the usage period. */
  head: ChainHeadRef | null;
  period?: { from: string; to: string };
  counts?: UsageCounts;
  kid: string;
  sig: string;
}

const SYSTEM_ACTOR = "Elan1 Govern";

/** Start of the current calendar month (UTC). */
const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

export async function signedStatement(deps: Deps, orgId: string, kind: StatementKind, opts: { from?: Date; to?: Date; actor?: string } = {}): Promise<SignedStatement> {
  const db = forOrg(orgId, deps.db);
  const now = new Date();
  const key = await orgKey(deps, orgId);
  let head: ChainHeadRef | null;
  let extra: Pick<SignedStatement, "period" | "counts"> = {};
  if (kind === "chain-head") {
    const r = await db.receipt.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, hash: true, ts: true } });
    head = r ? { seq: r.seq, hash: r.hash, ts: r.ts.toISOString() } : null;
  } else {
    const to = opts.to ?? now;
    const from = opts.from ?? monthStart(to);
    if (!(from < to)) throw new Error("the period must start before it ends");
    const where = { ts: { gte: from, lt: to } };
    const groups = await db.receipt.groupBy({ by: ["kind", "decision"], where, _count: { _all: true } });
    const n = (f: (g: (typeof groups)[number]) => boolean) => groups.filter(f).reduce((s, g) => s + g._count._all, 0);
    const counts: UsageCounts = {
      receipts: n(() => true),
      decisions: n((g) => g.kind === "decision"),
      allowed: n((g) => g.kind === "decision" && g.decision === "allow"),
      refused: n((g) => g.kind === "decision" && g.decision === "refuse"),
      asked: n((g) => g.kind === "decision" && g.decision === "ask"),
      approvals: n((g) => g.kind === "approval"),
      outcomes: n((g) => g.kind === "outcome"),
      admin: n((g) => g.kind === "admin"),
    };
    const last = await db.receipt.findFirst({ where: { ts: { lt: to } }, orderBy: { seq: "desc" }, select: { seq: true, hash: true, ts: true } });
    head = last ? { seq: last.seq, hash: last.hash, ts: last.ts.toISOString() } : null;
    extra = { period: { from: from.toISOString(), to: to.toISOString() }, counts };
  }
  const body: Omit<SignedStatement, "sig"> = { format: STATEMENT_FORMAT, kind, org: orgId, orgName: key.name, issuedAt: now.toISOString(), head, ...extra, kid: key.kid };
  const digest = hashCanonical(body);
  // Signed through the key's provider, so a key held inside an HSM signs without leaving it.
  const chainKey = await activeChainKey(deps, orgId);
  if (chainKey.kid !== key.kid) throw new Error("the signing key changed while the statement was being made; try again");
  const statement: SignedStatement = { ...body, sig: await signWithKey(chainKey, digest) };
  // Written after signing, so the statement names the chain as it stood when it was made.
  await adminEvent(deps, orgId, opts.actor ?? SYSTEM_ACTOR, "statement.signed", { kind, digest: digest.slice(7, 23), head_seq: head?.seq ?? 0, ...(extra.period ? { from: extra.period.from, to: extra.period.to } : {}) });
  return statement;
}

/** Elan1's check of a statement: the signature over its canonical body, by a key of the organisation's that was live then. */
export function verifyStatement(s: SignedStatement, keys: KeyInput | KeyRing): boolean {
  const ring = keys instanceof KeyRing ? keys : new KeyRing(keys);
  return ring.verify(hashCanonical(omit(s, ["sig"])), s.sig, s.issuedAt, s.kid).ok;
}
