import { forOrg } from "@gate/db";
import { HttpError, route } from "@/server/api";
import { gateBytes } from "@/server/gate";
import { can, type Role } from "@/server/policy";

const NUMBER = /^[A-Z0-9-]{3,60}$/;

/**
 * A stored invoice or credit note of a console organisation (`?org=`) as its GST PDF, for the people who may read
 * its billing (owners and admins, billing:view): the ledger's figures as stored, never recomputed.
 */
export const GET = route({ auth: "user" }, async ({ req, params, userId }) => {
  if (!userId) throw new HttpError(401, "Sign in to continue.");
  const orgId = req.nextUrl.searchParams.get("org") ?? "";
  const number = params.number ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orgId) || !NUMBER.test(number)) throw new HttpError(400, "Name the organisation and the invoice number.");
  const m = await forOrg(orgId).membership.findFirst({ where: { userId, status: "active" }, select: { role: true } });
  if (!can(m?.role as Role | undefined, "billing:view")) throw new HttpError(403, "Your role does not allow this.");
  const r = await gateBytes(`/internal/orgs/${encodeURIComponent(orgId)}/wiring/billing/pdf`, { number });
  if (r.error) throw new HttpError(r.status === 404 ? 404 : 502, r.error);
  return new Response(r.bytes, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${number}.pdf"` } });
});
