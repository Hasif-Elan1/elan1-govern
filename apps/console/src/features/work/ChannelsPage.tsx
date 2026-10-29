import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, Check, Clock3, Link2, Lock, MessageCircle, Pencil, TimerReset, Users } from 'lucide-react';
import { api } from '@/api';
import type { Channel, EscalationPolicy, RiskTag, Rule } from '@/types';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useUser } from '@/store/session';
import { toolByName } from '@/mock/catalog';
import { userName } from '@/mock/users';
import { channelLabel, dateTime, n, plural, rupees, tagLabel } from '@/lib/format';
import { Badge, Banner, Button, DataTable, EmptyState, Meter, PageHeader, Panel, Rule as Divider, Select, Skeleton, StatusChip, Switch, toast, type Column } from '@/components/ui';
import { AgentLink, Person, ReceiptLink, When } from '@/components/domain';
import { NotificationsSection } from '@/features/settings/sections/Notifications';
import { linksFor, twoPersonPolicy } from './backend';
import { isSovereignOrg } from '@/features/deployment/sovereignApi';

const D = 864e5;

/** Tags that never get Approve and Reject outside the console, whatever the rule says. */
const NEVER_IN_CHAT: { tag: RiskTag; label: string }[] = [
  { tag: 'deletes', label: 'Deletes' },
  { tag: 'changes_access', label: 'Access changes' },
  { tag: 'changes_production', label: 'Production changes' },
  { tag: 'personal_data', label: 'Personal data' },
];

function ruleTags(rule: Rule, connectorTags: Map<string, RiskTag[]>): RiskTag[] {
  if (rule.match.tag) return [rule.match.tag];
  if (rule.match.tool) return connectorTags.get(rule.match.tool) ?? toolByName(rule.match.tool)?.tags ?? [];
  return [];
}

/** A payment rule is capped when it bounds the amount from above or sets a running sum quota. */
function capped(rule: Rule) {
  const upper = (rule.when ?? []).some((c) => /amount/i.test(c.field) && (c.op === 'lt' || c.op === 'lte'));
  return upper || rule.quota?.kind === 'max_sum';
}

function neverReasons(rule: Rule, tags: RiskTag[]): string[] {
  const out = NEVER_IN_CHAT.filter((x) => tags.includes(x.tag)).map((x) => x.label);
  if (tags.includes('moves_money') && !capped(rule)) out.push('Uncapped payment');
  return out;
}

interface ChatRow { key: string; slug: string; ruleId: string; reason: string; approver?: string; tags: RiskTag[]; marked: boolean; never: string[] }

const AFTER_OPTIONS = [15, 30, 60, 120, 240, 480, 1440];
const minutesLabel = (m: number) => (m < 60 ? `${m} min` : m % 1440 === 0 ? `${m / 1440} d` : `${m / 60} h`);

/**
 * Channels — Work door. Where the door's queues reach people, and how approvals are routed when nobody answers.
 * A channel carries a link back into the console; it is never a place of its own.
 */
export default function ChannelsPage() {
  const orgId = useOrgId();
  const { data, loading, error, refetch } = useQuery(async (o) => {
    const [rulebooks, connectors, approvals] = await Promise.all([api.rulebooks(o), api.connectors(o), api.approvals(o)]);
    const since = Date.now() - 7 * D;
    const decided = approvals.filter((a) => a.decidedAt && a.decidedBy && new Date(a.decidedAt).getTime() >= since && (a.status === 'approved' || a.status === 'rejected' || a.status === 'approved_run_failed'));
    const byChannel: Record<string, number> = {};
    for (const a of decided) byChannel[a.channel ?? 'web'] = (byChannel[a.channel ?? 'web'] ?? 0) + 1;
    const pending = approvals.filter((a) => a.status === 'pending');
    return { rulebooks, connectors, byChannel, decidedTotal: decided.length, pending: pending.length, pendingChat: pending.filter((a) => a.approveInChat).length, approvals };
  }, []);

  // links such as /work/channels#routing land on that panel: scroll once the panels above it have their height
  // (once per navigation, so a live refresh never pulls the page back while someone is reading)
  const location = useLocation();
  const scrolledFor = useRef<string>();
  useEffect(() => {
    if (!location.hash || loading) return;
    const key = `${location.key}${location.hash}`;
    if (scrolledFor.current === key) return;
    const t = window.setTimeout(() => {
      try {
        const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
        if (el) { el.scrollIntoView({ block: 'start' }); scrolledFor.current = key; }
      } catch { /* a malformed hash scrolls nowhere */ }
    }, 50);
    return () => window.clearTimeout(t);
  }, [location.key, location.hash, loading]);

  const rows = useMemo<ChatRow[]>(() => {
    if (!data) return [];
    const connectorTags = new Map<string, RiskTag[]>();
    for (const c of data.connectors) for (const t of c.tools) connectorTags.set(t.name, t.tags);
    return data.rulebooks.flatMap((rb) => {
      const published = rb.versions.filter((v) => v.status === 'published');
      const v = published[published.length - 1];
      return (v?.rules ?? []).filter((r) => r.decide === 'ask').map((r) => {
        const tags = ruleTags(r, connectorTags);
        return { key: `${rb.slug}:${r.id}`, slug: rb.slug, ruleId: r.id, reason: r.reason, approver: r.approver, tags, marked: !!r.approveInChat, never: neverReasons(r, tags) };
      });
    });
  }, [data]);

  const inChat = rows.filter((r) => r.marked && r.never.length === 0);
  const never = rows.filter((r) => r.never.length > 0);
  const byChoice = rows.filter((r) => !r.marked && r.never.length === 0);
  const withheld = never.filter((r) => r.marked);
  // Sovereign: deny-all egress, so Slack and WhatsApp (both outside the network) are not channels here
  const sov = isSovereignOrg(orgId);
  const channels: Channel[] = sov ? ['web', 'email', 'phone_link'] : ['web', 'email', 'phone_link', 'slack', 'whatsapp'];

  return (
    <div className="relative space-y-6 overflow-x-clip">
      <PageHeader
        kicker="Work"
        title="Channels"
        description={sov
          ? <>Channels route into a door; they are never a door. Here approvals reach people in the console, by email through your own mail relay, and by phone links that open the console over your own network. Slack and WhatsApp are not available: egress is denied.</>
          : <>Channels route into a door; they are never a door. Email carries a link back here. Slack and WhatsApp carry Approve and Reject only for rules approvable in chat, and only for people the routing reaches there with a linked Slack account or a verified WhatsApp number; everyone else gets a link back here.</>}
        meta={data && (
          <>
            <Badge tone="neutral">{plural(data.pending, 'approval')} waiting</Badge>
            <Link to="/approvals" className="text-sm link inline-flex items-center gap-1">Open approvals <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
          </>
        )}
      />

      {error && <Banner tone="bad" title="Channel summary could not be loaded" actions={<Button size="sm" variant="secondary" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      {sov && <SovereignChannelsNote />}

      <div className="grid gap-6 lg:grid-cols-12">
        <Panel className="lg:col-span-7 min-w-0" title="Who can decide outside the console" flush
          footer={sov
            ? <>Under deny-all egress nothing is approved in chat: a rule marked approvable in chat sends an email link through your relay instead, and every decision opens the console, where a fresh sign-in is asked for.</>
            : <>Approvable in chat means a Slack or WhatsApp message may show Approve and Reject, to a person with a linked Slack account or a verified WhatsApp number whom the routing reaches. Everything else opens the console, where a fresh sign-in is asked for.</>}>
          {loading && !data ? <div className="p-5 space-y-3"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : !data ? (
            <p className="p-5 text-sm text-muted">The rules could not be read, so this summary is not shown.</p>
          ) : rows.length === 0 ? (
            <p className="p-5 text-sm text-muted">No published rule holds a call for a person yet, so nothing is sent to a channel for a decision. <Link to="/rulebooks" className="link">Rulebooks</Link></p>
          ) : (
            <div>
              <div className="grid grid-cols-3 border-b border-line">
                <Count label="Approvable in chat" value={inChat.length} />
                <Count label="Console by choice" value={byChoice.length} />
                <Count label="Never in chat" value={never.length} />
              </div>
              {withheld.length > 0 && (
                <p className="px-5 py-2.5 text-xs text-held-fg bg-held-bg border-b border-line">
                  {plural(withheld.length, 'rule')} marked approvable in chat {withheld.length === 1 ? 'touches' : 'touch'} a category that never is; chat buttons are withheld for {withheld.length === 1 ? 'it' : 'them'}.
                </p>
              )}
              <ul className="divide-y divide-line max-h-[420px] overflow-y-auto">
                {[...inChat, ...never, ...byChoice].map((r) => (
                  <li key={r.key} className="px-5 py-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        <Link to={`/rulebooks/${r.slug}?tab=rules`} className="font-mono text-[12.5px] font-medium hover:underline">{r.ruleId}</Link>
                        <span className="text-muted"> · </span><AgentLink slug={r.slug} />
                        {r.approver && <span className="text-xs text-muted"> · {r.approver}</span>}
                      </p>
                      <p className="text-xs text-muted mt-0.5">{r.reason}</p>
                    </div>
                    <div className="shrink-0">
                      {r.never.length > 0 ? (
                        <StatusChip tone="neutral" size="sm" icon={<Lock className="h-3 w-3" aria-hidden />}>Never in chat · {r.never.join(', ')}</StatusChip>
                      ) : r.marked && sov ? (
                        <StatusChip tone="neutral" size="sm" icon={<Lock className="h-3 w-3" aria-hidden />}>Email link · no chat (egress denied)</StatusChip>
                      ) : r.marked ? (
                        <StatusChip tone="info" size="sm" icon={<MessageCircle className="h-3 w-3" aria-hidden />}>Approvable in chat</StatusChip>
                      ) : (
                        <StatusChip tone="neutral" size="sm" icon={<Lock className="h-3 w-3" aria-hidden />}>Console only</StatusChip>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <div className="lg:col-span-5 space-y-6 min-w-0">
          <Panel title="Where decisions were made" kicker="Last 7 days">
            {loading && !data ? <Skeleton className="h-36" /> : !data ? (
              <p className="text-sm text-muted">Not available while the approvals cannot be read.</p>
            ) : data.decidedTotal === 0 ? (
              <p className="text-sm text-muted">No held call was approved or rejected in the last 7 days.</p>
            ) : (
              <ul className="space-y-3">
                {channels.map((c) => {
                  const v = data.byChannel[c] ?? 0;
                  return (
                    <li key={c}>
                      <div className="flex items-baseline justify-between text-sm mb-1">
                        <span>{channelLabel[c]}</span>
                        <span className="num text-muted">{n(v)}</span>
                      </div>
                      <Meter value={data.decidedTotal ? v / data.decidedTotal : 0} label={`${channelLabel[c]}: ${v} of ${data.decidedTotal}`} />
                    </li>
                  );
                })}
              </ul>
            )}
            {data && <p className="mt-4 text-xs text-muted">Every decision is recorded with its channel on the approval receipt. Expiries are not counted here — they are in <Link to="/work/not-done?class=expiry" className="link">Not done</Link>.</p>}
          </Panel>
          <Panel tone="sunken" title="What never comes to chat">
            <p className="text-sm text-muted leading-relaxed">Deletes, access changes, production changes, personal data, and any approval that asks for the password again (a call that cannot be reversed, or an amount at or above the step-up limit) always open the console, whatever the rule says.</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {NEVER_IN_CHAT.map((x) => <Badge key={x.tag}>{tagLabel[x.tag]}</Badge>)}
              <Badge>Password step-up</Badge>
            </div>
          </Panel>
        </div>
      </div>

      <RoutingPanel orgId={orgId} />
      <LinksPanel approvals={data?.approvals} />

      <Divider label="Notification channels" />
      <NotificationsSection />
    </div>
  );
}

/** Sovereign: why Slack and WhatsApp are not offered, and what reaches people instead. */
function SovereignChannelsNote() {
  return (
    <Banner tone="info" title="Slack and WhatsApp are not available on this deployment"
      actions={<Link to="/agents/deployment?tab=egress" className="text-sm link whitespace-nowrap">Egress log</Link>}>
      This deployment runs on your own infrastructure with egress denied. Slack (hooks.slack.com) and WhatsApp (graph.facebook.com) are outside your network, so held actions reach approvers in the console and by email through your internal mail relay, and phone links open the console over your own network. Only hosts on the internal allow-list can be reached.
    </Banner>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-3 sm:px-5 py-3 border-r border-line last:border-r-0 min-w-0">
      <p className="label leading-snug">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold num">{n(value)}</p>
    </div>
  );
}

/** Routing and escalation per approver group: members and their channels, the backup group, when it re-routes. */
function RoutingPanel({ orgId }: { orgId: string }) {
  const canEdit = useCan('approvals.reroute');
  const q = useQuery(async (o) => {
    const [esc, members] = await Promise.all([api.escalation(o), api.members(o)]);
    return { ...esc, members };
  }, [], { kinds: ['receipt', 'approval'] });
  const [editing, setEditing] = useState<string>();
  const tp = twoPersonPolicy(orgId);
  const sovOrg = isSovereignOrg(orgId);

  return (
    <Panel id="routing" title="Routing and escalation" kicker="Approver groups" flush
      actions={<Link to="/agents/people" className="text-sm link whitespace-nowrap">People and roles</Link>}
      footer={<span>When nobody in a group decides in time, the approval is re-routed once to its backup group, the backup group is notified, and an approval.escalated receipt names both groups. A rule can set its own escalate_after. {tp.enabled ? `Held calls of ${rupees(tp.above)} or more need two approvers (set in Reviews).` : ''}</span>}>
      {q.loading && !q.data ? <div className="p-5 space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div> : q.error && !q.data ? (
        <div className="p-5"><Banner tone="bad" title="Routing could not be loaded" actions={<Button size="sm" variant="secondary" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner></div>
      ) : q.data && q.data.groups.length === 0 ? (
        <EmptyState compact title="No approver groups" disc="gate">Approver groups come from your rulebooks and People and roles.</EmptyState>
      ) : q.data ? (
        <ul className="divide-y divide-line">
          {q.data.groups.map((g) => {
            const pol = q.data!.policies.find((p) => p.groupId === g.id);
            const member = (uid: string) => q.data!.members.find((m) => m.userId === uid);
            const active = g.members.filter((m) => member(m)?.status === 'active').length;
            return (
              <li key={g.id} className="px-5 py-4">
                <div className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4 text-muted" aria-hidden />{g.name}<span className="font-mono text-xs font-normal text-subtle">{g.id}</span>
                      {active === 0 ? <StatusChip tone="bad" size="sm">No active member</StatusChip> : active === 1 ? <StatusChip tone="held" size="sm">One active member</StatusChip> : null}</p>
                    <ul className="mt-2 space-y-1.5">
                      {g.members.map((m) => {
                        const mm = member(m);
                        return (
                          <li key={m} className="flex flex-wrap items-center gap-2 text-sm">
                            <Person id={m} size={20} />
                            {mm && mm.status !== 'active' && <Badge tone="held">{mm.status === 'suspended' ? 'Suspended' : 'Invited'}</Badge>}
                            <span className="text-xs text-muted">Email{!sovOrg && mm?.slackLinked ? ' · Slack' : ''}{!sovOrg && mm?.whatsappVerified ? ' · WhatsApp' : ''}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  <div className="min-w-0 text-sm">
                    {pol ? (
                      editing === g.id ? (
                        <PolicyForm pol={pol} groups={q.data!.groups.filter((x) => x.id !== g.id)} onDone={() => { setEditing(undefined); q.refetch(); }} />
                      ) : (
                        <>
                          <p className="flex items-center gap-1.5 font-medium"><TimerReset className="h-3.5 w-3.5 text-muted" aria-hidden />{pol.enabled ? <>Re-routes to {pol.backupGroupName} after {minutesLabel(pol.afterMinutes)}</> : 'No automatic re-routing'}</p>
                          <p className="mt-1 text-xs text-muted">Triggered {plural(pol.triggered, 'time')}{pol.lastTriggeredAt && <>, last <When iso={pol.lastTriggeredAt} /></>}.</p>
                          {canEdit ? <Button className="mt-2" size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" aria-hidden />} onClick={() => setEditing(g.id)}>Edit</Button> : <p className="mt-2 text-xs text-muted">Owners and admins change routing.</p>}
                        </>
                      )
                    ) : <p className="text-xs text-muted">No escalation policy for this group.</p>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {q.data && q.data.recent.length > 0 && (
        <div className="border-t border-line px-5 py-3">
          <p className="label mb-2">Recent re-routes</p>
          <ul className="space-y-1.5 text-sm">
            {q.data.recent.slice(0, 6).map((e, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Link to={`/approvals/${e.approvalId}`} className="min-w-0 truncate hover:underline">{e.headline}</Link>
                <span className="text-xs text-muted">{e.from} → {e.to} · {e.by === 'system' ? 'automatically' : `by ${userName(e.by)}`} · <When iso={e.at} /></span>
                {e.seq !== undefined && <ReceiptLink seq={e.seq} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function PolicyForm({ pol, groups, onDone }: { pol: EscalationPolicy; groups: { id: string; name: string }[]; onDone: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [on, setOn] = useState(pol.enabled);
  const [after, setAfter] = useState(pol.afterMinutes);
  const [backup, setBackup] = useState(pol.backupGroupId);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await api.setEscalation(orgId, pol.groupId, { enabled: on, afterMinutes: after, backupGroupId: backup }, user.id);
      toast.ok(`Routing for ${pol.groupName} saved`, 'Recorded as an escalation.updated receipt. It applies to calls already waiting.');
      onDone();
    } catch (e) {
      toast.bad('Not saved', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 border border-line bg-sunken/40 p-3">
      <Switch label="Re-route automatically" checked={on} onChange={setOn} />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor={`ch-after-${pol.groupId}`}>After</label>
          <Select id={`ch-after-${pol.groupId}`} size_="sm" value={String(after)} disabled={!on} onChange={(e) => setAfter(Number(e.target.value))}>
            {Array.from(new Set([...AFTER_OPTIONS, pol.afterMinutes])).sort((a, b) => a - b).map((m) => <option key={m} value={m}>{minutesLabel(m)}</option>)}
          </Select>
        </div>
        <div>
          <label className="label" htmlFor={`ch-backup-${pol.groupId}`}>Backup group</label>
          <Select id={`ch-backup-${pol.groupId}`} size_="sm" value={backup} disabled={!on} onChange={(e) => setBackup(e.target.value)}>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={busy} onClick={save}>Save</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

type LinkRow = ReturnType<typeof linksFor>[number];

/** Every single-use approval link issued: to whom, by which channel, and whether it was used or expired. */
function LinksPanel({ approvals }: { approvals?: Awaited<ReturnType<typeof api.approvals>> }) {
  const q = useQuery(async (o) => linksFor(o), [], { kinds: ['approval', 'receipt'] });
  const now = Date.now();
  const stateOf = (l: LinkRow) => (l.usedAt ? 'used' : new Date(l.expiresAt).getTime() < now ? 'expired' : 'sent');
  const columns: Column<LinkRow>[] = [
    { key: 'to', header: 'Sent to', cell: (l) => <Person id={l.issuedTo} size={20} /> },
    { key: 'ch', header: 'Channel', hideBelow: 'sm', cell: (l) => channelLabel[l.channel] },
    { key: 'what', header: 'Approval', hideBelow: 'md', cell: (l) => { const a = approvals?.find((x) => x.id === l.approvalId); return <Link to={`/approvals/${l.approvalId}`} className="block max-w-[280px] truncate hover:underline">{a?.headline ?? l.approvalId}</Link>; } },
    { key: 'issued', header: 'Issued', hideBelow: 'md', cell: (l) => <When iso={l.issuedAt} className="text-muted" />, sort: (l) => l.issuedAt },
    {
      key: 'state', header: 'State', cell: (l) => {
        const s = stateOf(l);
        return s === 'used'
          ? <span className="flex flex-col gap-0.5"><StatusChip tone="neutral" size="sm" icon={<Check className="h-3 w-3" aria-hidden />}>Used</StatusChip><span className="text-xs text-muted">{dateTime(l.usedAt!)} by {userName(l.usedBy)}</span></span>
          : s === 'expired' ? <StatusChip tone="neutral" size="sm" icon={<Clock3 className="h-3 w-3" aria-hidden />}>Expired</StatusChip>
            : <StatusChip tone="info" size="sm" icon={<Link2 className="h-3 w-3" aria-hidden />}>Sent</StatusChip>;
      },
    },
  ];
  return (
    <Panel title="Single-use approval links" kicker="Issued from approvals" flush footer={<span>Each link names one person and one channel, works once and expires with the approval. A used link shows who used it and the receipt it wrote.</span>}>
      {q.error ? (
        <div className="p-5"><Banner tone="bad" title="Links could not be loaded" actions={<Button size="sm" variant="secondary" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner></div>
      ) : (
        <DataTable className="border-0" caption="Single-use approval links" columns={columns} rows={q.data ?? []} loading={q.loading} rowKey={(l) => l.token} maxHeight={360}
          empty={<EmptyState compact title="No links issued yet" disc="registration">Send one from an approval: open it in Approvals and choose Send a single-use link.</EmptyState>} />
      )}
    </Panel>
  );
}
