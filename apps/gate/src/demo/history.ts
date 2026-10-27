import { forOrg } from "@gate/db";
import { chain } from "../chain";
import type { Deps } from "../deps";
import { findSuggestions } from "../suggestions";

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const DEMO_HISTORY_NOTE = "Demo history";

// Six regular vendors of the demo books (the first three are in the mock ledger).
const VENDORS = ["Sharma Traders", "Kaveri Logistics", "Nilgiri Office Supplies", "Deccan Steel Works", "Malabar Spice Co", "Coromandel Paper Mills"];

/**
 * A month of resolved payment approvals for the demo AP agent, so the rule-suggestion feature has
 * something to learn from: 41 payments between ₹50,000 and ₹1,00,000 to six vendors, all approved,
 * plus one larger payment rejected and one left to expire. The demo rulebook asks for every payment
 * over ₹50,000, so the suggestion is to raise that line to ₹1,00,000.
 *
 * The approval rows are dated over the last four weeks. Receipts cannot be backdated (the chain
 * records real time), so one admin receipt, `demo.history_added`, says this history was loaded,
 * and the rows point at it. Safe to run again: it does nothing if the history is already there.
 */
export async function addDemoHistory(deps: Deps, orgId: string, actor: string, now = new Date()): Promise<{ added: number; suggestions: number }> {
  const db = forOrg(orgId, deps.db);
  const agent = await db.agent.findFirst({ where: { slug: "ap-bot" } });
  if (!agent) return { added: 0, suggestions: 0 };
  if (await db.approval.count({ where: { agentId: agent.id, note: DEMO_HISTORY_NOTE } })) return { added: 0, suggestions: (await findSuggestions(deps, orgId, { agentId: agent.id, now })).open };

  const rows: { amount: number; vendor: string; daysAgo: number; status: "approved" | "rejected" | "expired"; waitH: number }[] = [];
  for (let i = 0; i < 41; i++) {
    // Mostly ₹52,000 to ₹99,000, and one exactly ₹1,00,000: the largest approved amount sets the cap.
    const amount = i === 3 ? 100000 : 52000 + Math.round(((i * 7919) % 47000) / 500) * 500;
    rows.push({ amount, vendor: VENDORS[i % VENDORS.length] as string, daysAgo: 1 + i * 0.66, status: "approved", waitH: 1 + ((i * 5) % 9) });
  }
  rows.push({ amount: 240000, vendor: "Konkan Interiors", daysAgo: 6, status: "rejected", waitH: 3 });
  rows.push({ amount: 155000, vendor: VENDORS[1] as string, daysAgo: 12, status: "expired", waitH: 24 });

  await chain(deps, orgId, async (append, tx) => {
    const receipt = await append({ kind: "admin", actor, action: "demo.history_added", agent: agent.slug, details: { approvals: rows.length } });
    for (const [i, r] of rows.entries()) {
      const createdAt = new Date(now.getTime() - r.daysAgo * DAY);
      const resolvedAt = new Date(createdAt.getTime() + r.waitH * HOUR);
      await tx.approval.create({
        data: {
          orgId,
          agentId: agent.id,
          tool: "zoho.record_bill_payment",
          argsSummary: { bill_id: `bill_h${100 + i}`, amount_inr: r.amount, vendor: r.vendor, bill: `INV-H${100 + i}` },
          ruleId: "pay-large",
          reason: "Payments over ₹50,000 need someone in finance to approve them.",
          approverGroup: "finance",
          approvers: [actor],
          status: r.status,
          heldSeq: receipt.seq,
          resolvedBy: r.status === "expired" ? null : actor,
          note: DEMO_HISTORY_NOTE,
          expiresAt: new Date(createdAt.getTime() + DAY),
          resolvedAt,
          createdAt,
          result: { status: r.status === "approved" ? "ok" : "not_run" },
        },
      });
    }
  });
  return { added: rows.length, suggestions: (await findSuggestions(deps, orgId, { agentId: agent.id, now })).open };
}
