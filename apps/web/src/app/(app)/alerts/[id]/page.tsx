import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertStatusPill, SeverityPill } from "@/components/alert-bits";
import { Card, KeyValue, PageHeader, Section } from "@/components/ui/layout";
import { fmtDateTime } from "@/lib/utils";
import { alertById } from "@/server/alerts";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { AlertActions } from "../client";

export const metadata: Metadata = { title: "Alert" };

export default async function AlertPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx();
  const a = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? await alertById(ctx.org.id, id) : null;
  if (!a) notFound();
  const canAct = can(ctx.role, "alerts:acknowledge");
  const history: [string, React.ReactNode][] = [["Raised", `${fmtDateTime(a.createdAt)} by Elan1 Govern${a.receiptSeq ? `, receipt ${a.receiptSeq}` : ""}`]];
  if (a.occurrences > 1) history.push(["Last seen", `${fmtDateTime(a.lastSeenAt)} (${a.occurrences} times)`]);
  if (a.autoPaused) history.push(["Automatic pause", "This alert paused the agent, as its settings ask."]);
  if (a.acknowledgedAt) history.push(["Acknowledged", `${fmtDateTime(a.acknowledgedAt)} by ${a.acknowledgedBy}`]);
  if (a.resolvedAt) history.push(["Resolved", `${fmtDateTime(a.resolvedAt)} by ${a.resolvedBy}`]);

  return (
    <>
      <PageHeader
        back={{ href: "/alerts", label: "Alerts" }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {a.title}
            <SeverityPill severity={a.severity} />
            <AlertStatusPill status={a.status} />
          </span>
        }
        description={
          <>
            {a.detectorLabel} for{" "}
            <Link href={`/agents/${a.agentSlug}`} className="text-accent hover:underline">
              {a.agentSlug}
            </Link>
          </>
        }
        actions={canAct ? <AlertActions id={a.id} status={a.status} /> : null}
      />
      <div className="grid gap-8 lg:grid-cols-[1.3fr_1fr]">
        <div className="grid content-start gap-8">
          <Section title="What happened">
            <Card className="p-5">
              <p className="text-[15px] leading-relaxed">{a.explanation}</p>
            </Card>
          </Section>
          <Section title="The numbers">
            <Card className="p-5">
              <KeyValue items={Object.entries(a.numbers).map(([k, v]) => [k[0]!.toUpperCase() + k.slice(1), typeof v === "number" ? v.toLocaleString("en-IN") : v])} />
            </Card>
          </Section>
        </div>
        <div className="grid content-start gap-8">
          <Section title="Receipts" actions={<Link href={`/activity?agent=${a.agentSlug}`} className="text-sm font-medium text-accent hover:underline">All activity</Link>}>
            {a.seqs.length ? (
              <ul className="flex flex-wrap gap-2">
                {a.seqs.slice(-20).map((s) => (
                  <li key={s}>
                    <Link href={`/activity?r=${s}&agent=${a.agentSlug}`} className="inline-flex h-7 items-center rounded-md border border-line bg-surface px-2.5 font-mono text-[13px] hover:border-line-2">
                      #{s}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-3">No single receipt; see the agent&apos;s activity.</p>
            )}
          </Section>
          <Section title="History">
            <Card className="p-5">
              <KeyValue items={history} />
            </Card>
          </Section>
          {!canAct ? <p className="text-sm text-ink-3">Owners, admins and approvers can acknowledge and resolve alerts.</p> : null}
        </div>
      </div>
    </>
  );
}
