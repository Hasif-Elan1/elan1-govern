import "server-only";
import { publicKeyHex } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import { HttpError } from "../api";
import { syncDoc, type ChainDoc } from "../console-chain";
import { overrideOp, type OverrideCtx } from "../console-overrides";
import { gate } from "../gate";

/*
 * Console operations whose signing the gate does outright, before the console's own bookkeeping runs (the domain
 * holds no keys on the server; console-signing.ts covers the signatures the domain asks for in passing):
 *  - api.rotateKey: the gate rotates the organisation's real key (a key.rotated receipt signed by the old key);
 *  - api.anchorNow: the gate batches and timestamps the new receipts with its RFC 3161 authorities;
 *  - successor keys (keys.bindKey, a key ceremony from L2, an approved KMS rotation, the confirmation, signing on,
 *    the withdrawal, the switch at the end of the overlap): the gate's custody takes each step, then the console's
 *    own bookkeeping runs with what the gate made and wrote (apps/console/src/mock/keys.ts serverKeys).
 * Each runs the console's own checks first, so nothing reaches the gate that the console would have refused.
 */

type Db = { memberRole(orgId: string, userId: string): string | undefined; touch(orgId: string, kind?: string): void };
type Keys = { assertKeyChangeAllowed(orgId: string, userId: string, what: string, step?: boolean): void };

const dbOf = (ctx: OverrideCtx) => ctx.domain.db as unknown as Db & typeof ctx.domain.db;
const docOf = (ctx: OverrideCtx) => ctx.domain.db.getDB(ctx.orgId) as unknown as ChainDoc & { org: { plan?: string; id: string; name: string } };
const keysOf = (ctx: OverrideCtx) => (ctx.domain as unknown as { keys: Keys }).keys;

function requireOwnerOrAdmin(ctx: OverrideCtx, what: string) {
  const role = dbOf(ctx).memberRole(ctx.orgId, ctx.actorUserId);
  if (role !== "owner" && role !== "admin") throw new Error(`${what} — owners and admins can do this; your role cannot.`);
}

async function gateCall<T>(ctx: OverrideCtx, path: string, body: unknown): Promise<T> {
  const r = await gate<T & { error?: string }>("POST", `/internal/orgs/${encodeURIComponent(ctx.orgId)}/${path}`, body).catch(() => undefined);
  if (!r) throw new HttpError(503, "Elan1 Govern is not reachable, so nothing was changed. Try again.");
  if (r.status !== 200) throw new HttpError(r.status === 422 ? 409 : r.status >= 500 ? 502 : r.status, r.data.error ?? "Elan1 Govern refused this.");
  return r.data;
}

// L1: the organisation's key is rotated in the gate; from L2 it changes only through custody (ceremony, successor)
overrideOp("api.rotateKey", async (ctx) => {
  requireOwnerOrAdmin(ctx, "Rotating the signing key");
  const d = docOf(ctx);
  if (d.org.plan !== "l1") throw new Error("From L2 the signing key is rotated in its custody (AWS KMS or your HSM), through a key ceremony.");
  keysOf(ctx).assertKeyChangeAllowed(ctx.orgId, ctx.actorUserId, "rotate the signing key");
  // the gate's key.rotated receipt names the person by their sign-in address, as its other admin receipts do
  const who = await prisma.user.findUnique({ where: { id: ctx.actorUserId }, select: { email: true } });
  if (!who) throw new Error("Only a person with an Elan1 Govern account can rotate the signing key.");
  const r = await gateCall<{ kid: string; previousKid: string; seq: number }>(ctx, "signing-key/rotate", { actor: who.email });
  // the key.rotated receipt and the new key come into the document as the chain has them
  await syncDoc(ctx.orgId, d);
  // the incoming key signs one record at once, so the newest record is signed by the organisation's current key
  ctx.domain.db.logAdmin(ctx.orgId, "system", "key.signing_started", { kid: r.kid, fingerprint: r.kid, rotated_seq: r.seq });
  ctx.domain.db.syncOrgMeta(d.org);
  dbOf(ctx).touch(ctx.orgId, "key");
  return undefined;
});

// "Anchor now": a real Merkle batch with two RFC 3161 timestamps, recorded by the gate's anchor.batched receipt
overrideOp("api.anchorNow", async (ctx) => {
  requireOwnerOrAdmin(ctx, "Anchoring on demand");
  const d = docOf(ctx);
  if (!["l2", "l3", "sovereign"].includes(d.org.plan ?? "")) throw new Error("Timestamping on demand is available from L2 Attested.");
  const r = await gateCall<{ batches: { id: string; fromSeq: number; toSeq: number; root: string; status: string; receiptSeq: number }[] }>(ctx, "console-signing/anchor", { actor: ctx.actorUserId });
  const b = r.batches.at(-1);
  if (!b) throw new Error("Every sealed record is already in a timestamped batch. There is nothing to anchor.");
  await syncDoc(ctx.orgId, d);
  dbOf(ctx).touch(ctx.orgId, "anchor");
  const view = (ctx.domain.api as unknown as { anchors(orgId: string, limit?: number): Promise<{ batches: { id: string }[] }> }).anchors(ctx.orgId, 200);
  const batch = (await view).batches.find((x) => x.id === b.id);
  if (!batch) throw new Error("The batch was recorded but does not read back. Reload the page.");
  return { ...batch, onDemand: true, recordedSeq: b.receiptSeq, status: b.status === "ok" ? "anchored" : "late" };
});

/* ── Successor keys (L2 and up): bound, confirmed, switched and withdrawn by the gate (custody.ts) ── */

type Step = { kid: string; publicKeyHex: string; seq: number; switchAt?: string };
const serverKeys = (ctx: OverrideCtx) => ctx.domain.serverSigning.serverKeys;
const openSuccessor = (orgId: string) => forOrg(orgId).keySuccessor.findFirst({ where: { activatedAt: null, withdrawnAt: null }, orderBy: { boundAt: "desc" } });

/** Run the console's own bookkeeping for a step the gate took, with what the gate made and wrote. */
async function withStep<T>(ctx: OverrideCtx, step: Step, run: () => T | Promise<T>): Promise<T> {
  serverKeys(ctx).setStep(step);
  try {
    return await run();
  } finally {
    serverKeys(ctx).setStep(undefined);
  }
}

/** The gate binds a new key, made by the organisation's key provider, as its successor (key.bound, a 30-day overlap). */
async function bindInGate(ctx: OverrideCtx): Promise<Step> {
  const r = await gateCall<{ kid: string; boundSeq: number; switchAt: string }>(ctx, "console-signing/successor", { actor: ctx.actorUserId });
  await syncDoc(ctx.orgId, docOf(ctx));
  const s = await forOrg(ctx.orgId).keySuccessor.findFirstOrThrow({ where: { kid: r.kid }, select: { publicKey: true } });
  return { kid: r.kid, publicKeyHex: publicKeyHex(s.publicKey), seq: r.boundSeq, switchAt: r.switchAt };
}

// "Publish a successor": the key is made and bound by the gate; the console records it as bound
overrideOp("keys.bindKey", async (ctx) => {
  const [orgId, userId, input] = ctx.args as [string, string, { purpose: "planned" | "compromise"; holders?: string[] }];
  serverKeys(ctx).bindCheck(orgId, userId, input);
  const step = await bindInGate(ctx);
  return withStep(ctx, step, () => ctx.original(...ctx.args));
});

// a key ceremony from L2 (or an approved KMS rotation) publishes the new key as the successor, the same way
overrideOp("api.runKeyCeremony", async (ctx) => {
  const [orgId, userId, participantNames, opts] = ctx.args as [string, string, string[] | undefined, { firstKey?: boolean } | undefined];
  // an L1 ceremony and the first customer-held key switch at once: not run by Elan1 Govern for the console yet
  if (opts?.firstKey || docOf(ctx).org.plan === "l1") return ctx.original(...ctx.args);
  serverKeys(ctx).ceremonyCheck(orgId, userId, participantNames, "ceremony");
  const step = await bindInGate(ctx);
  return withStep(ctx, step, () => ctx.original(...ctx.args));
});
overrideOp("keys.approveKmsRotation", async (ctx) => {
  const [orgId, userId] = ctx.args as [string, string];
  serverKeys(ctx).ceremonyCheck(orgId, userId, undefined, "kms");
  const step = await bindInGate(ctx);
  return withStep(ctx, step, () => ctx.original(...ctx.args));
});

/** The console's bound successor, which must be the gate's. */
async function boundSuccessor(ctx: OverrideCtx) {
  const b = serverKeys(ctx).boundOf(ctx.orgId);
  const s = await openSuccessor(ctx.orgId);
  if (!b || !s || s.kid !== b.kid) throw new Error("No successor key is waiting to sign.");
  return { b, s };
}

/**
 * The gate's dual control: a second owner or admin confirms (key.bound_confirmed); once the overlap has ended the
 * successor starts signing (key.rotated, signed by the old key). Returns what it did, the document brought up to it.
 */
async function confirmInGate(ctx: OverrideCtx) {
  const r = await gateCall<{ kid: string; switched: boolean; switchAt: string; confirmedSeq?: number; seq?: number }>(ctx, "console-signing/successor/confirm", { actor: ctx.actorUserId });
  await syncDoc(ctx.orgId, docOf(ctx));
  return r;
}

// L2 dual control: "Confirm the switch"
overrideOp("keys.confirmSwitch", async (ctx) => {
  requireOwnerOrAdmin(ctx, "Confirming the switch to a successor");
  const { b, s } = await boundSuccessor(ctx);
  if (docOf(ctx).org.plan !== "l2") throw new Error("A second confirmation is the L2 dual control. From L3 the key ceremony’s quorum stands for it.");
  if (s.confirmedBy) throw new Error("A second owner or admin has already confirmed this switch.");
  keysOf(ctx).assertKeyChangeAllowed(ctx.orgId, ctx.actorUserId, "confirm the switch to a successor", true);
  const r = await confirmInGate(ctx);
  return withStep(ctx, { kid: b.kid, publicKeyHex: "", seq: r.confirmedSeq! }, () => ctx.original(...ctx.args));
});

// "Turn signing on": the gate switches only once the overlap has ended, and only for a second person (dual control)
overrideOp("keys.signingOn", async (ctx) => {
  requireOwnerOrAdmin(ctx, "Turning signing on");
  const { b } = await boundSuccessor(ctx);
  keysOf(ctx).assertKeyChangeAllowed(ctx.orgId, ctx.actorUserId, "turn signing on", true);
  const r = await confirmInGate(ctx);
  if (!r.switched) {
    const when = new Date(r.switchAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
    throw new Error(`${r.confirmedSeq ? `Your confirmation is recorded as receipt #${r.confirmedSeq}. ` : ""}Elan1 Govern switches signing to ${b.kid} at the end of its 30-day overlap, on ${when} IST, so verifiers that pinned it are never caught out.`);
  }
  return withStep(ctx, { kid: b.kid, publicKeyHex: "", seq: r.seq! }, () => ctx.original(...ctx.args));
});

overrideOp("keys.withdrawBound", async (ctx) => {
  requireOwnerOrAdmin(ctx, "Withdrawing a bound key");
  const { b } = await boundSuccessor(ctx);
  const reason = String(ctx.args[2] ?? "").trim() || "Withdrawn before signing";
  const r = await gateCall<{ kid: string; seq: number }>(ctx, "console-signing/successor/withdraw", { actor: ctx.actorUserId, reason });
  await syncDoc(ctx.orgId, docOf(ctx));
  return withStep(ctx, { kid: b.kid, publicKeyHex: "", seq: r.seq }, () => ctx.original(...ctx.args));
});

// the switch at the end of the overlap: the gate makes it (for a confirmed successor), the console then records it
overrideOp("keys.settle", async (ctx) => {
  const s = await openSuccessor(ctx.orgId);
  if (s?.confirmedBy && s.switchAt.getTime() <= Date.now()) {
    await gateCall<{ seq: number | null }>(ctx, "console-signing/successor/settle", {});
    await syncDoc(ctx.orgId, docOf(ctx));
  }
  return ctx.original(...ctx.args);
});
