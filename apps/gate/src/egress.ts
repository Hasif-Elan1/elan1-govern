import { createEgress, EGRESS_PURPOSES, egressFetch, egressRuleProblem, forOrg, normalizeHost, purgeEgressLog, type Egress, type EgressCheckOptions } from "@gate/db";
import type { FastifyBaseLogger } from "fastify";
import { adminEvent } from "./admin";
import { raiseAlert, type Deps } from "./deps";
import type { GateEnv } from "./env";

// The gate's side of the egress gate (packages/db/src/egress.ts): a blocked connection for an
// organisation becomes an `egress.blocked` receipt on that organisation's chain; one with no
// organisation (the SMTP relay) becomes a health alert. A system attempt raises one per host,
// port and purpose per hour, so a webhook retrying against a denied host cannot flood the chain.

export const EGRESS_BLOCKED_ACTION = "egress.blocked";
/** Who the receipt names when Elan1 Govern itself tried to connect (same as behaviour.ts). */
const SYSTEM_ACTOR = "Elan1 Govern";
const DAY = 86_400_000;

export function makeEgress(env: GateEnv, log: FastifyBaseLogger, deps: () => Deps): Egress {
  return createEgress(
    { profile: env.GATE_PROFILE, allow: env.EGRESS_ALLOW, internalDomains: env.EGRESS_INTERNAL_DOMAINS },
    {
      warn: (message, data) => log.warn({ egress: true, ...data }, message),
      onBlocked: async (d) => {
        if (!d.orgId) {
          await raiseAlert(deps(), "egress-blocked", `Egress denied: ${d.host}:${d.port} (${d.purpose}) is not on this deployment's allow-list.`);
          return {};
        }
        const r = await adminEvent(deps(), d.orgId, d.actor ?? SYSTEM_ACTOR, EGRESS_BLOCKED_ACTION, {
          host: d.host,
          port: d.port,
          purpose: d.purpose,
          profile: d.profile,
          policy: "deny_all",
          ...(d.reason ? { reason: d.reason } : {}),
        });
        return { receiptSeq: r.seq };
      },
    },
  );
}

/** A fetch for one organisation and purpose that asks the egress gate first. */
export function orgFetch(deps: Deps, purpose: string, opts: EgressCheckOptions, base: typeof fetch = fetch): typeof fetch {
  return egressFetch(deps.egress, purpose, opts, base);
}

export type EgressRuleResult = { ok: true; id: string; seq: number } | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * An owner or admin adds an internal host to their organisation's own allow-list (it only matters
 * in the sovereign profile). Exact internal hosts only; wildcards stay with the operator.
 */
export async function addEgressRule(deps: Deps, orgId: string, input: { host: string; port?: number | null; purpose?: string | null; note?: string; actor: string }): Promise<EgressRuleResult> {
  const port = input.port ?? null;
  const problem = egressRuleProblem(input.host, port, deps.env.EGRESS_INTERNAL_DOMAINS);
  if (problem) return { ok: false, status: 400, error: problem };
  const purpose = input.purpose ?? null;
  if (purpose !== null && !(EGRESS_PURPOSES as readonly string[]).includes(purpose)) return { ok: false, status: 400, error: `The purpose must be one of ${EGRESS_PURPOSES.join(", ")}.` };
  const host = normalizeHost(input.host);
  const db = forOrg(orgId, deps.db);
  if (await db.egressRule.findFirst({ where: { host, port, purpose } })) return { ok: false, status: 409, error: `${host} is already on the allow-list.` };
  const note = input.note?.trim().slice(0, 200) || null;
  const row = await db.egressRule.create({ data: { orgId, host, port, purpose, note, createdBy: input.actor } });
  const r = await adminEvent(deps, orgId, input.actor, "egress.internal_host_added", { rule_id: row.id, host, port, purpose, ...(note ? { note } : {}) });
  return { ok: true, id: row.id, seq: r.seq };
}

export async function removeEgressRule(deps: Deps, orgId: string, id: string, actor: string): Promise<EgressRuleResult> {
  const db = forOrg(orgId, deps.db);
  const row = await db.egressRule.findFirst({ where: { id } });
  if (!row) return { ok: false, status: 404, error: "That host is not on the allow-list." };
  await db.egressRule.deleteMany({ where: { id } });
  const r = await adminEvent(deps, orgId, actor, "egress.internal_host_removed", { rule_id: id, host: row.host, port: row.port, purpose: row.purpose });
  return { ok: true, id, seq: r.seq };
}

export function egressRules(deps: Deps, orgId: string) {
  return forOrg(orgId, deps.db).egressRule.findMany({ orderBy: { createdAt: "asc" } });
}

/** Retention for the egress log (all organisations and platform rows). */
export function purgeEgress(deps: Deps, now = new Date()): Promise<number> {
  return purgeEgressLog(new Date(now.getTime() - deps.env.EGRESS_LOG_RETENTION_DAYS * DAY), deps.db);
}
