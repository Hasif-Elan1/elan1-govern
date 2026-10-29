/**
 * Each pack's default parameters (declaration version 1). Pure, with no imports beyond types, so the guard's pack
 * check (mock/packChecks.ts) and the Configure screen (./config.ts) read the same values without an import cycle.
 */
import type { PackId } from '@/types';

export const PACK_DEFAULTS: Record<PackId, Record<string, number>> = {
  ledger1: { dualControlAbove: 200000, retentionYears: 8 },
  invoice1: { ratePerMinute: 60, cancelWindowHours: 24 },
  collect1: { windowFrom: 8, windowTo: 19, dailyCap: 3 },
};
