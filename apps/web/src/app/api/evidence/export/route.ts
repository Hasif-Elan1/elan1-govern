import { z } from "zod";
import { HttpError, route } from "@/server/api";
import { gateBytes } from "@/server/gate";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-01.");
const Body = z.object({ from: day, to: day, kind: z.enum(["pack", "bundle"]) }).strict();

/** Auditor pack (PDF summary + evidence bundle) or the bundle alone, for a date range. */
export const POST = route({ auth: "org", permission: "evidence:export", body: Body }, async ({ body, ctx }) => {
  if (body.from > body.to) throw new HttpError(400, "The start date is after the end date.");
  const r = await gateBytes(`/internal/orgs/${ctx.org.id}/export`, { ...body, actor: ctx.user.email });
  if (r.error) throw new HttpError(r.status >= 500 ? 502 : r.status, r.error);
  const name = `${body.kind === "pack" ? "auditor-pack" : "evidence-bundle"}-${body.from}-to-${body.to}.zip`;
  return new Response(r.bytes, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${name}"` } });
});
