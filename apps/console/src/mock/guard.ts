/**
 * Role checks for operations screens call directly (the modules src/server/entry.ts lists). The server runs each
 * operation as the signed-in user, so a check made here with the operation's actor argument holds on the server:
 * a screen hiding a button is never the only guard. The role is the one the member record holds now
 * (db.memberRole), never the directory entry.
 */
import type { Role } from '@/types';
import { can, ROLE_INFO, type Permission } from '@/lib/permissions';
import { memberRole } from './db';
import { assertPilotWritable } from './billing';

const who = (roles: readonly Role[]) => {
  const labels = roles.map((r) => `${ROLE_INFO[r].label.toLowerCase()}s`);
  const text = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0] ?? 'nobody';
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** The caller's role here, which must hold `perm` (lib/permissions). Refused while a stopped pilot is read-only unless `anyTime`. */
export function requirePermission(orgId: string, userId: string, perm: Permission, what: string, opts: { anyTime?: boolean } = {}): Role {
  const role = memberRole(orgId, userId);
  if (!can(role, perm)) throw new Error(`${what} — ${role ? `${ROLE_INFO[role].label}s cannot do this` : 'you hold no active role in this organisation'}.`);
  if (!opts.anyTime) assertPilotWritable(orgId, userId, perm);
  return role!;
}

/** The caller's role here, which must be one of `roles`. Refused while a stopped pilot is read-only unless `anyTime`. */
export function requireRole(orgId: string, userId: string, roles: readonly Role[], what: string, opts: { anyTime?: boolean } = {}): Role {
  const role = memberRole(orgId, userId);
  if (!role || !roles.includes(role)) throw new Error(`${what} — ${who(roles)} can do this; ${role ? 'your role cannot' : 'you hold no active role in this organisation'}.`);
  if (!opts.anyTime) assertPilotWritable(orgId, userId, 'write');
  return role;
}

/** Any active member of the organisation (a change to the caller's own record, a note that they opened something). */
export function requireMember(orgId: string, userId: string, what: string): Role {
  const role = memberRole(orgId, userId);
  if (!role) throw new Error(`${what} — you hold no active role in this organisation.`);
  return role;
}
