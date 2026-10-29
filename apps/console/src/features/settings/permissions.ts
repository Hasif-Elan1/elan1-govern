import { useSyncExternalStore } from 'react';
import type { Role } from '@/types';
import { db } from '@/api';
import { PERMISSIONS, ROLE_PERMISSIONS, can as canBase, type Permission } from '@/lib/permissions';
import { useSession } from '@/store/session';

/**
 * Permissions for the level features (assurance levels, autonomy, custody, erasure, counterparties,
 * deployment, approver groups, closing). They sit beside the base set in lib/permissions and use the
 * same five roles; the console checks them with useCanDo().
 */
export const LEVEL_PERMISSIONS = [
  { id: 'settings.org', label: 'Edit the organisation profile', group: 'Organisation' },
  { id: 'plan.upgrade', label: 'Move to a higher assurance level', group: 'Organisation' },
  { id: 'org.close', label: 'Close the organisation', group: 'Organisation' },
  { id: 'data.retention', label: 'Set retention and the replay store', group: 'Organisation' },
  { id: 'approvers.manage', label: 'Edit approver groups, backups and escalation', group: 'Approvals' },
  // the id is kept from before autonomy became graduation only: no role can set a level directly
  { id: 'autonomy.grant', label: 'Propose or approve an autonomy graduation (two people), and revoke one', group: 'Agents' },
  { id: 'keys.custody', label: 'Run a key ceremony and manage key custody', group: 'Agents' },
  { id: 'deployment.manage', label: 'Verify, stage and apply update bundles', group: 'Agents' },
  { id: 'erasure.approve', label: 'Open and approve a personal-data erasure', group: 'Records' },
  { id: 'counterparty.manage', label: 'Add counterparties and issue receipts to them', group: 'Assurance' },
] as const;

export type LevelPermission = (typeof LEVEL_PERMISSIONS)[number]['id'];
export type AnyPermission = Permission | LevelPermission;

const ADMIN_LEVEL: LevelPermission[] = ['settings.org', 'data.retention', 'approvers.manage', 'autonomy.grant', 'keys.custody', 'deployment.manage', 'erasure.approve', 'counterparty.manage'];

export const LEVEL_ROLE_PERMISSIONS: Record<Role, LevelPermission[]> = {
  owner: LEVEL_PERMISSIONS.map((p) => p.id),
  admin: ADMIN_LEVEL,
  approver: [],
  viewer: [],
  auditor: [],
};

export const ALL_PERMISSIONS: { id: AnyPermission; label: string; group: string }[] = [...PERMISSIONS, ...LEVEL_PERMISSIONS];

export function roleHas(role: Role | undefined, perm: AnyPermission): boolean {
  if (!role) return false;
  if ((LEVEL_PERMISSIONS as readonly { id: string }[]).some((p) => p.id === perm)) return LEVEL_ROLE_PERMISSIONS[role].includes(perm as LevelPermission);
  return canBase(role, perm as Permission);
}

export function permissionCount(role: Role) {
  return ROLE_PERMISSIONS[role].length + LEVEL_ROLE_PERMISSIONS[role].length;
}

/**
 * The role this person holds in the current organisation: the member record's role (a role change in
 * Members applies at once), none while suspended or invited, and none once removed. Auditors hold no
 * member record in their client organisations, so their directory role stands there. Re-renders when the
 * member list changes.
 */
export function useMemberRole(): Role | undefined {
  const orgId = useSession((s) => s.orgId);
  const userId = useSession((s) => s.user?.id);
  const directory = useSession((s) => s.user?.role);
  const read = (): Role | undefined => {
    if (!userId) return undefined;
    const m = db.getDB(orgId).members.find((x) => x.userId === userId);
    if (!m) return directory === 'auditor' ? 'auditor' : undefined;
    return m.status === 'active' ? m.role : undefined;
  };
  return useSyncExternalStore((cb) => db.subscribe((o) => { if (o === orgId) cb(); }), read);
}

/** useCan for the full permission set, read against the member role in this organisation. */
export const useCanDo = (perm: AnyPermission) => roleHas(useMemberRole(), perm);

/** The portals outside the organisation: people who see only what was shared with them. */
export const PORTAL_ROLES = [
  { id: 'counterparty', label: 'Counterparty verifier', seat: 'Seat ₹45,000 a year', can: ['Open receipts and disclosures issued to their organisation', 'Verify signatures and committed fields offline', 'See which fields were revealed and which stay committed'], cannot: ['See anything not issued to them', 'Change anything in this organisation'] },
  { id: 'regulator', label: 'Regulator or partner (portal)', seat: 'Read-only link, expires', can: ['Open the disclosure packages and bundles shared with them', 'Verify signatures and run the profile for their regime on what was disclosed to them', 'Download the evidence they were given'], cannot: ['Browse receipts beyond what was shared', 'Approve, publish or export anything else'] },
] as const;
