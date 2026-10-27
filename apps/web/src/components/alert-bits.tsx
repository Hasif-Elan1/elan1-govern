import { Pill, type Tone } from "@/components/ui/status";

export type Severity = "low" | "medium" | "high";
export type AlertStatus = "open" | "acknowledged" | "resolved";

const SEVERITY: Record<Severity, { tone: Tone; label: string }> = {
  high: { tone: "no", label: "High" },
  medium: { tone: "wait", label: "Medium" },
  low: { tone: "neutral", label: "Low" },
};

const STATUS: Record<AlertStatus, { tone: Tone; label: string }> = {
  open: { tone: "accent", label: "Open" },
  acknowledged: { tone: "neutral", label: "Acknowledged" },
  resolved: { tone: "ok", label: "Resolved" },
};

/** Soft pill with text, never colour alone: high red, medium amber, low grey. */
export function SeverityPill({ severity }: { severity: Severity }) {
  const s = SEVERITY[severity] ?? SEVERITY.low;
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

export function AlertStatusPill({ status }: { status: AlertStatus }) {
  const s = STATUS[status] ?? STATUS.open;
  return <Pill tone={s.tone}>{s.label}</Pill>;
}
