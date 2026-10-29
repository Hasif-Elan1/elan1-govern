/**
 * State for the L3 extras (counterparties, disclosure, autonomy) kept with the organisation's platform state under
 * `platform.l3x`. Every field is optional: state saved in this browser before these features existed loads without
 * it, and the seeds below are added once on first read (`seeded` flags), for seeded and saved organisations alike.
 */
import type { PlatformState } from './platform';
import type { OrgDB } from './db';
import { memberRole } from './db';
import { atLeast, levelOfOrg, LEVEL_INFO } from '@/lib/levels';
import type { DisclosureBundle, DisclosureProfile } from '@/lib/disclosure';

/** A bundle as stored: the receipt numbers it covers, not the digests (they are rebuilt from a per-bundle secret). */
export type StoredBundle = Omit<DisclosureBundle, 'items'> & { seqs: number[] };

export interface L3Ext {
  profiles?: DisclosureProfile[];
  bundles?: StoredBundle[];
  /** per-bundle salt secrets (bundle id → hex); never returned */
  bundleSecrets?: Record<string, string>;
  /** autonomy_breach incident id → the graduated grants it revoked (empty when there was nothing to revoke) */
  autoRevoked?: Record<string, string[]>;
  seeded?: Record<string, boolean>;
}

export function l3ext(db: OrgDB): L3Ext {
  const p = db.platform as PlatformState & { l3x?: L3Ext };
  return (p.l3x ??= {});
}

export const H = 3_600_000;
export const D = 24 * H;
export const iso = (t: number) => new Date(t).toISOString();
export const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
export const randHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, '0')).join('');

export function isL3(db: OrgDB) {
  return atLeast(levelOfOrg(db.org), 'l3');
}

export function requireL3(db: OrgDB, what: string) {
  if (!isL3(db)) throw new Error(`${what} starts at ${LEVEL_INFO.l3.label}.`);
}

/** The caller's role in this organisation now, checked against the roles allowed. */
export function requireRoles(orgId: string, userId: string, roles: string[], what: string) {
  const role = memberRole(orgId, userId);
  if (!role || !roles.includes(role)) {
    const who = roles.length === 2 ? 'Owners and admins' : roles.length === 3 ? 'Owners, admins and approvers' : roles.join(', ');
    throw new Error(`${what} — ${who} can do this; ${role ? 'your role cannot' : 'you hold no active role in this organisation'}.`);
  }
  return role;
}
