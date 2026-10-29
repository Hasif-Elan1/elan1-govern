import type { Role } from '@/types';

/**
 * Permissions derived from the five built roles. The memoranda name 22 permissions without listing
 * them; this set is reconstructed from the role summary (R9.2) and labelled as derived in Agents > People and roles.
 */
export const PERMISSIONS = [
  { id: 'approvals.decide', label: 'Approve or reject held actions', group: 'Approvals' },
  { id: 'approvals.reroute', label: 'Re-route an approval to a backup approver', group: 'Approvals' },
  { id: 'activity.read', label: 'Read activity and receipts', group: 'Records' },
  { id: 'evidence.export', label: 'Export auditor packs', group: 'Records' },
  { id: 'evidence.checkpoint', label: 'Sign a checkpoint on demand', group: 'Records' },
  { id: 'agents.manage', label: 'Add, edit and delete agents', group: 'Agents' },
  { id: 'agents.pause', label: 'Pause and resume an agent', group: 'Agents' },
  { id: 'agents.keys', label: 'Issue and revoke agent keys', group: 'Agents' },
  { id: 'rulebooks.edit', label: 'Draft and edit rulebooks', group: 'Rulebooks' },
  { id: 'rulebooks.publish', label: 'Sign and publish a rulebook version', group: 'Rulebooks' },
  { id: 'rulebooks.review', label: 'Review a rulebook change (second person)', group: 'Rulebooks' },
  { id: 'connectors.manage', label: 'Connect systems and MCP servers', group: 'Connectors' },
  { id: 'inventory.manage', label: 'Register and edit AI systems', group: 'Governance' },
  { id: 'assessments.author', label: 'Write assessments', group: 'Governance' },
  { id: 'assessments.signoff', label: 'Sign off an assessment (different person)', group: 'Governance' },
  { id: 'compliance.manage', label: 'Enable frameworks and export reports', group: 'Governance' },
  // the role table gives approvers acknowledge and resolve, but not detector or auto-pause settings: two permissions
  { id: 'alerts.respond', label: 'Acknowledge and resolve alerts', group: 'Alerts and stop' },
  { id: 'alerts.manage', label: 'Set detectors and auto-pause', group: 'Alerts and stop' },
  { id: 'stop.engage', label: 'Engage and lift the emergency stop', group: 'Alerts and stop' },
  { id: 'members.manage', label: 'Invite members and change roles', group: 'Organisation' },
  { id: 'settings.security', label: 'SSO, sessions and signing keys', group: 'Organisation' },
  { id: 'settings.integrations', label: 'Webhooks and notification channels', group: 'Organisation' },
  { id: 'billing.manage', label: 'Plan, invoices and payment', group: 'Organisation' },
  { id: 'orgs.switch', label: 'Switch between client organisations', group: 'Organisation' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['id'];

const all = PERMISSIONS.map((p) => p.id) as Permission[];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: all.filter((p) => p !== 'orgs.switch'),
  admin: all.filter((p) => !['billing.manage', 'orgs.switch', 'settings.security'].includes(p)),
  // role table and flow F12: approvers also acknowledge and resolve alerts, and draft and submit assessments
  // (sign-off stays with owners and admins, never by the person who wrote or submitted it)
  approver: ['approvals.decide', 'activity.read', 'alerts.respond', 'assessments.author'],
  viewer: ['activity.read'],
  auditor: ['activity.read', 'evidence.export', 'orgs.switch'],
};

export const ROLE_INFO: Record<Role, { label: string; summary: string }> = {
  owner: { label: 'Owner', summary: 'Everything, including the emergency stop, signing keys and billing.' },
  admin: { label: 'Admin', summary: 'Agents, rulebooks, connectors, members and settings. Can engage the emergency stop.' },
  approver: { label: 'Approver', summary: 'Decides held actions in the approvals inbox, acknowledges and resolves alerts, and drafts assessments. Reads activity.' },
  viewer: { label: 'Viewer', summary: 'Reads the whole console. Changes nothing.' },
  auditor: { label: 'Auditor', summary: 'Read-only across client organisations. Samples receipts and exports auditor packs.' },
};

export function can(role: Role | undefined, perm: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].includes(perm);
}
