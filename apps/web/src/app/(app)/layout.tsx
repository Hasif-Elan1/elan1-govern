import { forOrg } from "@gate/db";
import { Shell } from "@/components/shell";
import { openAlertCounts, openIncident } from "@/server/alerts";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  const [waiting, alerts, incident] = await Promise.all([
    forOrg(ctx.org.id).approval.count({ where: { status: "pending", expiresAt: { gt: new Date() } } }),
    openAlertCounts(ctx.org.id),
    openIncident(ctx.org.id),
  ]);
  return (
    <Shell
      user={{ name: ctx.user.name, email: ctx.user.email }}
      org={ctx.org}
      role={ctx.role}
      memberships={ctx.memberships}
      waiting={waiting}
      alerts={alerts.total}
      incident={
        incident
          ? { startedBy: incident.startedBy, startedAt: incident.startedAt.toISOString(), paused: incident.pausedAgentIds.length, canResume: can(ctx.role, "emergency:stop"), totpEnabled: ctx.user.totpEnabled }
          : null
      }
    >
      {children}
    </Shell>
  );
}
