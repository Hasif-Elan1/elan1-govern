import { z } from "zod";
import { route } from "@/server/api";
import { gateOk } from "@/server/gate";

const Body = z
  .object({
    name: z.string().trim().min(1, "Give the server a name").max(80),
    url: z.string().trim().url("Enter the server's full URL, starting with https://").max(2000),
    authHeader: z.string().trim().max(4000).optional(),
  })
  .strict();

/** Add an MCP server. The auth header goes straight to Elan1 Govern, which stores it encrypted; it is never shown again. */
export const POST = route({ auth: "org", permission: "connectors:manage", body: Body }, async ({ body, ctx }) => {
  const { authHeader, ...rest } = body;
  return gateOk("POST", `/internal/orgs/${ctx.org.id}/upstreams`, { ...rest, ...(authHeader ? { authHeader } : {}), actor: ctx.user.email }, "Elan1 Govern could not add the server.");
});
