import { GST_PERCENT, REFUSAL_FACTOR, SUPPLIER, formatPaise, taxSplit, type ComputedInvoice } from "@gate/core";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Writer } from "./evidence";

export interface InvoiceBuyer {
  name: string;
  gstin?: string | null;
  address?: string | null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const STATUS: Record<ComputedInvoice["status"], string> = { draft: "Draft: the month is still open", issued: "Issued", held: "Held: the period is not reconciled, so it is not issued until it is" };

/**
 * A GST tax invoice (or credit note) as a PDF, in the evidence reports' style: supplier and buyer with their
 * GSTINs, place of supply, SAC, every line with its taxable value, CGST and SGST or IGST, the total and the IRN.
 * Amounts come from @gate/core's invoice in paise; nothing is recalculated here.
 */
export async function invoicePdf(inv: ComputedInvoice, buyer: InvoiceBuyer): Promise<Uint8Array> {
  const credit = inv.kind === "credit_note";
  const doc = await PDFDocument.create();
  doc.setTitle(`${credit ? "Credit note" : "Tax invoice"} ${inv.number} — ${buyer.name}`);
  doc.setProducer("Elan1 Govern");
  doc.setAuthor(SUPPLIER.name);
  const w = new Writer(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  const grey: [number, number, number] = [0.3, 0.3, 0.28];

  w.text(`${SUPPLIER.brand} · ${credit ? "Credit note" : "Tax invoice"}`, { size: 10, color: [0.42, 0.42, 0.4], gap: 20 });
  w.text(inv.number, { size: 22, bold: true, gap: 10 });
  const period = credit ? `Credit note against ${inv.creditFor?.invoice ?? ""} (${monthLabel(inv.period)})` : inv.kind === "deployment" ? `${day(inv.periodStart)} to ${day(inv.periodEnd)}` : monthLabel(inv.period);
  w.text(`${period}   ·   ${credit ? "Credit note" : STATUS[inv.status]}`, { color: grey });
  w.text(`Issued ${day(inv.issuedAt)}${inv.dueAt && !credit ? `   ·   Due ${day(inv.dueAt)}` : ""}`, { color: grey, gap: 14 });

  w.text("Supplier", { size: 11, bold: true, gap: 4 });
  w.text(SUPPLIER.name, { gap: 3 });
  w.text(SUPPLIER.address, { gap: 3 });
  w.text(`GSTIN ${SUPPLIER.gstin}   ·   State code ${SUPPLIER.stateCode} (${SUPPLIER.state})`, { gap: 12 });

  w.text("Bill to", { size: 11, bold: true, gap: 4 });
  w.text(buyer.name, { gap: 3 });
  if (buyer.address) w.text(buyer.address, { gap: 3 });
  w.text(buyer.gstin ? `GSTIN ${buyer.gstin}` : "GSTIN: not registered (unregistered buyer)", { gap: 3 });
  w.text(`Place of supply: ${inv.placeOfSupply}`, { gap: 3 });
  w.text(`Service: SAC ${SUPPLIER.sac}, ${SUPPLIER.sacLabel}`, { gap: 14 });

  const cols = [18, 207, 46, 44, 78, 90];
  w.row(["#", "Description", "SAC", "Qty", "Rate", "Taxable value"], cols, true);
  w.rule();
  const note = (s: string) => w.para(s, { x: 74, width: 200, size: 8, color: [0.55, 0.36, 0.05], gap: 5 });
  inv.lines.forEach((l, i) => {
    const qty = Number.isInteger(l.quantity) ? String(l.quantity) : l.quantity.toFixed(3);
    w.row([String(i + 1), l.label, SUPPLIER.sac, qty, l.rate ? formatPaise(l.rate) : "—", formatPaise(l.amount)], cols);
    if (l.held) note(`Held in dispute (receipt #${l.held.seq}): not payable until it is resolved.`);
    if (l.settled) note(`Dispute ${l.settled.outcome.replace("_", " ")} (receipt #${l.settled.seq})${l.settled.creditNote ? `, credit note ${l.settled.creditNote}` : ""}.`);
  });
  w.rule();
  const totals = [cols[0]! + cols[1]! + cols[2]! + cols[3]! + cols[4]!, cols[5]!];
  w.row(["Taxable value", formatPaise(inv.subtotal)], totals, true);
  for (const t of taxSplit(inv.gst, inv.placeOfSupply)) w.row([t.label, formatPaise(t.amount)], totals);
  w.row([credit ? "Total credit" : "Total", formatPaise(inv.total)], totals, true);
  if (inv.heldAmount > 0) w.row([inv.status === "held" ? "Payable now (held until the period reconciles)" : "Payable now (held lines excluded)", formatPaise(inv.payableNow)], totals, true);
  w.space();

  w.text(`IRN ${inv.irn}`, { size: 8, color: grey, gap: 8 });
  if (inv.fromSeq !== undefined) w.para(`Metered from receipts #${inv.fromSeq} to #${inv.toSeq} of ${buyer.name}'s chain (${inv.events} governed actions).${inv.partial ? ` Metered from ${day(inv.partial)}, where the chain starts.` : ""}`, { size: 9, color: grey, gap: 8 });
  if (inv.credits?.length) w.para(`Credited by ${inv.credits.map((c) => `${c.number} (${formatPaise(c.amount)})`).join(", ")}.`, { size: 9, color: grey, gap: 8 });
  w.para(
    `A refused action costs ${REFUSAL_FACTOR * 100}% of the per-action rate; inside the yearly allowance it uses ${REFUSAL_FACTOR} of an included action. Calls made with a sandbox key are metered at Rs 0. GST at ${GST_PERCENT}%: CGST and SGST within ${SUPPLIER.state}, IGST otherwise. Modelled list prices, flat to 31 March 2029. ${SUPPLIER.name}.`,
    { size: 9, color: grey },
  );
  return doc.save();
}
