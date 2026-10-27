import { forOrg } from "@gate/db";
import { BellRing } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AlertStatusPill, SeverityPill } from "@/components/alert-bits";
import { EmergencyStopButton } from "@/components/emergency";
import { Card, EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { fmtDateTime, relative } from "@/lib/utils";
import { alertFilter, alertList, openIncident, orgBehaviourSettings } from "@/server/alerts";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { AlertFilters, AlertSettingsButton, IncidentReportButton } from "./client";

export const metadata: Metadata = { title: "Alerts" };

export default async function Alerts({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx();
  const filter = alertFilter(await searchParams);
  const db = forOrg(ctx.org.id);
  const [alerts, agents, incident, incidents, { settings }, running] = await Promise.all([
    alertList(ctx.org.id, filter),
    db.agent.findMany({ select: { slug: true, name: true }, orderBy: { name: "asc" } }),
    openIncident(ctx.org.id),
    db.incident.findMany({ orderBy: { startedAt: "desc" }, take: 10 }),
    orgBehaviourSettings(ctx.org.id),
    db.agent.count({ where: { status: "active" } }),
  ]);
  const names = new Map(agents.map((a) => [a.slug, a.name]));
  const filtered = filter.show !== "open" || !!filter.severity || !!filter.agent;

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Elan1 Govern learns what is normal for each agent and tells you when it does something unusual: a burst of calls, a new vendor, an odd hour, a large amount."
        actions={
          <>
            {can(ctx.role, "alerts:configure") ? <AlertSettingsButton settings={settings} /> : null}
            {can(ctx.role, "emergency:stop") && !incident ? <EmergencyStopButton agents={running} totpEnabled={ctx.user.totpEnabled} /> : null}
          </>
        }
      />
      <AlertFilters filter={filter} agents={agents} />
      {alerts.length === 0 ? (
        <EmptyState
          icon={<BellRing />}
          title={filtered ? "No alerts match" : "No open alerts"}
          body={filtered ? "Try another filter." : `Each agent spends its first ${settings.learningDays} days learning what is normal for it. After that, anything unusual shows up here and, if it matters, in your email.`}
        />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {alerts.map((a) => (
            <li key={a.id}>
              <Link href={`/alerts/${a.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3.5 hover:bg-sunken/50">
                <SeverityPill severity={a.severity} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink">{a.title}</span>
                  <span className="block text-[13px] text-ink-3">
                    {names.get(a.agentSlug) ?? a.agentSlug} · {a.detectorLabel}
                    {a.occurrences > 1 ? ` · seen ${a.occurrences} times` : ""}
                    {a.autoPaused ? " · paused the agent" : ""}
                  </span>
                </span>
                <AlertStatusPill status={a.status} />
                <span className="w-24 text-right text-[13px] text-ink-3">{relative(a.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {incidents.length ? (
        <Section title="Emergency stops" description="Each stop paused every agent at once. The report lists what happened, who stopped and resumed, and the receipts to check." className="mt-10">
          <Card className="divide-y divide-line">
            {incidents.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {fmtDateTime(i.startedAt)}: {i.startedBy} paused {i.pausedAgentIds.length === 1 ? "1 agent" : `${i.pausedAgentIds.length} agents`}
                  </span>
                  <span className="block text-[13px] text-ink-3">{i.endedAt ? `Resumed by ${i.endedBy} ${relative(i.endedAt).toLowerCase()}` : "Still in place"}</span>
                </span>
                {can(ctx.role, "evidence:export") ? <IncidentReportButton id={i.id} /> : null}
              </div>
            ))}
          </Card>
        </Section>
      ) : null}
    </>
  );
}
