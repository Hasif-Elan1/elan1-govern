import { generateKeyPair, type Receipt } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import { afterAll, describe, expect, it } from "vitest";
import { applyApprovedTier, syncAgentSystems, SystemFields, withReceipt } from "../src/server/inventory";
import { adminTitle } from "../src/server/queries";

afterAll(() => prisma.$disconnect());

const keys = generateKeyPair();
const newOrg = () => prisma.org.create({ data: { name: "Inventory Co", publicKey: keys.publicKeyPem, privateKeyEnc: "x" } });

const system = {
  name: "Resume screener",
  kind: "vendor_tool",
  vendor: "HireCo",
  purpose: "Ranks job applications for the recruiting team.",
  ownerEmail: "Priya@Example.in",
  businessUnit: "",
  lifecycle: "proposed",
  dataCategories: ["personal"],
  affectedPeople: ["public"],
  decisionImpact: "supports_humans",
};

describe("system fields", () => {
  it("accepts a valid system and tidies it", () => {
    const r = SystemFields.parse(system);
    expect(r).toMatchObject({ ownerEmail: "priya@example.in", businessUnit: null, vendor: "HireCo" });
  });
  it("refuses unknown values, duplicates, 'none' with others and extra fields", () => {
    expect(SystemFields.safeParse({ ...system, kind: "robot" }).success).toBe(false);
    expect(SystemFields.safeParse({ ...system, dataCategories: ["personal", "personal"] }).success).toBe(false);
    expect(SystemFields.safeParse({ ...system, dataCategories: ["none", "health"] }).success).toBe(false);
    expect(SystemFields.safeParse({ ...system, riskTier: "low" }).success).toBe(false);
    expect(SystemFields.safeParse({ ...system, agentId: "a1" }).success).toBe(false);
    expect(SystemFields.safeParse({ ...system, name: "x" }).error?.issues[0]?.message).toBe("Give the system a name.");
  });
});

describe("agents in the inventory", () => {
  it("adds every Elan1 Govern agent once, however often it runs", async () => {
    const o = await newOrg();
    const db = forOrg(o.id);
    const agent = await db.agent.create({ data: { orgId: o.id, slug: "ap-bot", name: "AP bot", purpose: "Pays vendor bills", ownerEmail: "owner@x.in", riskTier: "high" } });
    expect(await syncAgentSystems(o.id)).toBe(1);
    expect(await syncAgentSystems(o.id)).toBe(0);
    await Promise.all([syncAgentSystems(o.id), syncAgentSystems(o.id)]);
    const rows = await db.aiSystem.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: agent.id, kind: "agent", name: "AP bot", lifecycle: "live", riskTier: "high", ownerEmail: "owner@x.in" });
    // Another org's agents never appear here.
    const other = await newOrg();
    await forOrg(other.id).agent.create({ data: { orgId: other.id, slug: "ap-bot", name: "Other bot", purpose: "x", ownerEmail: "o@y.in" } });
    await syncAgentSystems(other.id);
    expect(await db.aiSystem.count()).toBe(1);
    expect(await forOrg(other.id).aiSystem.count()).toBe(1);
  });
});

describe("approving assessments", () => {
  it("sets the highest tier among the latest approved assessment of each template, and the next review", async () => {
    const o = await newOrg();
    const db = forOrg(o.id);
    const s = await db.aiSystem.create({ data: { ...SystemFields.parse(system), orgId: o.id } });
    expect(s.riskTier).toBe("unassessed");
    const add = (templateKey: string, resultTier: string, reviewedAt: string, status = "approved") =>
      db.assessment.create({ data: { orgId: o.id, systemId: s.id, templateKey, templateVersion: 1, resultTier, status, createdBy: "a@x.in", reviewedAt: new Date(reviewedAt) } });
    await add("triage", "high", "2026-01-01");
    await add("triage", "low", "2026-06-01"); // the newer triage replaces the older one
    await add("impact", "medium", "2026-03-01");
    await add("data-protection", "high", "2026-07-01", "submitted"); // not approved: ignored
    const now = new Date("2026-10-26T00:00:00Z");
    const r = await applyApprovedTier(o.id, s.id, now);
    expect(r.tier).toBe("medium");
    expect(r.nextReviewAt.toISOString()).toBe("2027-10-26T00:00:00.000Z");
    expect(await db.aiSystem.findFirstOrThrow({ where: { id: s.id } })).toMatchObject({ riskTier: "medium", nextReviewAt: r.nextReviewAt });
  });
});

describe("receipts for inventory changes", () => {
  it("undoes the change when Elan1 Govern cannot write the receipt", async () => {
    const o = await newOrg();
    const db = forOrg(o.id);
    // This org exists only in the test database, so Elan1 Govern (running or not) cannot sign for it.
    await expect(
      withReceipt(
        o.id,
        "owner@x.in",
        "system.created",
        () => db.aiSystem.create({ data: { ...SystemFields.parse(system), orgId: o.id } }),
        (x) => ({ system: x.name }),
        (x) => db.aiSystem.delete({ where: { id: x.id } }),
      ),
    ).rejects.toThrow(/receipt for system.created not written/);
    expect(await db.aiSystem.count()).toBe(0);
  });

  it("describes the new actions in plain English", () => {
    const t = (action: string, details: Record<string, unknown>) => adminTitle({ kind: "admin", action, details, seq: 1, ts: "", org: "", prev_hash: "", hash: "", sig: "" } as Receipt);
    expect(t("system.created", { system: "Resume screener" })).toBe("Added Resume screener to the inventory");
    expect(t("system.updated", { system: "Resume screener", changed: "ownerEmail" })).toBe("Updated Resume screener in the inventory");
    expect(t("system.updated", { system: "Resume screener", changed: "lifecycle", lifecycle: "retired" })).toBe("Retired Resume screener");
    expect(t("assessment.submitted", { system: "Resume screener", assessment: "AI risk triage", tier: "high" })).toBe("Submitted the AI risk triage for Resume screener: high risk");
    expect(t("assessment.approved", { system: "Resume screener", assessment: "Data protection check", system_tier: "medium" })).toBe("Approved the data protection check for Resume screener, now medium risk");
    expect(t("assessment.changes_requested", {})).toBe("Asked for changes to the assessment for an AI system");
  });
});
