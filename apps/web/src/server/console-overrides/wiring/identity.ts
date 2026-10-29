import "server-only";
import { createHash } from "node:crypto";
import { forOrg, prisma } from "@gate/db";
import { initialsOf } from "@gate/db/console-demo";
import { enrolTotp } from "../../auth";
import { changeMemberRole, inviteMember, reissueInvite, removeMember, revokeInvite, setMemberSuspended, type Actor } from "../../identity";
import type { Role } from "../../policy";
import { acsUrl, parseIdpCert, saveSamlConnection } from "../../saml";
import { rotateScimToken, scimBaseUrl } from "../../scim";
import { currentSession } from "../../session";
import { saveSsoConnection, verifySsoDomain } from "../../sso";
import { docOf, emailOf, iso, onChain, override, pull, realRole, requireFresh, requireRole, touch, type Ctx, type Doc } from "./common";

/*
 * Identity settings on the real backend: People and roles (Membership, Invite), Sessions (Session), two-step
 * sign-in for "you" (User.totpSecret), Single sign-on (SsoConnection), SAML 2.0 and "Require SAML for everyone"
 * (SamlConnection) and the SCIM token (ScimConnection).
 *
 * Most operations run the console's own code first (its rules, its document, its receipt in its own words, written
 * to the real chain by the bridge) and then make the same change in the real tables with the real backend's rules
 * (apps/web/src/server/identity.ts, sso.ts, saml.ts, auth.ts), so a change either rule set refuses is not made. The
 * real change is idempotent: when the chain moves under the operation the bridge runs it again. The SCIM token is
 * the exception: its secret is shown once and is the real one, so the real backend makes it and records it.
 * Reads (api.members, orgApi.sessions, orgApi.oidc, api.identityConfig) bring the document in line with the tables
 * first, so changes made elsewhere (SCIM, sign-in by SAML or OIDC, the API) show too.
 */

type Fn = (...a: unknown[]) => unknown;
/** The console's settings module: orgState and the like at its top, the operations object (orgApi.orgApi) in it. */
const settingsModule = (ctx: Ctx) => ctx.domain.orgApi as { orgState: Fn; orgApi: { emailOf: Fn } };

interface Member {
  userId: string;
  role: Role;
  status: "active" | "invited" | "suspended";
  invitedAt?: string;
  invitedEmail?: string;
  [k: string]: unknown;
}

const membersOf = (d: Doc) => d.members as Member[];
const settingsOf = (ctx: Ctx) => {
  settingsModule(ctx).orgState(ctx.orgId);
  return docOf(ctx).orgSettings as Doc;
};

/** The signed-in person as the real rules know them, or the console's refusal. */
async function actorOf(ctx: Ctx, what: string): Promise<Actor> {
  const role = await realRole(ctx.orgId, ctx.actorUserId);
  if (!role) throw new Error(`${what} — you hold no active role in this organisation.`);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: ctx.actorUserId }, select: { id: true, email: true, name: true } });
  return { ...u, role };
}

const orgOf = async (ctx: Ctx) => (await forOrg(ctx.orgId).org.findFirstOrThrow({ select: { id: true, name: true } }));

const memberIn = (ctx: Ctx, memberId: string) => membersOf(docOf(ctx)).find((m) => m.userId === memberId);
const emailIn = (ctx: Ctx, m: Member) => String(settingsModule(ctx).orgApi.emailOf(ctx.orgId, m));

/** A placeholder member id for a real invitation the document has not seen (as the console names its own). */
const inviteeId = (email: string) => `u_inv_${createHash("sha256").update(email).digest("hex").slice(0, 12)}`;

/** The document's member list in line with Membership and the pending invitations; other fields (Slack, WhatsApp) kept. */
async function syncMembers(ctx: Ctx) {
  const db = forOrg(ctx.orgId);
  const [rows, invites] = await Promise.all([db.membership.findMany({ orderBy: { createdAt: "asc" } }), db.invite.findMany({ where: { acceptedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "asc" } })]);
  const d = docOf(ctx);
  const before = membersOf(d);
  const next: Member[] = [];
  for (const r of rows) {
    const had = before.find((m) => m.userId === r.userId);
    next.push({ ...(had ?? { invitedAt: r.createdAt.toISOString() }), userId: r.userId, role: r.role as Role, status: r.status });
  }
  for (const inv of invites) {
    const had = before.find((m) => m.status === "invited" && emailIn(ctx, m).toLowerCase() === inv.email);
    next.push({ ...(had ?? { userId: inviteeId(inv.email), invitedAt: inv.createdAt.toISOString(), invitedEmail: inv.email }), role: inv.role as Role, status: "invited" });
  }
  if (JSON.stringify(next) !== JSON.stringify(before)) {
    d.members = next;
    touch(ctx, "member");
  }
}

/** The directory entry the console names a member by (the server's own directory holds only the demo people). */
async function directory(ids: string[]) {
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true, title: true, totpEnabled: true, lastSignInAt: true } });
  return new Map(users.map((u) => [u.id, u]));
}

override("api.members", async (ctx) => {
  await syncMembers(ctx);
  const list = (await ctx.original(...ctx.args)) as (Member & { user?: Record<string, unknown> })[];
  const users = await directory(list.map((m) => m.userId));
  return list.map((m) => {
    const u = users.get(m.userId);
    if (!u) return m;
    return { ...m, user: { ...(m.user ?? {}), id: u.id, name: u.name, email: u.email, title: u.title, initials: initialsOf(u.name), mfa: u.totpEnabled, role: m.role, orgIds: [ctx.orgId], ...(u.lastSignInAt ? { lastSignIn: u.lastSignInAt.toISOString() } : {}) } };
  });
});

override("orgApi.inviteMembers", async (ctx) => {
  const [, , role] = ctx.args as [string, string[], Role];
  const actor = await actorOf(ctx, "Inviting people");
  const out = (await ctx.original(...ctx.args)) as { invites: { userId: string; email: string; token: string }[]; seq: number };
  const org = await orgOf(ctx);
  for (const inv of out.invites) {
    const r = await inviteMember(org, actor, { email: inv.email, role, token: inv.token });
    // an existing Elan1 Govern account is a member at once (the real rule): the document lists the person, not an invitation
    if (r.added && r.userId) {
      const m = memberIn(ctx, inv.userId);
      if (m) Object.assign(m, { userId: r.userId, status: "active" });
      const t = (settingsOf(ctx).invites as { userId: string; usedAt?: string }[]).find((x) => x.userId === inv.userId);
      if (t) Object.assign(t, { userId: r.userId, usedAt: new Date().toISOString() });
    }
  }
  return out;
});

override("orgApi.resendInvite", async (ctx) => {
  const [, memberId] = ctx.args as [string, string];
  const actor = await actorOf(ctx, "Resending an invitation");
  const m = memberIn(ctx, memberId);
  const out = (await ctx.original(...ctx.args)) as { invite: { token: string } };
  if (m) await reissueInvite(await orgOf(ctx), actor, emailIn(ctx, m), out.invite.token);
  return out;
});

override("orgApi.changeRole", async (ctx) => {
  const [, memberId, to] = ctx.args as [string, string, Role];
  const actor = await actorOf(ctx, "Changing roles");
  const m = memberIn(ctx, memberId);
  const out = await ctx.original(...ctx.args);
  if (m) await changeMemberRole(ctx.orgId, actor, m.status === "invited" ? { email: emailIn(ctx, m) } : { userId: memberId }, to);
  return out;
});

override("orgApi.setSuspended", async (ctx) => {
  const [, memberId, suspended] = ctx.args as [string, string, boolean];
  const actor = await actorOf(ctx, "Suspending members");
  const out = await ctx.original(...ctx.args);
  await setMemberSuspended(ctx.orgId, actor, memberId, suspended);
  return out;
});

override("orgApi.removeMember", async (ctx) => {
  const [, memberId] = ctx.args as [string, string];
  const actor = await actorOf(ctx, "Removing members");
  const m = memberIn(ctx, memberId);
  const email = m ? emailIn(ctx, m) : undefined;
  const out = await ctx.original(...ctx.args);
  if (m?.status === "invited" && email) await revokeInvite(ctx.orgId, actor, email);
  else if (m) await removeMember(ctx.orgId, actor, memberId, undefined, { ifPresent: true });
  return out;
});

// ---- Sessions: the person's own real sessions (they are the account's, so ending one ends it everywhere) ----

interface SessionRecord {
  id: string;
  userId: string;
  device: string;
  kind: string;
  method: string;
  startedAt: string;
  lastActiveAt: string;
  endedAt?: string;
  endedBy?: string;
  endReason?: string;
  via: string;
}

/** The console's id for a real session (what the browser computes for its own: ses_<user>_<signed-in ms>). */
const sessionId = (userId: string, createdAt: Date) => `ses_${userId}_${createdAt.getTime()}`;

async function syncSessions(ctx: Ctx) {
  const userId = ctx.actorUserId;
  const [rows, user] = await Promise.all([
    prisma.session.findMany({ where: { userId, expiresAt: { gt: new Date() } }, select: { createdAt: true, lastAuthAt: true }, orderBy: { createdAt: "asc" } }),
    prisma.user.findUnique({ where: { id: userId }, select: { totpEnabled: true } }),
  ]);
  const s = settingsOf(ctx);
  const list = s.sessions as SessionRecord[];
  const live = new Set(rows.map((r) => sessionId(userId, r.createdAt)));
  let changed = false;
  for (const r of rows) {
    const id = sessionId(userId, r.createdAt);
    const had = list.find((x) => x.id === id);
    if (had) {
      if (had.endedAt) continue;
      const last = r.lastAuthAt.toISOString();
      if (had.lastActiveAt < last) {
        had.lastActiveAt = last;
        changed = true;
      }
      continue;
    }
    list.unshift({ id, userId, device: "Signed-in browser", kind: "desktop", method: user?.totpEnabled ? "Password and 2-step code" : "Password", startedAt: r.createdAt.toISOString(), lastActiveAt: r.lastAuthAt.toISOString(), via: "console" });
    changed = true;
  }
  // a console session whose real session has ended (signed out, expired, ended elsewhere)
  for (const x of list) {
    if (x.userId !== userId || x.via !== "console" || x.endedAt || live.has(x.id)) continue;
    Object.assign(x, { endedAt: new Date().toISOString(), endReason: "Signed out" });
    changed = true;
  }
  if (list.length > 60) s.sessions = list.slice(0, 60);
  if (changed) touch(ctx, "session");
}

/** The real session a console session id stands for (only the person's own). */
function realSessionAt(userId: string, id: string) {
  const m = /^ses_(.+)_(\d{10,16})$/.exec(id);
  if (!m || m[1] !== userId) return undefined;
  return { userId, createdAt: new Date(Number(m[2])) };
}

override("orgApi.sessions", async (ctx) => {
  await syncSessions(ctx);
  return ctx.original(...ctx.args);
});

override("orgApi.endSession", async (ctx) => {
  const [, , id] = ctx.args as [string, string, string];
  await syncSessions(ctx);
  const out = await ctx.original(...ctx.args);
  const real = realSessionAt(ctx.actorUserId, id);
  if (real) await prisma.session.deleteMany({ where: real });
  return out;
});

override("orgApi.endOtherSessions", async (ctx) => {
  await syncSessions(ctx);
  const out = await ctx.original(...ctx.args);
  const current = await currentSession();
  await prisma.session.deleteMany({ where: { userId: ctx.actorUserId, ...(current ? { id: { not: current.id } } : {}) } });
  return out;
});

// ---- Two-step sign-in for "you" ----

override("orgApi.confirmTotp", async (ctx) => {
  const [, , secret, code] = ctx.args as [string, string, string, string];
  await requireFresh();
  const out = await ctx.original(...ctx.args);
  await enrolTotp(ctx.actorUserId, String(secret ?? ""), String(code ?? ""));
  // the secret is the account's, kept encrypted on the account; the shared document keeps only that it was set up
  const mine = (settingsOf(ctx).mfa as Record<string, { secret?: string }>)[ctx.actorUserId];
  if (mine) delete mine.secret;
  return out;
});

// ---- Single sign-on (OIDC) ----

interface OidcDomain {
  name: string;
  token: string;
  verified: boolean;
  checkedAt?: string;
  lastCheck?: string;
}

/** The document's OIDC settings in line with the real connection (once there is one). */
async function syncOidc(ctx: Ctx) {
  const conn = await forOrg(ctx.orgId).ssoConnection.findFirst();
  const s = settingsOf(ctx).oidc as Doc;
  if (!conn) return s;
  const had = (s.domains ?? []) as OidcDomain[];
  Object.assign(s, {
    issuer: conn.issuer,
    clientId: conn.clientId,
    ssoOnly: conn.enforce,
    jit: true,
    jitRole: conn.defaultRole,
    savedAt: s.savedAt ?? conn.updatedAt.toISOString(),
    domains: conn.domains.map((name) => {
      const prev = had.find((x) => x.name === name);
      return { ...(prev ?? {}), name, token: conn.verifyToken, verified: conn.verifiedDomains.includes(name) };
    }),
  });
  return s;
}

/** The connection as the real backend saves it, from the console's settings. */
async function saveOidcReal(ctx: Ctx, secret?: string) {
  const s = settingsOf(ctx).oidc as Doc;
  const domains = ((s.domains ?? []) as OidcDomain[]).map((x) => x.name);
  if (!domains.length) throw new Error("Add your email domain first: single sign-on is offered to people from it.");
  const role = s.jitRole === "owner" ? "viewer" : (s.jitRole as Role);
  await saveSsoConnection(ctx.orgId, { issuer: String(s.issuer), clientId: String(s.clientId), ...(secret ? { clientSecret: secret } : {}), domains, enforce: !!s.ssoOnly, defaultRole: role, enabled: true }, { actor: await emailOf(ctx.actorUserId) });
}

override("orgApi.oidc", async (ctx) => {
  await syncOidc(ctx);
  return ctx.original(...ctx.args);
});

override("orgApi.saveOidc", async (ctx) => {
  const [, input] = ctx.args as [string, { secret?: string }];
  await requireFresh();
  await requireRole(ctx, ["owner"], "Single sign-on");
  const out = (await ctx.original(...ctx.args)) as { config: unknown; seq: number };
  await saveOidcReal(ctx, input?.secret);
  return { ...out, config: structuredClone(await syncOidc(ctx)) };
});

/** A domain change on a saved connection is the real connection's; before it is saved, the console keeps the list. */
async function ifSaved(ctx: Ctx) {
  if (await forOrg(ctx.orgId).ssoConnection.findFirst({ select: { id: true } })) {
    await saveOidcReal(ctx);
    await syncOidc(ctx);
  }
}

for (const op of ["orgApi.addDomain", "orgApi.removeDomain", "orgApi.setSsoOnly"]) {
  override(op, async (ctx) => {
    await requireRole(ctx, ["owner"], "Single sign-on");
    const out = await ctx.original(...ctx.args);
    await ifSaved(ctx);
    return out;
  });
}

override("orgApi.setJit", async (ctx) => {
  const [, patch] = ctx.args as [string, { jit?: boolean; jitRole?: Role }];
  await requireRole(ctx, ["owner"], "Just-in-time accounts");
  if (patch?.jit === false && (await forOrg(ctx.orgId).ssoConnection.findFirst({ select: { id: true } }))) {
    throw new Error("Single sign-on always creates an account for someone from a verified domain the first time they sign in. To add people only by invitation, use SAML with just-in-time accounts off.");
  }
  if (patch?.jitRole === "owner") throw new Error("New SSO users cannot become owners automatically.");
  const out = await ctx.original(...ctx.args);
  await ifSaved(ctx);
  return out;
});

override("orgApi.verifyDomain", async (ctx) => {
  const [, name] = ctx.args as [string, string];
  await requireRole(ctx, ["owner"], "Single sign-on");
  if (!(await forOrg(ctx.orgId).ssoConnection.findFirst({ select: { id: true } }))) throw new Error("Save the connection first, then verify the domain.");
  // the real DNS check; the console's own result is what the screen shows (its receipt names a verified domain)
  await verifySsoDomain(ctx.orgId, String(name ?? "").trim().toLowerCase());
  await syncOidc(ctx);
  const dm = ((settingsOf(ctx).oidc as Doc).domains as OidcDomain[]).find((x) => x.name === name);
  if (dm) Object.assign(dm, { checkedAt: new Date().toISOString(), lastCheck: "found" });
  const r = ctx.domain.db.logAdmin(ctx.orgId, ctx.actorUserId, "sso.domain_verified", { domain: String(name) });
  touch(ctx, "sso");
  return { domain: structuredClone(dm), published: [], seq: r.seq };
});

// ---- SAML 2.0, "Require SAML for everyone", and the SCIM token ----

/** The document's SAML and SCIM settings in line with the real connections. */
async function syncIdentity(ctx: Ctx) {
  const db = forOrg(ctx.orgId);
  const [saml, scim] = await Promise.all([db.samlConnection.findFirst(), db.scimConnection.findFirst()]);
  const d = docOf(ctx);
  const identity = d.platform.identity as Doc;
  const cert = saml?.idpCertPems[0] ? parseIdpCert(saml.idpCertPems[0], new Date(0)) : undefined;
  Object.assign(identity.saml, {
    enabled: !!saml?.enabled,
    enforced: !!saml?.enforced,
    jitProvisioning: saml ? saml.jit : false,
    acsUrl: acsUrl(),
    ...(saml ? { entityId: saml.spEntityId, metadataUrl: saml.idpSsoUrl } : {}),
    ...(cert && !("error" in cert) ? { certFingerprint: cert.fingerprint, certExpiresAt: cert.expiresAt } : {}),
  });
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [provisioned, deprovisioned] = await Promise.all([db.scimUser.count({ where: { active: true } }), db.scimUser.count({ where: { active: false, updatedAt: { gte: since } } })]);
  Object.assign(identity.scim, {
    enabled: !!scim,
    endpoint: scimBaseUrl(),
    tokenPrefix: scim?.tokenPrefix ?? "",
    ...(scim?.lastUsedAt ? { lastSyncAt: iso(scim.lastUsedAt) } : {}),
    usersProvisioned: provisioned,
    deprovisioned30d: deprovisioned,
  });
  return structuredClone(identity);
}

override("api.identityConfig", async (ctx) => {
  await ctx.original(...ctx.args);
  return syncIdentity(ctx);
});

override("api.setIdentityConfig", async (ctx) => {
  const [, patch] = ctx.args as [string, { saml?: { enabled?: boolean; enforced?: boolean; jitProvisioning?: boolean; metadataUrl?: string } }];
  await requireFresh();
  await requireRole(ctx, ["owner"], "SAML and SCIM");
  const conn = patch?.saml ? await forOrg(ctx.orgId).samlConnection.findFirst() : null;
  if (patch?.saml && !conn) {
    throw new Error("Set up SAML for your organisation first: Elan1 Govern needs your identity provider's entity id, its signing certificate and your email domains before SAML can be switched on.");
  }
  await ctx.original(...ctx.args);
  if (patch?.saml && conn) {
    const p = patch.saml;
    await saveSamlConnection(ctx.orgId, {
      idpEntityId: conn.idpEntityId,
      idpSsoUrl: p.metadataUrl ?? conn.idpSsoUrl,
      idpCertPems: conn.idpCertPems,
      spEntityId: conn.spEntityId,
      domains: conn.domains,
      enforced: p.enforced ?? conn.enforced,
      jit: p.jitProvisioning ?? conn.jit,
      defaultRole: conn.defaultRole as Role,
      enabled: p.enabled ?? conn.enabled,
    });
  }
  return syncIdentity(ctx);
});

override("api.rotateScimToken", async (ctx) => {
  await requireFresh();
  await requireRole(ctx, ["owner"], "The SCIM token");
  onChain(ctx);
  // the secret shown once is the real one: the real backend makes it and records identity.scim_token_rotated
  const { token } = await rotateScimToken(ctx.orgId, await emailOf(ctx.actorUserId));
  await pull(ctx);
  touch(ctx, "settings");
  return { secret: token, config: await syncIdentity(ctx) };
});
