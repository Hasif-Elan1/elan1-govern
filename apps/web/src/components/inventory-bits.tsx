import { LIFECYCLES, labelOf, STATUS_LABELS, type AssessmentStatus } from "@gate/core/browser";
import { Pill, RISK_TONE, type Tone } from "@/components/ui/status";
import { cn, fmtDate } from "@/lib/utils";

/** Risk tier of an AI system, including "Not assessed". */
export function TierPill({ tier }: { tier: string | null | undefined }) {
  if (!tier || tier === "unassessed") return <Pill>Not assessed</Pill>;
  return <Pill tone={RISK_TONE[tier] ?? "neutral"}>{tier[0]!.toUpperCase() + tier.slice(1)} risk</Pill>;
}

const LIFECYCLE_TONE: Record<string, Tone> = { proposed: "neutral", in_review: "wait", approved: "accent", live: "ok", retired: "neutral" };

export function LifecyclePill({ lifecycle }: { lifecycle: string }) {
  return <Pill tone={LIFECYCLE_TONE[lifecycle] ?? "neutral"}>{labelOf(LIFECYCLES, lifecycle)}</Pill>;
}

const STATUS_TONE: Record<AssessmentStatus, Tone> = { draft: "neutral", submitted: "wait", approved: "ok", changes_requested: "no" };

export function AssessmentStatusPill({ status }: { status: string }) {
  return <Pill tone={STATUS_TONE[status as AssessmentStatus] ?? "neutral"}>{STATUS_LABELS[status as AssessmentStatus] ?? status}</Pill>;
}

/** The next review date; amber with "overdue" once it has passed. */
export function ReviewDue({ at, className }: { at: Date | string | null; className?: string }) {
  if (!at) return <span className={cn("text-ink-3", className)}>Not scheduled</span>;
  const overdue = new Date(at).getTime() < Date.now();
  return overdue ? <span className={cn("font-medium text-wait", className)}>Overdue since {fmtDate(at)}</span> : <span className={className}>{fmtDate(at)}</span>;
}

/** Every built-in template carries this until a lawyer has reviewed it. */
export function LegalReviewNote() {
  return <Pill tone="wait">Draft — needs legal review</Pill>;
}
