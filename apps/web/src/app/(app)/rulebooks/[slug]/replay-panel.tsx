"use client";

import { ArrowRight, Ban, Check, Clock, History } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/layout";
import { Pill, type Tone } from "@/components/ui/status";
import { api, ApiError } from "@/lib/client";
import { CHANGE_PHRASES, DECISION_WORDS, REPLAY_DAYS, replaySummary, type ReplayDecision, type ReplayReport } from "@/lib/replay";
import { cn, fmtDateTime } from "@/lib/utils";

const TONE: Record<ReplayDecision, Tone> = { allow: "ok", ask: "wait", refuse: "no" };
const ICON = { allow: <Check />, ask: <Clock />, refuse: <Ban /> };

export function ReplayDecisionPill({ d }: { d: ReplayDecision }) {
  return (
    <Pill tone={TONE[d]} icon={ICON[d]}>
      {DECISION_WORDS[d]}
    </Pill>
  );
}

/** The numbers only: used in the panel and on the publish confirmation. */
export function ReplayCounts({ report }: { report: ReplayReport }) {
  const rows: [string, number, Tone][] = [];
  for (const d of ["refuse", "ask", "allow"] as const) {
    if (report.more[d]) rows.push([CHANGE_PHRASES[d][0], report.more[d], TONE[d]]);
    if (report.fewer[d]) rows.push([CHANGE_PHRASES[d][1], report.fewer[d], TONE[d]]);
  }
  return (
    <div className="grid gap-3" data-testid="replay-counts">
      <dl className="grid grid-cols-3 gap-2 text-center">
        {(
          [
            ["Calls", report.total],
            ["Would change", report.changed],
            ["Could not be judged", report.notJudged],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="rounded-lg border border-line bg-surface px-2 py-2.5">
            <dt className="text-[12px] text-ink-3">{label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{n.toLocaleString("en-IN")}</dd>
          </div>
        ))}
      </dl>
      {rows.length ? (
        <ul className="flex flex-wrap gap-2 text-sm">
          {rows.map(([label, n, tone]) => (
            <li key={label}>
              <Pill tone={tone}>
                {n.toLocaleString("en-IN")} {label}
              </Pill>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ReplayPanel({
  slug,
  yaml,
  ready,
  canRun,
  result,
  onResult,
}: {
  slug: string;
  /** The draft as it stands, or null while it has errors. */
  yaml: string | null;
  ready: boolean;
  canRun: boolean;
  result: { yaml: string; report: ReplayReport } | null;
  onResult: (r: { yaml: string; report: ReplayReport }) => void;
}) {
  const [days, setDays] = useState<(typeof REPLAY_DAYS)[number]>(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canRun) return <p className="text-sm text-ink-3">Only owners and admins can test a rulebook on past actions.</p>;

  async function run() {
    if (!yaml) return;
    setBusy(true);
    setError(null);
    try {
      const report = await api<ReplayReport>(`/api/rulebooks/${slug}/replay`, { yaml, days });
      onResult({ yaml, report });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The test did not run.");
    } finally {
      setBusy(false);
    }
  }

  const report = result?.report;
  const stale = !!result && result.yaml !== yaml;

  return (
    <div className="grid gap-4">
      <p className="text-sm text-ink-2">See what these rules would have decided for this agent&apos;s real calls, next to what actually happened. Nothing runs and nothing is published.</p>
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex overflow-hidden rounded-md border border-line-2" role="radiogroup" aria-label="Period">
          {REPLAY_DAYS.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={days === d}
              data-on={days === d}
              onClick={() => setDays(d)}
              className="-ml-px cursor-pointer border-l border-line-2 px-3 py-1.5 text-sm font-medium text-ink-2 first:ml-0 first:border-l-0 data-[on=true]:bg-accent-soft data-[on=true]:text-accent"
            >
              Last {d} days
            </button>
          ))}
        </span>
        <Button variant="primary" disabled={!ready || !yaml || busy} onClick={() => void run()}>
          {busy ? "Testing…" : "Run test"}
        </Button>
      </div>
      {!ready ? <p className="text-[13px] text-ink-3">Fix the problems in the rules first.</p> : null}
      {error ? (
        <p role="alert" className="rounded-lg border border-no-line bg-no-soft px-3 py-2 text-sm text-no">
          {error}
        </p>
      ) : null}

      {report ? (
        <div className={cn("grid gap-4", stale && "opacity-60")} data-testid="replay-result">
          {stale ? <p className="text-[13px] text-ink-2">The rules changed since this test. Run it again to see the effect.</p> : null}
          {report.total === 0 ? (
            <EmptyState
              icon={<History />}
              title="No past actions yet"
              body={
                report.storeOn
                  ? `This agent made no calls in the last ${report.days} days. Calls it makes from now on are kept for 30 days, so you can test changes on them.`
                  : "Keeping past actions is off in Settings, so there is nothing to test on. An owner or admin can turn it on."
              }
            />
          ) : (
            <>
              <p className="text-[15px]" data-testid="replay-summary">
                {replaySummary(report)}
              </p>
              <ReplayCounts report={report} />
              {report.judged === 0 ? (
                <p className="text-[13px] text-ink-3">
                  {report.storeOn
                    ? "These calls happened before Elan1 Govern started keeping past actions, or were refused before any rule was checked."
                    : "Keeping past actions is off in Settings, so no call can be judged."}
                </p>
              ) : report.notJudged ? (
                <p className="text-[13px] text-ink-3">Calls are judged only when Elan1 Govern kept their details: from the last 30 days, while keeping past actions was on, and past the checks that come before the rules (a paused agent, an unknown tool, invalid details).</p>
              ) : null}
              {report.limited ? <p className="text-[13px] text-ink-3">Only the most recent 50,000 calls were tested.</p> : null}
              {report.changes.length ? (
                <section>
                  <h3 className="mb-2 text-sm font-semibold">
                    Calls that would change{report.truncated ? ` (first ${report.changes.length} of ${report.changed.toLocaleString("en-IN")})` : ""}
                  </h3>
                  <ul className="divide-y divide-line rounded-lg border border-line" data-testid="replay-changes">
                    {report.changes.map((c) => (
                      <li key={c.seq} className="grid gap-1.5 px-3 py-2.5 text-sm">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-medium">{c.action}</span>
                          <span className="shrink-0 text-[12px] text-ink-3">{fmtDateTime(c.at)}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="sr-only">Was</span>
                          <ReplayDecisionPill d={c.from} />
                          <ArrowRight className="size-3.5 text-ink-3" aria-label="now" />
                          <ReplayDecisionPill d={c.to} />
                          <span className="text-[13px] text-ink-3">
                            {c.rule === "default" ? (
                              "no rule matches"
                            ) : (
                              <>
                                by <code className="font-mono text-[12.5px] text-ink-2">{c.quotaId ?? c.rule}</code>
                              </>
                            )}
                          </span>
                        </div>
                        <p className="text-[13px] text-ink-3">{c.reason}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
