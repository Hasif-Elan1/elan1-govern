import { randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { buildInvoices, formatPaise, hashToken, type ComputedInvoice, type Receipt } from "@gate/core";
import { forOrg, meterReceipts, pilotDecisionCount, withChain } from "@gate/db";
import { PDFArray, PDFDocument, PDFRawStream, type PDFObject } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertPilot, pilotGate, startPilot } from "../src/billing";
import { invoicePdf } from "../src/invoice-pdf";
import { signer } from "../src/keys";
import { demoOrg, gateMeta, internal, makeApp, tool } from "./helpers";

const D = 86_400_000;

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  // behaviour checks are covered elsewhere; here they would only add background work
  ctx = await makeApp({ behaviourInline: async () => 0 });
});
afterAll(async () => {
  await ctx.app.close();
});

async function receipts(orgId: string) {
  return (await forOrg(orgId).receipt.findMany({ orderBy: { seq: "asc" } })).map((r) => r.body as unknown as Receipt);
}
const read = (d: Awaited<ReturnType<typeof demoOrg>>) => tool(ctx.app, d.apiKey, "gmail.read_message", { message_id: "m_101" });

describe("the pilot's hard stop in the guard", () => {
  it("allows the 2,000th production action and refuses every call after it, with a normal refusal receipt", async () => {
    const d = await demoOrg(ctx.deps);
    expect(await startPilot(ctx.deps, d.org.id, d.owner.email)).toMatchObject({ ok: true });
    // 1,999 decisions already on the chain, written as the guard writes them
    await withChain(d.org.id, signer(ctx.deps, d.org.id), async (append) => {
      for (let i = 0; i < 1999; i++) await append({ kind: "decision", agent: "ap-bot", tool: "gmail.read_message", decision: "allow", rule_id: "read" });
    }, ctx.deps.db);
    expect(gateMeta(await read(d))).toMatchObject({ decision: "allow" }); // the 2,000th
    const r = gateMeta(await read(d));
    expect(r).toMatchObject({ decision: "refuse", rule_id: "pilot-limit" });
    expect(String(r.reason)).toBe("The free pilot has used its 2,000 governed actions, so every action is refused. An owner moves to the paid plan on the Meter page to resume.");
    const all = await receipts(d.org.id);
    const refusal = all.find((x) => x.seq === r.receipt_seq)!;
    expect(refusal).toMatchObject({ kind: "decision", decision: "refuse", rule_id: "pilot-limit", tool: "gmail.read_message", agent: "ap-bot" });
    expect(all.filter((x) => x.action === "billing.pilot_stopped")).toHaveLength(1);
    expect(all.find((x) => x.action === "billing.pilot_stopped")).toMatchObject({ actor: "Elan1 Govern", details: { why: "2000 governed actions used", used: 2000, cap: 2000, code: "POLICY.TENANT_STOPPED", read_only_days: 30 } });
    const acct = await d.db.billingAccount.findFirstOrThrow();
    expect(acct.pilotStoppedAt).not.toBeNull();
    expect(acct.pilotStoppedSeq).toBe(all.find((x) => x.action === "billing.pilot_stopped")!.seq);
  }, 60_000);

  it("counts production actions only, records the stop once, and lifts it when the owner moves to the paid plan", async () => {
    const d = await demoOrg(ctx.deps);
    await startPilot(ctx.deps, d.org.id, d.owner.email, { cap: 3 });
    expect((await startPilot(ctx.deps, d.org.id, d.owner.email)).ok).toBe(false);
    // a platform refusal is our failure and never counts
    await withChain(d.org.id, signer(ctx.deps, d.org.id), (append) => append({ kind: "decision", agent: "ap-bot", tool: "x", decision: "refuse", rule_id: "gate-error" }), ctx.deps.db);
    expect(gateMeta(await read(d)).decision).toBe("allow");
    expect(gateMeta(await tool(ctx.app, d.apiKey, "zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 900000 })).decision).toBe("ask"); // sent to a person: it counts
    expect(gateMeta(await read(d)).decision).toBe("allow");
    for (let i = 0; i < 3; i++) expect(gateMeta(await read(d))).toMatchObject({ decision: "refuse", rule_id: "pilot-limit" });
    // the stop comes before everything else, a paused agent included
    await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/status`, { status: "paused", actor: d.owner.email });
    expect(gateMeta(await read(d)).rule_id).toBe("pilot-limit");
    await internal(ctx.app, "POST", `/internal/orgs/${d.org.id}/agents/${d.agentId}/status`, { status: "active", actor: d.owner.email });
    expect((await receipts(d.org.id)).filter((x) => x.action === "billing.pilot_stopped")).toHaveLength(1);

    expect(await convertPilot(ctx.deps, d.org.id, d.owner.email)).toMatchObject({ ok: true });
    expect(gateMeta(await read(d)).decision).toBe("allow");
    expect(await convertPilot(ctx.deps, d.org.id, d.owner.email)).toMatchObject({ ok: false });
    const converted = (await receipts(d.org.id)).find((x) => x.action === "billing.pilot_converted");
    expect(converted).toMatchObject({ actor: d.owner.email, details: { plan: "l1", used: 3, cap: 3 } });
  });

  it("stops after 90 days whatever the count, then closes after 30 read-only days", async () => {
    const d = await demoOrg(ctx.deps);
    await startPilot(ctx.deps, d.org.id, d.owner.email, { at: new Date(Date.now() - 91 * D) });
    const r = gateMeta(await read(d));
    expect(r).toMatchObject({ decision: "refuse", rule_id: "pilot-limit" });
    expect(String(r.reason)).toMatch(/ended after 90 days/);
    expect((await receipts(d.org.id)).find((x) => x.action === "billing.pilot_stopped")).toMatchObject({ details: { why: "90 days ended" } });

    // 30 days on, the organisation is closed: recorded once, and no call runs
    expect(await pilotGate(ctx.deps, d.org.id, Date.now() + 30 * D)).toMatchObject({ ruleId: "pilot-limit", reason: expect.stringMatching(/closed/) });
    expect(gateMeta(await read(d)).reason).toMatch(/closed/);
    expect((await receipts(d.org.id)).filter((x) => x.action === "billing.pilot_closed")).toHaveLength(1);
    expect(await convertPilot(ctx.deps, d.org.id, d.owner.email)).toMatchObject({ ok: false, error: expect.stringMatching(/closed/) });
  });

  it("never counts a sandbox key's calls towards the cap, and never stops them", async () => {
    const d = await demoOrg(ctx.deps);
    await startPilot(ctx.deps, d.org.id, d.owner.email, { cap: 2 });
    const sandboxKey = `sk_sbx_${randomBytes(16).toString("hex")}`;
    await d.db.apiKey.create({ data: { orgId: d.org.id, agentId: d.agentId, prefix: sandboxKey.slice(0, 10), keyHash: hashToken(sandboxKey), label: "Sandbox", environment: "sandbox" } });
    const sandbox = () => tool(ctx.app, sandboxKey, "gmail.read_message", { message_id: "m_101" });
    for (let i = 0; i < 4; i++) expect(gateMeta(await sandbox()).decision).toBe("allow");
    // marked on the receipt as the console's receipts mark it, and metered at ₹0
    const marked = (await receipts(d.org.id)).filter((x) => x.kind === "decision" && x.details?.["console.environment"] === "sandbox");
    expect(marked).toHaveLength(4);
    const acct = await d.db.billingAccount.findFirstOrThrow();
    expect(await pilotDecisionCount(d.org.id, acct.pilotStartsAt!)).toBe(0);
    expect((await meterReceipts(d.org.id, acct.pilotStartsAt!)).filter((r) => r.environment === "sandbox")).toHaveLength(4);
    // production calls count: two use the cap, the third is refused; the sandbox key keeps working
    expect(gateMeta(await read(d)).decision).toBe("allow");
    expect(gateMeta(await read(d)).decision).toBe("allow");
    expect(gateMeta(await read(d))).toMatchObject({ decision: "refuse", rule_id: "pilot-limit" });
    expect(gateMeta(await sandbox()).decision).toBe("allow");
    expect(await pilotDecisionCount(d.org.id, acct.pilotStartsAt!)).toBe(2);
  });

  it("leaves organisations without a pilot alone", async () => {
    const d = await demoOrg(ctx.deps);
    expect(await pilotGate(ctx.deps, d.org.id)).toBeUndefined();
    expect(await convertPilot(ctx.deps, d.org.id, d.owner.email)).toMatchObject({ ok: false, error: expect.stringMatching(/not on a pilot/) });
    // an account opened without a pilot first, then a pilot started on it
    await d.db.billingAccount.create({ data: { orgId: d.org.id, invoicePrefix: "TEST", buyerName: "Test Traders" } });
    expect(await pilotGate(ctx.deps, d.org.id)).toBeUndefined();
    expect(await startPilot(ctx.deps, d.org.id, d.owner.email)).toMatchObject({ ok: true });
    expect(gateMeta(await read(d)).decision).toBe("allow");
  });
});

/** Every string drawn on every page of a PDF made by pdf-lib (hex-encoded, in Flate content streams). */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams: PDFObject[] = contents instanceof PDFArray ? contents.asArray().map((x) => doc.context.lookup(x)!) : contents ? [contents] : [];
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      const raw = Buffer.from(inflateSync(s.contents)).toString("latin1");
      for (const m of raw.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) out.push(Buffer.from(m[1]!, "hex").toString("latin1"));
    }
  }
  return out.join("\n");
}

describe("the invoice PDF", () => {
  const receipts_ = [{ seq: 1, ts: "2026-08-03T06:00:00.000Z", kind: "decision", decision: "allow", rule_id: "r" }];
  const all = buildInvoices({
    org: { prefix: "KAVE", name: "Kaveri Health", level: "l1", createdAt: "2026-08-01T00:00:00Z", residency: "Bengaluru, Karnataka" },
    receipts: receipts_,
    disputes: [{ seq: 7, invoice: "EG-KAVE-202609", line: "l1-floor", reason: "r", by: "u", at: "2026-10-02T00:00:00Z", open: false, settlement: { seq: 8, outcome: "partly_upheld", credit: 50_000, creditNote: "CN-KAVE-202609-7", at: "2026-10-05T00:00:00.000Z" } }],
    now: Date.parse("2026-10-20T00:00:00Z"),
  });
  const sep = all.find((i) => i.number === "EG-KAVE-202609") as ComputedInvoice;
  const cn = all.find((i) => i.kind === "credit_note") as ComputedInvoice;

  it("is a GST tax invoice with supplier, buyer, SAC, lines and totals", async () => {
    const bytes = await invoicePdf(sep, { name: "Kaveri Health", gstin: "29AAACK1234A1Z9", address: "MG Road, Bengaluru" });
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const text = await pdfText(bytes);
    for (const s of ["Tax invoice", "EG-KAVE-202609", "ELAN1 AGENTIC TECHNOLOGIES PRIVATE LIMITED", "GSTIN 29ABCDE1234F1Z5", "Kaveri Health", "GSTIN 29AAACK1234A1Z9", "Place of supply: Karnataka (29)", "SAC 998315", "Guarded platform floor (L1)", "CGST 9%", "SGST 9%", `IRN ${sep.irn}`]) expect(text).toContain(s);
    expect(sep).toMatchObject({ subtotal: 1_500_000, gst: 270_000, total: 1_770_000 });
    for (const paise of [sep.subtotal, sep.total, sep.gst / 2]) expect(text).toContain(formatPaise(paise).replace("₹", "Rs "));
    expect(text).toContain("CN-KAVE-202609-7");
  });

  it("prints credit notes, held lines, IGST and an unregistered buyer", async () => {
    const credit = await pdfText(await invoicePdf(cn, { name: "Kaveri Health" }));
    expect(credit).toContain("Credit note against EG-KAVE-202609");
    expect(credit).toContain("Total credit");
    expect(credit).toContain(formatPaise(cn.total).replace("₹", "Rs "));
    const held: ComputedInvoice = { ...sep, placeOfSupply: "Maharashtra (27)", status: "held", heldAmount: sep.subtotal, payableNow: 0, lines: sep.lines.map((l) => ({ ...l, held: { seq: 9, by: "u", reason: "r", at: "2026-10-03T00:00:00Z" } })) };
    const text = await pdfText(await invoicePdf(held, { name: "Kaveri Health" }));
    expect(text).toContain("IGST 18%");
    expect(text).toContain("GSTIN: not registered");
    expect(text).toContain("Held in dispute (receipt #9)");
    expect(text).toContain("Payable now (held until the period reconciles)");
  });
});
