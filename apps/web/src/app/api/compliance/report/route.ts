import { FRAMEWORK_IDS } from "@gate/core/frameworks";
import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gateBytes } from "@/server/gate";

const Body = z.object({ framework: z.enum(FRAMEWORK_IDS as [string, ...string[]], { error: "Unknown framework." }) }).strict();

/** The framework report: a PDF built by the gate service from live evidence counts. */
export const POST = route({ auth: "org", permission: "evidence:export", body: Body }, async ({ body, ctx }) => {
  const r = await gateBytes(`/internal/orgs/${ctx.org.id}/frameworks/${body.framework}/report`, { actor: ctx.user.email });
  if (r.error) throw new HttpError(r.status >= 500 ? 502 : r.status, r.error);
  const day = new Date().toISOString().slice(0, 10);
  return new Response(r.bytes, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="framework-report-${body.framework}-${day}.pdf"` } });
});
