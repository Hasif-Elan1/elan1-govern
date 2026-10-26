import { EVIDENCE_LABELS, frameworkById, frameworkCoverage, LEGAL_REVIEW_NOTE } from "@gate/core/frameworks";
import { enabledFrameworks, evidenceCounts } from "@gate/db";
import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, PageHeader } from "@/components/ui/layout";
import { Pill } from "@/components/ui/status";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { FrameworkSwitch, ReportButton } from "../client";
import { CoverageBar } from "../coverage-bar";

type Props = { params: Promise<{ framework: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const f = frameworkById((await params).framework);
  return { title: f ? f.shortName : "Compliance" };
}

export default async function FrameworkPage({ params }: Props) {
  const ctx = await requireCtx();
  const framework = frameworkById((await params).framework);
  if (!framework) notFound();
  const [enabled, counts] = await Promise.all([enabledFrameworks(ctx.org.id), evidenceCounts(ctx.org.id)]);
  const on = enabled.some((f) => f.frameworkId === framework.id);
  const c = frameworkCoverage(framework.id, counts);
  const gaps = c.requirements.filter((r) => r.gap).length;
  const waiting = c.requirements.filter((r) => !r.gap && !r.covered).length;

  return (
    <>
      <PageHeader
        back={{ href: "/compliance", label: "Compliance" }}
        title={framework.shortName}
        description={framework.description}
        actions={
          <>
            {can(ctx.role, "evidence:export") ? <ReportButton framework={framework.id} /> : null}
            {can(ctx.role, "compliance:manage") ? <FrameworkSwitch id={framework.id} label={framework.shortName} enabled={on} /> : null}
          </>
        }
      />

      <div className="mb-8 grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <Card className="p-5">
          <p className="text-sm text-ink-3">Coverage</p>
          <CoverageBar className="mt-2" percent={c.percent} />
          <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-ink-3">Backed by evidence</dt>
              <dd className="mt-0.5 text-xl font-semibold text-ok tabular-nums">{c.covered}</dd>
            </div>
            <div>
              <dt className="text-ink-3">No evidence yet</dt>
              <dd className="mt-0.5 text-xl font-semibold text-wait tabular-nums">{waiting}</dd>
            </div>
            <div>
              <dt className="text-ink-3">No control</dt>
              <dd className="mt-0.5 text-xl font-semibold text-no tabular-nums">{gaps}</dd>
            </div>
          </dl>
        </Card>
        <Card className="p-5 text-sm">
          <p className="text-ink-3">About this framework</p>
          <p className="mt-1 font-medium">{framework.name}</p>
          <p className="mt-1 text-ink-2">{framework.jurisdiction}</p>
          <a href={framework.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 font-medium text-accent hover:underline">
            Read the official text <ExternalLink className="size-3.5" />
          </a>
          <div className="mt-3 flex flex-wrap gap-2">
            <Pill tone="wait">{LEGAL_REVIEW_NOTE}</Pill>
            {on ? <Pill tone="ok">On for your organisation</Pill> : <Pill>Not turned on</Pill>}
          </div>
        </Card>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="hidden border-b border-line bg-sunken/60 text-left text-[13px] text-ink-3 md:table-header-group">
            <tr>
              <th className="px-4 py-2.5 font-medium whitespace-nowrap">Reference</th>
              <th className="px-4 py-2.5 font-medium">Requirement</th>
              <th className="px-4 py-2.5 font-medium">Controls and live evidence</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line align-top">
            {c.requirements.map((r) => (
              <tr key={r.requirement.id} className="grid gap-2 px-4 py-3.5 md:table-row md:p-0">
                <td className="font-medium whitespace-nowrap md:px-4 md:py-3.5">{r.requirement.ref}</td>
                <td className="md:max-w-[300px] md:px-4 md:py-3.5">
                  <p className="font-medium">{r.requirement.title}</p>
                  <p className="mt-0.5 text-[13px] text-ink-3">{r.requirement.summary}</p>
                </td>
                <td className="md:px-4 md:py-3.5">
                  {r.gap ? (
                    <p className="text-no">No control covers this yet.</p>
                  ) : (
                    <ul className="grid gap-1.5">
                      {r.controls.map((x) => (
                        <li key={x.control.id}>
                          <span className="font-medium">{x.control.title}</span>
                          <span className="block text-[13px] text-ink-3">
                            {x.control.id} · <span className={x.evidence ? "text-ink-2" : "text-wait"}>{x.evidence} {EVIDENCE_LABELS[x.control.evidence]}</span>
                            {x.note ? ` · ${x.note}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="md:px-4 md:py-3.5">{r.gap ? <Pill tone="no">Gap</Pill> : r.covered ? <Pill tone="ok">Backed by evidence</Pill> : <Pill tone="wait">No evidence yet</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 max-w-[72ch] text-[13px] text-ink-3">
        A gap is not a failure: some requirements are about things Elan1 Govern does not do, such as staff training or technical documentation. Cover them with your own process and keep the proof alongside the framework report.
      </p>
    </>
  );
}
