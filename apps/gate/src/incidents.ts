import { describeAction, keyFingerprint, type Receipt } from "@gate/core";
import { forOrg } from "@gate/db";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { adminEvent } from "./admin";
import { background, chain } from "./chain";
import type { Deps } from "./deps";
import { orgKey } from "./deps";
import { Writer } from "./evidence";
import { noticeEmail, ownersAndAdmins, sendAll } from "./notices";

// The emergency stop: pause every agent in the org at once, and later resume exactly those.

export type StopResult = { ok: true; incidentId: string; paused: number; seq: number } | { ok: false; status: 409; error: string };

export async function emergencyStop(deps: Deps, orgId: string, actor: string, reason?: string): Promise<StopResult> {
  const out = await chain(deps, orgId, async (append, tx) => {
    if (await tx.incident.findFirst({ where: { status: "open" } })) return { ok: false as const, status: 409 as const, error: "An emergency stop is already in place. Resume agents first." };
    const active = await tx.agent.findMany({ where: { status: "active" }, select: { id: true } });
    const ids = active.map((a) => a.id);
    if (ids.length) await tx.agent.updateMany({ where: { id: { in: ids } }, data: { status: "paused" } });
    const incident = await tx.incident.create({ data: { orgId, startedBy: actor, reason: reason ?? null, pausedAgentIds: ids } });
    const r = await append({ kind: "admin", actor, action: "emergency.stop", details: { count: ids.length, incident_id: incident.id, ...(reason ? { reason } : {}) } });
    await tx.incident.update({ where: { id: incident.id }, data: { startSeq: r.seq } });
    return { ok: true as const, incidentId: incident.id, paused: ids.length, seq: r.seq };
  });
  if (out.ok) {
    background(
      deps,
      ownersAndAdmins(deps, orgId).then((to) =>
        sendAll(
          deps,
          to,
          (addr) =>
            noticeEmail({
              to: addr,
              kicker: "emergency stop",
              title: `Emergency stop: all agents are paused`,
              body: [`${actor} used the emergency stop. Elan1 Govern paused ${out.paused === 1 ? "1 agent" : `${out.paused} agents`} at once and refuses every call they make.`, ...(reason ? [`Reason given: ${reason}`] : []), "Agents stay paused until an owner or admin presses Resume agents."],
              link: `${deps.env.WEB_URL}/alerts`,
              linkLabel: "Open Elan1 Govern",
              urgent: true,
            }),
          "emergency-stop",
          orgId,
        ),
      ),
    );
  }
  return out;
}

export type ResumeResult = { ok: true; incidentId: string; resumed: number; seq: number } | { ok: false; status: 409; error: string };

/** Resumes only the agents the stop paused that are still paused; anything paused for another reason stays paused. */
export async function resumeAfterStop(deps: Deps, orgId: string, actor: string): Promise<ResumeResult> {
  return chain(deps, orgId, async (append, tx) => {
    const incident = await tx.incident.findFirst({ where: { status: "open" } });
    if (!incident) return { ok: false as const, status: 409 as const, error: "There is no emergency stop to undo." };
    const still = await tx.agent.findMany({ where: { id: { in: incident.pausedAgentIds }, status: "paused" }, select: { id: true } });
    const ids = still.map((a) => a.id);
    if (ids.length) await tx.agent.updateMany({ where: { id: { in: ids } }, data: { status: "active" } });
    const r = await append({ kind: "admin", actor, action: "emergency.resumed", details: { count: ids.length, incident_id: incident.id } });
    await tx.incident.update({ where: { id: incident.id }, data: { status: "closed", endedBy: actor, endedAt: new Date(), endSeq: r.seq, resumedCount: ids.length } });
    return { ok: true as const, incidentId: incident.id, resumed: ids.length, seq: r.seq };
  });
}

// ---- Incident report ----

const ACTION_WORDS: Record<string, (r: Receipt) => string> = {
  "emergency.stop": (r) => `Emergency stop: paused ${String((r.details as Record<string, unknown>)?.count ?? "every")} agents`,
  "emergency.resumed": (r) => `Resumed ${String((r.details as Record<string, unknown>)?.count ?? "the")} agents paused by the stop`,
  "alert.created": (r) => `Alert (${String((r.details as Record<string, unknown>)?.severity ?? "")}): ${String((r.details as Record<string, unknown>)?.title ?? "")}`,
  "alert.acknowledged": (r) => `Acknowledged the alert: ${String((r.details as Record<string, unknown>)?.title ?? "")}`,
  "alert.resolved": (r) => `Resolved the alert: ${String((r.details as Record<string, unknown>)?.title ?? "")}`,
  "agent.paused": (r) => ((r.details as Record<string, unknown>)?.reason === "auto-pause" ? `Paused automatically after an alert` : "Paused the agent"),
  "agent.resumed": () => "Resumed the agent",
};

export function receiptLine(r: Receipt): string {
  if (r.kind === "admin") return ACTION_WORDS[r.action ?? ""]?.(r) ?? (r.action ?? "Setup change");
  const what = describeAction(r.tool ?? "", r.args_summary ?? {});
  if (r.kind === "approval") return `${r.approval?.result ?? "decided"}: ${what}`;
  if (r.kind === "outcome") return `Reported: ${what}`;
  return `${r.decision === "allow" ? "Allowed" : r.decision === "ask" ? "Asked a person" : "Refused"}: ${what}`;
}

/** Where to look for a report: an hour before the stop, to the resume (or now). */
export function incidentWindow(i: { startedAt: Date; endedAt: Date | null }, now = new Date()) {
  return { from: new Date(i.startedAt.getTime() - 3_600_000), to: i.endedAt ?? now };
}

/** A plain-English PDF of an emergency stop, with the receipt range to check against an evidence bundle. */
export async function incidentReport(deps: Deps, orgId: string, incidentId: string, actor: string): Promise<Uint8Array | null> {
  const db = forOrg(orgId, deps.db);
  const incident = await db.incident.findFirst({ where: { id: incidentId } });
  if (!incident) return null;
  await adminEvent(deps, orgId, actor, "evidence.exported", { kind: "incident-report", incident_id: incident.id });
  const key = await orgKey(deps, orgId);
  const org = await db.org.findFirstOrThrow({ select: { timezone: true } });
  const tz = org.timezone;
  const win = incidentWindow(incident);
  const rows = await db.receipt.findMany({ where: { ts: { gte: win.from, lte: win.to } }, orderBy: { seq: "asc" }, take: 5000, select: { body: true } });
  const receipts = rows.map((r) => r.body as unknown as Receipt).filter((r) => !(r.action === "evidence.exported" && (r.details as Record<string, unknown>)?.incident_id === incident.id));
  const alerts = await db.behaviourAlert.findMany({ where: { createdAt: { gte: win.from, lte: win.to } }, orderBy: { createdAt: "asc" }, take: 200 });
  const agents = await db.agent.findMany({ where: { id: { in: incident.pausedAgentIds } }, select: { slug: true, name: true } });
  const when = (d: Date | string) => new Date(d).toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

  const doc = await PDFDocument.create();
  doc.setTitle(`Elan1 Govern incident report — ${key.name} — ${when(incident.startedAt)}`);
  doc.setProducer("Elan1 Govern");
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  const grey: [number, number, number] = [0.3, 0.3, 0.28];

  w.text("Elan1 Govern · Incident report", { size: 10, color: [0.42, 0.42, 0.4] });
  w.text(key.name, { size: 22, bold: true, gap: 10 });
  w.text(`Emergency stop on ${when(incident.startedAt)} (${tz})   ·   Generated ${when(new Date())}`, { color: grey });
  w.text(`Signing key fingerprint: ${keyFingerprint(key.publicKeyPem)}`, { color: grey, gap: 14 });

  w.text("What happened", { size: 13, bold: true });
  w.para(
    `${incident.startedBy} used the emergency stop on ${when(incident.startedAt)}. Elan1 Govern paused ${incident.pausedAgentIds.length === 1 ? "1 agent" : `${incident.pausedAgentIds.length} agents`} at once, in one step, and refused every call they made from then on${incident.startSeq ? ` (receipt ${incident.startSeq})` : ""}.${incident.reason ? ` Reason given: ${incident.reason}.` : ""}`,
    { gap: 6 },
  );
  w.para(
    incident.endedAt
      ? `${incident.endedBy} resumed the agents on ${when(incident.endedAt)} (receipt ${incident.endSeq}). ${incident.resumedCount ?? 0} of them were started again; agents that had been paused for another reason, or paused again since, were left paused.`
      : "The agents are still paused. Nothing they try will run until an owner or admin presses Resume agents.",
    { gap: 12 },
  );

  w.text("Who", { size: 13, bold: true });
  w.row(["Stopped by", incident.startedBy, when(incident.startedAt)], [110, 220, 153]);
  w.row(["Resumed by", incident.endedBy ?? "Not resumed yet", incident.endedAt ? when(incident.endedAt) : ""], [110, 220, 153]);
  w.row(["Agents paused", agents.map((a) => a.slug).join(", ") || "None were running"], [110, 373]);
  w.space();

  w.text("Alerts in this window", { size: 13, bold: true });
  if (!alerts.length) w.text("No unusual-behaviour alerts were raised in this window.", { color: grey, gap: 10 });
  else {
    w.row(["When", "Agent", "Severity", "Alert", "Status"], [95, 70, 55, 213, 50], true);
    w.rule();
    for (const a of alerts) w.row([when(a.createdAt), a.agentSlug, a.severity, a.title, a.status], [95, 70, 55, 213, 50]);
    w.space();
  }

  w.text("Timeline of receipts", { size: 13, bold: true });
  w.text(`From ${when(win.from)} (an hour before the stop) to ${when(win.to)}.`, { color: grey });
  w.row(["Seq", "When", "Agent or person", "What"], [45, 95, 110, 233], true);
  w.rule();
  for (const r of receipts.slice(0, 300)) w.row([String(r.seq), when(r.ts), r.agent ?? r.actor ?? "", receiptLine(r)], [45, 95, 110, 233]);
  if (receipts.length > 300) w.text(`…and ${receipts.length - 300} more receipts in the evidence bundle.`, { color: grey });
  w.space();

  w.text("Check it yourself", { size: 13, bold: true });
  const first = receipts[0]?.seq;
  const last = receipts.at(-1)?.seq;
  w.para(
    first !== undefined
      ? `This report covers receipts ${first} to ${last}. On the Evidence page, download an evidence bundle for ${day(win.from)} to ${day(win.to)} (India time), then run: govern verify <bundle>.zip. It checks every receipt's signature and chain link offline; receipts ${first} to ${last} in the bundle are the ones listed here.`
      : "There are no receipts in this window.",
    { gap: 6 },
  );
  return doc.save();
}
