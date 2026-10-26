import { HttpError, route } from "@/server/api";
import { gate } from "@/server/gate";

/** "Try the demo agent": mock Gmail and Zoho Books, a signed rulebook, and a scripted run. */
export const POST = route({ auth: "org", permission: "demo:run" }, async ({ ctx }) => {
  const r = await gate<{ agentId?: string; apiKey?: string; mcpUrl?: string; error?: string }>("POST", `/internal/orgs/${ctx.org.id}/demo`, { userId: ctx.user.id, email: ctx.user.email, run: true });
  if (r.status !== 200) throw new HttpError(502, r.data.error ?? "Elan1 Govern could not start the demo agent.");
  return { agentId: r.data.agentId, apiKey: r.data.apiKey, mcpUrl: r.data.mcpUrl };
});
