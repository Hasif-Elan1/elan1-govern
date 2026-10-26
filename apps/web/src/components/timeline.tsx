"use client";

import { TOOLS } from "@gate/core/browser";
import type { Receipt } from "@gate/core";
import { CircleCheck, CircleX, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { KeyValue } from "@/components/ui/layout";
import { DecisionPill, Stamp, type DecisionKind } from "@/components/ui/status";
import { api, ApiError } from "@/lib/client";
import { cn, dayLabel, fmtDateTime, fmtTime, shortHash } from "@/lib/utils";

export interface Item {
  seq: number;
  ts: string;
  kind: string;
  status: DecisionKind;
  title: string;
  agent?: string;
  tool?: string;
  ruleId?: string;
  reason?: string;
  hash: string;
  approvalId?: string;
  by?: string;
  selfApproval?: boolean;
  outcome?: { status: string; ref?: string; error?: string };
  actor?: string;
}

const DOT: Record<string, string> = {
  allow: "bg-ok",
  approved: "bg-ok",
  outcome: "bg-ink-3",
  ask: "bg-wait",
  pending: "bg-wait",
  refuse: "bg-no",
  rejected: "bg-no",
  expired: "bg-no",
  error: "bg-no",
  admin: "bg-line-2",
};

function subline(i: Item) {
  if (i.kind === "admin") return i.actor ? `by ${i.actor}` : "Setup";
  const parts = [i.agent, i.ruleId ? `rule ${i.ruleId}` : null];
  if (i.kind === "approval" && i.by) parts.push(`${i.status} by ${i.by}`);
  if (i.outcome?.ref) parts.push(i.outcome.ref);
  return parts.filter(Boolean).join(", ");
}

/** The chain: one continuous line, each receipt hanging off it in order. */
export function Timeline({ items, onOpen, compact }: { items: Item[]; onOpen: (seq: number) => void; compact?: boolean }) {
  const groups = useMemo(() => {
    const out: { day: string; items: Item[] }[] = [];
    for (const i of items) {
      const day = dayLabel(i.ts);
      const last = out.at(-1);
      if (last && last.day === day) last.items.push(i);
      else out.push({ day, items: [i] });
    }
    return out;
  }, [items]);

  return (
    <div className="grid gap-6">
      {groups.map((g) => (
        <section key={g.day}>
          {!compact ? <h3 className="mb-2 text-[13px] font-medium text-ink-3">{g.day}</h3> : null}
          <ol className="relative">
            <span aria-hidden className="absolute top-3 bottom-3 left-[7px] w-px bg-line-2" />
            {g.items.map((i) => (
              <li key={i.seq}>
                <button
                  type="button"
                  onClick={() => onOpen(i.seq)}
                  className="group relative flex w-full cursor-pointer items-start gap-3.5 rounded-md py-2 pr-2 text-left hover:bg-sunken/70"
                >
                  <span className={cn("relative z-10 mt-1.5 size-[15px] shrink-0 rounded-full border-[3px] border-paper", DOT[i.status] ?? "bg-line-2")} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className={cn("text-[14.5px]", i.kind === "admin" ? "text-ink-2" : "font-medium text-ink")}>{i.title}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[13px] text-ink-3">{subline(i)}</span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
                    {i.kind !== "admin" ? <DecisionPill kind={i.status} /> : null}
                    <span className="text-xs text-ink-3 tabular-nums">{fmtTime(i.ts)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

type Check = { hashOk: boolean; sigOk: boolean; prevOk: boolean; nextOk: boolean | null; ok: boolean };

/** A receipt, shown as a signed slip. */
export function ReceiptDialog({ seq, onClose }: { seq: number | null; onClose: () => void }) {
  const [data, setData] = useState<{ receipt: Receipt; view: Item; check: Check } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setData(null);
    setShown(false);
    setError(null);
    if (seq === null) return;
    api<{ receipt: Receipt; view: Item; check: Check }>(`/api/receipts/${seq}`, undefined, "GET")
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load the receipt."));
  }, [seq]);
  const r = data?.receipt;
  const v = data?.view;
  return (
    <Dialog open={seq !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Receipt ${seq ?? ""}`} description={r ? fmtDateTime(r.ts) : undefined}>
        {error ? <p className="text-sm text-no">{error}</p> : null}
        {!r || !v ? (
          !error ? <div className="h-48 animate-pulse rounded-md bg-sunken" /> : null
        ) : (
          <div className="slip px-5 pt-6 pb-5">
            <div className="flex items-start justify-between gap-3">
              <p className="text-[16px] leading-snug font-medium">{v.title}</p>
              {v.kind !== "admin" ? <Stamp kind={v.status} className="shrink-0" /> : null}
            </div>
            <KeyValue
              className="mt-5"
              items={[
                ...(r.agent ? ([["Agent", r.agent]] as [string, React.ReactNode][]) : []),
                ...(r.tool ? ([["Tool", TOOLS[r.tool as keyof typeof TOOLS]?.label ?? r.tool]] as [string, React.ReactNode][]) : []),
                ...(r.rule_id ? ([["Rule", <code key="r" className="font-mono text-[13px]">{r.rule_id}</code>]] as [string, React.ReactNode][]) : []),
                ...(r.reason ? ([["Why", r.reason]] as [string, React.ReactNode][]) : []),
                ...(r.approval?.by
                  ? ([["Decided by", <span key="b">{r.approval.by}{r.approval.self_approval ? <span className="ml-2 text-wait">set up this agent</span> : null}</span>]] as [string, React.ReactNode][])
                  : []),
                ...(r.outcome ? ([["Result", r.outcome.status === "ok" ? `Done${r.outcome.ref ? `, ${r.outcome.ref}` : ""}` : r.outcome.status === "not_run" ? "Not run" : `Failed: ${r.outcome.error ?? ""}`]] as [string, React.ReactNode][]) : []),
                ...(r.actor ? ([["By", r.actor]] as [string, React.ReactNode][]) : []),
                ...(r.ref_seq ? ([["Follows", `receipt ${r.ref_seq}`]] as [string, React.ReactNode][]) : []),
                ["Rulebook", r.rulebook ? `v${r.rulebook.version}` : "—"],
                ["Hash", <code key="h" className="font-mono text-[13px]" title={r.hash}>{shortHash(r.hash)}</code>],
              ]}
            />
            <div className="mt-5 border-t border-dashed border-line-2 pt-4">
              {shown && data ? (
                <ul className="grid gap-1.5 text-sm">
                  {(
                    [
                      [data.check.hashOk, "Contents match the hash"],
                      [data.check.sigOk, "Signed with this organisation's key"],
                      [data.check.prevOk, seq === 1 ? "First receipt in the chain" : `Linked to receipt ${(seq ?? 1) - 1}`],
                      ...(data.check.nextOk === null ? [] : ([[data.check.nextOk, `Receipt ${(seq ?? 0) + 1} links to it`]] as [boolean, string][])),
                    ] as [boolean, string][]
                  ).map(([ok, text]) => (
                    <li key={text} className={cn("flex items-center gap-2", ok ? "text-ok" : "text-no")}>
                      {ok ? <CircleCheck className="size-4" /> : <CircleX className="size-4" />}
                      {text}
                    </li>
                  ))}
                </ul>
              ) : (
                <Button onClick={() => setShown(true)} className="w-full sm:w-auto">
                  <ShieldCheck />
                  Verify this receipt
                </Button>
              )}
            </div>
          </div>
        )}
        {v?.approvalId ? (
          <Link href={`/approvals/${v.approvalId}`} className="mt-4 inline-block text-sm font-medium text-accent hover:underline">
            Open the approval
          </Link>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Polls for new receipts and prepends them. */
export function useLiveItems(initial: Item[], query = "") {
  const [items, setItems] = useState(initial);
  const latest = useRef(initial[0]?.seq ?? 0);
  useEffect(() => {
    setItems(initial);
    latest.current = initial[0]?.seq ?? 0;
  }, [initial]);
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.hidden) return;
      try {
        const r = await api<{ items: Item[] }>(`/api/activity?after=${latest.current}${query ? `&${query}` : ""}`, undefined, "GET");
        if (r.items.length) {
          latest.current = r.items[0]!.seq;
          setItems((xs) => [...r.items, ...xs].slice(0, 300));
        }
      } catch {
        // Keep showing what we have; the next tick retries.
      }
    }, 4000);
    return () => clearInterval(t);
  }, [query]);
  return items;
}


