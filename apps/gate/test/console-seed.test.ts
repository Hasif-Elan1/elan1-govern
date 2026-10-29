import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decrypt, invoicePrefix } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import { CONSOLE_DEMO_ACCOUNTS, CONSOLE_INVITES, CONSOLE_ORGS, CONSOLE_PEOPLE } from "@gate/db/console-demo";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../src/deps";
import { seedConsoleDemo } from "../src/seed";
import { internal, makeApp } from "./helpers";

// The console's own directory (apps/console/src/mock/users.ts), read as data, so the seed cannot drift from it.
interface ConsoleUser { id: string; name: string; email: string; role: string; title: string; orgIds: string[]; mfa: boolean }
interface ConsoleOrg { id: string; name: string; industry: string; currency: string; timezone: string; plan: string; regions: string[] }
type ConsoleMock = { USERS: ConsoleUser[]; ORGS: ConsoleOrg[]; INVITED: { email: string; role: string }[]; DEMO_ACCOUNTS: { userId: string; orgId: string; journey: string }[] };

const PASSWORD = "seed test demo password";
const WEB_ENC_KEY = process.env.WEB_ENC_KEY!;
let app: Awaited<ReturnType<typeof makeApp>>["app"];
let deps: Deps;
let mock: ConsoleMock;

const snapshot = async () => {
  const ids = CONSOLE_ORGS.map((o) => o.id);
  return {
    users: await prisma.user.count({ where: { id: { in: CONSOLE_PEOPLE.map((p) => p.id) } } }),
    memberships: await prisma.membership.count({ where: { orgId: { in: ids } } }),
    invites: await prisma.invite.count({ where: { orgId: { in: ids } } }),
    // the anchor job (anchors.test.ts runs it over every org, in parallel) may batch the console orgs' new receipts:
    // its anchor.batched receipts are not the seed's
    receipts: await prisma.receipt.count({ where: { orgId: { in: ids }, OR: [{ action: null }, { action: { not: "anchor.batched" } }] } }),
    hashes: (await prisma.user.findMany({ where: { id: { in: CONSOLE_PEOPLE.map((p) => p.id) } }, select: { id: true, passwordHash: true, totpSecret: true }, orderBy: { id: "asc" } })),
  };
};

beforeAll(async () => {
  ({ app, deps } = await makeApp());
  mock = (await import(pathToFileURL(resolve(__dirname, "../../console/src/mock/users.ts")).href)) as ConsoleMock;
  await seedConsoleDemo(deps, { password: PASSWORD, webEncKey: WEB_ENC_KEY });
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("seeding the console's demo organisations", () => {
  it("matches the console's own directory: every org, person, role and the pending invite", () => {
    expect(CONSOLE_ORGS.map((o) => [o.id, o.name, o.industry, o.currency, o.timezone, o.level, o.regions.join(",")])).toEqual(
      mock.ORGS.map((o) => [o.id, o.name, o.industry, o.currency, o.timezone, o.plan, o.regions.map((r) => r.toLowerCase()).join(",")]),
    );
    expect(CONSOLE_PEOPLE.map((p) => [p.id, p.name, p.email, p.title, p.mfa, p.memberships.map((m) => `${m.orgId}:${m.role}`).join(" ")])).toEqual(
      mock.USERS.map((u) => [u.id, u.name, u.email, u.title, u.mfa, u.orgIds.map((o) => `${o}:${u.role}`).join(" ")]),
    );
    expect(CONSOLE_INVITES.map((i) => [i.email, i.role])).toEqual(mock.INVITED.map((i) => [i.email, i.role]));
    // the panel lists the foundation's accounts first, in the same order and organisations
    expect(CONSOLE_DEMO_ACCOUNTS.slice(0, mock.DEMO_ACCOUNTS.length).map((a) => [a.userId, a.orgId, a.journey])).toEqual(mock.DEMO_ACCOUNTS.map((a) => [a.userId, a.orgId, a.journey]));
  });

  it("creates the four organisations with their exact ids, levels and settings", async () => {
    const orgs = await prisma.org.findMany({ where: { id: { in: CONSOLE_ORGS.map((o) => o.id) } }, orderBy: { createdAt: "asc" } });
    expect(Object.fromEntries(orgs.map((o) => [o.id, [o.name, o.level, o.industry, o.currency, o.timezone]]))).toEqual({
      org_demo: ["Demo Traders Pvt Ltd", "l1", "finance", "INR", "Asia/Kolkata"],
      org_northbank: ["Northbank Industrial Ltd", "l2", "general", "INR", "Asia/Kolkata"],
      org_kaveri: ["Kaveri Health Network", "l3", "healthcare", "INR", "Asia/Kolkata"],
      org_deccan: ["Deccan Cooperative Bank Ltd", "sovereign", "finance", "INR", "Asia/Kolkata"],
    });
    // a real org: its own signing key and a receipt chain that starts with its creation; level changes are receipts
    const nb = await forOrg("org_northbank").receipt.findMany({ where: { kind: "admin" }, orderBy: { seq: "asc" } });
    expect(nb[0]!.action).toBe("org.created");
    expect((nb.find((r) => r.action === "org.level_set")?.body as { details?: unknown } | undefined)?.details).toMatchObject({ level: "l2", from: "l1" });
    expect(await forOrg("org_demo").receipt.count({ where: { action: "org.level_set" } })).toBe(0);
    expect(await forOrg("org_northbank").agent.count()).toBe(0);
  });

  it("gives every person their console id, role per org and membership status", async () => {
    for (const p of CONSOLE_PEOPLE) {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: p.id }, include: { memberships: true } });
      expect([u.email, u.name, u.title]).toEqual([p.email, p.name, p.title]);
      expect(u.memberships.map((m) => `${m.orgId}:${m.role}:${m.status}`).sort()).toEqual(p.memberships.map((m) => `${m.orgId}:${m.role}:${m.status}`).sort());
    }
    const kavita = await prisma.membership.findMany({ where: { userId: "u_kavita" } });
    expect(kavita.map((m) => [m.orgId, m.role, m.status]).sort()).toEqual([
      ["org_deccan", "auditor", "active"],
      ["org_demo", "auditor", "active"],
      ["org_kaveri", "auditor", "active"],
      ["org_northbank", "auditor", "active"],
    ]);
    const deepak = await prisma.membership.findFirstOrThrow({ where: { userId: "u_nb_deepak" } });
    expect([deepak.orgId, deepak.role, deepak.status]).toEqual(["org_northbank", "viewer", "suspended"]);
    expect(await forOrg("org_northbank").receipt.count({ where: { action: "member.suspended" } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: "u_ananya" } })).id).toBe("u_ananya");
  });

  it("uses the shared demo password and a per-install TOTP secret for two-step accounts only", async () => {
    const ananya = await prisma.user.findUniqueOrThrow({ where: { id: "u_ananya" } });
    expect(ananya.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(ananya.passwordHash, PASSWORD)).toBe(true);
    expect(ananya.totpEnabled).toBe(true);
    expect(decrypt(WEB_ENC_KEY, ananya.totpSecret!, "totp")).toMatch(/^[A-Z2-7]{32}$/);
    const meera = await prisma.user.findUniqueOrThrow({ where: { id: "u_meera" } });
    expect([meera.totpEnabled, meera.totpSecret]).toEqual([false, null]);
    // every two-step secret is its own
    const secrets = (await prisma.user.findMany({ where: { id: { in: CONSOLE_PEOPLE.filter((p) => p.mfa).map((p) => p.id) } } })).map((u) => decrypt(WEB_ENC_KEY, u.totpSecret!, "totp"));
    expect(new Set(secrets).size).toBe(CONSOLE_PEOPLE.filter((p) => p.mfa).length);
  });

  it("lists the console's pending invitation", async () => {
    const inv = await forOrg("org_demo").invite.findMany({ where: { email: "deepa.joshi@demotraders.in" } });
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ role: "approver", invitedBy: "ananya.rao@demotraders.in", acceptedAt: null });
    expect(inv[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("opens each organisation's billing account on its console plan, with its receipt, and nobody is platform staff", async () => {
    for (const o of CONSOLE_ORGS) {
      expect(await forOrg(o.id).billingAccount.findFirst()).toMatchObject({ plan: o.level, buyerName: o.name, invoicePrefix: invoicePrefix(o.name) });
      expect(await forOrg(o.id).receipt.count({ where: { action: "billing.account_opened" } })).toBe(1);
    }
    expect(await prisma.user.count({ where: { id: { in: CONSOLE_PEOPLE.map((p) => p.id) }, isPlatformStaff: true } })).toBe(0);
  });

  it("is idempotent: a second run reuses every row and writes nothing", async () => {
    const before = await snapshot();
    await seedConsoleDemo(deps, { password: "a different password now", webEncKey: WEB_ENC_KEY });
    expect(await snapshot()).toEqual(before);
  });

  it("refuses to take over an email that belongs to another account", async () => {
    const clash = CONSOLE_PEOPLE.find((p) => p.id === "u_dc_ashwin")!;
    await prisma.user.delete({ where: { id: clash.id } });
    await prisma.user.create({ data: { email: clash.email, name: "Someone else", passwordHash: "x" } });
    await expect(seedConsoleDemo(deps, { password: PASSWORD, webEncKey: WEB_ENC_KEY })).rejects.toThrow(/already belongs to another account/);
    await prisma.user.delete({ where: { email: clash.email } });
    await seedConsoleDemo(deps, { password: PASSWORD, webEncKey: WEB_ENC_KEY });
    expect(await prisma.membership.findFirst({ where: { userId: clash.id, orgId: "org_deccan", role: "approver" } })).not.toBeNull();
  });
});

describe("web events for identity", () => {
  it("accepts auth.password_reset and auth.sign_in_refused receipts from the web app", async () => {
    for (const action of ["auth.password_reset", "auth.sign_in_refused"]) {
      const res = await internal(app, "POST", "/internal/orgs/org_kaveri/events", { actor: "lakshmi.pillai@kaverihealth.in", action, details: { sessions_ended: 2 } });
      expect(res.statusCode).toBe(200);
      const r = await forOrg("org_kaveri").receipt.findFirstOrThrow({ where: { seq: res.json().seq } });
      expect([r.kind, r.action, (r.body as { actor?: string }).actor]).toEqual(["admin", action, "lakshmi.pillai@kaverihealth.in"]);
    }
  });
});
