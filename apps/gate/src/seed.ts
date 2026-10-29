import { randomBytes } from "node:crypto";
import { BEHAVIOUR_DEFAULTS, encrypt, hashToken, invoicePrefix, randomToken } from "@gate/core";
import { packById, recommendedFrameworks, type Region } from "@gate/core/frameworks";
import { addMembership, enableFrameworks, forOrg, membershipsForUser, prisma } from "@gate/db";
import { CONSOLE_INVITES, CONSOLE_ORGS, CONSOLE_PEOPLE, CONSOLE_SUSPENSIONS } from "@gate/db/console-demo";
import argon2 from "argon2";
import pino from "pino";
import { adminEvent, createOrg, setUpDemoAgent } from "./admin";
import { addDemoHistory } from "./demo/history";
import { addEgressRule } from "./egress";
import { updateBehaviourSettings } from "./behaviour";
import { guard } from "./guard";
import { makeDeps } from "./deps";
import { readGateEnv } from "./env";

// Seeds a demo org you can sign in to: owner@demo.test with DEMO_OWNER_PASSWORD from .env.
// Safe to run again: existing users and orgs are reused.

export const DEMO = {
  owner: { email: "owner@demo.test", name: "Priya Raman" },
  ca: { email: "ca@demo.test", name: "Anil Sharma (CA)" },
  clientOwner: { email: "owner@patelagro.test", name: "Meera Patel" },
  org: "Demo Traders Pvt Ltd",
  clientOrg: "Patel Agro Foods LLP",
};

async function user(email: string, name: string, password: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({ data: { email, name, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) } });
}

async function orgFor(userId: string, name: string, deps: ReturnType<typeof makeDeps>, email: string) {
  const found = (await membershipsForUser(userId)).find((m) => m.org.name === name);
  if (found) return found.orgId;
  return (await createOrg(deps, { name, ownerUserId: userId, ownerEmail: email })).id;
}

/** Records the org's industry and switches on the pack's frameworks for where it operates. */
async function setIndustry(deps: ReturnType<typeof makeDeps>, orgId: string, actor: string, industry: string, regions: Region[]) {
  const db = forOrg(orgId);
  const org = await db.org.findFirstOrThrow();
  if (org.industry !== industry) {
    await db.org.update({ where: { id: orgId }, data: { industry, regions } });
    await adminEvent(deps, orgId, actor, "org.industry_set", { industry, regions: regions.join(", ") });
  }
  for (const framework of await enableFrameworks(orgId, recommendedFrameworks(packById(industry)!, regions), actor)) {
    await adminEvent(deps, orgId, actor, "framework.enabled", { framework });
  }
}

/**
 * So the Alerts page has something real to show: the demo agent does a little ordinary work
 * (reads invoices, pays Kaveri Logistics) while it is still learning, then the demo org turns
 * its learning period off and the agent pays a vendor it has never paid before. That payment
 * raises a genuine "New vendor" alert through the normal inline check. Runs once.
 */
async function demoBehaviour(deps: ReturnType<typeof makeDeps>, orgId: string, agentId: string, actor: string) {
  const db = forOrg(orgId);
  if (await db.receipt.count({ where: { agent: "ap-bot", kind: "decision" } })) return;
  const who = { orgId, agentId };
  await guard(deps, who, "gmail.search", { query: "invoice has:attachment" });
  for (const id of ["m_101", "m_102", "m_103"]) await guard(deps, who, "gmail.read_message", { message_id: id });
  await guard(deps, who, "zoho.list_bills", { status: "open" });
  await guard(deps, who, "zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 6000, reference: "NEFT part payment" });
  await updateBehaviourSettings(deps, orgId, { ...BEHAVIOUR_DEFAULTS, learningDays: 0 }, actor);
  await guard(deps, who, "zoho.record_bill_payment", { bill_id: "bill_554", amount_inr: 4200, reference: "NEFT demo" });
  for (let i = 0; i < 5 && deps.background.size; i++) await Promise.all([...deps.background]);
}

export async function seed() {
  const env = readGateEnv();
  const password = process.env.DEMO_OWNER_PASSWORD;
  const demoKey = process.env.DEMO_AGENT_KEY;
  if (!password || password.length < 12) throw new Error("DEMO_OWNER_PASSWORD must be set (12+ characters) to seed the demo org.");
  if (!demoKey || !/^gk_[A-Za-z0-9_-]{43}$/.test(demoKey)) throw new Error("DEMO_AGENT_KEY must be set (gk_ followed by 43 characters).");
  const deps = makeDeps(env, pino({ level: "warn" }));

  const owner = await user(DEMO.owner.email, DEMO.owner.name, password);
  const ca = await user(DEMO.ca.email, DEMO.ca.name, password);
  const orgId = await orgFor(owner.id, DEMO.org, deps, owner.email);
  await addMembership({ orgId, userId: ca.id, role: "approver" });
  await setIndustry(deps, orgId, owner.email, "finance", ["india", "eu"]);
  const demo = await setUpDemoAgent(deps, orgId, owner);

  // The demo agent's key is fixed by .env so `pnpm demo` can use it. Retire the random one.
  const db = forOrg(orgId);
  await db.apiKey.updateMany({ where: { agentId: demo.agentId, keyHash: { not: hashToken(demoKey) }, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!(await db.apiKey.findFirst({ where: { keyHash: hashToken(demoKey) } }))) {
    await db.apiKey.create({ data: { orgId, agentId: demo.agentId, label: "Demo key from .env", prefix: demoKey.slice(0, 10), keyHash: hashToken(demoKey) } });
  } else {
    await db.apiKey.updateMany({ where: { keyHash: hashToken(demoKey) }, data: { revokedAt: null } });
  }

  // A month of resolved payment approvals, so the Rulebooks page has a suggestion to show.
  await addDemoHistory(deps, orgId, owner.email);
  await demoBehaviour(deps, orgId, demo.agentId, owner.email);

  // A second client org where the CA is an auditor, to show the client switcher.
  const clientOwner = await user(DEMO.clientOwner.email, DEMO.clientOwner.name, password);
  const clientId = await orgFor(clientOwner.id, DEMO.clientOrg, deps, clientOwner.email);
  await addMembership({ orgId: clientId, userId: ca.id, role: "auditor" });
  await setIndustry(deps, clientId, clientOwner.email, "finance", ["india"]);

  console.log(`Seeded "${DEMO.org}". Sign in as ${DEMO.owner.email} (password: DEMO_OWNER_PASSWORD in .env).`);

  // The approved console's four demo organisations, one per level, with their people.
  if (env.DEMO_CONSOLE_PASSWORD) {
    const webEncKey = process.env.WEB_ENC_KEY;
    if (!webEncKey || !/^[0-9a-f]{64}$/i.test(webEncKey)) throw new Error("WEB_ENC_KEY must be set (64 hex characters) to seed two-step sign-in for the console's demo accounts.");
    const r = await seedConsoleDemo(deps, { password: env.DEMO_CONSOLE_PASSWORD, webEncKey });
    console.log(`Seeded the console's ${r.orgs} demo organisations and ${r.users} people. Every demo account signs in with DEMO_CONSOLE_PASSWORD from .env.`);
  } else {
    console.log("DEMO_CONSOLE_PASSWORD is not set, so the console's demo organisations were not seeded.");
  }
  await prisma.$disconnect();
}

// ── The console's demo organisations ──

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding, the form authenticator apps and otpauth read. */
function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** A fresh TOTP secret (160 bits), encrypted exactly as the web app stores one (WEB_ENC_KEY, AAD "totp"). */
function newTotpSecretEnc(webEncKey: string): string {
  return encrypt(webEncKey, base32(randomBytes(20)), "totp");
}

/**
 * Seeds the console's organisations (org_demo, org_northbank, org_kaveri, org_deccan) with their fixed ids
 * and levels, every console person with their console id, their memberships (the auditor in all four,
 * Deepak Jain suspended at Northbank), TOTP secrets for the two-step accounts and the pending invitation.
 * Agents and receipts are not seeded here; only the org's own setup receipts are written.
 * Safe to run again: existing rows are reused and never overwritten (passwords, roles and secrets stay as they are).
 */
/** ── wiring: sovereign ── the hosts inside Deccan's network its deployment may reach (apps/console/src/mock/sovereign.ts seedState). */
const DECCAN_INTERNAL_HOSTS = [
  { host: "siem.deccanbank.internal", note: "Splunk HTTP Event Collector in the security operations centre (receipt events)" },
  { host: "smtp-relay.deccanbank.internal", note: "Internal mail relay for approval and sign-in emails" },
  { host: "itsm.deccanbank.internal", note: "On-premises ServiceNow (incident tickets from alerts)" },
];

export async function seedConsoleDemo(deps: ReturnType<typeof makeDeps>, opts: { password: string; webEncKey: string }) {
  const passwordHash = await argon2.hash(opts.password, { type: argon2.argon2id });
  const byId = new Map(CONSOLE_PEOPLE.map((p) => [p.id, p]));

  for (const person of CONSOLE_PEOPLE) {
    const existing = await prisma.user.findUnique({ where: { id: person.id } });
    if (existing) continue;
    const clash = await prisma.user.findUnique({ where: { email: person.email }, select: { id: true } });
    if (clash) throw new Error(`${person.email} already belongs to another account (${clash.id}), so the console's ${person.id} cannot be seeded.`);
    await prisma.user.create({
      data: {
        id: person.id,
        email: person.email,
        name: person.name,
        title: person.title,
        passwordHash,
        ...(person.mfa ? { totpSecret: newTotpSecretEnc(opts.webEncKey), totpEnabled: true } : {}),
      },
    });
  }

  for (const o of CONSOLE_ORGS) {
    const owner = CONSOLE_PEOPLE.find((p) => p.memberships.some((m) => m.orgId === o.id && m.role === "owner"))!;
    const db = forOrg(o.id);
    if (!(await db.org.findFirst({ select: { id: true } }))) {
      await createOrg(deps, { id: o.id, name: o.name, ownerUserId: owner.id, ownerEmail: owner.email });
      await db.org.update({ where: { id: o.id }, data: { industry: o.industry, regions: o.regions, currency: o.currency, timezone: o.timezone, level: o.level } });
      await adminEvent(deps, o.id, owner.email, "org.industry_set", { industry: o.industry, regions: o.regions.join(", ") });
      if (o.level !== "l1") await adminEvent(deps, o.id, owner.email, "org.level_set", { level: o.level, from: "l1" });
    }

    for (const person of CONSOLE_PEOPLE) {
      for (const m of person.memberships.filter((x) => x.orgId === o.id)) {
        if (await db.membership.findFirst({ where: { userId: person.id } })) continue;
        await db.membership.create({ data: { orgId: o.id, userId: person.id, role: m.role, status: m.status } });
        await adminEvent(deps, o.id, owner.email, "member.joined", { role: m.role });
        const suspension = CONSOLE_SUSPENSIONS.find((s) => s.orgId === o.id && s.userId === person.id);
        if (suspension) await adminEvent(deps, o.id, byId.get(suspension.by)?.email ?? owner.email, "member.suspended", { member_id: person.id, reason: suspension.reason });
      }
    }

    for (const inv of CONSOLE_INVITES.filter((i) => i.orgId === o.id)) {
      if (await db.invite.findFirst({ where: { email: inv.email, acceptedAt: null } })) continue;
      // The link itself is not kept: the console lists the invitation as pending; resending makes a new link.
      const invitedBy = byId.get(inv.invitedBy)?.email ?? owner.email;
      await db.invite.create({ data: { orgId: o.id, email: inv.email, role: inv.role, tokenHash: hashToken(randomToken()), invitedBy, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
      await adminEvent(deps, o.id, invitedBy, "member.invited", { role: inv.role });
    }
  }

  // ── wiring: sovereign ── Deccan's internal allow-list, as the console's Egress screen seeds it (real EgressRule
  // rows: the console's "what it is for" is the rule's note). Each is added by the owner, with its receipt.
  const deccanOwner = CONSOLE_PEOPLE.find((p) => p.memberships.some((m) => m.orgId === "org_deccan" && m.role === "owner"));
  for (const h of DECCAN_INTERNAL_HOSTS) {
    if (!deccanOwner || (await forOrg("org_deccan").egressRule.findFirst({ where: { host: h.host }, select: { id: true } }))) continue;
    const r = await addEgressRule(deps, "org_deccan", { host: h.host, port: null, purpose: null, note: h.note, actor: deccanOwner.id });
    if (!r.ok) throw new Error(`Deccan's internal host ${h.host} could not be seeded: ${r.error}`);
  }

  // ── wiring: billing ── each demo organisation's billing account on its console plan (its level). The console's
  // own seed tells the rest as receipts (Demo Traders' pilot, offers, disputes, runs), which the ledger takes as they
  // are written (apps/gate/src/wiring/billing.ts).
  for (const o of CONSOLE_ORGS) {
    const db = forOrg(o.id);
    if (await db.billingAccount.findFirst({ select: { id: true } })) continue;
    const owner = CONSOLE_PEOPLE.find((p) => p.memberships.some((m) => m.orgId === o.id && m.role === "owner"))!;
    const account = await db.billingAccount.create({ data: { orgId: o.id, plan: o.level, invoicePrefix: invoicePrefix(o.name), buyerName: o.name } });
    await adminEvent(deps, o.id, owner.email, "billing.account_opened", { plan: account.plan, invoice_prefix: account.invoicePrefix });
  }
  return { orgs: CONSOLE_ORGS.length, users: CONSOLE_PEOPLE.length };
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seed().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
