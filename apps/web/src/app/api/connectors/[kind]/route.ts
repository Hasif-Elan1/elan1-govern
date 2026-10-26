import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";

const Body = z.object({ action: z.enum(["connect", "disconnect"]), mode: z.enum(["mock", "live"]).optional() }).strict();

/** Connect with demo data, start OAuth for a real account (tokens land in Elan1 Govern, never here), or disconnect. */
export const POST = route({ auth: "org", permission: "connectors:manage", body: Body }, async ({ body, params, ctx }) => {
  if (params.kind !== "gmail" && params.kind !== "zoho") throw new HttpError(404, "No such connector.");
  const r = await gate<{ ok?: boolean; status?: string; redirect?: string; error?: string }>("POST", `/internal/orgs/${ctx.org.id}/connectors/${params.kind}`, { ...body, actor: ctx.user.email });
  if (r.status !== 200) throw new HttpError(r.status === 400 ? 400 : 502, r.data.error ?? "Elan1 Govern could not change the connector.");
  return { status: r.data.status ?? null, redirect: r.data.redirect ?? null };
});
