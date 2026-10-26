import { authorizeUrl, CONNECTOR_LABELS, type ConnectorKind, type ConnectorMode } from "@gate/connectors";
import {
  encrypt,
  generateKeyPair,
  hashToken,
  hmacSign,
  parseRulebookYaml,
  publishProblems,
  randomToken,
  rulebookHash,
  rulebookToYaml,
  signRulebook,
  type ReceiptInput,
} from "@gate/core";
import { packById, starterRulebook } from "@gate/core/frameworks";
import { addMembership, createOrgRow, forOrg, type RiskTier } from "@gate/db";
import { chain, record } from "./chain";
import type { Deps } from "./deps";
import { addFirstKey, legacyKeyAad } from "./keys";
import { registryFor } from "./registry";

export async function adminEvent(deps: Deps, orgId: string, actor: string, action: string, details: Record<string, unknown> = {}, extra: Partial<ReceiptInput> = {}) {
  return record(deps, orgId, { kind: "admin", actor, action, details, ...extra });
}

export async function createOrg(deps: Deps, input: { name: string; ownerUserId: string; ownerEmail: string }) {
  const keys = generateKeyPair();
  // Encrypt under an AAD bound to the org id, so the row id is needed before the key.
  const org = await createOrgRow({ name: input.name, publicKey: keys.publicKeyPem, privateKeyEnc: "pending", notifyEmail: input.ownerEmail }, deps.db);
  await forOrg(org.id, deps.db).org.update({ where: { id: org.id }, data: { privateKeyEnc: encrypt(deps.env.GATE_MASTER_KEY, keys.privateKeyPem, legacyKeyAad(org.id)) } });
  await addFirstKey(deps, org.id, keys);
  await addMembership({ orgId: org.id, userId: input.ownerUserId, role: "owner" }, deps.db);
  const db = forOrg(org.id, deps.db);
  for (const kind of ["gmail", "zoho"] as const) {
    await db.connector.create({ data: { orgId: org.id, kind, mode: deps.env.CONNECTOR_MODE, status: "disconnected" } });
  }
  await adminEvent(deps, org.id, input.ownerEmail, "org.created", { name: input.name });
  return org;
}

export function newApiKey() {
  const key = randomToken("gk_");
  return { key, prefix: key.slice(0, 10), keyHash: hashToken(key) };
}

export async function createAgent(
  deps: Deps,
  orgId: string,
  input: { name: string; slug: string; purpose: string; ownerEmail: string; createdById: string; riskTier: RiskTier; riskAnswers?: Record<string, string>; actor: string },
) {
  const db = forOrg(orgId, deps.db);
  if (await db.agent.findFirst({ where: { slug: input.slug } })) return { ok: false as const, error: `An agent called "${input.slug}" already exists.` };
  const agent = await db.agent.create({
    data: { orgId, slug: input.slug, name: input.name, purpose: input.purpose, ownerEmail: input.ownerEmail.toLowerCase(), createdById: input.createdById, riskTier: input.riskTier, riskAnswers: input.riskAnswers ?? undefined },
  });
  const k = newApiKey();
  await db.apiKey.create({ data: { orgId, agentId: agent.id, prefix: k.prefix, keyHash: k.keyHash } });
  await adminEvent(deps, orgId, input.actor, "agent.created", { name: agent.name, risk_tier: agent.riskTier, owner: agent.ownerEmail }, { agent: agent.slug });
  return { ok: true as const, agent, apiKey: k.key };
}

export async function rotateKey(deps: Deps, orgId: string, agentId: string, actor: string, revokeKeyId?: string) {
  const db = forOrg(orgId, deps.db);
  const agent = await db.agent.findFirstOrThrow({ where: { id: agentId } });
  if (revokeKeyId) {
    await db.apiKey.updateMany({ where: { id: revokeKeyId, agentId, revokedAt: null }, data: { revokedAt: new Date() } });
    await adminEvent(deps, orgId, actor, "key.revoked", { key_id: revokeKeyId }, { agent: agent.slug });
    return { apiKey: null };
  }
  const k = newApiKey();
  await db.apiKey.create({ data: { orgId, agentId, prefix: k.prefix, keyHash: k.keyHash, label: "Created in Elan1 Govern" } });
  await adminEvent(deps, orgId, actor, "key.created", { prefix: k.prefix }, { agent: agent.slug });
  return { apiKey: k.key };
}

export async function setAgentStatus(deps: Deps, orgId: string, agentId: string, status: "active" | "paused", actor: string) {
  const db = forOrg(orgId, deps.db);
  const agent = await db.agent.update({ where: { id: agentId }, data: { status } });
  await adminEvent(deps, orgId, actor, status === "paused" ? "agent.paused" : "agent.resumed", {}, { agent: agent.slug });
  return agent;
}

export type PublishResult = { ok: true; version: number; hash: string; yaml: string } | { ok: false; errors: string[] };

export async function publishRulebook(deps: Deps, orgId: string, agentId: string, yaml: string, actor: string): Promise<PublishResult> {
  const registry = await registryFor(deps, orgId);
  const parsed = parseRulebookYaml(yaml, registry);
  if (!parsed.ok) return parsed;
  const db = forOrg(orgId, deps.db);
  const agent = await db.agent.findFirst({ where: { id: agentId } });
  if (!agent) return { ok: false, errors: ["No such agent."] };
  return chain(deps, orgId, async (append, tx, key) => {
      const latest = await tx.rulebook.findFirst({ where: { agentId }, orderBy: { version: "desc" }, select: { version: true } });
      const { signature: _old, ...rest } = parsed.rulebook;
      const rb = { ...rest, version: (latest?.version ?? 0) + 1, agent: agent.slug };
      const problems = publishProblems(rb, agent.riskTier, registry);
      if (problems.length) return { ok: false as const, errors: problems };
      const signed = signRulebook(rb, key.privateKeyPem);
      const text = rulebookToYaml(signed);
      const hash = rulebookHash(signed);
      const row = await tx.rulebook.create({ data: { orgId, agentId, version: rb.version, yaml: text, hash, signedBy: actor } });
      await tx.agent.update({ where: { id: agentId }, data: { activeRulebookId: row.id } });
      await append({ kind: "admin", actor, action: "rulebook.signed", agent: agent.slug, rulebook: { version: rb.version, hash }, details: { rules: rb.rules.length } });
      return { ok: true as const, version: rb.version, hash, yaml: text };
  });
}

export function oauthState(deps: Deps, orgId: string, kind: ConnectorKind, actor: string) {
  return hmacSign(deps.env.INTERNAL_API_SECRET, { p: "oauth", o: orgId, k: kind, u: actor, x: Math.floor(Date.now() / 1000) + 600, n: randomToken() });
}

export function redirectUri(deps: Deps, kind: ConnectorKind) {
  return `${deps.env.GATE_PUBLIC_URL}/oauth/${kind}/callback`;
}

export async function connectConnector(deps: Deps, orgId: string, kind: ConnectorKind, actor: string, requestedMode?: ConnectorMode) {
  const mode = requestedMode ?? deps.env.CONNECTOR_MODE;
  const db = forOrg(orgId, deps.db);
  if (mode === "live") {
    const cfg = kind === "gmail" ? deps.live.google : deps.live.zoho;
    if (!cfg) return { ok: false as const, error: `${CONNECTOR_LABELS[kind]} is not configured on this server. Set the ${kind === "gmail" ? "GOOGLE" : "ZOHO"}_CLIENT_ID and _SECRET values.` };
    return { ok: true as const, redirect: authorizeUrl(kind, cfg, redirectUri(deps, kind), oauthState(deps, orgId, kind, actor)) };
  }
  const label = kind === "gmail" ? "ap@demotraders.in (demo mailbox)" : "Demo Traders Pvt Ltd (demo books)";
  await db.connector.upsert({
    where: { orgId_kind: { orgId, kind } },
    create: { orgId, kind, mode: "mock", status: "connected", accountLabel: label, connectedAt: new Date() },
    update: { mode: "mock", status: "connected", accountLabel: label, connectedAt: new Date(), tokensEnc: null },
  });
  await adminEvent(deps, orgId, actor, "connector.connected", { connector: kind, mode: "mock" });
  return { ok: true as const, status: "connected" };
}

export async function disconnectConnector(deps: Deps, orgId: string, kind: ConnectorKind, actor: string) {
  await forOrg(orgId, deps.db).connector.updateMany({ where: { kind }, data: { status: "disconnected", tokensEnc: null } });
  await adminEvent(deps, orgId, actor, "connector.disconnected", { connector: kind });
  return { ok: true as const, status: "disconnected" };
}

/** The accounts-payable demo's rulebook: the finance industry pack's starter rules. */
export function demoRulebookYaml(owner: string, approvers: string[]): string {
  return rulebookToYaml(starterRulebook(packById("finance")!, { agent: "ap-bot", owner, approvers }));
}

/** Creates (or reuses) the demo AP agent with mock connectors and a signed rulebook. */
export async function setUpDemoAgent(deps: Deps, orgId: string, user: { id: string; email: string }) {
  const db = forOrg(orgId, deps.db);
  for (const kind of ["gmail", "zoho"] as const) await connectConnector(deps, orgId, kind, user.email, "mock");
  let agent = await db.agent.findFirst({ where: { slug: "ap-bot" } });
  let apiKey: string;
  if (!agent) {
    const created = await createAgent(deps, orgId, {
      name: "AP bot",
      slug: "ap-bot",
      purpose: "Reads vendor invoices from Gmail, creates bills in Zoho Books and records payments.",
      ownerEmail: user.email,
      createdById: user.id,
      riskTier: "high",
      riskAnswers: { money: "yes", external: "yes", personal: "yes", amount: "medium", oversight: "sometimes" },
      actor: user.email,
    });
    if (!created.ok) throw new Error(created.error);
    agent = created.agent;
    apiKey = created.apiKey;
  } else {
    apiKey = (await rotateKey(deps, orgId, agent.id, user.email)).apiKey as string;
  }
  if (!agent.activeRulebookId) {
    const approvers = (await db.membership.findMany({ where: { role: { in: ["owner", "admin", "approver"] } }, include: { user: { select: { email: true } } } })).map((m) => m.user.email);
    const res = await publishRulebook(deps, orgId, agent.id, demoRulebookYaml(user.email, approvers), user.email);
    if (!res.ok) throw new Error(res.errors.join("; "));
  }
  return { agentId: agent.id, apiKey, mcpUrl: `${deps.env.GATE_PUBLIC_URL}/mcp` };
}
