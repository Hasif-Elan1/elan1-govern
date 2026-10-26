import {
  GENESIS,
  PACK_BUNDLE_NAME,
  buildBundle,
  keyFingerprint,
  verifyChain,
  type Receipt,
} from "@gate/core";
import { allOrgIds, createCheckpoint, evidenceCounts, forOrg, startOfDayIST, toCheckpoint } from "@gate/db";
import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { adminEvent } from "./admin";
import { orgKey, raiseAlert, type Deps } from "./deps";

export interface Range {
  from: string; // YYYY-MM-DD, IST
  to: string;
}

export function rangeDates(r: Range) {
  const from = startOfDayIST(new Date(`${r.from}T12:00:00+05:30`));
  const to = new Date(startOfDayIST(new Date(`${r.to}T12:00:00+05:30`)).getTime() + 86_400_000 - 1);
  return { from, to };
}

async function rangeData(deps: Deps, orgId: string, r: Range) {
  const db = forOrg(orgId, deps.db);
  const { from, to } = rangeDates(r);
  const rows = await db.receipt.findMany({ where: { ts: { gte: from, lte: to } }, orderBy: { seq: "asc" } });
  const receipts = rows.map((row) => row.body as unknown as Receipt);
  const first = receipts[0];
  let anchor = GENESIS;
  if (first && first.seq > 1) {
    const prev = await db.receipt.findFirstOrThrow({ where: { seq: first.seq - 1 } });
    anchor = { seq: prev.seq, hash: prev.hash };
  } else if (!first) {
    const before = await db.receipt.findFirst({ where: { ts: { lt: from } }, orderBy: { seq: "desc" } });
    if (before) anchor = { seq: before.seq, hash: before.hash };
  }
  const last = receipts.at(-1);
  const cps = first && last ? await db.checkpoint.findMany({ where: { seq: { gte: first.seq, lte: last.seq } }, orderBy: { seq: "asc" } }) : [];
  return { receipts, anchor, checkpoints: cps.map(toCheckpoint), dates: { from, to } };
}

export async function exportBundle(deps: Deps, orgId: string, r: Range, actor: string): Promise<Uint8Array> {
  const key = await orgKey(deps, orgId);
  await adminEvent(deps, orgId, actor, "evidence.exported", { from: r.from, to: r.to, kind: "bundle" });
  await createCheckpoint(orgId, key.privateKeyPem, deps.db);
  const data = await rangeData(deps, orgId, r);
  return buildBundle({ org: { id: orgId, name: key.name }, range: { from: r.from, to: r.to }, anchor: data.anchor, receipts: data.receipts, checkpoints: data.checkpoints, publicKeyPem: key.publicKeyPem, privateKeyPem: key.privateKeyPem, generatedAt: new Date().toISOString() });
}

export async function exportPack(deps: Deps, orgId: string, r: Range, actor: string): Promise<Uint8Array> {
  const bundle = await exportBundle(deps, orgId, r, actor);
  const key = await orgKey(deps, orgId);
  const data = await rangeData(deps, orgId, r);
  const pdf = await summaryPdf(deps, orgId, key.name, key.publicKeyPem, r, data);
  const readme = `Gate auditor pack for ${key.name}, ${r.from} to ${r.to}\n\nsummary.pdf          a readable summary\n${PACK_BUNDLE_NAME}  the signed receipts\n\nVerify offline:  gate verify <this-file>.zip\nKey fingerprint: ${keyFingerprint(key.publicKeyPem)}\n`;
  return zipSync({ "summary.pdf": pdf, [PACK_BUNDLE_NAME]: bundle, "README.txt": strToU8(readme) }, { level: 6 });
}

// ---- PDF ----

/** Standard PDF fonts use WinAnsi, which has no rupee sign. */
const pdfText = (s: string) => s.replace(/\u20B9/g, "Rs ").replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, "?");
const inr = (n: number) => `Rs ${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n)}`;

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([595, 842]);
    this.y = 790;
  }
  ensure(h: number) {
    if (this.y - h < 60) this.newPage();
  }
  text(s: string, opts: { size?: number; bold?: boolean; color?: [number, number, number]; x?: number; gap?: number } = {}) {
    const size = opts.size ?? 10;
    this.ensure(size + 6);
    this.page.drawText(pdfText(s), { x: opts.x ?? 56, y: this.y, size, font: opts.bold ? this.bold : this.font, color: rgb(...(opts.color ?? [0.11, 0.11, 0.1])) });
    this.y -= size + (opts.gap ?? 6);
  }
  row(cells: string[], widths: number[], bold = false) {
    this.ensure(16);
    let x = 56;
    cells.forEach((c, i) => {
      const w = widths[i] ?? 100;
      const f = bold ? this.bold : this.font;
      let t = pdfText(c);
      if (f.widthOfTextAtSize(t, 9) > w - 6) {
        while (t.length > 1 && f.widthOfTextAtSize(`${t}…`, 9) > w - 6) t = t.slice(0, -1);
        t = `${t}…`;
      }
      this.page.drawText(t, { x, y: this.y, size: 9, font: f, color: rgb(0.15, 0.15, 0.14) });
      x += w;
    });
    this.y -= 15;
  }
  rule() {
    this.ensure(10);
    this.page.drawLine({ start: { x: 56, y: this.y + 4 }, end: { x: 539, y: this.y + 4 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.83) });
    this.y -= 8;
  }
  space(h = 10) {
    this.y -= h;
  }
}

async function summaryPdf(deps: Deps, orgId: string, orgName: string, publicKeyPem: string, r: Range, data: Awaited<ReturnType<typeof rangeData>>) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Gate auditor pack — ${orgName} — ${r.from} to ${r.to}`);
  doc.setProducer("Gate");
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  const { receipts } = data;
  const chain = verifyChain(receipts, publicKeyPem, { anchor: data.anchor, checkpoints: data.checkpoints });
  const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

  w.text("Gate · Auditor pack", { size: 10, color: [0.42, 0.42, 0.4] });
  w.text(orgName, { size: 22, bold: true, gap: 10 });
  w.text(`Period: ${r.from} to ${r.to} (India time)   ·   Generated ${ist} IST`, { color: [0.3, 0.3, 0.28] });
  w.text(`Signing key fingerprint: ${keyFingerprint(publicKeyPem)}`, { color: [0.3, 0.3, 0.28], gap: 14 });

  w.text("Evidence chain", { size: 13, bold: true });
  if (chain.ok) {
    w.text(chain.count ? `Chain intact: ${chain.count} receipts (seq ${chain.firstSeq}–${chain.lastSeq}), ${chain.checkpoints} signed checkpoints.` : "No receipts in this period.");
  } else {
    w.text(`Chain broken at seq ${chain.seq}: ${chain.reason}`, { color: [0.7, 0.1, 0.1] });
  }
  w.text("Re-check it yourself, offline: gate verify <auditor-pack>.zip", { color: [0.3, 0.3, 0.28], gap: 14 });

  const decisions = receipts.filter((x) => x.kind === "decision");
  const resolutions = receipts.filter((x) => x.kind === "approval");
  const count = (rs: Receipt[], f: (x: Receipt) => boolean) => rs.filter(f).length;
  w.text("What the agents did", { size: 13, bold: true });
  w.row(["", "Count"], [300, 100], true);
  w.rule();
  w.row(["Actions checked", String(decisions.length)], [300, 100]);
  w.row(["Allowed", String(count(decisions, (x) => x.decision === "allow"))], [300, 100]);
  w.row(["Sent to a person", String(count(decisions, (x) => x.decision === "ask"))], [300, 100]);
  w.row(["Refused", String(count(decisions, (x) => x.decision === "refuse"))], [300, 100]);
  w.row(["Approved", String(count(resolutions, (x) => x.approval?.result === "approved"))], [300, 100]);
  w.row(["Rejected", String(count(resolutions, (x) => x.approval?.result === "rejected"))], [300, 100]);
  w.row(["Expired (refused)", String(count(resolutions, (x) => x.approval?.result === "expired"))], [300, 100]);
  w.row(["Approved by the person who set up the agent", String(count(resolutions, (x) => x.approval?.self_approval === true))], [300, 100]);
  const paid = receipts.filter((x) => x.tool === "zoho.record_bill_payment" && x.outcome?.status === "ok").reduce((s, x) => s + (Number(x.args_summary?.amount_inr) || 0), 0);
  w.row(["Payments recorded", inr(paid)], [300, 100]);
  w.space();

  const refusals = new Map<string, number>();
  for (const x of decisions.filter((d) => d.decision === "refuse")) refusals.set(x.rule_id ?? "?", (refusals.get(x.rule_id ?? "?") ?? 0) + 1);
  if (refusals.size) {
    w.text("Refusals by rule", { size: 13, bold: true });
    w.row(["Rule", "Refused"], [300, 100], true);
    w.rule();
    for (const [rule, n] of [...refusals].sort((a, b) => b[1] - a[1])) w.row([rule, String(n)], [300, 100]);
    w.space();
  }

  const admin = receipts.filter((x) => x.kind === "admin");
  if (admin.length) {
    w.text("Changes to the setup", { size: 13, bold: true });
    w.row(["Seq", "When (IST)", "Who", "What"], [50, 120, 150, 163], true);
    w.rule();
    for (const x of admin.slice(-40)) {
      const when = new Date(x.ts).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" });
      w.row([String(x.seq), when, x.actor ?? "", `${x.action ?? ""}${x.agent ? ` (${x.agent})` : ""}`], [50, 120, 150, 163]);
    }
    w.space();
  }

  const controls = await forOrg(orgId, deps.db).control.findMany({ orderBy: { code: "asc" } });
  const counts = await evidenceCounts(orgId, data.dates, deps.db);
  w.newPage();
  w.text("Compliance map", { size: 13, bold: true });
  w.text("DRAFT — NEEDS LEGAL REVIEW. Clause references show where a reviewer might look; they are not a claim of compliance.", { size: 9, color: [0.6, 0.35, 0.05], gap: 10 });
  w.row(["Control", "Framework references", "Evidence"], [190, 233, 60], true);
  w.rule();
  for (const c of controls) {
    const maps = (c.mappings as { framework: string; clause: string }[]).map((m) => `${m.framework} ${m.clause}`);
    w.row([`${c.code} ${c.title}`, maps.slice(0, 2).join("; "), String(counts[c.evidence as keyof typeof counts] ?? 0)], [190, 233, 60]);
    for (let i = 2; i < maps.length; i += 2) w.row(["", maps.slice(i, i + 2).join("; "), ""], [190, 233, 60]);
  }
  return doc.save();
}

/** Hourly: sign the head of every org's chain. */
export async function checkpointAll(deps: Deps) {
  for (const orgId of await allOrgIds(deps.db)) {
    try {
      await createCheckpoint(orgId, (await orgKey(deps, orgId)).privateKeyPem, deps.db);
    } catch (e) {
      await raiseAlert(deps, "checkpoint-failed", (e as Error).message, orgId);
    }
  }
}
