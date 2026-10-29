import { deleteUser, getUser, noContent, ok, patchUser, readBody, replaceUser, scimRoute, toResource } from "@/server/scim";

// One SCIM user, by the id this org's directory was given. Another org's ids are simply not found.

export const GET = scimRoute(async ({ orgId, params }) => ok(toResource(await getUser(orgId, params.id ?? ""))));

export const PUT = scimRoute(async ({ req, orgId, params }) => ok(toResource(await replaceUser(orgId, params.id ?? "", await readBody(req)))));

/** active=false deactivates the membership; active=true restores it with its role. */
export const PATCH = scimRoute(async ({ req, orgId, params }) => ok(toResource(await patchUser(orgId, params.id ?? "", await readBody(req)))));

export const DELETE = scimRoute(async ({ orgId, params }) => {
  await deleteUser(orgId, params.id ?? "");
  return noContent();
});
