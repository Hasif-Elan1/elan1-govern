import { forOrg } from "@gate/db";
import { Shell } from "@/components/shell";
import { requireCtx } from "@/server/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  const waiting = await forOrg(ctx.org.id).approval.count({ where: { status: "pending", expiresAt: { gt: new Date() } } });
  return (
    <Shell
      user={{ name: ctx.user.name, email: ctx.user.email }}
      org={ctx.org}
      role={ctx.role}
      memberships={ctx.memberships}
      waiting={waiting}
    >
      {children}
    </Shell>
  );
}
