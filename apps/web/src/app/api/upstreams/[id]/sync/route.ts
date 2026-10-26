import { route } from "@/server/api";
import { gateOk } from "@/server/gate";

/** Ask the server for its tools again. New tools arrive switched off. */
export const POST = route({ auth: "org", permission: "connectors:manage" }, async ({ params, ctx }) =>
  gateOk("POST", `/internal/orgs/${ctx.org.id}/upstreams/${encodeURIComponent(params.id ?? "")}/sync`, { actor: ctx.user.email }, "Elan1 Govern could not sync the server."),
);
