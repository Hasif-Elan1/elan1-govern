import { hashToken, randomToken } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeIdp } from "../saml-idp";
import { lastReceipt, type Doc, type Harness } from "./harness";

// People and roles, Sessions, two-step sign-in, single sign-on (OIDC), SAML and the SCIM token on the real
// Membership, Invite, Session, User, SsoConnection, SamlConnection and ScimConnection rows
// (apps/web/src/server/console-overrides/wiring/identity.ts). Northbank (L2): Rohan owns it, Neha is an admin.
const ORG = "org_northbank";
const OWNER = "u_rohan";
const ADMIN = "u_nb_neha";
const APPROVER = "u_nb_imran";
const VIEWER = "u_nb_pooja";
const NEWCOMER = "kiran.rao@northbank.co.in";

type Member = { userId: string; role: string; status: string; invitedEmail?: string };
const membersOf = (d: Doc) => d.members as Member[];

export function identityCases(h: Harness) {
  const db = forOrg(ORG);

  beforeAll(async () => {
    await h.reset(ORG);
    await db.invite.deleteMany({ where: { email: NEWCOMER } });
    await db.membership.updateMany({ where: { userId: APPROVER }, data: { role: "approver", status: "active" } });
    await db.membership.deleteMany({ where: { userId: "u_lakshmi" } });
    await Promise.all([db.ssoConnection.deleteMany({}), db.samlConnection.deleteMany({}), db.scimConnection.deleteMany({})]);
    await prisma.user.update({ where: { id: VIEWER }, data: { totpEnabled: false, totpSecret: null } });
  }, 120_000);
  afterAll(async () => {
    await db.membership.updateMany({ where: { userId: APPROVER }, data: { role: "approver", status: "active" } });
    await prisma.user.update({ where: { id: VIEWER }, data: { totpEnabled: false, totpSecret: null } });
    await Promise.all([db.ssoConnection.deleteMany({}), db.samlConnection.deleteMany({}), db.scimConnection.deleteMany({})]);
  });

  describe("identity settings on the real backend", () => {
    it("invites people as owners and admins only: a pending invitation, or an existing account added at once", async () => {
      expect((await h.rpc("orgApi.inviteMembers", [ORG, [NEWCOMER], "approver", ADMIN], VIEWER)).status).toBe(400);
      expect(await db.invite.count({ where: { email: NEWCOMER } })).toBe(0);

      const r = await h.rpc("orgApi.inviteMembers", [ORG, [NEWCOMER], "approver", VIEWER], ADMIN);
      expect(r.status, r.body.error).toBe(200);
      const token = (r.body.result as { invites: { token: string }[] }).invites[0]!.token;
      // the link the console shows the inviter is the real invitation's
      expect(await db.invite.findFirst({ where: { email: NEWCOMER } })).toMatchObject({ role: "approver", tokenHash: hashToken(token), acceptedAt: null });
      const { doc } = await h.state(ORG, ADMIN);
      expect(membersOf(doc).find((m) => m.invitedEmail === NEWCOMER)).toMatchObject({ status: "invited", role: "approver" });
      expect(lastReceipt(doc, "member.invited")).toMatchObject({ actor: ADMIN });

      // someone who already has an Elan1 Govern account (an auditor's client, a group company) joins at once
      const added = await h.rpc("orgApi.inviteMembers", [ORG, ["lakshmi.pillai@kaverihealth.in"], "viewer", ADMIN], ADMIN);
      expect(added.status, added.body.error).toBe(200);
      expect(await db.membership.findFirst({ where: { userId: "u_lakshmi" } })).toMatchObject({ role: "viewer", status: "active" });
      expect(membersOf((await h.state(ORG, ADMIN)).doc).find((m) => m.userId === "u_lakshmi")).toMatchObject({ role: "viewer", status: "active" });
      // her own organisation is untouched
      expect(await forOrg("org_kaveri").membership.findFirst({ where: { userId: "u_lakshmi" } })).toMatchObject({ role: "owner" });
    });

    it("changes roles under both the console's rules and the real ones", async () => {
      const r = await h.rpc("orgApi.changeRole", [ORG, APPROVER, "viewer", OWNER], ADMIN);
      expect(r.status, r.body.error).toBe(200);
      expect(await db.membership.findFirst({ where: { userId: APPROVER } })).toMatchObject({ role: "viewer" });
      const { doc } = await h.state(ORG, ADMIN);
      expect(membersOf(doc).find((m) => m.userId === APPROVER)?.role).toBe("viewer");
      expect(lastReceipt(doc, "member.role_changed")).toMatchObject({ actor: ADMIN, details: { from: "approver", to: "viewer" } });
      // only an owner makes an owner; nobody changes their own role; a viewer changes nothing
      expect((await h.rpc("orgApi.changeRole", [ORG, APPROVER, "owner", ADMIN], ADMIN)).status).toBe(400);
      expect((await h.rpc("orgApi.changeRole", [ORG, ADMIN, "owner", ADMIN], ADMIN)).status).toBe(400);
      expect((await h.rpc("orgApi.changeRole", [ORG, APPROVER, "admin", VIEWER], VIEWER)).status).toBe(400);
      expect(await db.membership.findFirst({ where: { userId: APPROVER } })).toMatchObject({ role: "viewer" });
      // an invitation's role changes with it
      const invited = membersOf((await h.state(ORG, ADMIN)).doc).find((m) => m.invitedEmail === NEWCOMER)!;
      expect((await h.rpc("orgApi.changeRole", [ORG, invited.userId, "viewer", ADMIN], ADMIN)).status).toBe(200);
      expect(await db.invite.findFirst({ where: { email: NEWCOMER } })).toMatchObject({ role: "viewer" });
    });

    it("suspends and reinstates a member in Membership", async () => {
      expect((await h.rpc("orgApi.setSuspended", [ORG, APPROVER, true, ADMIN, "x"], ADMIN)).status).toBe(400); // a reason is required
      const r = await h.rpc("orgApi.setSuspended", [ORG, APPROVER, true, ADMIN, "Access review after a change of team"], ADMIN);
      expect(r.status, r.body.error).toBe(200);
      expect(await db.membership.findFirst({ where: { userId: APPROVER } })).toMatchObject({ status: "suspended" });
      expect(membersOf((await h.state(ORG, ADMIN)).doc).find((m) => m.userId === APPROVER)?.status).toBe("suspended");
      expect((await h.rpc("orgApi.setSuspended", [ORG, APPROVER, false, ADMIN, ""], ADMIN)).status).toBe(200);
      expect(await db.membership.findFirst({ where: { userId: APPROVER } })).toMatchObject({ status: "active" });
    });

    it("removes members and withdraws invitations for real", async () => {
      const invited = membersOf((await h.state(ORG, ADMIN)).doc).find((m) => m.invitedEmail === NEWCOMER)!;
      expect((await h.rpc("orgApi.removeMember", [ORG, invited.userId, ADMIN], ADMIN)).status).toBe(200);
      expect(await db.invite.count({ where: { email: NEWCOMER } })).toBe(0);
      expect((await h.rpc("orgApi.removeMember", [ORG, "u_lakshmi", VIEWER], VIEWER)).status).toBe(400);
      expect((await h.rpc("orgApi.removeMember", [ORG, "u_lakshmi", ADMIN], ADMIN)).status).toBe(200);
      expect(await db.membership.count({ where: { userId: "u_lakshmi" } })).toBe(0);
      const { doc } = await h.state(ORG, ADMIN);
      expect(membersOf(doc).some((m) => m.userId === "u_lakshmi" || m.invitedEmail === NEWCOMER)).toBe(false);
      // a member someone removes elsewhere (the directory, the API) leaves the People list at the next read
      await db.membership.update({ where: { userId_orgId: { userId: "u_nb_karthik", orgId: ORG } }, data: { role: "viewer" } });
      const list = (await h.rpc("api.members", [ORG], VIEWER)).body.result as (Member & { user?: { email: string } })[];
      expect(list.find((m) => m.userId === "u_nb_karthik")).toMatchObject({ role: "viewer", user: { email: "karthik.s@northbank.co.in" } });
      await db.membership.update({ where: { userId_orgId: { userId: "u_nb_karthik", orgId: ORG } }, data: { role: "approver" } });
    });

    it("lists and ends the person's own real sessions", async () => {
      const at = new Date(Date.now() - 60_000);
      const mine = await prisma.session.create({ data: { tokenHash: hashToken(randomToken()), userId: ADMIN, csrfToken: "x", createdAt: at, lastAuthAt: at, expiresAt: new Date(Date.now() + 86_400_000) } });
      const other = await prisma.session.create({ data: { tokenHash: hashToken(randomToken()), userId: ADMIN, csrfToken: "x", expiresAt: new Date(Date.now() + 86_400_000) } });
      const id = `ses_${ADMIN}_${at.getTime()}`;
      const r = await h.rpc("orgApi.sessions", [ORG, ADMIN], ADMIN);
      expect(r.status, r.body.error).toBe(200);
      expect((r.body.result as { sessions: { id: string; endedAt?: string }[] }).sessions.find((s) => s.id === id)?.endedAt).toBeUndefined();
      // someone else's session is not theirs to end
      expect((await h.rpc("orgApi.endSession", [ORG, VIEWER, id], VIEWER)).status).toBe(400);
      expect((await h.rpc("orgApi.endSession", [ORG, ADMIN, id], ADMIN)).status).toBe(200);
      expect(await prisma.session.count({ where: { id: mine.id } })).toBe(0);
      expect(await prisma.session.count({ where: { id: other.id } })).toBe(1);
      expect(lastReceipt((await h.state(ORG, ADMIN)).doc, "session.revoked")).toMatchObject({ actor: ADMIN });
      expect((await h.rpc("orgApi.endOtherSessions", [ORG, ADMIN, "ses_keep"], ADMIN)).status).toBe(200);
      expect(await prisma.session.count({ where: { userId: ADMIN } })).toBe(0);
    });

    it("sets up two-step sign-in on the account, after a fresh sign-in, keeping the secret off the document", async () => {
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      const code = () => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: "SHA1", digits: 6, period: 30 }).generate();
      h.session.lastAuthAt = new Date(Date.now() - 11 * 60_000);
      expect((await h.rpc("orgApi.confirmTotp", [ORG, VIEWER, secret, code()], VIEWER)).body.error).toMatch(/Confirm it's you/);
      h.session.lastAuthAt = new Date();
      expect((await h.rpc("orgApi.confirmTotp", [ORG, VIEWER, secret, "000000"], VIEWER)).status).toBe(400);
      const r = await h.rpc("orgApi.confirmTotp", [ORG, VIEWER, secret, code()], VIEWER);
      expect(r.status, r.body.error).toBe(200);
      const u = await prisma.user.findUniqueOrThrow({ where: { id: VIEWER } });
      expect(u.totpEnabled).toBe(true);
      expect(u.totpSecret).toBeTruthy();
      expect(u.totpSecret).not.toContain(secret);
      const saved = await h.saved(ORG);
      expect(JSON.stringify(saved)).not.toContain(secret);
      expect(saved.orgSettings.mfa[VIEWER]).toBeTruthy();
      // already on: the real backend refuses a second set-up
      expect((await h.rpc("orgApi.confirmTotp", [ORG, VIEWER, secret, code()], VIEWER)).body.error).toMatch(/already on/);
    });

    it("rotates the SCIM token for owners only, showing the real secret once", async () => {
      expect((await h.rpc("api.rotateScimToken", [ORG, OWNER], ADMIN)).status).toBe(400);
      const r = await h.rpc("api.rotateScimToken", [ORG, ADMIN], OWNER);
      expect(r.status, r.body.error).toBe(200);
      const { secret, config } = r.body.result as { secret: string; config: { scim: { enabled: boolean; tokenPrefix: string } } };
      const conn = await db.scimConnection.findFirstOrThrow();
      expect(conn.tokenHash).toBe(hashToken(secret));
      expect(config.scim).toMatchObject({ enabled: true, tokenPrefix: conn.tokenPrefix });
      const { doc } = await h.state(ORG, OWNER);
      expect(doc.platform.identity.scim.tokenPrefix).toBe(conn.tokenPrefix);
      expect(JSON.stringify(doc)).not.toContain(secret);
      expect(lastReceipt(doc, "identity.scim_token_rotated")?.details).toMatchObject({ prefix: conn.tokenPrefix });
    });

    it("requires SAML for everyone on the real connection, owner only, with the real safeguards", async () => {
      expect((await h.rpc("api.setIdentityConfig", [ORG, { saml: { enabled: true } }, OWNER], OWNER)).body.error).toMatch(/Set up SAML/);
      const idp = makeIdp();
      await db.samlConnection.create({ data: { orgId: ORG, idpEntityId: idp.entityId, idpSsoUrl: "https://idp.northbank.example/sso", idpCertPems: [idp.certPem], spEntityId: `https://sp.test/${ORG}`, domains: ["northbank.co.in"], verifyToken: "tok", verifiedDomains: [], enabled: true, enforced: false, jit: true } });
      // no verified domain yet: the real rule refuses, and nothing is changed
      expect((await h.rpc("api.setIdentityConfig", [ORG, { saml: { enforced: true } }, OWNER], OWNER)).body.error).toMatch(/Verify at least one domain/);
      expect(await db.samlConnection.findFirst()).toMatchObject({ enforced: false });
      await db.samlConnection.updateMany({ data: { verifiedDomains: ["northbank.co.in"] } });
      expect((await h.rpc("api.setIdentityConfig", [ORG, { saml: { enforced: true } }, ADMIN], ADMIN)).status).toBe(400);
      const r = await h.rpc("api.setIdentityConfig", [ORG, { saml: { enforced: true, jitProvisioning: false } }, OWNER], OWNER);
      expect(r.status, r.body.error).toBe(200);
      expect(await db.samlConnection.findFirst()).toMatchObject({ enforced: true, jit: false });
      expect((await h.state(ORG, OWNER)).doc.platform.identity.saml).toMatchObject({ enabled: true, enforced: true, jitProvisioning: false, entityId: `https://sp.test/${ORG}` });
      await db.samlConnection.updateMany({ data: { enforced: false } });
    });

    it("keeps domains, SSO-only and the default role on the saved OIDC connection", async () => {
      await db.ssoConnection.create({ data: { orgId: ORG, issuer: "https://login.northbank.example", clientId: "client-northbank", clientSecretEnc: "", domains: ["northbank.co.in"], verifyToken: "vt-northbank", verifiedDomains: ["northbank.co.in"] } });
      const read = await h.rpc("orgApi.oidc", [ORG], ADMIN);
      expect(read.body.result).toMatchObject({ issuer: "https://login.northbank.example", clientId: "client-northbank", domains: [{ name: "northbank.co.in", token: "vt-northbank", verified: true }] });
      expect((await h.rpc("orgApi.addDomain", [ORG, "nb-labs.co.in", ADMIN], ADMIN)).status).toBe(400);
      expect((await h.rpc("orgApi.addDomain", [ORG, "nb-labs.co.in", OWNER], OWNER)).status).toBe(200);
      expect((await db.ssoConnection.findFirstOrThrow()).domains).toEqual(["northbank.co.in", "nb-labs.co.in"]);
      expect((await h.rpc("orgApi.setSsoOnly", [ORG, true, OWNER], OWNER)).status).toBe(200);
      expect((await h.rpc("orgApi.setJit", [ORG, { jitRole: "approver" }, OWNER], OWNER)).status).toBe(200);
      expect(await db.ssoConnection.findFirstOrThrow()).toMatchObject({ enforce: true, defaultRole: "approver" });
      // OIDC always creates accounts for verified domains: turning just-in-time off is refused rather than pretended
      expect((await h.rpc("orgApi.setJit", [ORG, { jit: false }, OWNER], OWNER)).body.error).toMatch(/always creates an account/);
      expect((await h.rpc("orgApi.removeDomain", [ORG, "nb-labs.co.in", OWNER], OWNER)).status).toBe(200);
      expect((await db.ssoConnection.findFirstOrThrow()).domains).toEqual(["northbank.co.in"]);
      expect((await h.state(ORG, OWNER)).doc.orgSettings.oidc).toMatchObject({ ssoOnly: true, jitRole: "approver" });
    });

    it("never lets one organisation's people change another's", async () => {
      expect((await h.rpc("orgApi.changeRole", ["org_kaveri", "u_kh_rafi", "viewer", ADMIN], ADMIN)).status).toBe(403);
      expect((await h.rpc("api.rotateScimToken", ["org_kaveri", OWNER], OWNER)).status).toBe(403);
      expect(await forOrg("org_kaveri").membership.findFirst({ where: { userId: "u_kh_rafi" } })).toMatchObject({ role: "approver" });
      expect(await forOrg("org_kaveri").scimConnection.count()).toBe(0);
    });
  });
}
