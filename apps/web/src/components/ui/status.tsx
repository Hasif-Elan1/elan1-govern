import { Ban, Check, Clock, Minus } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export type Tone = "ok" | "wait" | "no" | "neutral" | "accent";

const TONES: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok border-ok-line",
  wait: "bg-wait-soft text-wait border-wait-line",
  no: "bg-no-soft text-no border-no-line",
  neutral: "bg-sunken text-ink-2 border-line",
  accent: "bg-accent-soft text-accent border-accent-line",
};

export function Pill({ tone = "neutral", className, children, icon }: { tone?: Tone; className?: string; children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <span className={cn("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12.5px] font-medium whitespace-nowrap [&_svg]:size-3.5", TONES[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

export type DecisionKind = "allow" | "ask" | "refuse" | "approved" | "rejected" | "expired" | "pending" | "admin" | "outcome" | "error";

const DECISION: Record<DecisionKind, { tone: Tone; label: string; icon: React.ReactNode }> = {
  allow: { tone: "ok", label: "Allowed", icon: <Check /> },
  approved: { tone: "ok", label: "Approved", icon: <Check /> },
  ask: { tone: "wait", label: "Waiting", icon: <Clock /> },
  pending: { tone: "wait", label: "Waiting", icon: <Clock /> },
  refuse: { tone: "no", label: "Refused", icon: <Ban /> },
  rejected: { tone: "no", label: "Rejected", icon: <Ban /> },
  expired: { tone: "no", label: "Expired", icon: <Ban /> },
  error: { tone: "no", label: "Failed", icon: <Ban /> },
  admin: { tone: "neutral", label: "Setup", icon: <Minus /> },
  outcome: { tone: "neutral", label: "Reported", icon: <Check /> },
};

export function DecisionPill({ kind, className }: { kind: DecisionKind; className?: string }) {
  const d = DECISION[kind];
  return (
    <Pill tone={d.tone} icon={d.icon} className={className}>
      {d.label}
    </Pill>
  );
}

export function decisionMeta(kind: DecisionKind) {
  return DECISION[kind];
}

/** The rubber-stamp mark used on receipts and on a decided approval. */
export function Stamp({ kind, animate, className }: { kind: DecisionKind; animate?: boolean; className?: string }) {
  const d = DECISION[kind];
  const color = { ok: "text-ok", wait: "text-wait", no: "text-no", neutral: "text-ink-3", accent: "text-accent" }[d.tone];
  return (
    <span className={cn("stamp text-sm [&_svg]:size-4", color, animate && "stamp-in", className)}>
      {d.icon}
      {d.label}
    </span>
  );
}

export const RISK_TONE: Record<string, Tone> = { low: "ok", medium: "wait", high: "no" };

export function RiskPill({ tier }: { tier: string }) {
  return <Pill tone={RISK_TONE[tier] ?? "neutral"}>{tier[0]?.toUpperCase() + tier.slice(1)} risk</Pill>;
}
