/**
 * Organisation settings kept on the organisation's database (`orgSettings`): sign-in, sessions, notification
 * channels and routing, retention and the replay store, invitations, approver-group edits, the webhook outbox.
 *
 * The settings screens change these through src/features/settings/orgApi.ts. They live here, in the mock, so
 * the parts that enforce them (who may approve, who is notified, whether Test on past actions can replay)
 * read the same saved state the screens wrote. Every function takes the organisation's database, so this file
 * never opens one itself.
 */
import type { ApproverGroup, Channel, Member, Role, WebhookEvent } from '@/types';
import type { OrgDB } from './db';
import { sha256Hex } from '@/lib/crypto';
import { INVITED, baseApproverGroupsFor } from './users';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const iso = (t: number) => new Date(t).toISOString();
const D = 864e5;

/* ── Types ─────────────────────────────────────────────────────────────── */

export type OidcProvider = 'okta' | 'entra' | 'google' | 'keycloak';
export interface OidcDomain { name: string; token: string; verified: boolean; checkedAt?: string; lastCheck?: 'found' | 'not_found' | 'mismatch' }
export interface OidcCheck { label: string; ok: boolean; detail: string }
export interface OidcConfig {
  provider: OidcProvider; issuer: string; clientId: string; secretLast4?: string; savedAt?: string; savedBy?: string;
  test?: { ok: boolean; at: string; checks: OidcCheck[] };
  domains: OidcDomain[]; ssoOnly: boolean; jit: boolean; jitRole: Role;
}
export type Lifetime = '8h' | '12h' | '24h' | '7d';
export interface SessionPolicy { lifetime: Lifetime; require2step: boolean; updatedAt?: string; updatedBy?: string }
export interface SessionRecord {
  id: string; userId: string; device: string; kind: 'desktop' | 'phone'; method: string;
  startedAt: string; lastActiveAt: string; endedAt?: string; endedBy?: string; endReason?: string;
  via: 'console' | 'approval_link'; approvalId?: string; seq?: number;
}
export interface MfaEnrolment { enrolledAt: string; secret: string; seq: number }
export type ChannelKey = 'email' | 'slack' | 'whatsapp';
export interface NotifyConfig {
  slack: { connected: boolean; team?: string; workspace?: string; channel: string; installedAt?: string; installedBy?: string; scopes?: string[]; pendingState?: string };
  email: boolean;
  routing: Record<string, Record<ChannelKey, boolean>>;
}
export interface WhatsAppState { number: string; verifiedAt?: string; pending?: { codeHash: string; sentAt: string; attempts: number; testCode: string } }
export interface InviteToken { token: string; userId: string; email: string; role: Role; invitedBy: string; invitedAt: string; expiresAt: string; usedAt?: string; revokedAt?: string; replacedBy?: string; seq?: number }
export interface GroupEdit { add: string[]; remove: string[] }
export interface DeadLetter { id: string; webhookId: string; url: string; event: WebhookEvent; ts: string; attempts: number; lastStatus: number; seq?: number; replayedAt?: string; replayStatus?: number }
export interface SecretRoll { webhookId: string; newPrefix: string; previousPrefix: string; previousValidUntil: string; at: string; by: string; seq: number }
export interface Closure { scheduledAt: string; scheduledBy: string; effectiveAt: string; retentionUntil: string; exportId?: string; seq: number; cancelledAt?: string; cancelledBy?: string }

export interface OrgSettings {
  v: 1;
  oidc: OidcConfig;
  sessionPolicy: SessionPolicy;
  sessions: SessionRecord[];
  mfa: Record<string, MfaEnrolment>;
  notify: NotifyConfig;
  whatsapp: Record<string, WhatsAppState>;
  retention: { years: number; updatedAt?: string; updatedBy?: string };
  replay: { on: boolean; changedAt?: string; changedBy?: string; clearedRows?: number };
  invites: InviteToken[];
  groupEdits: Record<string, GroupEdit>;
  deadLetter: DeadLetter[];
  secretRolls: SecretRoll[];
  outboxWatermark?: number;
  closure?: Closure;
  passwordChanges: { userId: string; at: string; seq: number }[];
}

/* ── Routing defaults ──────────────────────────────────────────────────── */

export const ROUTE_IDS = ['approval.pending', 'approval.resolved', 'approval.escalated', 'alert.high', 'alert.medium', 'alert.low', 'stop.engaged'] as const;
export const DEFAULT_ROUTING: Record<string, Record<ChannelKey, boolean>> = {
  'approval.pending': { email: true, slack: true, whatsapp: true },
  'approval.resolved': { email: false, slack: true, whatsapp: false },
  'approval.escalated': { email: true, slack: true, whatsapp: true },
  'alert.high': { email: true, slack: true, whatsapp: true },
  'alert.medium': { email: true, slack: true, whatsapp: false },
  'alert.low': { email: false, slack: false, whatsapp: false },
  'stop.engaged': { email: true, slack: true, whatsapp: true },
};

/* ── Seed and access ───────────────────────────────────────────────────── */

const mailDomain = (d: OrgDB) => d.org.domain ?? `${d.org.slug}.in`;
export const domainToken = (orgId: string, domain: string) => sha256Hex(`${orgId}:dns:${domain}`).slice(0, 24);

function seed(d: OrgDB): OrgSettings {
  const dom = mailDomain(d);
  const sov = d.org.deployment === 'sovereign';
  const provider: OidcProvider = sov ? 'keycloak' : d.org.id === 'org_demo' ? 'okta' : 'entra';
  // Sovereign: deny-all egress, so Slack is never connected there
  const slackLinked = !sov && d.members.some((m) => m.slackLinked);
  const owner = d.members.find((m) => m.role === 'owner')?.userId ?? '';
  return {
    v: 1,
    oidc: { provider, issuer: '', clientId: '', domains: [{ name: dom, token: domainToken(d.org.id, dom), verified: false }], ssoOnly: false, jit: true, jitRole: 'viewer' },
    sessionPolicy: { lifetime: '12h', require2step: false },
    sessions: [],
    mfa: {},
    notify: {
      slack: slackLinked
        ? { connected: true, team: `T0${sha256Hex(d.org.id).slice(0, 8).toUpperCase()}`, workspace: d.org.name.replace(/ (Pvt )?Ltd$/, ''), channel: '#govern-approvals', installedAt: d.org.createdAt, installedBy: owner, scopes: ['chat:write', 'commands', 'users:read.email'] }
        : { connected: false, channel: '#govern-approvals' },
      email: true,
      routing: clone(DEFAULT_ROUTING),
    },
    whatsapp: {},
    retention: { years: 8 },
    replay: { on: true },
    invites: [],
    groupEdits: {},
    deadLetter: [],
    secretRolls: [],
    passwordChanges: [],
  };
}

/** The organisation's settings, created on first use and saved with the organisation. */
export function settingsOf(d: OrgDB): OrgSettings {
  if (!d.orgSettings || d.orgSettings.v !== 1) d.orgSettings = seed(d);
  const s = d.orgSettings;
  // seeded invitations get a real single-use token
  for (const m of d.members) {
    if (m.status !== 'invited' || s.invites.some((i) => i.userId === m.userId && !i.revokedAt && !i.replacedBy)) continue;
    const email = (m as Member & { invitedEmail?: string }).invitedEmail ?? INVITED.find((x) => x.id === m.userId)?.email ?? `${m.userId}@${mailDomain(d)}`;
    (m as Member & { invitedEmail?: string }).invitedEmail = email;
    const at = m.invitedAt ? new Date(m.invitedAt).getTime() : Date.now();
    s.invites.push({ token: `inv_${sha256Hex(`${d.org.id}:${m.userId}:${at}`).slice(0, 24)}`, userId: m.userId, email, role: m.role, invitedBy: d.members.find((x) => x.role === 'owner')?.userId ?? '', invitedAt: iso(at), expiresAt: iso(at + 7 * D) });
  }
  return s;
}

/* ── Approver groups as they are now ───────────────────────────────────── */

export type EffectiveGroup = ApproverGroup & { edited: boolean; added: string[]; removed: string[] };

/**
 * The approver groups with the edits saved in People and roles › Approver groups applied. Only active members
 * of the organisation count, so a removed or suspended person stops deciding at once. Read-only: it never seeds.
 */
export function effectiveGroupsOf(d: OrgDB): EffectiveGroup[] {
  const edits = d.orgSettings?.groupEdits ?? {};
  return baseApproverGroupsFor(d.org.id).map((g) => {
    const e = edits[g.id];
    const list = Array.from(new Set([...g.members.filter((m) => !e?.remove.includes(m)), ...(e?.add ?? [])]));
    return { ...g, members: list.filter((id) => d.members.some((m) => m.userId === id && m.status === 'active')), edited: !!(e && (e.add.length || e.remove.length)), added: e?.add ?? [], removed: e?.remove ?? [] };
  });
}

/** The effective group a name or id refers to. */
export function effectiveGroupOf(d: OrgDB, nameOrId?: string): EffectiveGroup | undefined {
  if (!nameOrId) return undefined;
  const k = nameOrId.trim().toLowerCase();
  return effectiveGroupsOf(d).find((g) => g.id === k || g.name.toLowerCase() === k);
}

/* ── Notification routing ──────────────────────────────────────────────── */

export interface Recipient { userId: string; email: boolean; slack: boolean; whatsapp: boolean }

/**
 * Who an event reaches, from the saved routing table (Settings › Notifications) and the channels each person
 * has linked. Approval events go to the approver group's current members; everything else to active owners
 * and admins.
 */
export function recipientsOf(d: OrgDB, routeId: string, approverGroup?: string): Recipient[] {
  const s = settingsOf(d);
  const route = { ...DEFAULT_ROUTING, ...s.notify.routing }[routeId];
  const people = routeId.startsWith('approval') && approverGroup
    ? effectiveGroupOf(d, approverGroup)?.members ?? []
    : d.members.filter((m) => m.status === 'active' && (m.role === 'owner' || m.role === 'admin')).map((m) => m.userId);
  return people.map((id) => {
    const m = d.members.find((x) => x.userId === id);
    const wa = !!m?.whatsappVerified || !!s.whatsapp[id]?.verifiedAt;
    // Sovereign: deny-all egress — nothing goes to Slack or WhatsApp, whatever older saved settings say
    const sov = d.org.deployment === 'sovereign';
    return { userId: id, email: !!route?.email && s.notify.email, slack: !sov && !!route?.slack && s.notify.slack.connected && !!m?.slackLinked, whatsapp: !sov && !!route?.whatsapp && wa };
  });
}

/** The channels a recipient list uses, with the console always first. */
export function channelsOf(rs: Recipient[]): Channel[] {
  const out: Channel[] = ['web'];
  if (rs.some((r) => r.email)) out.push('email');
  if (rs.some((r) => r.slack)) out.push('slack');
  if (rs.some((r) => r.whatsapp)) out.push('whatsapp');
  return out;
}

export function recipientChannels(r: Recipient): Channel[] {
  return [...(r.email ? ['email' as const] : []), ...(r.slack ? ['slack' as const] : []), ...(r.whatsapp ? ['whatsapp' as const] : [])];
}

/** A short phrase for timelines: "2 people by email and Slack", or "nobody outside the console". */
export function reachPhrase(rs: Recipient[]): string {
  const ch = channelsOf(rs).filter((c) => c !== 'web');
  const reached = rs.filter((r) => r.email || r.slack || r.whatsapp).length;
  if (!ch.length || !reached) return 'shown in the console only (routing sends it nowhere else)';
  const label: Record<string, string> = { email: 'email', slack: 'Slack', whatsapp: 'WhatsApp' };
  const names = ch.map((c) => label[c]);
  return `${reached} ${reached === 1 ? 'person' : 'people'} notified by ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}`;
}

/* ── Replay store ──────────────────────────────────────────────────────── */

/** true when Test on past actions has stored arguments to replay. */
export function replayOnOf(d: OrgDB): boolean {
  return settingsOf(d).replay.on;
}

/** The moment from which stored arguments exist (the store was last switched on), if it was ever switched. */
export function replaySinceOf(d: OrgDB): string | undefined {
  const r = settingsOf(d).replay;
  return r.on ? r.changedAt : undefined;
}
