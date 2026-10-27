import { route, HttpError } from "@/server/api";
import { gateBytes } from "@/server/gate";

/** The incident report PDF for an emergency stop, built by the gate service and logged as an export. */
export const POST = route({ auth: "org", permission: "evidence:export" }, async ({ params, ctx }) => {
  const id = /^[A-Za-z0-9_-]{1,64}$/.test(params.id ?? "") ? params.id! : "none";
  const r = await gateBytes(`/internal/orgs/${ctx.org.id}/incidents/${id}/report`, { actor: ctx.user.email });
  if (r.error) throw new HttpError(r.status >= 500 ? 502 : r.status, r.error);
  return new Response(r.bytes, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="incident-report-${id}.pdf"` } });
});
