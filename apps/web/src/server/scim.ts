import "server-only";
import { randomUUID } from "node:crypto";
import { hashToken, randomToken, safeEqual } from "@gate/core";
import { addMembership, findScimByTokenHash, forOrg, prisma, type Role, type ScimUser } from "@gate/db";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ipFrom } from "./api";
import { env } from "./env";
import { orgVerifiedDomains } from "./identity";
import { withReceipt } from "./inventory";
import { log } from "./log";
import { hit, LIMIT_MULTIPLIER } from "./ratelimit";
import { domainOf } from "./sso";

// SCIM 2.0 (RFC 7643, RFC 7644), Users only: the directory creates, deactivates and removes
// members. These are machine endpoints: no session, no cookies, so no CSRF check. Each request
// carries the org's bearer token, which is stored only as a SHA-256 hash and names the org.
// Groups, Bulk, sorting and every filter but `userName eq "…"` are not supported.

export const SCIM_CONTENT_TYPE = "application/scim+json";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
/** Receipts for directory changes name this actor (receipts need an email-shaped actor). */
export const SCIM_ACTOR = "scim@directory.invalid";
const MAX_BODY = 64 * 1024;
/** Per IP, then per org. */
const LIMIT = { ip: { max: 300, windowMs: 60_000 }, org: { max: 600, windowMs: 60_000 } };

export const scimBaseUrl = () => `${env().WEB_URL}/api/scim/v2`;

export class ScimError extends Error {
  constructor(readonly status: number, detail: string, readonly scimType?: string) {
    super(detail);
  }
}

const scimJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new NextResponse(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": SCIM_CONTENT_TYPE, "cache-control": "no-store", ...headers } });

const scimError = (status: number, detail: string, scimType?: string, headers?: Record<string, string>) =>
  scimJson({ schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail }, status, headers);

type ScimCtx = { req: NextRequest; orgId: string; defaultRole: Role; params: Record<string, string> };

/** The bearer token -> org, or null. Constant-time compare on top of the hash lookup. */
export async function scimOrgForToken(authorization: string | null): Promise<{ orgId: string; defaultRole: Role } | null> {
  const m = /^Bearer\s+(scim_[A-Za-z0-9_-]{20,100})$/.exec(authorization?.trim() ?? "");
  if (!m) return null;
  const hash = hashToken(m[1]!);
  const conn = await findScimByTokenHash(hash);
  if (!conn || !safeEqual(conn.tokenHash, hash)) return null;
  return { orgId: conn.orgId, defaultRole: conn.defaultRole };
}

/** Every SCIM route goes through here: rate limit -> bearer token -> handler, with SCIM-shaped errors. */
export function scimRoute(fn: (c: ScimCtx) => Promise<Response>) {
  return async (req: NextRequest, segment: { params: Promise<Record<string, string>> }) => {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    const started = Date.now();
    let orgId: string | null = null;
    let res: Response;
    try {
      const ip = ipFrom(req.headers);
      const byIp = hit(`scim:${ip}`, LIMIT.ip.max * LIMIT_MULTIPLIER, LIMIT.ip.windowMs);
      if (!byIp.ok) throw new ScimError(429, `Too many requests. Try again in ${byIp.retryAfter} seconds.`);
      const auth = await scimOrgForToken(req.headers.get("authorization"));
      if (!auth) {
        res = scimError(401, "Send the organisation's SCIM token as a Bearer token.", undefined, { "www-authenticate": 'Bearer realm="scim"' });
      } else {
        orgId = auth.orgId;
        const byOrg = hit(`scim-org:${orgId}`, LIMIT.org.max, LIMIT.org.windowMs);
        if (!byOrg.ok) throw new ScimError(429, `Too many requests. Try again in ${byOrg.retryAfter} seconds.`);
        await forOrg(orgId).scimConnection.updateMany({ data: { lastUsedAt: new Date() } });
        res = await fn({ req, orgId, defaultRole: auth.defaultRole, params: await segment.params });
      }
    } catch (e) {
      if (e instanceof ScimError) res = scimError(e.status, e.message, e.scimType);
      else {
        log("error", "scim", { requestId, method: req.method, path: req.nextUrl.pathname, orgId, err: (e as Error).message });
        res = scimError(500, "Something went wrong on our side. Nothing was changed.");
      }
    }
    res.headers.set("x-request-id", requestId);
    log(res.status >= 500 ? "error" : "info", "scim", { requestId, method: req.method, path: req.nextUrl.pathname, status: res.status, ms: Date.now() - started, orgId });
    return res;
  };
}

async function readJson(req: NextRequest): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new ScimError(413, "The request is too large.");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ScimError(413, "The request is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new ScimError(400, "The body is not valid JSON.", "invalidSyntax");
  }
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ScimError(400, i ? `${i.path.join(".") || "body"}: ${i.message}` : "Invalid request.", "invalidValue");
  }
  return r.data;
}

/** Entra ID sends booleans as "True"/"False" strings. */
const bool = z.union([z.boolean(), z.enum(["true", "false", "True", "False"]).transform((v) => v.toLowerCase() === "true")]);
const text = (max: number) => z.string().trim().max(max);

// Directories send many more attributes (enterprise extension, phone numbers…); unknown ones are ignored.
const UserIn = z
  .object({
    userName: text(320).min(3),
    externalId: text(200).optional(),
    displayName: text(200).optional(),
    name: z.object({ formatted: text(200).optional(), givenName: text(100).optional(), familyName: text(100).optional() }).passthrough().optional(),
    emails: z.array(z.object({ value: text(320), primary: bool.optional() }).passthrough()).max(20).optional(),
    active: bool.optional(),
  })
  .passthrough();
type UserIn = z.infer<typeof UserIn>;

const PatchIn = z
  .object({
    schemas: z.array(z.string()).refine((s) => s.includes(PATCH_SCHEMA), `Use the ${PATCH_SCHEMA} schema.`),
    Operations: z.array(z.object({ op: z.string(), path: z.string().max(200).optional(), value: z.unknown().optional() }).passthrough()).min(1).max(50),
  })
  .passthrough();

const email = z.string().trim().toLowerCase().email().max(320);

/** userName if it is an email, else the primary (or first) email. */
function emailOf(u: UserIn): string {
  const candidates = [u.userName, ...(u.emails ?? []).filter((e) => e.primary).map((e) => e.value), ...(u.emails ?? []).map((e) => e.value)];
  for (const c of candidates) {
    const r = email.safeParse(c);
    if (r.success) return r.data;
  }
  throw new ScimError(400, "userName (or a primary email) must be an email address.", "invalidValue");
}

const nameOf = (u: Pick<UserIn, "displayName" | "name">, fallback: string) =>
  (u.displayName || u.name?.formatted || [u.name?.givenName, u.name?.familyName].filter(Boolean).join(" ") || fallback.split("@")[0]!).slice(0, 80);

export function toResource(u: ScimUser) {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    ...(u.externalId ? { externalId: u.externalId } : {}),
    userName: u.userName,
    ...(u.displayName ? { displayName: u.displayName } : {}),
    emails: [{ value: u.userName, primary: true, type: "work" }],
    active: u.active,
    meta: { resourceType: "User", created: u.createdAt.toISOString(), lastModified: u.updatedAt.toISOString(), location: `${scimBaseUrl()}/Users/${u.id}` },
  };
}

/** Directory-created members get the token's default role, never Owner or Auditor. */
const safeRole = (r: Role): Role => (r === "owner" || r === "auditor" ? "viewer" : r);

const OWNERS_ARE_LOCAL = "Owners are managed in Elan1 Govern, not by the directory.";

// ---- Users ----

export async function listUsers(orgId: string, url: URL) {
  const filter = url.searchParams.get("filter");
  let userName: string | undefined;
  if (filter) {
    const m = /^\s*userName\s+eq\s+"((?:[^"\\]|\\.){1,320})"\s*$/i.exec(filter);
    if (!m) throw new ScimError(400, 'Only the filter userName eq "…" is supported.', "invalidFilter");
    try {
      userName = (JSON.parse(`"${m[1]}"`) as string).toLowerCase();
    } catch {
      throw new ScimError(400, "The filter value is not a valid string.", "invalidFilter");
    }
  }
  const startIndex = Math.max(1, Math.floor(Number(url.searchParams.get("startIndex") ?? 1)) || 1);
  const count = Math.min(100, Math.max(0, Math.floor(Number(url.searchParams.get("count") ?? 100)) || 0));
  const db = forOrg(orgId);
  const where = userName ? { userName } : {};
  const [total, rows] = await Promise.all([db.scimUser.count({ where }), count ? db.scimUser.findMany({ where, orderBy: { createdAt: "asc" }, skip: startIndex - 1, take: count }) : []]);
  return { schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: rows.length, Resources: rows.map(toResource) };
}

/**
 * Create (or link) a member. The email must be in one of the org's verified domains. An existing
 * account is linked rather than duplicated, and an existing membership keeps its role.
 */
export async function createUser(orgId: string, defaultRole: Role, body: unknown) {
  const u = parse(UserIn, body);
  const mail = emailOf(u);
  if (!(await orgVerifiedDomains(orgId)).includes(domainOf(mail))) throw new ScimError(400, `${domainOf(mail)} is not a verified domain of this organisation.`, "invalidValue");
  const db = forOrg(orgId);
  if (await db.scimUser.findFirst({ where: { userName: mail } })) throw new ScimError(409, "A user with this userName already exists.", "uniqueness");

  return withReceipt(
    orgId,
    SCIM_ACTOR,
    "scim.user_provisioned",
    async () => {
      const existing = await prisma.user.findUnique({ where: { email: mail } });
      const user = existing ?? (await prisma.user.create({ data: { email: mail, name: nameOf(u, mail), passwordHash: `!scim:${randomToken()}` } }));
      const member = await db.membership.findFirst({ where: { userId: user.id } });
      const active = u.active ?? true;
      if (member?.role === "owner" && !active) throw new ScimError(403, OWNERS_ARE_LOCAL);
      const role = member ? member.role : safeRole(defaultRole);
      if (!member && active) await addMembership({ orgId, userId: user.id, role });
      if (member && !active) await db.membership.deleteMany({ where: { userId: user.id } });
      const row = await db.scimUser.create({ data: { orgId, userId: user.id, userName: mail, externalId: u.externalId ?? null, displayName: u.displayName ?? null, active, role } });
      return { row, createdUser: !existing, member };
    },
    (t) => ({ role: t.row.role, linked: !!t.member, active: t.row.active }),
    async (t) => {
      await db.scimUser.delete({ where: { id: t.row.id } });
      if (t.member && !t.row.active) await addMembership({ orgId, userId: t.row.userId, role: t.member.role });
      if (!t.member) await db.membership.deleteMany({ where: { userId: t.row.userId } });
      if (t.createdUser) await prisma.user.delete({ where: { id: t.row.userId } });
    },
  ).then((t) => t.row);
}

const scimId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export async function getUser(orgId: string, id: string): Promise<ScimUser> {
  const r = scimId.safeParse(id);
  const row = r.success ? await forOrg(orgId).scimUser.findFirst({ where: { id: r.data } }) : null;
  if (!row) throw new ScimError(404, "No such user.");
  return row;
}

/** active=false removes the membership (and with it all access) but keeps the row and the role, so it can come back. */
async function setActive(orgId: string, row: ScimUser, active: boolean): Promise<ScimUser> {
  if (row.active === active) return row;
  const db = forOrg(orgId);
  if (!active) {
    const member = await db.membership.findFirst({ where: { userId: row.userId } });
    if (member?.role === "owner") throw new ScimError(403, OWNERS_ARE_LOCAL);
    return withReceipt(
      orgId,
      SCIM_ACTOR,
      "scim.user_deactivated",
      async () => {
        await db.membership.deleteMany({ where: { userId: row.userId } });
        return db.scimUser.update({ where: { id: row.id }, data: { active: false, role: member?.role ?? row.role } });
      },
      (t) => ({ role: t.role }),
      async (t) => {
        if (member) await addMembership({ orgId, userId: t.userId, role: member.role });
        await db.scimUser.update({ where: { id: t.id }, data: { active: true } });
      },
    );
  }
  return withReceipt(
    orgId,
    SCIM_ACTOR,
    "scim.user_reactivated",
    async () => {
      await addMembership({ orgId, userId: row.userId, role: row.role });
      return db.scimUser.update({ where: { id: row.id }, data: { active: true } });
    },
    (t) => ({ role: t.role }),
    async (t) => {
      await db.membership.deleteMany({ where: { userId: t.userId } });
      await db.scimUser.update({ where: { id: t.id }, data: { active: false } });
    },
  );
}

/** PUT: replace the attributes we keep. userName is the email and cannot change. */
export async function replaceUser(orgId: string, id: string, body: unknown) {
  const row = await getUser(orgId, id);
  const u = parse(UserIn, body);
  if (emailOf(u) !== row.userName) throw new ScimError(400, "userName cannot be changed. Remove the user and add them again.", "mutability");
  const updated = await forOrg(orgId).scimUser.update({ where: { id: row.id }, data: { externalId: u.externalId ?? null, displayName: u.displayName ?? null } });
  return u.active === undefined ? updated : setActive(orgId, updated, u.active);
}

/** PATCH (RFC 7644 §3.5.2): add/replace/remove on active, displayName and externalId. Other paths are ignored. */
export async function patchUser(orgId: string, id: string, body: unknown) {
  const row = await getUser(orgId, id);
  const p = parse(PatchIn, body);
  const changes: { externalId?: string | null; displayName?: string | null } = {};
  let active: boolean | undefined;
  const apply = (path: string, value: unknown, op: string) => {
    const key = path.toLowerCase();
    if (key === "active") {
      if (op === "remove") throw new ScimError(400, "active cannot be removed.", "mutability");
      active = parse(bool, value);
    } else if (key === "displayname" || key === "externalid") {
      const v = op === "remove" ? null : parse(text(200), value);
      changes[key === "displayname" ? "displayName" : "externalId"] = v || null;
    } else if (key === "username") {
      if (op === "remove" || parse(email, value) !== row.userName) throw new ScimError(400, "userName cannot be changed.", "mutability");
    }
  };
  for (const o of p.Operations) {
    const op = o.op.toLowerCase();
    if (!["add", "replace", "remove"].includes(op)) throw new ScimError(400, `Unknown op ${o.op.slice(0, 20)}.`, "invalidSyntax");
    if (o.path) apply(o.path, o.value, op);
    else if (op !== "remove" && o.value && typeof o.value === "object" && !Array.isArray(o.value)) for (const [k, v] of Object.entries(o.value)) apply(k, v, op);
    else throw new ScimError(400, "Each operation needs a path or an object value.", "noTarget");
  }
  const updated = Object.keys(changes).length ? await forOrg(orgId).scimUser.update({ where: { id: row.id }, data: changes }) : row;
  return active === undefined ? updated : setActive(orgId, updated, active);
}

/** DELETE: the membership and the SCIM row go. The account itself stays (it may belong to other orgs). */
export async function deleteUser(orgId: string, id: string): Promise<void> {
  const row = await getUser(orgId, id);
  const db = forOrg(orgId);
  const member = await db.membership.findFirst({ where: { userId: row.userId } });
  if (member?.role === "owner") throw new ScimError(403, OWNERS_ARE_LOCAL);
  await withReceipt(
    orgId,
    SCIM_ACTOR,
    "scim.user_removed",
    async () => {
      await db.membership.deleteMany({ where: { userId: row.userId } });
      await db.scimUser.delete({ where: { id: row.id } });
      return row;
    },
    (t) => ({ role: member?.role ?? t.role }),
    async (t) => {
      const { orgId: _o, ...data } = t;
      await db.scimUser.create({ data: { ...data, orgId } });
      if (member) await addMembership({ orgId, userId: t.userId, role: member.role });
    },
  );
}

export const serviceProviderConfig = () => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 100 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "The SCIM token from Settings, sent as Authorization: Bearer scim_…", primary: true }],
  meta: { resourceType: "ServiceProviderConfig", location: `${scimBaseUrl()}/ServiceProviderConfig` },
});

export const created = (row: ScimUser) => scimJson(toResource(row), 201, { location: `${scimBaseUrl()}/Users/${row.id}` });
export const ok = (body: unknown) => scimJson(body);
export const noContent = () => scimJson(null, 204);
export const readBody = readJson;

// ---- The token ----

/** A new token (shown once), replacing the old one at once. Owners only, after a fresh sign-in. */
export async function rotateScimToken(orgId: string, actor: string, defaultRole?: Role): Promise<{ token: string; prefix: string }> {
  const db = forOrg(orgId);
  const before = await db.scimConnection.findFirst();
  const token = randomToken("scim_");
  const prefix = token.slice(0, 12);
  const role = safeRole(defaultRole ?? before?.defaultRole ?? "viewer");
  await withReceipt(
    orgId,
    actor,
    "identity.scim_token_rotated",
    () =>
      before
        ? db.scimConnection.update({ where: { id: before.id }, data: { tokenHash: hashToken(token), tokenPrefix: prefix, defaultRole: role } })
        : db.scimConnection.create({ data: { orgId, tokenHash: hashToken(token), tokenPrefix: prefix, defaultRole: role } }),
    () => ({ prefix, default_role: role }),
    (t) => (before ? db.scimConnection.update({ where: { id: t.id }, data: { tokenHash: before.tokenHash, tokenPrefix: before.tokenPrefix, defaultRole: before.defaultRole } }) : db.scimConnection.delete({ where: { id: t.id } })),
  );
  return { token, prefix };
}
