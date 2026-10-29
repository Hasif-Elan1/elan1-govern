import { prisma } from "@gate/db";
import { CONSOLE_DEMO_ACCOUNTS, CONSOLE_ORGS, type ConsoleLevel } from "@gate/db/console-demo";
import { HttpError, route } from "@/server/api";
import { totpNow } from "@/server/auth";

const LEVELS: ConsoleLevel[] = ["l1", "l2", "l3", "sovereign"];

/**
 * Development only: the console's "Demo accounts" panel and demo authenticator. Lists the seeded demo
 * accounts by level and organisation, with the shared demo password and, for two-step accounts, the
 * current 6-digit code. With APP_ENV=production this route does not exist (404).
 */
export const GET = route({ auth: "public" }, async () => {
  if (process.env.APP_ENV === "production") throw new HttpError(404, "Not found.");
  const users = await prisma.user.findMany({
    where: { id: { in: CONSOLE_DEMO_ACCOUNTS.map((a) => a.userId) } },
    select: { id: true, name: true, email: true, title: true, totpEnabled: true, totpSecret: true, memberships: { select: { orgId: true, role: true, status: true } } },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  const step = Math.floor(Date.now() / 30_000);
  const codeValidFor = 30 - Math.floor((Date.now() / 1000) % 30);

  const groups = LEVELS.flatMap((level) =>
    CONSOLE_ORGS.filter((o) => o.level === level).map((o) => ({
      level,
      orgId: o.id,
      orgName: o.name,
      accounts: CONSOLE_DEMO_ACCOUNTS.filter((a) => a.orgId === o.id).flatMap((a) => {
        const u = byId.get(a.userId);
        const m = u?.memberships.find((x) => x.orgId === o.id);
        if (!u || !m) return []; // not seeded (yet) on this install
        const twoStep = u.totpEnabled && !!u.totpSecret;
        return [{ userId: u.id, name: u.name, email: u.email, title: u.title, role: m.role, status: m.status, journey: a.journey, twoStep, code: twoStep ? totpNow(u.totpSecret!) : null }];
      }),
    })),
  );
  return { password: process.env.DEMO_CONSOLE_PASSWORD || null, step, codeValidFor, groups };
});
