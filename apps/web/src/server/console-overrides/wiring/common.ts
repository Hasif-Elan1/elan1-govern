import "server-only";
import { forOrg, prisma } from "@gate/db";
import { HttpError } from "../../api";
import { syncDoc, type ChainDoc } from "../../console-chain";
import { gate } from "../../gate";
import { overrideOp, type OverrideCtx } from "../../console-overrides";
import type { Role } from "../../policy";
import { currentSession, isFresh } from "../../session";

/*
 * What every wiring override shares (apps/web/src/server/console-overrides/wiring.ts). An override:
 *  1. checks who may do it as the real backend does (the real Membership, not the document's member list);
 *  2. makes the real change: through the gate (`wire`, /internal/orgs/:org/wiring/…), which writes the receipt
 *     in the console's words on the real chain, or through a web server function that does the same;
 *  3. brings the document up to the chain (the receipts the gate just wrote) and in line with the real tables,
 *     so the screens' synchronous reads show the real values; the bridge then saves it with the operation.
 * The document must hold no provisional receipt when the gate writes one (`onChain`): the bridge would then
 * write the provisional one after a head that moved and run the whole operation (and its real change) again.
 */

export type Ctx = OverrideCtx;

type Queued = [string, (ctx: Ctx) => unknown][];

/** Overrides waiting to be registered (kept off module scope: see override). */
function queued(): Queued {
  const g = globalThis as unknown as { __gateWiringQueue?: Queued };
  return (g.__gateWiringQueue ??= []);
}

function registerQueued() {
  const q = queued();
  while (q.length) {
    const [name, f] = q[0]!;
    try {
      overrideOp(name, f);
    } catch (e) {
      // console-overrides.ts has not finished loading (a loader that evaluates modules asynchronously, such as
      // vitest's): try again on the next turn, the rest of the queue with it
      if (e instanceof ReferenceError) {
        setTimeout(registerQueued, 0);
        return;
      }
      throw e;
    }
    q.shift();
  }
}

/**
 * Register an override. console-overrides.ts imports these modules and they import it back, so whichever loads
 * first, the other may still be loading: an override is registered a microtask later, once the module graph has
 * loaded (long before any operation runs), and nothing here touches module state while it loads.
 */
export function override(op: string, fn: (ctx: Ctx) => unknown) {
  const q = queued();
  q.push([op, fn]);
  if (q.length === 1) queueMicrotask(registerQueued);
}
// the document as these modules read it: plain JSON objects
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any>;

export const docOf = (ctx: Ctx): Doc => ctx.domain.db.getDB(ctx.orgId) as unknown as Doc;

/** Tell the screens what changed (the kinds they refetch on). */
export const touch = (ctx: Ctx, kind: string) => ctx.domain.db.touch(ctx.orgId, kind);

/** The person's role in the organisation: an active member's, or none (invited, suspended, removed, never). */
export async function realRole(orgId: string, userId: string): Promise<Role | null> {
  const m = await forOrg(orgId).membership.findFirst({ where: { userId, status: "active" }, select: { role: true } });
  return (m?.role as Role | undefined) ?? null;
}

/** Refuse unless the person holds one of `roles` here, in the console's words. */
export async function requireRole(ctx: Ctx, roles: readonly Role[], what: string): Promise<Role> {
  const role = await realRole(ctx.orgId, ctx.actorUserId);
  if (!role || !roles.includes(role)) throw new Error(`${what} — ${roles.map((r) => `${r}s`).join(" and ")} can do this; your role cannot.`);
  return role;
}

/** The signed-in person's email (receipts the web app's own routes write name people by email). */
export async function emailOf(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!u) throw new Error("Your account no longer exists.");
  return u.email;
}

/** The real routes ask for a sign-in within the last 10 minutes before these changes; so do the overrides. */
export async function requireFresh() {
  const s = await currentSession();
  if (!s || !isFresh(s.lastAuthAt)) throw new HttpError(401, "Confirm it's you to continue: sign in again, then try once more.", { reauth: true });
}

/** Refuse before a real change when the document holds a receipt the chain has not written yet. */
export function onChain(ctx: Ctx) {
  const pending = ctx.domain.db.PENDING;
  if ((docOf(ctx).receipts as { hash: string }[]).some((r) => r.hash.startsWith(pending))) {
    throw new Error("Elan1 Govern is still recording an earlier change for this organisation. Nothing was changed; try again.");
  }
}

/** Bring the document up to the chain: the receipts the real change just wrote. */
export async function pull(ctx: Ctx) {
  await syncDoc(ctx.orgId, docOf(ctx) as unknown as ChainDoc);
}

/**
 * A real change through the gate: POST /internal/orgs/:org/wiring/<path>. Its refusal comes back as the console
 * shows refusals (an Error with the gate's sentence); afterwards the document holds the receipts it wrote.
 */
export async function wire<T = Record<string, unknown>>(ctx: Ctx, path: string, body: unknown, fallback = "Elan1 Govern could not make this change. Nothing was changed."): Promise<T> {
  onChain(ctx);
  let r: { status: number; data: T & { error?: string } };
  try {
    r = await gate<T & { error?: string }>("POST", `/internal/orgs/${encodeURIComponent(ctx.orgId)}/wiring/${path}`, body);
  } catch {
    throw new Error("Elan1 Govern is not reachable, so nothing was changed. Try again in a moment.");
  }
  if (r.status !== 200) {
    // a refusal may still have recorded something (a blocked egress attempt): the document shows it too
    await pull(ctx).catch(() => undefined);
    throw new Error(r.data.error ?? fallback);
  }
  await pull(ctx);
  return r.data;
}

/** The receipt a real change wrote, as the document now holds it. */
export function receiptAt(ctx: Ctx, seq: number) {
  return (docOf(ctx).receipts as { seq: number }[]).find((r) => r.seq === seq);
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
