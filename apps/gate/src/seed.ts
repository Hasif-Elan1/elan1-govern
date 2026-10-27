import { hashToken } from "@gate/core";
import { packById, recommendedFrameworks, type Region } from "@gate/core/frameworks";
import { addMembership, enableFrameworks, forOrg, membershipsForUser, prisma } from "@gate/db";
import argon2 from "argon2";
import pino from "pino";
import { adminEvent, createOrg, setUpDemoAgent } from "./admin";
import { addDemoHistory } from "./demo/history";
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

  // A second client org where the CA is an auditor, to show the client switcher.
  const clientOwner = await user(DEMO.clientOwner.email, DEMO.clientOwner.name, password);
  const clientId = await orgFor(clientOwner.id, DEMO.clientOrg, deps, clientOwner.email);
  await addMembership({ orgId: clientId, userId: ca.id, role: "auditor" });
  await setIndustry(deps, clientId, clientOwner.email, "finance", ["india"]);

  console.log(`Seeded "${DEMO.org}". Sign in as ${DEMO.owner.email} (password: DEMO_OWNER_PASSWORD in .env).`);
  await prisma.$disconnect();
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seed().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
