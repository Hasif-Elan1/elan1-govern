import type { Approval, Channel } from '@/types';
import { api } from '@/api';

/** Local helpers for the approvals inbox, the approval detail and the approve-by-link page. */

export type Urgency = 'hour' | 'today' | 'later' | 'decided';

export const URGENCY_ORDER: Urgency[] = ['hour', 'today', 'later', 'decided'];

export const URGENCY_LABEL: Record<Urgency, string> = {
  hour: 'Expiring within 1 hour',
  today: 'Expiring today',
  later: 'Later',
  decided: 'Decided',
};

const IST = 5.5 * 3.6e6;

/** Midnight at the end of the current day in India Standard Time. */
export function endOfIstDay(now = Date.now()): number {
  const t = new Date(now + IST);
  t.setUTCHours(24, 0, 0, 0);
  return t.getTime() - IST;
}

export function urgencyOf(a: Approval, now: number): Urgency {
  if (a.status !== 'pending') return 'decided';
  const at = new Date(a.expiresAt).getTime();
  if (at - now <= 3.6e6) return 'hour';
  if (at <= endOfIstDay(now)) return 'today';
  return 'later';
}

/** Approvals sorted for the inbox: waiting by soonest expiry, then decided by most recent decision. */
export function sortForInbox(items: Approval[]): Approval[] {
  const waiting = items.filter((a) => a.status === 'pending').sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  const decided = items.filter((a) => a.status !== 'pending').sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  return [...waiting, ...decided];
}

export function groupByUrgency(items: Approval[], now: number) {
  const groups: { key: Urgency; items: Approval[] }[] = URGENCY_ORDER.map((key) => ({ key, items: [] }));
  for (const a of items) groups.find((g) => g.key === urgencyOf(a, now))!.items.push(a);
  return groups.filter((g) => g.items.length > 0);
}

export function matchesQuery(a: Approval, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [a.headline, a.agentSlug, a.tool, a.ruleId, a.approverGroup, a.counterparty ?? '', a.id, a.connector, String(a.seq), a.amount !== undefined ? String(a.amount) : '']
    .some((s) => s.toLowerCase().includes(needle));
}

/** The organisation's approver group for the free-text group stored on an approval ("Finance" or "finance"). */
export function approverGroup(orgId: string, name: string) {
  const k = name.trim().toLowerCase();
  return api.approverGroups(orgId).find((g) => g.name.toLowerCase() === k || g.id === k);
}

/** Is this person a member of the approver group in this organisation? */
export function isInGroup(orgId: string, userId: string | undefined, groupName: string): boolean {
  if (!userId) return false;
  return approverGroup(orgId, groupName)?.members.includes(userId) ?? false;
}

/** May this person decide this approval (member of the group or the group it was escalated from)? */
export function canDecideApproval(orgId: string, userId: string | undefined, a: Approval): boolean {
  if (!userId) return false;
  return api.allowedApprovers(orgId, a.id).includes(userId);
}

/**
 * Why this waiting approval cannot be decided right now, or undefined when it can. An emergency stop
 * holds the approvals that were waiting when it was engaged (approval.heldByStop) and any approval of
 * an agent it covers: nobody can approve or reject them until the stop is lifted, and their expiry still runs.
 */
export function heldReason(orgId: string, a: Approval): string | undefined {
  if (a.status !== 'pending') return undefined;
  const blocked = api.decisionBlocked(orgId, a.id);
  if (blocked) return blocked;
  return a.heldByStop ? 'Held by the emergency stop. Nobody can approve or reject it while the stop is on; it keeps waiting, and its expiry still runs. Lift the stop to decide it.' : undefined;
}

/** Bank-detail changes and payments carry the call-back hint. */
export function needsCallBack(a: Pick<Approval, 'tool' | 'riskTags'>): boolean {
  return a.tool.includes('bank_details') || a.tool.includes('bank.') || a.riskTags.includes('moves_money');
}

/** "47 m 12 s" under an hour, "3 h 12 m" under a day, "2 d 4 h" beyond. */
export function preciseCountdown(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'Expired';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d} d ${h % 24} h`;
  if (h > 0) return `${h} h ${String(m % 60).padStart(2, '0')} m`;
  return `${m} m ${String(s % 60).padStart(2, '0')} s`;
}

/** Share of the approval window that has passed (0..1). */
export function windowElapsed(a: Pick<Approval, 'createdAt' | 'expiresAt'>, now = Date.now()): number {
  const start = new Date(a.createdAt).getTime();
  const end = new Date(a.expiresAt).getTime();
  if (end <= start) return 1;
  return Math.max(0, Math.min(1, (now - start) / (end - start)));
}

/** Channels a single-use link can be sent through. */
export const LINK_CHANNELS: Channel[] = ['phone_link', 'email', 'whatsapp', 'slack'];
