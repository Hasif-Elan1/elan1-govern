// Assurance levels — L1 Guarded → L2 Attested → L3 Proven → Sovereign. Each level includes everything below it.
// The part of the console's lib/levels.ts the verifier reads.
import type { LevelId } from "./types";

export const LEVELS: LevelId[] = ["l1", "l2", "l3", "sovereign"];

export const LEVEL_INFO: Record<LevelId, { short: string; tag: string; name: string; label: string; question: string }> = {
  l1: { short: "L1", tag: "L1", name: "Guarded", label: "Guarded · L1", question: "Can I let this run?" },
  l2: { short: "L2", tag: "L2", name: "Attested", label: "Attested · L2", question: "Can I hand this over?" },
  l3: { short: "L3", tag: "L3", name: "Proven", label: "Proven · L3", question: "Does this survive the vendor?" },
  sovereign: { short: "Sovereign", tag: "SOV", name: "Sovereign", label: "Sovereign · on premises", question: "Can we run it ourselves?" },
};

/** 0 = L1, 1 = L2, 2 = L3, 3 = Sovereign. An unknown level ranks as L1. */
export function levelRank(level: LevelId | undefined): number {
  const i = LEVELS.indexOf(level ?? "l1");
  return i < 0 ? 0 : i;
}

/** true when `level` is at least `atLeastLevel`. */
export function atLeast(level: LevelId | undefined, atLeastLevel: LevelId): boolean {
  return levelRank(level) >= levelRank(atLeastLevel);
}
