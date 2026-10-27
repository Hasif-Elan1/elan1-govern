// "Test on past actions": the report the gate service sends back, and how to say it in words.

export type ReplayDecision = "allow" | "ask" | "refuse";
export type DecisionCounts = Record<ReplayDecision, number>;

export interface ReplayChange {
  seq: number;
  at: string;
  tool: string;
  /** Plain words from the receipt's minimal summary. */
  action: string;
  from: ReplayDecision;
  to: ReplayDecision;
  fromRule: string;
  rule: string;
  quotaId?: string;
  reason: string;
}

export interface ReplayReport {
  days: number;
  since: string;
  storeOn: boolean;
  limited: boolean;
  total: number;
  judged: number;
  notJudged: number;
  unchanged: number;
  changed: number;
  more: DecisionCounts;
  fewer: DecisionCounts;
  before: DecisionCounts;
  after: DecisionCounts;
  changes: ReplayChange[];
  truncated: boolean;
}

export const REPLAY_DAYS = [7, 30] as const;

/** [more, fewer] for each decision. */
export const CHANGE_PHRASES: Record<ReplayDecision, [string, string]> = {
  refuse: ["more would be refused", "fewer would be refused"],
  ask: ["more would ask a person", "fewer would ask a person"],
  allow: ["more would be allowed", "fewer would be allowed"],
};

const calls = (n: number) => `${n.toLocaleString("en-IN")} ${n === 1 ? "call" : "calls"}`;

function joinWords(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** "Of 412 calls, 12 more would be refused, 30 more would ask a person and 5 fewer would ask a person. 3 could not be judged." */
export function replaySummary(r: Pick<ReplayReport, "total" | "judged" | "notJudged" | "changed" | "more" | "fewer">): string {
  if (r.total === 0) return "No calls in this period.";
  const parts: string[] = [];
  for (const d of ["refuse", "ask", "allow"] as const) {
    if (r.more[d]) parts.push(`${r.more[d].toLocaleString("en-IN")} ${CHANGE_PHRASES[d][0]}`);
    if (r.fewer[d]) parts.push(`${r.fewer[d].toLocaleString("en-IN")} ${CHANGE_PHRASES[d][1]}`);
  }
  const head = r.judged === 0 ? `Of ${calls(r.total)}, none could be judged.` : parts.length ? `Of ${calls(r.total)}, ${joinWords(parts)}.` : `Of ${calls(r.total)}, none would change.`;
  return r.judged > 0 && r.notJudged > 0 ? `${head} ${r.notJudged.toLocaleString("en-IN")} could not be judged.` : head;
}

export const DECISION_WORDS: Record<ReplayDecision, string> = { allow: "Allowed", ask: "Ask a person", refuse: "Refused" };
