import "server-only";
import { createEgress, egressFetch, recordHealthAlert, type Egress, type EgressCheckOptions } from "@gate/db";
import { env } from "./env";
import { gate } from "./gate";
import { log } from "./log";

// The web app's side of the egress gate (packages/db/src/egress.ts), for SMTP invites and OIDC.
// A person's blocked attempt (testing an identity provider) becomes an `egress.blocked` receipt
// through the gate service; a system attempt (a sign-in, an invite email) a health alert.

let cached: Egress | undefined;

export function egress(): Egress {
  if (cached) return cached;
  const e = env();
  cached = createEgress(
    { profile: e.GATE_PROFILE, allow: e.EGRESS_ALLOW, internalDomains: e.EGRESS_INTERNAL_DOMAINS },
    {
      warn: (message, data) => log("warn", message, { host: String(data.host ?? ""), purpose: String(data.purpose ?? ""), err: String(data.err ?? "") }),
      onBlocked: async (d) => {
        if (d.orgId && d.actor) {
          const r = await gate<{ seq?: number }>("POST", `/internal/orgs/${d.orgId}/events`, {
            actor: d.actor,
            action: "egress.blocked",
            details: { host: d.host, port: d.port, purpose: d.purpose, profile: d.profile, policy: "deny_all" },
          });
          return { receiptSeq: r.data.seq };
        }
        await recordHealthAlert({ ...(d.orgId ? { orgId: d.orgId } : {}), kind: "egress-blocked", message: `Egress denied: ${d.host}:${d.port} (${d.purpose}) is not on this deployment's allow-list.` });
        return {};
      },
    },
  );
  return cached;
}

/** A fetch that asks the egress gate before every request (OIDC discovery, JWKS and tokens). */
export function webFetch(purpose: string, opts: EgressCheckOptions): typeof fetch {
  return egressFetch(egress(), purpose, opts);
}

/** Tests switch profiles; the gate is rebuilt from env() on next use. */
export function resetEgress() {
  cached = undefined;
}
