import { PILOT, invoicePrefix, pilotPaused, pilotRefusalReason, pilotState, pilotUsage, type PilotRecord, type PilotState } from "@gate/core";
import { forOrg, meterReceipts, pilotDecisionCount } from "@gate/db";
import { SYSTEM_ACTOR } from "./behaviour";
import { chain } from "./chain";
import type { Deps } from "./deps";

const D = 86_400_000;

type PilotRow = {
  pilotStartsAt: Date | null;
  pilotEndsAt: Date | null;
  pilotCap: number | null;
  pilotStoppedAt: Date | null;
  pilotStoppedWhy: string | null;
  pilotConvertedAt: Date | null;
  pilotClosedAt: Date | null;
};

const PILOT_FIELDS = { pilotStartsAt: true, pilotEndsAt: true, pilotCap: true, pilotStoppedAt: true, pilotStoppedWhy: true, pilotConvertedAt: true, pilotClosedAt: true } as const;

function recordOf(a: PilotRow & { pilotStartsAt: Date }): PilotRecord {
  return {
    starts: a.pilotStartsAt.toISOString(),
    ...(a.pilotEndsAt ? { ends: a.pilotEndsAt.toISOString() } : {}),
    ...(a.pilotCap !== null ? { cap: a.pilotCap } : {}),
    ...(a.pilotStoppedAt ? { stoppedAt: a.pilotStoppedAt.toISOString(), stoppedWhy: a.pilotStoppedWhy ?? "" } : {}),
    ...(a.pilotConvertedAt ? { convertedAt: a.pilotConvertedAt.toISOString() } : {}),
    ...(a.pilotClosedAt ? { closedAt: a.pilotClosedAt.toISOString() } : {}),
  };
}

/** Where the organisation's pilot stands now, or undefined when it has none (or it moved to the paid plan). */
export async function pilotNow(deps: Deps, orgId: string, now = Date.now()): Promise<PilotState | undefined> {
  const acct = await forOrg(orgId, deps.db).billingAccount.findFirst({ select: PILOT_FIELDS });
  if (!acct?.pilotStartsAt || acct.pilotConvertedAt) return undefined;
  const record = recordOf({ ...acct, pilotStartsAt: acct.pilotStartsAt });
  const cap = record.cap ?? PILOT.cap;
  let usage: { used: number; capAt?: number } = { used: await pilotDecisionCount(orgId, acct.pilotStartsAt, null, deps.db) };
  // at the cap, once (until the stop is recorded): read the chain for the moment it was reached, as the 30
  // read-only days run from there
  if (!acct.pilotStoppedAt && usage.used >= cap) usage = pilotUsage(await meterReceipts(orgId, acct.pilotStartsAt, null, deps.db), record);
  return pilotState(record, usage, now);
}

/**
 * The pilot's hard stop, checked by the guard before any rule runs. While the pilot is stopped (2,000 production
 * actions used, the 90 days over, or ended early by an owner), read-only, or closed, every guarded call is refused.
 * The stop and the closure are each recorded once, as receipts, the first time a call finds them due.
 */
export async function pilotGate(deps: Deps, orgId: string, now = Date.now()): Promise<{ ruleId: string; reason: string } | undefined> {
  const state = await pilotNow(deps, orgId, now);
  if (!pilotPaused(state)) return undefined;
  await recordPilotStop(deps, orgId, state!);
  return { ruleId: PILOT.ruleId, reason: pilotRefusalReason(state!) };
}

/** Writes the billing.pilot_stopped and billing.pilot_closed receipts once each, in the same transaction as the row. */
async function recordPilotStop(deps: Deps, orgId: string, s: PilotState) {
  await chain(deps, orgId, async (append, tx) => {
    if (s.stoppedAt) {
      const n = await tx.billingAccount.updateMany({ where: { pilotStoppedAt: null }, data: { pilotStoppedAt: new Date(s.stoppedAt), pilotStoppedWhy: s.stoppedWhy ?? null } });
      if (n.count) {
        const r = await append({ kind: "admin", actor: SYSTEM_ACTOR, action: "billing.pilot_stopped", details: { why: s.stoppedWhy ?? "", used: s.used, cap: s.cap, code: PILOT.code, at: s.stoppedAt, read_only_days: PILOT.readOnlyDays } });
        await tx.billingAccount.updateMany({ data: { pilotStoppedSeq: r.seq } });
      }
    }
    if (s.status === "closed" && s.closedAt) {
      const n = await tx.billingAccount.updateMany({ where: { pilotClosedAt: null }, data: { pilotClosedAt: new Date(s.closedAt) } });
      if (n.count) await append({ kind: "admin", actor: SYSTEM_ACTOR, action: "billing.pilot_closed", details: { at: s.closedAt, read_only_days: PILOT.readOnlyDays } });
    }
  });
}

/** Opens the organisation's billing account on the ₹0 Guarded pilot. Writes billing.pilot_started. */
export async function startPilot(deps: Deps, orgId: string, actor: string, opts: { at?: Date; cap?: number } = {}) {
  const starts = opts.at ?? new Date();
  const ends = new Date(starts.getTime() + PILOT.days * D);
  const cap = opts.cap ?? PILOT.cap;
  return chain(deps, orgId, async (append, tx) => {
    const org = await tx.org.findFirstOrThrow({ select: { name: true } });
    const existing = await tx.billingAccount.findFirst({ select: { pilotStartsAt: true } });
    if (existing?.pilotStartsAt) return { ok: false as const, error: "This organisation has already had its pilot." };
    const data = { plan: PILOT.listPlan, pilotStartsAt: starts, pilotEndsAt: ends, pilotCap: cap };
    if (existing) await tx.billingAccount.updateMany({ data });
    else await tx.billingAccount.create({ data: { orgId, invoicePrefix: invoicePrefix(org.name), buyerName: org.name, ...data } });
    const r = await append({ kind: "admin", actor, action: "billing.pilot_started", details: { starts: starts.toISOString(), ends: ends.toISOString(), cap, list_plan: PILOT.listPlan } });
    return { ok: true as const, seq: r.seq };
  });
}

/** An owner moves the pilot to the paid Guarded plan: billing starts now and a stop is lifted. Writes billing.pilot_converted. */
export async function convertPilot(deps: Deps, orgId: string, actor: string, at = new Date()) {
  const state = await pilotNow(deps, orgId, at.getTime());
  if (!state) return { ok: false as const, error: "This organisation is not on a pilot." };
  if (state.status === "closed") return { ok: false as const, error: "The organisation is closed: its 30 read-only days have passed. Ask elan1 to reopen it." };
  return chain(deps, orgId, async (append, tx) => {
    const n = await tx.billingAccount.updateMany({ where: { pilotConvertedAt: null }, data: { pilotConvertedAt: at, pilotConvertedTo: PILOT.listPlan } });
    if (!n.count) return { ok: false as const, error: "The pilot has already moved to the paid plan." };
    const r = await append({ kind: "admin", actor, action: "billing.pilot_converted", details: { plan: PILOT.listPlan, used: state.used, cap: state.cap, billed_from: at.toISOString() } });
    return { ok: true as const, seq: r.seq };
  });
}
