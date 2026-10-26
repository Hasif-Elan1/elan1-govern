import { FRAMEWORKS, frameworkCoverage, LEGAL_REVIEW_NOTE, packFor, recommendedFrameworks, REGION_LABELS, type Region } from "@gate/core/frameworks";
import { enabledFrameworks, evidenceCounts, forOrg } from "@gate/db";
import { ChevronRight, Scale } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { Pill } from "@/components/ui/status";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { AddFramework, type FrameworkOption } from "./client";
import { CoverageBar } from "./coverage-bar";

export const metadata: Metadata = { title: "Compliance" };

export default async function Compliance() {
  const ctx = await requireCtx();
  const [org, enabled, counts] = await Promise.all([forOrg(ctx.org.id).org.findFirstOrThrow(), enabledFrameworks(ctx.org.id), evidenceCounts(ctx.org.id)]);
  const manage = can(ctx.role, "compliance:manage");
  const pack = packFor(org.industry);
  const regions = org.regions as Region[];
  const recommended = new Set(recommendedFrameworks(pack, regions.length ? regions : ["other"]));
  const on = new Set(enabled.map((f) => f.frameworkId));
  const cards = enabled.map((f) => frameworkCoverage(f.frameworkId, counts));
  const options: FrameworkOption[] = FRAMEWORKS.filter((f) => !on.has(f.id)).map((f) => ({ id: f.id, shortName: f.shortName, jurisdiction: f.jurisdiction, description: f.description, recommended: recommended.has(f.id) }));

  return (
    <>
      <PageHeader
        title="Compliance"
        description="The frameworks that apply to you, which of their requirements Elan1 Govern's controls cover, and how much live evidence backs each one."
        actions={manage && cards.length ? <AddFramework options={options} /> : null}
      />

      <Card className="mb-8 flex flex-wrap items-start gap-x-8 gap-y-3 p-5">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink-3">Industry pack</p>
          <p className="mt-0.5 font-medium">{org.industry ? pack.name : `${pack.name} (set up before industry packs)`}</p>
          <p className="mt-1 max-w-[70ch] text-sm text-ink-2">{pack.description}</p>
        </div>
        <div className="min-w-[180px]">
          <p className="text-sm text-ink-3">Where you operate</p>
          <p className="mt-0.5 font-medium">{regions.length ? regions.map((r) => REGION_LABELS[r] ?? r).join(", ") : "Not set"}</p>
          {manage ? (
            <Link href="/onboarding?step=industry&then=compliance" className="mt-1 inline-block text-sm font-medium text-accent hover:underline">
              Change
            </Link>
          ) : null}
        </div>
      </Card>

      {cards.length === 0 ? (
        <EmptyState
          icon={<Scale />}
          title="No frameworks yet"
          body="Turn on the laws and standards that apply to you. Elan1 Govern shows which requirements its controls cover and where the gaps are."
          action={manage ? <AddFramework options={options} primary /> : undefined}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {cards.map((c) => {
            const gaps = c.requirements.filter((r) => r.gap).length;
            return (
              <Link key={c.framework.id} href={`/compliance/${c.framework.id}`} className="group rounded-lg border border-line bg-surface p-5 hover:border-line-2 hover:bg-sunken/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-semibold">{c.framework.shortName}</h2>
                    <p className="mt-0.5 text-[13px] text-ink-3">{c.framework.jurisdiction}</p>
                  </div>
                  <ChevronRight className="mt-0.5 size-4 shrink-0 text-ink-3 group-hover:text-ink" />
                </div>
                <CoverageBar className="mt-4" percent={c.percent} />
                <p className="mt-2 text-sm text-ink-2">
                  <span className="font-semibold text-ink tabular-nums">{c.covered}</span> of {c.total} requirements have a control with live evidence
                </p>
                <p className="mt-1 text-[13px] text-ink-3">{gaps ? `${gaps} ${gaps === 1 ? "requirement has" : "requirements have"} no control yet` : "Every requirement has at least one control"}</p>
              </Link>
            );
          })}
        </div>
      )}

      <Section title="What your industry usually worries about" className="mt-12" description={`From the ${pack.name.toLowerCase()} pack. The add-agent wizard starts from this pack's rules.`}>
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {pack.risks.map((r) => (
            <li key={r} className="flex gap-3">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-wait" />
              {r}
            </li>
          ))}
        </ul>
      </Section>

      <p className="mt-10 flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
        <Pill tone="wait">{LEGAL_REVIEW_NOTE}</Pill>
        References and summaries are starting points written by the Elan1 Govern team, not legal advice and not a claim of compliance.
      </p>
    </>
  );
}
