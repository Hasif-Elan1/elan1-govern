import { randomBytes } from "node:crypto";
import { hashToken } from "@gate/core";
import { prisma } from "@gate/db";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConsoleOrg, startGate } from "./console-gate";

// Invitations and sign-out across the console and the real backend: the routes, the real session code, the built
// domain, Postgres and a real gate service (its chain). Only the cookie jar and the mailer are stand-ins. These
// tests use org_kaveri, and org_deccan for isolation.
const state = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  mails: [] as { to: string; org: string; inviter: string; link: string; role: string }[],
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void state.jar.set(name, value),
    delete: (name: string) => void state.jar.delete(name),
  }),
}));
vi.mock("../src/server/mail", () => ({
  sendInvite: async (to: string, org: string, inviter: string, link: string, role: string) => void state.mails.push({ to, org, inviter, link, role }),
  sendPasswordReset: async () => undefined,
}));

const gateService = await startGate();
const invites = await import("../src/app/api/invites/route");
const inviteRead = await import("../src/app/api/invites/[token]/route");
const send = await import("../src/app/api/invites/send/route");
const session = await import("../src/app/api/auth/session/route");
const rpcRoute = await import("../src/app/api/console/rpc/route");
const consoleDomain = await import("../src/server/console-domain");
const { startSession, CSRF_COOKIE, SESSION_COOKIE } = await import("../src/server/session");
const { hashPassword } = await import("../src/server/auth");
const { resetRateLimits } = await import("../src/server/ratelimit");

const ORG = "org_kaveri";
const OTHER = "org_deccan";
const OWNER = "u_lakshmi";
const ADMIN = "u_kh_arvind";
const VIEWER = "u_kh_nandini";
const seg = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });
const tag = () => randomBytes(4).toString("hex");
const PASSWORD = "a long enough passphrase 7";

type Invite = { email: string; role: string; userId: string; token?: string; tokenHash?: string; usedAt?: string; acceptedBy?: string; revokedAt?: string; replacedBy?: string };
type Doc = {
  members: { userId: string; role: string; status: string }[];
  receipts: { seq: number; actor?: string; action?: string; details?: Record<string, unknown> }[];
  orgSettings: { invites: Invite[]; sessions: { id: string; userId: string; endedAt?: string; endReason?: string; seq?: number }[] };
};
const docOf = async (orgId = ORG) => (await consoleDomain.stateFor(orgId)).doc as unknown as Doc;

function req(path: string, method = "GET", body?: unknown) {
  const headers: Record<string, string> = { origin: "http://localhost:3000" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-csrf-token"] = state.jar.get(CSRF_COOKIE) ?? "";
  return new NextRequest(`http://localhost:3000${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function signOut() {
  state.jar.clear();
  state.jar.set(CSRF_COOKIE, "signed-out-csrf"); // the middleware's double-submit cookie
}
async function signIn(userId: string, orgId = ORG) {
  signOut();
  await startSession(userId, orgId);
}
async function call<T = Record<string, unknown>>(res: Promise<Response>) {
  const r = await res;
  return { status: r.status, body: (await r.json()) as T & { error?: string } };
}
const sendInvites = (orgId: string, emails: string[], role: string) =>
  call<{ invites: { email: string; added: boolean; link: string | null }[]; seq: number | null }>(send.POST(req("/api/invites/send", "POST", { orgId, emails, role }), seg()));
const readInvite = (token: string) => call<{ orgName: string; inviter: string | null; role: string }>(inviteRead.GET(req(`/api/invites/${token}`), seg({ token })));
const accept = (body: Record<string, unknown>) => call<{ ok: boolean; orgId: string }>(invites.POST(req("/api/invites", "POST", body), seg()));
const rpc = (op: string, args: unknown[]) => call<{ result: unknown }>(rpcRoute.POST(req("/api/console/rpc", "POST", { op, args }), seg()));

/** The owner invites a new address in the console; the emailed link's token. */
async function invited(role = "approver", orgId = ORG, by = OWNER) {
  const email = `new-${tag()}@invites.test`;
  await signIn(by, orgId);
  const r = await sendInvites(orgId, [email], role);
  expect(r.status).toBe(200);
  const mail = state.mails.findLast((m) => m.to === email)!;
  const token = /^http:\/\/localhost:3000\/invite\/([A-Za-z0-9_-]{40,})$/.exec(mail.link)![1]!;
  signOut();
  return { email, token, mail };
}

const created: string[] = [];
beforeAll(async () => {
  await consoleDomain.forgetConsoleMemory();
  for (const org of [ORG, OTHER]) await resetConsoleOrg(org);
});
afterAll(async () => {
  // the people these tests made, so the console's demo organisations keep only the seeded members
  await prisma.user.deleteMany({ where: { email: { endsWith: "@invites.test" } } });
  await gateService.close();
  await prisma.$disconnect();
});
beforeEach(() => {
  resetRateLimits();
  signOut();
});

describe("an invitation sent in the console", () => {
  it("is a real invite, emailed, that a new person accepts by signing up: a member in Membership and in the document", async () => {
    const { email, token, mail } = await invited("approver");
    expect(mail).toMatchObject({ to: email, org: "Kaveri Health Network", inviter: "Dr Lakshmi Pillai", role: "approver" });
    // the Invite row keeps the link's hash only, and so does the document's pending entry
    const row = await prisma.invite.findFirstOrThrow({ where: { email } });
    expect(row).toMatchObject({ orgId: ORG, role: "approver", tokenHash: hashToken(token), invitedBy: "lakshmi.pillai@kaverihealth.in", acceptedAt: null });
    let doc = await docOf();
    const pending = doc.orgSettings.invites.find((i) => i.email === email)!;
    expect(pending).toMatchObject({ role: "approver", tokenHash: hashToken(token) });
    expect(pending.token).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain(token);
    expect(doc.members.find((m) => m.userId === pending.userId)).toMatchObject({ status: "invited", role: "approver" });
    expect(doc.receipts.findLast((r) => r.action === "member.invited")).toMatchObject({ actor: OWNER, details: { email, role: "approver" } });

    // the page, signed out, sees the organisation, the inviter and the role, nothing else
    const read = await readInvite(token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ orgName: "Kaveri Health Network", inviter: "Dr Lakshmi Pillai", role: "approver" });

    const chainBefore = await prisma.receipt.count({ where: { orgId: ORG, action: "member.joined" } });
    const r = await accept({ token, name: "Priya Iyer", email, password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, orgId: ORG });
    expect(state.jar.get(SESSION_COOKIE)).toBeTruthy();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    created.push(user.id);
    expect(await prisma.membership.findFirst({ where: { orgId: ORG, userId: user.id } })).toMatchObject({ role: "approver", status: "active" });
    expect((await prisma.invite.findUniqueOrThrow({ where: { id: row.id } })).acceptedAt).not.toBeNull();
    expect((await prisma.session.findFirstOrThrow({ where: { userId: user.id } })).activeOrgId).toBe(ORG);

    doc = await docOf();
    expect(doc.members.filter((m) => m.userId === user.id)).toEqual([expect.objectContaining({ role: "approver", status: "active" })]);
    expect(doc.members.some((m) => m.userId === pending.userId)).toBe(false);
    expect(doc.orgSettings.invites.find((i) => i.email === email)).toMatchObject({ acceptedBy: user.id, usedAt: expect.any(String) });
    expect(doc.receipts.findLast((x) => x.action === "member.joined")).toMatchObject({ actor: user.id, details: { email, role: "approver" } });
    // written once, on the real chain (not again through the events path)
    expect(await prisma.receipt.count({ where: { orgId: ORG, action: "member.joined" } })).toBe(chainBefore + 1);
    // and the console opens for them: the door's membership check and the domain's role check both pass
    expect(await consoleDomain.consoleMember(user.id, ORG)).toBe(true);
    expect((await rpc("api.members", [ORG])).status).toBe(200);

    // single use
    expect((await readInvite(token)).status).toBe(410);
    expect((await accept({ token })).status).toBe(410);
    // nor can someone else holding the link join the document with it through the door
    await signIn(VIEWER);
    const replay = await rpc("consoleOps.ensureInvitedMembership", [ORG, token, VIEWER]);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toMatch(/already used/);
  });

  it("is accepted by a person already signed in, with the address it was sent to only", async () => {
    const { email, token } = await invited("viewer");
    const someoneElse = await prisma.user.create({ data: { email: `other-${tag()}@invites.test`, name: "Someone Else", passwordHash: await hashPassword(PASSWORD) } });
    await signIn(someoneElse.id, OTHER);
    const wrong = await accept({ token });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).not.toContain(email);

    const right = await prisma.user.create({ data: { email, name: "Kiran Das", passwordHash: await hashPassword(PASSWORD) } });
    await signIn(right.id, OTHER);
    expect((await accept({ token })).status).toBe(200);
    expect(await prisma.membership.findFirst({ where: { orgId: ORG, userId: right.id } })).toMatchObject({ role: "viewer" });
    expect((await docOf()).members.find((m) => m.userId === right.id)).toMatchObject({ role: "viewer", status: "active" });
  });

  it("adds a person who already has an account at once, in both places", async () => {
    const existing = await prisma.user.create({ data: { email: `has-account-${tag()}@invites.test`, name: "Mira Shah", passwordHash: "x" } });
    await signIn(ADMIN);
    const r = await sendInvites(ORG, [existing.email], "viewer");
    expect(r.status).toBe(200);
    expect(r.body.invites).toEqual([{ email: existing.email, added: true, link: null, seq: expect.any(Number) }]);
    expect(state.mails.some((m) => m.to === existing.email)).toBe(false);
    expect(await prisma.membership.findFirst({ where: { orgId: ORG, userId: existing.id } })).toMatchObject({ role: "viewer", status: "active" });
    expect((await docOf()).members.find((m) => m.userId === existing.id)).toMatchObject({ role: "viewer", status: "active" });
    expect((await sendInvites(ORG, [existing.email], "viewer")).status).toBe(409);
  });

  it("refuses expired, forged, withdrawn and replaced links, the same way", async () => {
    const forged = randomBytes(32).toString("base64url");
    expect((await readInvite(forged)).status).toBe(410);
    expect((await accept({ token: forged, name: "Forger", email: `forger-${tag()}@invites.test`, password: PASSWORD })).status).toBe(410);
    expect(await prisma.user.count({ where: { name: "Forger" } })).toBe(0);

    const expired = await invited();
    await prisma.invite.updateMany({ where: { email: expired.email }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await readInvite(expired.token)).status).toBe(410);
    expect((await accept({ token: expired.token, name: "Late Comer", email: expired.email, password: PASSWORD })).status).toBe(410);

    // withdrawn in the console (People and roles › Revoke): the real invite stops working too
    const withdrawn = await invited();
    const placeholder = (await docOf()).orgSettings.invites.find((i) => i.email === withdrawn.email)!.userId;
    await signIn(OWNER);
    expect((await rpc("orgApi.removeMember", [ORG, placeholder, OWNER])).status).toBe(200);
    signOut();
    const gone = await readInvite(withdrawn.token);
    expect(gone.status).toBe(410);
    expect(gone.body).toEqual({ error: "This invite has expired or was already used. Ask for a new one." });
    expect((await accept({ token: withdrawn.token, name: "Not Anymore", email: withdrawn.email, password: PASSWORD })).status).toBe(410);

    // resending replaces the link: the old one stops working, the new one works
    const first = await invited("viewer");
    await signIn(OWNER);
    expect((await sendInvites(ORG, [first.email], "viewer")).status).toBe(200);
    const second = /\/invite\/([A-Za-z0-9_-]+)$/.exec(state.mails.findLast((m) => m.to === first.email)!.link)![1]!;
    signOut();
    expect((await readInvite(first.token)).status).toBe(410);
    expect((await readInvite(second)).status).toBe(200);
    expect((await docOf()).members.filter((m) => m.status === "invited" && (m as { invitedEmail?: string }).invitedEmail === first.email)).toHaveLength(1);
  });
});

describe("who may invite, and where", () => {
  it("is an owner or admin of that organisation; only an owner invites an owner", async () => {
    await signIn(VIEWER);
    expect((await sendInvites(ORG, [`v-${tag()}@invites.test`], "viewer")).status).toBe(403);
    await signIn(ADMIN);
    const owner = await sendInvites(ORG, [`o-${tag()}@invites.test`], "owner");
    expect(owner.status).toBe(403);
    expect(owner.body.error).toMatch(/Only an owner/);
    // an organisation they do not belong to
    expect((await sendInvites(OTHER, [`x-${tag()}@invites.test`], "viewer")).status).toBe(403);
  });

  it("keeps organisations apart: an invitation admits to its own organisation only", async () => {
    const theirs = await invited("approver", OTHER, "u_suresh");
    const ours = await invited("viewer");
    const r = await accept({ token: ours.token, name: "Only Kaveri", email: ours.email, password: PASSWORD });
    expect(r.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: ours.email } });
    expect((await prisma.membership.findMany({ where: { userId: user.id } })).map((m) => m.orgId)).toEqual([ORG]);
    expect((await docOf(OTHER)).members.some((m) => m.userId === user.id)).toBe(false);
    expect((await rpc("api.members", [OTHER])).status).toBe(403);
    // another organisation's link does not admit them here or there, through the door or the operation
    expect((await accept({ token: theirs.token })).status).toBe(403);
    await expect(consoleDomain.runOp(ORG, user.id, "consoleOps.ensureInvitedMembership", [ORG, theirs.token, user.id])).rejects.toMatchObject({ status: 400 });
    expect((await docOf(OTHER)).orgSettings.invites.find((i) => i.email === theirs.email)?.usedAt).toBeUndefined();
  });
});

describe("DELETE /api/auth/session", () => {
  it("writes auth.signed_out on the organisation signed in to and ends the console's session record", async () => {
    await signIn(ADMIN);
    const s = await prisma.session.findFirstOrThrow({ where: { userId: ADMIN }, orderBy: { createdAt: "desc" } });
    const signedInAt = s.createdAt.getTime();
    // the console registers this browser's session (Sessions, You)
    expect((await rpc("orgApi.registerSession", [ORG, ADMIN, signedInAt, "Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0", false])).status).toBe(200);
    const id = `ses_${ADMIN}_${signedInAt}`;
    expect((await docOf()).orgSettings.sessions.find((x) => x.id === id)?.endedAt).toBeUndefined();

    const res = await session.DELETE(req("/api/auth/session", "DELETE"), seg());
    expect(res.status).toBe(200);
    expect(state.jar.get(SESSION_COOKIE)).toBeUndefined();
    expect(await prisma.session.findUnique({ where: { id: s.id } })).toBeNull();

    const receipt = await prisma.receipt.findFirstOrThrow({ where: { orgId: ORG, action: "auth.signed_out" }, orderBy: { seq: "desc" } });
    expect((receipt.body as { actor?: unknown; details?: unknown }).details).toMatchObject({ session: id, reason: "Signed out", minutes: 0 });
    const record = (await docOf()).orgSettings.sessions.find((x) => x.id === id)!;
    expect(record).toMatchObject({ endedAt: expect.any(String), endReason: "Signed out", seq: receipt.seq });
    // nobody else's record, and not again
    await signIn(VIEWER);
    expect(((await rpc("consoleOps.endSignedOutSession", [ORG, { session: id }, VIEWER])).body.result as { ended: boolean }).ended).toBe(false);
  });
});

describe("orgApi.closure through POST /api/console/rpc", () => {
  it("answers null when no closure is scheduled (it failed with \"undefined\" is not valid JSON)", async () => {
    await signIn(OWNER);
    const r = await rpc("orgApi.closure", [ORG]);
    expect(r.status).toBe(200);
    expect(r.body.result).toBeNull();
  });
});
