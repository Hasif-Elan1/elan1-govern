// The AI inventory's vocabulary: every AI system a company uses, not only Elan1 Govern agents.
// Values are stored as plain strings; these lists are the only accepted values.

const labels = <T extends string>(pairs: readonly (readonly [T, string])[]) => pairs;

export const SYSTEM_KINDS = labels([
  ["agent", "Agent"],
  ["model", "Model"],
  ["vendor_tool", "Vendor tool"],
  ["internal_app", "Internal app"],
] as const);

export const LIFECYCLES = labels([
  ["proposed", "Proposed"],
  ["in_review", "In review"],
  ["approved", "Approved"],
  ["live", "Live"],
  ["retired", "Retired"],
] as const);

export const SYSTEM_TIERS = labels([
  ["unassessed", "Not assessed"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
] as const);

export const DATA_CATEGORIES = labels([
  ["personal", "Personal"],
  ["financial", "Financial"],
  ["health", "Health"],
  ["biometric", "Biometric"],
  ["children", "Children's"],
  ["none", "No personal data"],
] as const);

export const AFFECTED_PEOPLE = labels([
  ["employees", "Employees"],
  ["customers", "Customers"],
  ["public", "The public"],
  ["patients", "Patients"],
] as const);

export const DECISION_IMPACTS = labels([
  ["none", "No decisions"],
  ["supports_humans", "Supports people who decide"],
  ["makes_decisions", "Makes decisions"],
] as const);

type Values<T extends readonly (readonly [string, string])[]> = T[number][0];
export type SystemKind = Values<typeof SYSTEM_KINDS>;
export type Lifecycle = Values<typeof LIFECYCLES>;
export type SystemTier = Values<typeof SYSTEM_TIERS>;
export type DataCategory = Values<typeof DATA_CATEGORIES>;
export type AffectedPeople = Values<typeof AFFECTED_PEOPLE>;
export type DecisionImpact = Values<typeof DECISION_IMPACTS>;

/** Values only, for zod enums: `z.enum(values(SYSTEM_KINDS))`. */
export function values<T extends string>(pairs: readonly (readonly [T, string])[]): [T, ...T[]] {
  return pairs.map(([v]) => v) as [T, ...T[]];
}

/** The label for a stored value, or the value itself if it is unknown. */
export function labelOf(pairs: readonly (readonly [string, string])[], value: string): string {
  return pairs.find(([v]) => v === value)?.[1] ?? value;
}
