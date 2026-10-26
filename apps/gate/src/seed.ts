import { hashToken } from "@gate/core";
import { addMembership, forOrg, membershipsForUser, prisma } from "@gate/db";
import argon2 from "argon2";
import pino from "pino";
import { createOrg, setUpDemoAgent } from "./admin";
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
  const demo = await setUpDemoAgent(deps, orgId, owner);

  // The demo agent's key is fixed by .env so `pnpm demo` can use it. Retire the random one.
  const db = forOrg(orgId);
  await db.apiKey.updateMany({ where: { agentId: demo.agentId, keyHash: { not: hashToken(demoKey) }, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!(await db.apiKey.findFirst({ where: { keyHash: hashToken(demoKey) } }))) {
    await db.apiKey.create({ data: { orgId, agentId: demo.agentId, label: "Demo key from .env", prefix: demoKey.slice(0, 10), keyHash: hashToken(demoKey) } });
  } else {
    await db.apiKey.updateMany({ where: { keyHash: hashToken(demoKey) }, data: { revokedAt: null } });
  }

  // A second client org where the CA is an auditor, to show the client switcher.
  const clientOwner = await user(DEMO.clientOwner.email, DEMO.clientOwner.name, password);
  const clientId = await orgFor(clientOwner.id, DEMO.clientOrg, deps, clientOwner.email);
  await addMembership({ orgId: clientId, userId: ca.id, role: "auditor" });

  console.log(`Seeded "${DEMO.org}". Sign in as ${DEMO.owner.email} (password: DEMO_OWNER_PASSWORD in .env).`);
  await prisma.$disconnect();
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seed().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
