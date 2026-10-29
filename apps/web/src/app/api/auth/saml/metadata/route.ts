import { forOrg } from "@gate/db";
import { HttpError, route } from "@/server/api";
import { defaultSpEntityId, spMetadata } from "@/server/saml";

/**
 * The service provider metadata an IdP admin imports (entity id, ACS URL, NameID format,
 * WantAssertionsSigned). Public, like every SAML SP's: it holds no secrets. Before SAML is saved
 * it describes the default entity id, so the IdP can be set up first.
 */
export const GET = route({ auth: "public" }, async ({ req }) => {
  const orgId = req.nextUrl.searchParams.get("org") ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orgId)) throw new HttpError(400, "Add ?org=<organisation id>.");
  const db = forOrg(orgId);
  if (!(await db.org.findFirst({ select: { id: true } }))) throw new HttpError(404, "No such organisation.");
  const conn = await db.samlConnection.findFirst();
  const xml = spMetadata(conn ?? { spEntityId: defaultSpEntityId(orgId) });
  return new Response(xml, { headers: { "content-type": "application/samlmetadata+xml; charset=utf-8" } });
});
