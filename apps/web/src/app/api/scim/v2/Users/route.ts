import { createUser, created, listUsers, ok, readBody, scimRoute } from "@/server/scim";

// SCIM 2.0 Users. Bearer-token machine endpoints: not route(), no session or CSRF (see server/scim.ts).

export const GET = scimRoute(async ({ req, orgId }) => ok(await listUsers(orgId, req.nextUrl)));

export const POST = scimRoute(async ({ req, orgId, defaultRole }) => created(await createUser(orgId, defaultRole, await readBody(req))));
