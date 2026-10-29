import { CONNECTOR_LABELS, exchangeCode, zohoOrganizations, type ConnectorKind, type OAuthTokens } from "@gate/connectors";
import { hmacVerify } from "@gate/core";
import { forOrg } from "@gate/db";
import type { FastifyInstance } from "fastify";
import { adminEvent, redirectUri } from "../admin";
import { sealTokens } from "../connectors";
import type { Deps } from "../deps";
import { orgFetch } from "../egress";

interface State {
  p: string;
  o: string;
  k: ConnectorKind;
  u: string;
  x: number;
}

/** OAuth callbacks land on Elan1 Govern, so tokens never pass through the web app or the agent. */
export function registerOAuth(app: FastifyInstance, deps: Deps) {
  app.get<{ Params: { kind: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/oauth/:kind/callback",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const back = (q: string) => reply.redirect(`${deps.env.WEB_URL}/connectors?${q}`);
      const kind = req.params.kind;
      if (kind !== "gmail" && kind !== "zoho") return reply.code(404).send({ error: "not found" });
      const state = typeof req.query.state === "string" ? hmacVerify<State>(deps.env.INTERNAL_API_SECRET, req.query.state) : null;
      if (!state || state.p !== "oauth" || state.k !== kind || state.x < Date.now() / 1000) return back("error=link_expired");
      if (req.query.error || typeof req.query.code !== "string") return back(`error=denied&connector=${kind}`);
      const cfg = kind === "gmail" ? deps.live.google : deps.live.zoho;
      if (!cfg) return back("error=not_configured");

      try {
        const f = orgFetch(deps, "connector", { orgId: state.o }, deps.live.fetch ?? fetch);
        const tokens: OAuthTokens = await exchangeCode(kind, cfg, req.query.code, redirectUri(deps, kind), f);
        let meta: Record<string, unknown> = {};
        let label = CONNECTOR_LABELS[kind];
        if (kind === "zoho" && deps.live.zoho) {
          const orgs = await zohoOrganizations(deps.live.zoho, tokens.access_token, f);
          if (!orgs[0]) return back("error=no_zoho_org");
          meta = { zoho_org_id: orgs[0].organization_id };
          label = orgs[0].name;
        } else {
          const res = await f("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${tokens.access_token}` } });
          const profile = (await res.json().catch(() => ({}))) as { emailAddress?: string };
          if (profile.emailAddress) label = profile.emailAddress;
        }
        await forOrg(state.o, deps.db).connector.upsert({
          where: { orgId_kind: { orgId: state.o, kind } },
          create: { orgId: state.o, kind, mode: "live", status: "connected", tokensEnc: sealTokens(deps, state.o, kind, tokens), accountLabel: label, meta: meta as object, connectedAt: new Date() },
          update: { mode: "live", status: "connected", tokensEnc: sealTokens(deps, state.o, kind, tokens), accountLabel: label, meta: meta as object, connectedAt: new Date() },
        });
        await adminEvent(deps, state.o, state.u, "connector.connected", { connector: kind, mode: "live" });
        return back(`connected=${kind}`);
      } catch (e) {
        deps.log.warn({ err: (e as Error).message, kind }, "oauth callback failed");
        return back(`error=exchange_failed&connector=${kind}`);
      }
    },
  );
}
