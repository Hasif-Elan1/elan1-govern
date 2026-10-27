import { generateKeyPair, rulebookToYaml, type Receipt } from "@gate/core";
import { packById, starterRulebook } from "@gate/core/frameworks";
import { forOrg, prisma } from "@gate/db";
import { afterAll, describe, expect, it } from "vitest";
import { adminTitle } from "../src/server/queries";
import { compactDiff, openSuggestions, suggestionDraft, suggestionTotals, totalsLine, waitWords } from "../src/server/suggestions";

afterAll(() => prisma.$disconnect());

const keys = generateKeyPair();

async function setup() {
  const o = await prisma.org.create({ data: { name: "Suggest Co", publicKey: keys.publicKeyPem, privateKeyEnc: "x" } });
  const db = forOrg(o.id);
  const agent = await db.agent.create({ data: { orgId: o.id, slug: "ap-bot", name: "AP bot", purpose: "Pays bills", ownerEmail: "o@x.in", riskTier: "high" } });
  const rb = starterRulebook(packById("finance")!, { agent: "ap-bot", owner: "o@x.in", approvers: ["o@x.in"] });
  const yaml = rulebookToYaml(rb);
  await db.rulebook.create({ data: { orgId: o.id, agentId: agent.id, version: 1, yaml: `${yaml}signature: abc\n`, hash: "h", signedBy: "o@x.in" } });
  const draftYaml = yaml.replace("lte: 50000", "lte: 100000").replace("gt: 50000", "gt: 100000");
  const row = (over: Record<string, unknown> = {}) =>
    db.ruleSuggestion.create({
      data: {
        orgId: o.id,
        agentId: agent.id,
        kind: "raise_limit",
        fingerprint: `sha256:${Math.random()}`,
        ruleId: "pay-large",
        tool: "zoho.record_bill_payment",
        title: "Raise the no-approval limit for payments from ₹50,000 to ₹1,00,000",
        proposal: "In the last 30 days people approved all 41 payments…",
        confidence: "high",
        explanation: "Strong evidence.",
        evidence: { approved: 41, rejected: 1, expired: 1, covered: 41, spanDays: 27, field: "amount_inr", cap: 100000 },
        savedPerMonth: 44,
        medianWaitSeconds: 10_800,
        covered: 41,
        baseVersion: 1,
        draftYaml,
        ...over,
      },
    });
  return { o, db, agent, row };
}

describe("rule suggestions in the console", () => {
  it("lists open suggestions with a compact YAML diff, and totals them for Today", async () => {
    const { o, row } = await setup();
    const s = await row();
    await row({ status: "dismissed", savedPerMonth: 99 });
    const list = await openSuggestions(o.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: s.id, agentSlug: "ap-bot", agentName: "AP bot", confidence: "high", medianWait: "about 3 hours", savedPerMonth: 44 });
    const changed = list[0]!.diff.filter((l) => l.type !== "same" && l.type !== "gap").map((l) => `${l.type} ${l.text.trim()}`);
    expect(changed).toEqual(["remove when: { amount_inr: { lte: 50000 } }", "add when: { amount_inr: { lte: 100000 } }", "remove when: { amount_inr: { gt: 50000 } }", "add when: { amount_inr: { gt: 100000 } }"]);
    expect(list[0]!.diff.some((l) => l.type === "gap")).toBe(true);
    expect(JSON.stringify(list[0]!.diff)).not.toContain("signature");
    expect(await openSuggestions(o.id, "nobody")).toEqual([]);
    expect(await suggestionTotals(o.id)).toEqual({ count: 1, perMonth: 44 });
    expect(totalsLine({ count: 2, perMonth: 40 })).toBe("2 rule suggestions could save about 40 approvals a month.");
    expect(totalsLine({ count: 1, perMonth: 1 })).toBe("1 rule suggestion could save about 1 approval a month.");
    expect(totalsLine({ count: 0, perMonth: 0 })).toBeNull();
  });

  it("opens a draft only once applied, for the right agent, on the version it was made from", async () => {
    const { o, db, agent, row } = await setup();
    const s = await row();
    expect(await suggestionDraft(o.id, "ap-bot", s.id)).toBeNull(); // not opened yet
    await db.ruleSuggestion.update({ where: { id: s.id }, data: { status: "applied" } });
    expect(await suggestionDraft(o.id, "ap-bot", s.id)).toMatchObject({ yaml: expect.stringContaining("lte: 100000"), title: expect.stringMatching(/^Raise/) });
    expect(await suggestionDraft(o.id, "other-bot", s.id)).toBeNull();
    // Another org cannot open it, even knowing the id.
    const other = await setup();
    expect(await suggestionDraft(other.o.id, "ap-bot", s.id)).toBeNull();
    expect(await openSuggestions(other.o.id)).toEqual([]);
    // Once a newer version is published, the draft is out of date.
    await db.rulebook.create({ data: { orgId: o.id, agentId: agent.id, version: 2, yaml: "x", hash: "h2", signedBy: "o@x.in" } });
    expect(await suggestionDraft(o.id, "ap-bot", s.id)).toBeNull();
  });

  it("keeps only changed lines and their context", () => {
    const lines = ["a", "b", "c", "d", "e", "f", "g", "h"].map((text) => ({ type: "same" as const, text }));
    lines[4] = { type: "add" as never, text: "E" };
    expect(compactDiff(lines, 1).map((l) => l.text)).toEqual(["…", "d", "E", "f", "…"]);
  });

  it("says waits in words", () => {
    expect([null, 30, 90, 1500, 3600, 10_800, 200_000].map(waitWords)).toEqual([null, "about 1 minute", "about 2 minutes", "about 25 minutes", "about 1 hour", "about 3 hours", "about 2 days"]);
  });

  it("describes the receipts in plain words", () => {
    const r = (action: string) => adminTitle({ kind: "admin", action, details: {}, agent: "ap-bot", seq: 1, ts: "", org: "", prev_hash: "", hash: "", sig: "" } as Receipt);
    expect(r("suggestion.applied")).toBe("Opened a suggested rule change for ap-bot as a draft");
    expect(r("suggestion.dismissed")).toBe("Dismissed a suggested rule change for ap-bot");
    expect(r("demo.history_added")).toBe("Loaded a month of demo approvals for ap-bot");
  });
});
