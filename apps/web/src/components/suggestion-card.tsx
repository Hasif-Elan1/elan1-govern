"use client";

import { formatINR } from "@gate/core/browser";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { YamlDiff, type YamlDiffLine } from "@/components/yaml-diff";
import { api, ApiError } from "@/lib/client";

export interface SuggestionCardData {
  id: string;
  agentName: string;
  title: string;
  proposal: string;
  confidence: "high" | "medium";
  explanation: string;
  evidence: { approved: number; rejected: number; expired: number; covered: number; spanDays: number; field?: string; cap?: number; displayNames?: string[]; counterparties?: string[] };
  savedPerMonth: number;
  medianWait: string | null;
  diff: YamlDiffLine[];
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12.5px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/** One rule suggestion: the proposal, the evidence, the YAML change, and the two choices. */
export function SuggestionCard({ s, canManage }: { s: SuggestionCardData; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<"open" | "dismiss" | null>(null);
  const run = async (what: "open" | "dismiss") => {
    setBusy(what);
    try {
      if (what === "open") {
        const r = await api<{ href: string }>(`/api/suggestions/${s.id}/apply`, {});
        router.push(r.href);
      } else {
        await api(`/api/suggestions/${s.id}/dismiss`, {});
        toast.ok("Dismissed. It comes back only if the evidence behind it at least doubles.");
        router.refresh();
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "That did not work. Try again.");
    } finally {
      setBusy(null);
    }
  };
  const e = s.evidence;
  return (
    <li className="rounded-lg border border-line bg-surface p-5" data-testid="suggestion">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink-3">{s.agentName}</span>
        <Pill tone={s.confidence === "high" ? "ok" : "neutral"}>{s.confidence === "high" ? "Strong evidence" : "Some evidence"}</Pill>
        <Pill tone="accent">Saves about {s.savedPerMonth} approvals a month</Pill>
      </div>
      <h3 className="mt-2 text-[16px] font-semibold">{s.title}</h3>
      <p className="mt-1.5 text-[14.5px] text-ink-2">{s.proposal}</p>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Fact label="Approved" value={e.approved} />
        <Fact label="Rejected" value={e.rejected} />
        <Fact label="Nobody answered" value={e.expired} />
        <Fact label="Usual wait" value={s.medianWait ?? "Not known"} />
      </dl>
      {e.displayNames?.length ? <p className="mt-3 text-[13px] text-ink-3">Vendors: {e.displayNames.join(", ")}</p> : null}
      {e.field === "amount_inr" && e.cap !== undefined ? <p className="mt-1 text-[13px] text-ink-3">New limit: {formatINR(e.cap)}, no higher than the largest amount a person approved.</p> : null}
      <p className="mt-3 text-[13px] text-ink-2">{s.explanation}</p>
      <details className="mt-3">
        <summary className="cursor-pointer text-[13px] font-medium text-accent">See the change to the rulebook</summary>
        <YamlDiff lines={s.diff} className="mt-2" testId="suggestion-diff" />
      </details>
      {canManage ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy !== null} onClick={() => run("open")}>
            {busy === "open" ? "Opening…" : "Open as draft"}
          </Button>
          <Button disabled={busy !== null} onClick={() => run("dismiss")}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Runs the same check the nightly job does, now. */
export function LookForSuggestions() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ open: number }>("/api/suggestions", {});
          toast.ok(r.open ? `${r.open === 1 ? "1 suggestion" : `${r.open} suggestions`} to review.` : "No suggestions right now. Elan1 Govern checks again every night.");
          router.refresh();
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : "Could not look for suggestions.");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Looking…" : "Look for suggestions"}
    </Button>
  );
}
