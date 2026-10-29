import "server-only";
import { hashToken, randomToken, safeEqual } from "@gate/core";
import { membershipsForUser, prisma } from "@gate/db";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { env } from "./env";
import type { Role } from "./policy";

export const SESSION_COOKIE = "gate_session";
export const CSRF_COOKIE = "gate_csrf";
const SESSION_DAYS = 7;
export const FRESH_AUTH_MS = 10 * 60_000;

function cookieOpts(httpOnly: boolean) {
  return { httpOnly, secure: env().COOKIE_SECURE === "true", sameSite: "lax" as const, path: "/" };
}

/** Starts a session: a random 256-bit token in an httpOnly cookie, stored only as a hash. */
export async function startSession(userId: string, activeOrgId?: string | null) {
  const token = randomToken();
  const csrf = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  const firstOrg = activeOrgId ?? (await membershipsForUser(userId))[0]?.orgId ?? null;
  await prisma.session.create({ data: { tokenHash: hashToken(token), userId, activeOrgId: firstOrg, csrfToken: csrf, expiresAt, lastAuthAt: new Date() } });
  await prisma.user.update({ where: { id: userId }, data: { lastSignInAt: new Date() } });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, { ...cookieOpts(true), expires: expiresAt });
  jar.set(CSRF_COOKIE, csrf, { ...cookieOpts(false), expires: expiresAt });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  jar.delete(SESSION_COOKIE);
  jar.delete(CSRF_COOKIE);
}

export const currentSession = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length > 100) return null;
  const tokenHash = hashToken(token);
  const s = await prisma.session.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!s || !safeEqual(s.tokenHash, tokenHash) || s.expiresAt < new Date()) return null;
  return s;
});

export type Membership = { orgId: string; orgName: string; role: Role };

export interface Ctx {
  user: { id: string; email: string; name: string; totpEnabled: boolean };
  session: { id: string; csrfToken: string; lastAuthAt: Date };
  org: { id: string; name: string };
  role: Role;
  memberships: Membership[];
}

/** The signed-in user and their active org, or null. */
export const currentCtx = cache(async (): Promise<Ctx | "no-org" | null> => {
  const s = await currentSession();
  if (!s) return null;
  const ms = (await membershipsForUser(s.userId)).map((m) => ({ orgId: m.orgId, orgName: m.org.name, role: m.role as Role }));
  if (!ms.length) return "no-org";
  const active = ms.find((m) => m.orgId === s.activeOrgId) ?? ms[0]!;
  return {
    user: { id: s.user.id, email: s.user.email, name: s.user.name, totpEnabled: s.user.totpEnabled },
    session: { id: s.id, csrfToken: s.csrfToken, lastAuthAt: s.lastAuthAt },
    org: { id: active.orgId, name: active.orgName },
    role: active.role,
    memberships: ms,
  };
});

/** For pages: signed in with an org, or redirect. */
export async function requireCtx(next?: string): Promise<Ctx> {
  const c = await currentCtx();
  if (c === null) redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  if (c === "no-org") redirect("/onboarding");
  return c;
}

export function isFresh(lastAuthAt: Date) {
  return Date.now() - lastAuthAt.getTime() < FRESH_AUTH_MS;
}
