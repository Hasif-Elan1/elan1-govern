import { route } from "@/server/api";
import { gateOk } from "@/server/gate";

/** Remove an MCP server and its tools. Elan1 Govern deletes the stored auth header. */
export const DELETE = route({ auth: "org", permission: "connectors:manage" }, async ({ params, ctx }) =>
  gateOk("POST", `/internal/orgs/${ctx.org.id}/upstreams/${encodeURIComponent(params.id ?? "")}/remove`, { actor: ctx.user.email }, "Elan1 Govern could not remove the server."),
);
