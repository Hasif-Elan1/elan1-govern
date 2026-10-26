import { riskTier, rulebookToYaml, suggestRules, validateRulebook, type RiskAnswers } from "@gate/core";
import { approverGroupsOf, mergeStarterRules, packFor } from "@gate/core/frameworks";
import { forOrg } from "@gate/db";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";
import { syncAgentSystems } from "@/server/inventory";

const Answers = z.object({
  money: z.enum(["no", "yes"]),
  external: z.enum(["no", "yes"]),
  personal: z.enum(["no", "yes"]),
  amount: z.enum(["small", "medium", "large"]),
  oversight: z.enum(["always", "sometimes", "never"]),
});

const Body = z
  .object({
    name: z.string().trim().min(2, "Give the agent a name.").max(80),
    purpose: z.string().trim().min(5, "Say in a sentence what the agent does.").max(500),
    ownerEmail: z.string().trim().toLowerCase().email().max(320),
    answers: Answers,
    keepRules: z.array(z.string().max(64)).max(50).optional(),
  })
  .strict();

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}

/**
 * Add-agent wizard: register the agent, publish a starter rulebook from the questionnaire and
 * the org's industry pack, and return the key once.
 */
export const POST = route({ auth: "org", permission: "agents:manage", body: Body }, async ({ body, ctx }) => {
  const answers = body.answers as RiskAnswers;
  const tier = riskTier(answers);
  const db = forOrg(ctx.org.id);
  const org = await db.org.findFirstOrThrow({ select: { industry: true } });
  const starter = mergeStarterRules(packFor(org.industry), suggestRules(answers, tier), answers, tier);
  const rules = body.keepRules ? starter.rules.filter((r) => body.keepRules!.includes(r.id)) : starter.rules;

  const members = await db.membership.findMany({ where: { role: { in: ["owner", "admin", "approver"] } }, include: { user: { select: { email: true } } } });
  const people = [...new Set([body.ownerEmail, ...members.map((m) => m.user.email)])];

  let slug = slugify(body.name);
  if (await db.agent.findFirst({ where: { slug } })) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

  const rb = validateRulebook({
    version: 1,
    agent: slug,
    owner: body.ownerEmail,
    default: "refuse",
    // Every group the starter rules ask gets the same people: the owner and the org's approvers.
    approvers: Object.fromEntries(approverGroupsOf(rules, starter.quotas).map((g) => [g, people])),
    ...(answers.money === "yes" ? { limits: { daily_payments_inr: tier === "high" ? 300000 : 500000 } } : {}),
    ...(starter.quotas.length ? { quotas: starter.quotas } : {}),
    rules,
  });
  if (!rb.ok) throw new HttpError(400, rb.errors[0] ?? "The starter rules are not valid.");

  const r = await gate<{ agentId?: string; apiKey?: string; error?: string; rulebook?: { ok: boolean; errors?: string[] } }>("POST", `/internal/orgs/${ctx.org.id}/agents`, {
    name: body.name,
    slug,
    purpose: body.purpose,
    ownerEmail: body.ownerEmail,
    createdById: ctx.user.id,
    riskTier: tier,
    riskAnswers: answers,
    yaml: rulebookToYaml(rb.rulebook),
    actor: ctx.user.email,
  });
  if (r.status !== 200) throw new HttpError(r.status === 409 ? 409 : 502, r.data.error ?? "Elan1 Govern could not create the agent.");
  // The new agent joins the AI inventory straight away (the inventory page also catches up on load).
  await syncAgentSystems(ctx.org.id);
  return { slug, tier, apiKey: r.data.apiKey, rulebook: r.data.rulebook };
});
