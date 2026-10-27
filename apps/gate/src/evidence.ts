import {
  GENESIS,
  PACK_BUNDLE_NAME,
  buildBundle,
  keyFingerprint,
  verifyChain,
  type Receipt,
} from "@gate/core";
import { CONTROLS, controlsFor, EVIDENCE_LABELS, frameworkById, frameworkCoverage, LEGAL_REVIEW_NOTE } from "@gate/core/frameworks";
import { allOrgIds, enabledFrameworks, evidenceCounts, forOrg, orgPublicKeys, startOfDayIST, toCheckpoint } from "@gate/db";
import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { adminEvent } from "./admin";
import { checkpoint } from "./chain";
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
  return { receipts, anchor, checkpoints: cps.map(toCheckpoint), dates: { from, to }, keys: await orgPublicKeys(orgId, deps.db) };
}

export async function exportBundle(deps: Deps, orgId: string, r: Range, actor: string): Promise<Uint8Array> {
  const key = await orgKey(deps, orgId);
  await adminEvent(deps, orgId, actor, "evidence.exported", { from: r.from, to: r.to, kind: "bundle" });
  await checkpoint(deps, orgId);
  const data = await rangeData(deps, orgId, r);
  return buildBundle({ org: { id: orgId, name: key.name }, range: { from: r.from, to: r.to }, anchor: data.anchor, receipts: data.receipts, checkpoints: data.checkpoints, publicKeyPem: key.publicKeyPem, privateKeyPem: key.privateKeyPem, publicKeys: data.keys, generatedAt: new Date().toISOString() });
}

export async function exportPack(deps: Deps, orgId: string, r: Range, actor: string): Promise<Uint8Array> {
  const bundle = await exportBundle(deps, orgId, r, actor);
  const key = await orgKey(deps, orgId);
  const data = await rangeData(deps, orgId, r);
  const pdf = await summaryPdf(deps, orgId, key.name, key.publicKeyPem, r, data);
  const readme = `Elan1 Govern auditor pack for ${key.name}, ${r.from} to ${r.to}\n\nsummary.pdf          a readable summary\n${PACK_BUNDLE_NAME}  the signed receipts\n\nVerify offline:  govern verify <this-file>.zip\nKey fingerprint: ${keyFingerprint(key.publicKeyPem)}\n`;
  return zipSync({ "summary.pdf": pdf, [PACK_BUNDLE_NAME]: bundle, "README.txt": strToU8(readme) }, { level: 6 });
}

// ---- PDF ----

/** Standard PDF fonts use WinAnsi, which has no rupee sign. */
export const pdfText = (s: string) => s.replace(/\u20B9/g, "Rs ").replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, "?");
const inr = (n: number) => `Rs ${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n)}`;

export class Writer {
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
  /** Text wrapped to the page width. */
  para(s: string, opts: { size?: number; bold?: boolean; color?: [number, number, number]; x?: number; width?: number; gap?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    const width = opts.width ?? 539 - (opts.x ?? 56);
    const lines: string[] = [];
    let line = "";
    for (const word of pdfText(s).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(next, size) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    lines.forEach((l, i) => this.text(l, { ...opts, gap: i === lines.length - 1 ? opts.gap : 3 }));
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
  doc.setTitle(`Elan1 Govern auditor pack — ${orgName} — ${r.from} to ${r.to}`);
  doc.setProducer("Elan1 Govern");
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  const { receipts } = data;
  const chain = verifyChain(receipts, data.keys, { anchor: data.anchor, checkpoints: data.checkpoints });
  const ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

  w.text("Elan1 Govern · Auditor pack", { size: 10, color: [0.42, 0.42, 0.4] });
  w.text(orgName, { size: 22, bold: true, gap: 10 });
  w.text(`Period: ${r.from} to ${r.to} (India time)   ·   Generated ${ist} IST`, { color: [0.3, 0.3, 0.28] });
  const retired = data.keys.filter((k) => k.retiredAt);
  w.text(`Signing key fingerprint: ${keyFingerprint(publicKeyPem)}`, { color: [0.3, 0.3, 0.28], gap: retired.length ? 6 : 14 });
  if (retired.length) w.text(`Earlier keys, kept for verification: ${retired.map((k) => `${k.kid} (retired ${k.retiredAt?.slice(0, 10)})`).join(", ")}`, { size: 9, color: [0.3, 0.3, 0.28], gap: 14 });

  w.text("Evidence chain", { size: 13, bold: true });
  if (chain.ok) {
    w.text(chain.count ? `Chain intact: ${chain.count} receipts (seq ${chain.firstSeq}–${chain.lastSeq}), ${chain.checkpoints} signed checkpoints.` : "No receipts in this period.");
  } else {
    w.text(`Chain broken at seq ${chain.seq}: ${chain.reason}`, { color: [0.7, 0.1, 0.1] });
  }
  w.text("Re-check it yourself, offline: govern verify <auditor-pack>.zip", { color: [0.3, 0.3, 0.28], gap: 14 });

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

  const enabled = (await enabledFrameworks(orgId, deps.db)).map((f) => frameworkById(f.frameworkId)!);
  const counts = await evidenceCounts(orgId, data.dates, deps.db);
  w.newPage();
  w.text("Compliance map", { size: 13, bold: true });
  w.text(`${LEGAL_REVIEW_NOTE.toUpperCase()}. References show where a reviewer might look; they are not a claim of compliance.`, { size: 9, color: [0.6, 0.35, 0.05], gap: 10 });
  if (!enabled.length) {
    w.text("No frameworks are switched on for this organisation. Turn them on under Compliance in Elan1 Govern.");
    return doc.save();
  }
  w.row(["Control", "Framework references", "Evidence"], [190, 233, 60], true);
  w.rule();
  const shown = new Set(enabled.map((f) => f.id));
  for (const c of CONTROLS.filter((x) => x.mappings.some((m) => shown.has(m.framework)))) {
    const refs = c.mappings
      .filter((x) => shown.has(x.framework))
      .map((x) => `${frameworkById(x.framework)!.shortName} ${frameworkById(x.framework)!.requirements.find((q) => q.id === x.requirement)!.ref}`);
    w.row([`${c.id} ${c.title}`, refs.slice(0, 2).join("; "), String(counts[c.evidence])], [190, 233, 60]);
    for (let i = 2; i < refs.length; i += 2) w.row(["", refs.slice(i, i + 2).join("; "), ""], [190, 233, 60]);
  }
  return doc.save();
}

// ---- Framework report ----

/**
 * One framework: each requirement, the controls that map to it, their live evidence, and the
 * gaps. Evidence counts cover all receipts to date. Logged as an evidence export.
 */
export async function exportFrameworkReport(deps: Deps, orgId: string, frameworkId: string, actor: string): Promise<Uint8Array | null> {
  const framework = frameworkById(frameworkId);
  if (!framework) return null;
  const key = await orgKey(deps, orgId);
  await adminEvent(deps, orgId, actor, "evidence.exported", { kind: "framework-report", framework: framework.id });
  const counts = await evidenceCounts(orgId, undefined, deps.db);
  const coverage = frameworkCoverage(framework.id, counts);
  const enabled = (await enabledFrameworks(orgId, deps.db)).some((f) => f.frameworkId === framework.id);

  const doc = await PDFDocument.create();
  doc.setTitle(`Elan1 Govern framework report — ${framework.shortName} — ${key.name}`);
  doc.setProducer("Elan1 Govern");
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  const grey: [number, number, number] = [0.3, 0.3, 0.28];
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

  w.text("Elan1 Govern · Framework report", { size: 10, color: [0.42, 0.42, 0.4], gap: 10 });
  w.para(framework.name, { size: 18, bold: true, gap: 8 });
  w.text(`${key.name}   ·   Generated ${when} IST   ·   Key ${keyFingerprint(key.publicKeyPem)}`, { color: grey });
  w.text(`Jurisdiction: ${framework.jurisdiction}`, { color: grey });
  w.text(`Official text: ${framework.url}`, { color: grey, gap: 10 });
  w.para(`${LEGAL_REVIEW_NOTE.toUpperCase()}. The references and summaries were written by the Elan1 Govern team as starting points. They are not legal advice and not a claim that using Elan1 Govern meets this framework. Have your counsel review them.`, { size: 9, color: [0.6, 0.35, 0.05], gap: 12 });
  if (!enabled) w.text("This framework is not switched on for the organisation.", { color: grey, gap: 10 });

  w.text("Summary", { size: 13, bold: true });
  w.para(framework.description, { gap: 8 });
  const gaps = coverage.requirements.filter((x) => x.gap);
  const waiting = coverage.requirements.filter((x) => !x.gap && !x.covered);
  w.text(`${coverage.covered} of ${coverage.total} requirements have a control with live evidence (${coverage.percent}%).`, { bold: true });
  w.text(`${waiting.length} have a control but no evidence yet. ${gaps.length} have no control at all.`, { gap: 14 });

  w.text("Requirements", { size: 13, bold: true });
  const cols = [72, 160, 140, 46, 65];
  w.row(["Reference", "Requirement", "Controls", "Evidence", "Status"], cols, true);
  w.rule();
  for (const x of coverage.requirements) {
    const ev = x.controls.reduce((n, c) => n + c.evidence, 0);
    const status = x.gap ? "Gap" : x.covered ? "Covered" : "No evidence";
    const ids = x.controls.map((c) => c.control.id);
    w.row([x.requirement.ref, x.requirement.title, ids.slice(0, 3).join(", ") || "None", x.gap ? "—" : String(ev), status], cols);
    for (let i = 3; i < ids.length; i += 3) w.row(["", "", ids.slice(i, i + 3).join(", "), "", ""], cols);
  }
  w.space();

  if (gaps.length) {
    w.text("Gaps: no control covers these yet", { size: 13, bold: true });
    for (const x of gaps) {
      w.text(`${x.requirement.ref}  ${x.requirement.title}`, { bold: true, gap: 3 });
      w.para(x.requirement.summary, { color: grey, gap: 8 });
    }
    w.space();
  }

  w.text("Controls used for this framework", { size: 13, bold: true });
  for (const c of controlsFor(framework.id)) {
    w.text(`${c.id}  ${c.title}`, { bold: true, gap: 3 });
    w.para(c.description, { color: grey, gap: 3 });
    const refs = c.refs.map((r) => framework.requirements.find((q) => q.id === r.requirement)!.ref);
    w.text(`Evidence: ${counts[c.evidence]} ${EVIDENCE_LABELS[c.evidence]}   ·   Maps to: ${[...new Set(refs)].join(", ")}`, { size: 9, color: grey, gap: 10 });
  }
  return doc.save();
}

/** Hourly: sign the head of every org's chain. */
export async function checkpointAll(deps: Deps): Promise<number> {
  let signed = 0;
  for (const orgId of await allOrgIds(deps.db)) {
    try {
      if (await checkpoint(deps, orgId)) signed++;
    } catch (e) {
      await raiseAlert(deps, "checkpoint-failed", (e as Error).message, orgId);
    }
  }
  return signed;
}
