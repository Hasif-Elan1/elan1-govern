/**
 * Compatibility layer. Assessments used to be drafted in this browser; they now live in the organisation's
 * shared record (see backend.ts), so every person sees the same draft, submission and sign-off.
 * These exports keep older call sites working: there are no browser-only assessments any more, a system's
 * tier is the one stored on it, and the server list is the whole list. Drafts saved by the earlier build are
 * imported into the shared record the first time the organisation's assessments are read.
 */
import type { AiSystem, Assessment } from '@/types';

const EMPTY: Assessment[] = [];

/** No browser-only assessments remain. */
export function useLocalAssessments(_orgId: string): Assessment[] {
  return EMPTY;
}

export function isLocalOnly(_id: string) {
  return false;
}

/** The server list is the whole list. */
export function mergeAssessments<T extends Assessment>(server: T[], _local: Assessment[], _attach: (a: Assessment) => T): T[] {
  return server;
}

/** The tier on the system is the one an approved assessment set; nothing is applied in the browser. */
export function effectiveSystem<S extends AiSystem>(s: S, _local: Assessment[], _server: Assessment[] = []): S & { tierFrom?: string } {
  return s;
}
