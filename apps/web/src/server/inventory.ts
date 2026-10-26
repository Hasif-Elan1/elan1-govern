import "server-only";
import {
  AFFECTED_PEOPLE,
  DATA_CATEGORIES,
  DECISION_IMPACTS,
  highestTier,
  LIFECYCLES,
  nextReviewDate,
  SYSTEM_KINDS,
  values,
  type RiskTier,
} from "@gate/core";
import { forOrg } from "@gate/db";
import { z } from "zod";
import { gate } from "./gate";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

const unique = <T>(xs: T[]) => new Set(xs).size === xs.length;

/** The fields a person can set on an AI system. Risk tier and next review come from approved assessments. */
export const SystemFields = z
  .object({
    name: z.string().trim().min(2, "Give the system a name.").max(120),
    kind: z.enum(values(SYSTEM_KINDS)),
    vendor: optionalText(120),
    purpose: z.string().trim().min(5, "Say in a sentence what it is used for.").max(1000),
    ownerEmail: z.string().trim().toLowerCase().email("Enter the owner's email address.").max(320),
    businessUnit: optionalText(120),
    lifecycle: z.enum(values(LIFECYCLES)),
    dataCategories: z
      .array(z.enum(values(DATA_CATEGORIES)))
      .max(DATA_CATEGORIES.length)
      .refine(unique, "Each kind of data once.")
      .refine((xs) => !(xs.includes("none") && xs.length > 1), "\"No personal data\" cannot be combined with other kinds."),
    affectedPeople: z.array(z.enum(values(AFFECTED_PEOPLE))).max(AFFECTED_PEOPLE.length).refine(unique, "Each group once."),
    decisionImpact: z.enum(values(DECISION_IMPACTS)),
  })
  .strict();

export type SystemInput = z.infer<typeof SystemFields>;

/**
 * Every Elan1 Govern agent appears in the inventory. Adds a system for each agent that has none;
 * idempotent and safe to run on every page load (a unique index on orgId + agentId
 * stops duplicates when two loads race).
 */
export async function syncAgentSystems(orgId: string): Promise<number> {
  const db = forOrg(orgId);
  const [agents, linked] = await Promise.all([
    db.agent.findMany({ select: { id: true, name: true, purpose: true, ownerEmail: true, riskTier: true } }),
    db.aiSystem.findMany({ where: { agentId: { not: null } }, select: { agentId: true } }),
  ]);
  const have = new Set(linked.map((s) => s.agentId));
  const missing = agents.filter((a) => !have.has(a.id));
  if (!missing.length) return 0;
  const r = await db.aiSystem.createMany({
    data: missing.map((a) => ({
      orgId,
      agentId: a.id,
      name: a.name,
      kind: "agent",
      purpose: a.purpose,
      ownerEmail: a.ownerEmail,
      lifecycle: "live",
      // A starting point from the agent's setup questions, until an assessment is approved.
      riskTier: a.riskTier,
      dataCategories: [],
      affectedPeople: [],
      decisionImpact: "makes_decisions",
    })),
    skipDuplicates: true,
  });
  return r.count;
}

/**
 * After an approval: the system's tier is the highest result among the latest approved
 * assessment of each template, and the next review is due 6, 12 or 24 months from now.
 */
export async function applyApprovedTier(orgId: string, systemId: string, now = new Date()) {
  const db = forOrg(orgId);
  const approved = await db.assessment.findMany({ where: { systemId, status: "approved" }, orderBy: { reviewedAt: "desc" }, select: { templateKey: true, resultTier: true } });
  const latest = new Map<string, RiskTier>();
  for (const a of approved) if (!latest.has(a.templateKey)) latest.set(a.templateKey, a.resultTier as RiskTier);
  const tier = highestTier(latest.values());
  const nextReviewAt = nextReviewDate(tier, now);
  await db.aiSystem.update({ where: { id: systemId }, data: { riskTier: tier, nextReviewAt } });
  return { tier, nextReviewAt };
}

type Details = Record<string, string | number | boolean | null>;

/**
 * Makes a change, then has Elan1 Govern write its signed receipt. If the receipt cannot be written,
 * the change is undone and the request fails, so nothing changes without a record.
 */
export async function withReceipt<T>(
  orgId: string,
  actor: string,
  action: string,
  change: () => Promise<T>,
  details: (t: T) => Details,
  undo: (t: T) => Promise<unknown>,
): Promise<T> {
  const t = await change();
  const r = await gate("POST", `/internal/orgs/${orgId}/events`, { actor, action, details: details(t) }).catch(() => ({ status: 0 }));
  if (r.status !== 200) {
    await undo(t);
    throw new Error(`receipt for ${action} not written (gate status ${r.status})`);
  }
  return t;
}
