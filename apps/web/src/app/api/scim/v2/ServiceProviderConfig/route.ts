import { ok, scimRoute, serviceProviderConfig } from "@/server/scim";

/** What this SCIM service supports (RFC 7643 §5): Users with PATCH and the userName filter; no Groups or Bulk. */
export const GET = scimRoute(async () => ok(serviceProviderConfig()));
