import { randomBytes } from "node:crypto";
import { generateKeyPair, type Receipt } from "@gate/core";
import { appendReceipt, createCheckpoint, forOrg, prisma } from "@gate/db";
import { afterAll, describe, expect, it } from "vitest";
import { safeNext } from "../src/app/api/auth/route-helpers";
import { checkPassword, hashPassword, lockoutMs, newTotp, passwordProblem, totpNow, verifyTotp } from "../src/server/auth";
import { activity, adminTitle, chainStatus, receiptBySeq, todayStats, toView } from "../src/server/queries";
import { hit, resetRateLimits } from "../src/server/ratelimit";
import { dayLabel, fmtDate, relative, shortHash, timeLeft } from "../src/lib/utils";

afterAll(() => prisma.$disconnect());

const email = () => `u-${randomBytes(4).toString("hex")}@test.in`;

describe("passwords and lockout", () => {
  it("checks password strength", () => {
    expect(passwordProblem("short")).toMatch(/12 characters/);
    expect(passwordProblem("a".repeat(13))).toMatch(/harder to guess/);
    expect(passwordProblem("password1234567")).toMatch(/harder to guess/);
    expect(passwordProblem("x".repeat(201))).toMatch(/at most/);
    expect(passwordProblem("monsoon ledger 42")).toBeNull();
  });
  it("backs off after five failures", () => {
    expect(lockoutMs(4)).toBe(0);
    expect(lockoutMs(5)).toBe(60_000);
    expect(lockoutMs(6)).toBe(120_000);
    expect(lockoutMs(30)).toBe(3_600_000);
  });
  it("locks the account and does not reveal unknown emails", async () => {
    const e = email();
    await prisma.user.create({ data: { email: e, name: "T", passwordHash: await hashPassword("correct horse battery") } });
    expect(await checkPassword("nobody@test.in", "x")).toEqual({ ok: false, reason: "invalid" });
    for (let i = 0; i < 4; i++) expect((await checkPassword(e, "wrong")).ok).toBe(false);
    expect(await checkPassword(e, "wrong")).toMatchObject({ ok: false, reason: "locked" });
    // Even the right password is refused while locked.
    expect(await checkPassword(e, "correct horse battery")).toMatchObject({ ok: false, reason: "locked" });
    await prisma.user.update({ where: { email: e }, data: { lockedUntil: null } });
    expect(await checkPassword(e.toUpperCase(), "correct horse battery")).toMatchObject({ ok: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { email: e } })).failedLogins).toBe(0);
  });
  it("asks for and checks a TOTP code", async () => {
    const e = email();
    const t = newTotp(e);
    expect(t.uri).toMatch(/^otpauth:\/\/totp\/Gate:/);
    await prisma.user.create({ data: { email: e, name: "T", passwordHash: await hashPassword("correct horse battery"), totpSecret: t.secretEnc, totpEnabled: true } });
    expect(await checkPassword(e, "correct horse battery")).toEqual({ ok: false, reason: "totp_required" });
    expect(await checkPassword(e, "correct horse battery", "000000")).toMatchObject({ reason: "totp_invalid" });
    expect(await checkPassword(e, "correct horse battery", totpNow(t.secretEnc))).toMatchObject({ ok: true });
    expect(verifyTotp(t.secretEnc, "abc")).toBe(false);
  });
});

describe("rate limits", () => {
  it("counts per key and window", () => {
    resetRateLimits();
    for (let i = 0; i < 3; i++) expect(hit("k", 3, 60_000).ok).toBe(true);
    const r = hit("k", 3, 60_000);
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
    expect(hit("other", 3, 60_000).ok).toBe(true);
    expect(hit("short", 1, -1).ok).toBe(true);
    expect(hit("short", 1, -1).ok).toBe(true);
  });
});

describe("redirect safety", () => {
  it("only allows paths inside the app", () => {
    expect(safeNext("/approvals/apr_1?t=x")).toBe("/approvals/apr_1?t=x");
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext("/\\evil.com")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("/javascript:alert(1)")).toBe("/");
  });
});

describe("receipt views", () => {
  const keys = generateKeyPair();
  async function org() {
    return prisma.org.create({ data: { name: "Q", publicKey: keys.publicKeyPem, privateKeyEnc: "x" } });
  }

  it("turns receipts into plain sentences and filters them", async () => {
    const o = await org();
    const add = (input: Parameters<typeof appendReceipt>[2]) => appendReceipt(o.id, keys.privateKeyPem, input);
    await add({ kind: "admin", actor: "a@b.in", action: "org.created", details: { name: "Q" } });
    await add({ kind: "decision", agent: "ap-bot", tool: "zoho.record_bill_payment", args_summary: { amount_inr: 200000, vendor: "Sharma Traders", bill: "INV-2291" }, rule_id: "pay-large", decision: "ask", approval: { id: "apr_1", result: "pending" } });
    await add({ kind: "approval", agent: "ap-bot", tool: "zoho.record_bill_payment", args_summary: { amount_inr: 200000, vendor: "Sharma Traders" }, rule_id: "pay-large", decision: "ask", approval: { id: "apr_1", result: "approved", by: "a@b.in", self_approval: true }, outcome: { status: "ok", ref: "PAY-1" }, ref_seq: 2 });
    await add({ kind: "decision", agent: "ap-bot", tool: "zoho.update_vendor", args_summary: { fields: ["ifsc"] }, rule_id: "no-bank-change", decision: "refuse" });
    await add({ kind: "decision", agent: "ap-bot", tool: "gmail.read_message", args_summary: {}, rule_id: "read-mail", decision: "allow", outcome: { status: "error", error: "x" } });
    await add({ kind: "outcome", agent: "ap-bot", tool: "zoho.record_bill_payment", args_summary: { amount_inr: 1 }, outcome: { status: "ok" }, ref_seq: 2 });

    const all = await activity(o.id);
    expect(all.map((v) => v.status)).toEqual(["outcome", "error", "refuse", "approved", "ask", "admin"]);
    expect(all.find((v) => v.seq === 2)?.title).toBe("Pay ₹2,00,000 to Sharma Traders for INV-2291");
    expect(all[0]!.title).toMatch(/^Reported:/);
    expect(all.at(-1)!.title).toBe("Created the organisation Q");
    expect((await activity(o.id, { decision: "refuse" })).map((v) => v.ruleId)).toEqual(["no-bank-change"]);
    expect((await activity(o.id, { decision: "admin" }))).toHaveLength(1);
    expect((await activity(o.id, { decision: "ask" }))).toHaveLength(2);
    expect((await activity(o.id, { q: "sharma" }))).toHaveLength(2);
    expect((await activity(o.id, { q: "PAY-1" }))).toHaveLength(1);
    expect((await activity(o.id, { tool: "gmail.read_message", agent: "ap-bot" }))).toHaveLength(1);
    expect((await activity(o.id, { after: 5 }))).toHaveLength(1);
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    expect((await activity(o.id, { from: today, to: today }))).toHaveLength(6);
    expect((await activity(o.id, { from: "2000-01-01", to: "2000-01-02" }))).toHaveLength(0);
    expect((await receiptBySeq(o.id, 2))?.rule_id).toBe("pay-large");
    expect(await receiptBySeq(o.id, 99)).toBeNull();

    expect(await todayStats(o.id)).toMatchObject({ total: 3, allowed: 1, asked: 1, refused: 1, waiting: 0 });
    await createCheckpoint(o.id, keys.privateKeyPem);
    expect(await chainStatus(o.id)).toMatchObject({ ok: true, count: 6 });

    // Tamper with a stored receipt: the status names it.
    const row = await forOrg(o.id).receipt.findFirstOrThrow({ where: { seq: 3 } });
    await forOrg(o.id).receipt.update({ where: { id: row.id }, data: { body: { ...(row.body as object), approval: { id: "apr_1", result: "rejected" } } } });
    expect(await chainStatus(o.id)).toMatchObject({ ok: false, seq: 3 });
  });

  it("describes every admin action", () => {
    const r = (action: string, details: Record<string, unknown> = {}, extra: Partial<Receipt> = {}) => adminTitle({ kind: "admin", action, details, seq: 1, ts: "", org: "", prev_hash: "", hash: "", sig: "", ...extra } as Receipt);
    expect(r("agent.created", {}, { agent: "ap-bot" })).toBe("Added the agent ap-bot");
    expect(r("agent.paused", {}, { agent: "ap-bot" })).toBe("Paused ap-bot");
    expect(r("agent.resumed")).toBe("Resumed an agent");
    expect(r("rulebook.signed", {}, { agent: "ap-bot", rulebook: { version: 3, hash: "" } })).toBe("Signed and published rulebook v3 for ap-bot");
    expect(r("key.created", {}, { agent: "x" })).toBe("Created an API key for x");
    expect(r("key.revoked")).toBe("Revoked an API key");
    expect(r("connector.connected", { connector: "zoho", mode: "live" })).toBe("Connected Zoho Books");
    expect(r("connector.connected", { connector: "gmail", mode: "mock" })).toBe("Connected Gmail with demo data");
    expect(r("connector.disconnected", { connector: "x" })).toBe("Disconnected a connector");
    expect(r("evidence.exported", { from: "a", to: "b" })).toBe("Downloaded evidence for a to b");
    expect(r("member.invited", { role: "auditor" })).toBe("Invited someone as auditor");
    expect(r("member.joined")).toBe("A new member joined as a member");
    expect(r("member.role_changed", { role: "admin" })).toBe("Changed a member's role to admin");
    expect(r("member.removed")).toBe("Removed a member");
    expect(r("settings.updated")).toBe("Changed organisation settings");
    expect(r("user.2fa_enabled")).toMatch(/on two-step/);
    expect(r("user.2fa_disabled")).toMatch(/off two-step/);
    expect(r("evidence.exported", { kind: "framework-report", framework: "hipaa" })).toBe("Downloaded the HIPAA framework report");
    expect(r("org.industry_set", { industry: "healthcare" })).toBe("Set the industry to healthcare");
    expect(r("framework.enabled", { framework: "gdpr" })).toBe("Turned on GDPR");
    expect(r("framework.disabled", { framework: "made-up" })).toBe("Turned off made-up");
    expect(r("key.rotated", { new_kid: "abc" })).toBe("Rotated the signing key to abc");
    expect(r("key.rotated")).toBe("Rotated the signing key");
    expect(r("webhook.created", { host: "siem.example.com" })).toBe("Added a webhook to siem.example.com");
    expect(r("webhook.deleted")).toBe("Deleted a webhook");
    expect(r("something.else")).toBe("something.else");
    expect(adminTitle({ kind: "admin" } as Receipt)).toBe("Setup change");
    expect(toView({ kind: "decision", seq: 1, ts: "", org: "", prev_hash: "", hash: "", sig: "" } as Receipt).status).toBe("admin");
  });
});

describe("formatting", () => {
  it("formats times in India time", () => {
    expect(fmtDate("2026-10-26T20:00:00Z")).toBe("27 Oct 2026");
    expect(dayLabel(new Date())).toBe("Today");
    expect(dayLabel(new Date(Date.now() - 86_400_000))).toBe("Yesterday");
    expect(dayLabel("2020-01-01T06:00:00Z")).toMatch(/January/);
    expect(relative(null)).toBe("Never");
    expect(relative(new Date())).toBe("Just now");
    expect(relative(new Date(Date.now() - 600_000))).toBe("10 min ago");
    expect(relative(new Date(Date.now() - 7_200_000))).toBe("2 h ago");
    expect(relative("2020-01-01T00:00:00Z")).toMatch(/2020/);
    expect(timeLeft(new Date(Date.now() - 1))).toBe("Expired");
    expect(timeLeft(new Date(Date.now() + 30 * 60_000 + 5000))).toBe("30 min left");
    expect(timeLeft(new Date(Date.now() + 25 * 3_600_000 + 5000))).toBe("25 h 0 min left");
    expect(timeLeft(new Date(Date.now() + 5 * 86_400_000))).toBe("5 days left");
    expect(shortHash("sha256:abcdef0123456789")).toBe("abcdef012345");
  });
});
