import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, CheckCircle2, Hash as HashIcon, Mail, MessageCircle, Minus, MonitorSmartphone, Smartphone, Timer, Webhook, XCircle } from 'lucide-react';
import { api } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useRole, useUser } from '@/store/session';
import { userName } from '@/mock/users';
import { cn } from '@/lib/cn';
import { relative } from '@/lib/format';
import { Badge, Banner, Button, Checkbox, Dialog, Field, Input, Panel, Select, Skeleton, StatusChip, Switch, toast } from '@/components/ui';
import { ReadOnlyNote, SectionHeader, errText, receiptNote } from '../shared';
import { DEFAULT_ROUTING, effectiveGroups, orgApi, type ChannelKey, type ExtEvent } from '../orgApi';
import { isSovereignOrg } from '@/features/deployment/sovereignApi';
import { EgressBlocked } from '@/features/deployment/EgressBlocked';

interface RouteRow { id: string; event: string; severity?: string; what: string; who: string; webhook?: ExtEvent }

const ROUTES: RouteRow[] = [
  { id: 'approval.pending', event: 'approval.pending', what: 'A held action is waiting for a person', who: 'Approver group named on the rule', webhook: 'approval.pending' },
  { id: 'approval.escalated', event: 'approval.escalated', what: 'No one decided in time; re-routed to the backup group', who: 'The backup group, and owners', webhook: 'approval.escalated' },
  { id: 'approval.resolved', event: 'approval.resolved', what: 'A held action was approved, rejected or expired', who: 'The agent’s owner', webhook: 'approval.resolved' },
  { id: 'alert.high', event: 'alert.created', severity: 'High', what: 'Unusual behaviour, high severity', who: 'Owners and admins', webhook: 'alert.created' },
  { id: 'alert.medium', event: 'alert.created', severity: 'Medium', what: 'Unusual behaviour, medium severity', who: 'Owners and admins', webhook: 'alert.created' },
  { id: 'alert.low', event: 'alert.created', severity: 'Low', what: 'Unusual behaviour, low severity', who: 'Owners and admins', webhook: 'alert.created' },
  { id: 'stop.engaged', event: 'stop.engaged', what: 'The emergency stop was engaged or lifted', who: 'Owners and admins', webhook: 'stop.engaged' },
];

const AFTER = [15, 30, 60, 120, 240, 480, 1440];
const afterLabel = (m: number) => (m < 60 ? `${m} minutes` : m < 1440 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m / 1440} day${m === 1440 ? '' : 's'}`);

export function NotificationsSection() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const canEdit = useCan('settings.integrations');
  // Sovereign: deny-all egress — Slack and WhatsApp are outside the network and are not offered (mock/sovereign.ts)
  const sov = isSovereignOrg(orgId);
  const { data: s, loading, error, refetch } = useQuery((o) => orgApi.notify(o), [], { kinds: ['channel', 'settings'] });
  const { data: members } = useQuery((o) => api.members(o), [], { kinds: ['member'] });
  const { data: hooks } = useQuery((o) => orgApi.webhooks(o), [], { kinds: ['webhook'] });
  const { data: rulebooks, loading: rbLoading } = useQuery((o) => api.rulebooks(o), [], { kinds: ['rulebook'] });
  const { data: esc } = useQuery((o) => api.escalation(o), [], { kinds: ['approval', 'receipt'] });
  const { data: wa, refetch: refetchWa } = useQuery((o) => orgApi.whatsapp(o, user?.id ?? ''), [user?.id], { kinds: ['channel', 'member'] });

  const [code, setCode] = useState('');
  const [number, setNumber] = useState<string>();
  const [waErr, setWaErr] = useState<string>();
  const [testCode, setTestCode] = useState<string>();
  const [install, setInstall] = useState<{ state: string; scopes: string[] }>();
  const [workspace, setWorkspace] = useState('');
  const [channel, setChannel] = useState<string>();
  const sendCode = useMutation(orgApi.sendWhatsAppCode);
  const verifyCode = useMutation(orgApi.verifyWhatsAppCode);
  const complete = useMutation(orgApi.completeSlackInstall);
  const setEsc = useMutation(api.setEscalation);

  const chatRules = useMemo(() => (rulebooks ?? []).flatMap((rb) => {
    const v = rb.versions.find((x) => x.version === rb.currentVersion);
    return (v?.rules ?? []).filter((r) => r.approveInChat).map((r) => ({ slug: rb.slug, id: r.id, reason: r.reason, approver: r.approver }));
  }), [rulebooks]);

  const subscribed = (e?: ExtEvent) => !!e && (hooks?.endpoints ?? []).some((w) => w.status !== 'disabled' && w.events.includes(e));
  const linkedSlack = members?.filter((m) => m.status === 'active' && m.slackLinked).length ?? 0;
  const verifiedWa = members?.filter((m) => m.status === 'active' && m.whatsappVerified).length ?? 0;
  const activeCount = members?.filter((m) => m.status === 'active').length ?? 0;
  const num = number ?? wa?.number ?? '';

  const run = async <T,>(fn: () => Promise<T & { seq: number }>, ok: string) => {
    try { const r = await fn(); toast.ok(ok, receiptNote(r.seq)); return r; } catch (e) { toast.bad('Not changed', errText(e)); }
  };

  const escRun = async (groupId: string, patch: { afterMinutes?: number; backupGroupId?: string; enabled?: boolean }, ok: string) => {
    if (!user) return;
    try { await setEsc.mutate(orgId, groupId, patch, user.id); toast.ok(ok, 'Recorded as an escalation.updated receipt.'); } catch (e) { toast.bad('Not changed', errText(e)); }
  };

  const startSlack = async () => {
    if (!user) return;
    try { const r = await orgApi.startSlackInstall(orgId, user.id); setWorkspace(api.org(orgId).name.replace(/ (Pvt )?Ltd$/, '')); setInstall({ state: r.state, scopes: r.scopes }); } catch (e) { toast.bad('Could not start', errText(e)); }
  };
  const finishSlack = async (decision: 'allow' | 'deny') => {
    if (!user || !install) return;
    try {
      const r = await complete.mutate(orgId, user.id, { state: install.state, decision, workspace });
      setInstall(undefined);
      toast.ok('Slack connected', `${r.slack.workspace} (${r.slack.team}). Approvals post to ${r.slack.channel}. ${receiptNote(r.seq)}`);
    } catch (e) { setInstall(undefined); toast.bad('Slack not connected', errText(e)); }
  };
  const send = async () => {
    if (!user) return;
    try { const r = await sendCode.mutate(orgId, user.id, num); setWaErr(undefined); setTestCode(r.testCode); toast.info('Code sent on WhatsApp', `To ${r.sentTo}. It expires in 10 minutes.`); refetchWa(); }
    catch (e) { setWaErr(errText(e)); }
  };
  const verify = async () => {
    if (!user) return;
    try { const r = await verifyCode.mutate(orgId, user.id, code); setCode(''); setTestCode(undefined); setWaErr(undefined); toast.ok('WhatsApp number verified', `Stored as a keyed hash on receipts, never in plain text. ${receiptNote(r.seq)}`); refetchWa(); }
    catch (e) { setWaErr(errText(e)); }
  };

  const cols: { key: ChannelKey | 'console' | 'webhook'; label: string; icon: JSX.Element }[] = [
    { key: 'console', label: 'Console', icon: <MonitorSmartphone className="h-3.5 w-3.5" aria-hidden /> },
    { key: 'email', label: 'Email', icon: <Mail className="h-3.5 w-3.5" aria-hidden /> },
    { key: 'slack', label: 'Slack', icon: <HashIcon className="h-3.5 w-3.5" aria-hidden /> },
    { key: 'whatsapp', label: 'WhatsApp', icon: <MessageCircle className="h-3.5 w-3.5" aria-hidden /> },
    { key: 'webhook', label: 'Webhook', icon: <Webhook className="h-3.5 w-3.5" aria-hidden /> },
  ];

  if (error) return <Banner tone="bad" title="Channels could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;

  return (
    <div>
      <SectionHeader
        title="Notifications and channels"
        description="Where people hear about held actions, escalations, alerts and the emergency stop. Decisions made from any channel are recorded with the channel on the receipt."
      />
      {!canEdit && <ReadOnlyNote role={role} who="Owners and admins">You can still verify your own WhatsApp number.</ReadOnlyNote>}

      <div className="grid gap-4 lg:grid-cols-3 mb-6">
        <Panel title={<span className="inline-flex items-center gap-2"><HashIcon className="h-4 w-4" aria-hidden />Slack</span>}
          actions={sov ? undefined : s?.slack.connected ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Connected</StatusChip> : <StatusChip tone="neutral" size="sm" icon={<XCircle className="h-3 w-3" />}>Not connected</StatusChip>}>
          {sov ? <EgressBlocked service="Slack" host="hooks.slack.com" instead="Held actions reach approvers in the console and by email through your internal relay." /> : loading && !s ? <Skeleton className="h-24" /> : s?.slack.connected ? (
            <>
              <p className="text-sm"><span className="font-medium">{s.slack.workspace}</span> workspace <span className="font-mono text-xs text-muted">{s.slack.team}</span></p>
              {s.slack.installedAt && <p className="text-xs text-muted mt-0.5">Installed {relative(s.slack.installedAt)}{s.slack.installedBy && ` by ${userName(s.slack.installedBy)}`}</p>}
              <Field label="Approvals channel" htmlFor="slack-ch" className="mt-3">
                <div className="flex gap-2">
                  <Input id="slack-ch" mono value={channel ?? s.slack.channel} disabled={!canEdit} onChange={(e) => setChannel(e.target.value)} />
                  {channel !== undefined && channel !== s.slack.channel && <Button variant="secondary" onClick={async () => { if (user && await run(() => orgApi.setSlackChannel(orgId, channel, user.id), 'Approvals channel changed')) setChannel(undefined); }}>Save</Button>}
                </div>
              </Field>
              <p className="mt-3 text-xs text-muted">{linkedSlack} of {activeCount} members have linked their Slack account. <Link to="/agents/people" className="link">Members</Link></p>
              <Button className="mt-3" size="sm" variant="ghost" disabled={!canEdit} onClick={() => user && run(() => orgApi.disconnectSlack(orgId, user.id), 'Slack disconnected')}>Disconnect</Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted">Post held actions to a channel and let linked people decide rules marked approvable in chat.</p>
              <Button className="mt-4" variant="secondary" disabled={!canEdit} title={!canEdit ? 'Owners and admins connect Slack.' : undefined} onClick={startSlack}>Connect Slack</Button>
            </>
          )}
        </Panel>

        <Panel title={<span className="inline-flex items-center gap-2"><MessageCircle className="h-4 w-4" aria-hidden />WhatsApp</span>}
          actions={sov ? undefined : wa?.verified ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Verified</StatusChip> : <StatusChip tone="held" size="sm" icon={<Smartphone className="h-3 w-3" />}>Not verified</StatusChip>}>
          {sov ? <EgressBlocked service="WhatsApp" host="graph.facebook.com" instead="No number is collected or verified on this deployment." /> : <>
          <p className="text-sm text-muted">Your own number, verified with a 6-digit code. {verifiedWa} of {activeCount} members have verified theirs.</p>
          {!wa ? <Skeleton className="mt-3 h-10" /> : wa.verified ? (
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="font-mono text-sm whitespace-nowrap">{wa.number}</span>
              <Button size="sm" variant="ghost" onClick={() => user && run(() => orgApi.forgetWhatsApp(orgId, user.id), 'Number removed').then(() => { setNumber(''); refetchWa(); })}>Change number</Button>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <div className="flex gap-2">
                <Input aria-label="Your WhatsApp number" type="tel" inputMode="tel" value={num} onChange={(e) => setNumber(e.target.value)} placeholder="+91 98450 11203" />
                <Button variant="secondary" loading={sendCode.pending} onClick={send}>{wa.pending ? 'Resend' : 'Send code'}</Button>
              </div>
              {wa.pending && (
                <div className="flex gap-2">
                  <Input aria-label="6-digit code" mono inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6-digit code" onKeyDown={(e) => e.key === 'Enter' && verify()} />
                  <Button variant="primary" loading={verifyCode.pending} onClick={verify}>Verify</Button>
                </div>
              )}
              {testCode && wa.pending && <p className="text-xs text-muted">This console uses the WhatsApp test gateway: the message it sent carries <span className="font-mono text-fg">{testCode}</span>.</p>}
              {waErr && <p className="text-xs text-bad-fg" role="alert">{waErr}</p>}
            </div>
          )}
          </>}
        </Panel>

        <Panel title={<span className="inline-flex items-center gap-2"><Mail className="h-4 w-4" aria-hidden />Email</span>}
          actions={s && <Switch label="Email notifications" checked={s.email} disabled={!canEdit} onChange={(v) => user && run(() => orgApi.setEmail(orgId, v, user.id), v ? 'Email notifications on' : 'Email notifications off')} />}>
          <p className="text-sm text-muted">Approval emails carry a signed, single-use link. Opening it still asks the approver to sign in; once used, the link is recorded as used and a second use is refused.</p>
          <p className="mt-3 text-xs text-muted">Medium and high alerts email owners and admins while email is on.</p>
        </Panel>
      </div>

      <Panel title="Routing by event" flush footer={<>The console always shows every event. Webhook delivery is set per endpoint in <Link to="/assurance/exports?tab=webhooks" className="link">Webhooks</Link>, including stop.engaged and approval.escalated. Each change here is a channel.routing_changed receipt.</>}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <caption className="sr-only">Which channels each event goes to</caption>
            <thead className="bg-sunken/95">
              <tr className="border-b border-line">
                <th scope="col" className="h-10 px-4 text-left label font-semibold">Event</th>
                <th scope="col" className="h-10 px-3 text-left label font-semibold">Who hears</th>
                {cols.map((c) => <th key={c.key} scope="col" className="h-10 px-2 text-center label font-semibold w-[84px]"><span className="inline-flex items-center gap-1">{c.icon}{c.label}</span></th>)}
              </tr>
            </thead>
            <tbody>
              {ROUTES.map((r) => {
                const row = s?.routing[r.id] ?? DEFAULT_ROUTING[r.id];
                return (
                  <tr key={r.id} className="border-b border-line last:border-b-0">
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      <span className="flex items-center gap-2"><span className="font-mono text-[12.5px]">{r.event}</span>{r.severity && <Badge tone={r.severity === 'High' ? 'bad' : r.severity === 'Medium' ? 'held' : 'info'}>{r.severity}</Badge>}</span>
                      <span className="block text-xs text-muted mt-0.5">{r.what}</span>
                    </th>
                    <td className="px-3 py-3 text-xs text-muted">{r.who}</td>
                    {cols.map((c) => (
                      <td key={c.key} className="px-2 text-center">
                        {c.key === 'console' ? (
                          <span className="inline-flex" title="Always on"><Check className="h-4 w-4 text-fg" aria-hidden /><span className="sr-only">Always on</span></span>
                        ) : c.key === 'webhook' ? (
                          <Link to="/assurance/exports?tab=webhooks" title={subscribed(r.webhook) ? 'An active endpoint subscribes to this event' : 'No endpoint subscribes yet'} className="inline-flex">
                            {subscribed(r.webhook) ? <Check className="h-4 w-4 text-fg" aria-hidden /> : <Minus className="h-4 w-4 text-subtle" aria-hidden />}
                            <span className="sr-only">{subscribed(r.webhook) ? 'Subscribed' : 'Not subscribed'} — open webhooks</span>
                          </Link>
                        ) : (
                          <span className={cn('inline-flex justify-center', ((c.key === 'slack' && !s?.slack.connected) || (c.key === 'email' && !s?.email) || (sov && (c.key === 'slack' || c.key === 'whatsapp'))) && 'opacity-40')} title={sov && (c.key === 'slack' || c.key === 'whatsapp') ? `${c.label} is not available: egress is denied on this deployment` : undefined}>
                            <Checkbox label={<span className="sr-only">{`${r.event}${r.severity ? ` ${r.severity}` : ''} to ${c.label}`}</span>} checked={!(sov && (c.key === 'slack' || c.key === 'whatsapp')) && !!row[c.key as ChannelKey]} disabled={!canEdit || !s || (sov && (c.key === 'slack' || c.key === 'whatsapp'))} onChange={(v) => user && run(() => orgApi.setRoute(orgId, r.id, c.key as ChannelKey, v, user.id),`${r.event}${r.severity ? ` (${r.severity.toLowerCase()})` : ''} ${v ? 'now goes to' : 'no longer goes to'} ${c.label}`)} />
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel className="mt-6" title={<span className="inline-flex items-center gap-2"><Timer className="h-4 w-4" aria-hidden />Escalation and backup approvers</span>} flush
        actions={<Link to="/agents/people?tab=groups" className="text-sm inline-flex items-center gap-1 link">Group members<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>}
        footer="If no one in the group decides within the time, the held action is re-routed once to the backup group and an approval.escalated receipt is written. Members of the first group can still decide. Checked on every live tick.">
        {!esc ? <div className="p-5"><Skeleton className="h-32" /></div> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <caption className="sr-only">Escalation policy per approver group</caption>
              <thead className="bg-sunken/80"><tr className="border-b border-line">
                <th scope="col" className="h-10 px-4 text-left label font-semibold">Group</th>
                <th scope="col" className="h-10 px-3 text-left label font-semibold">Re-route after</th>
                <th scope="col" className="h-10 px-3 text-left label font-semibold">Backup group</th>
                <th scope="col" className="h-10 px-3 text-left label font-semibold">On</th>
                <th scope="col" className="h-10 px-3 text-right label font-semibold">Re-routed</th>
              </tr></thead>
              <tbody>
                {esc.policies.map((p) => {
                  const members = effectiveGroups(orgId).find((g) => g.id === p.groupId)?.members ?? [];
                  return (
                    <tr key={p.groupId} className="border-b border-line last:border-b-0">
                      <th scope="row" className="px-4 py-2.5 text-left font-normal"><span className="font-medium">{p.groupName}</span><span className="block text-xs text-muted">{members.map((m) => userName(m).split(' ')[0]).join(', ') || 'No members'}</span></th>
                      <td className="px-3 py-2">
                        <Select size_="sm" aria-label={`Re-route ${p.groupName} after`} className="w-36" value={String(p.afterMinutes)} disabled={!canEdit || setEsc.pending}
                          onChange={(e) => user && escRun(p.groupId, { afterMinutes: Number(e.target.value) }, `${p.groupName} re-routes after ${afterLabel(Number(e.target.value))}`)}>
                          {Array.from(new Set([...AFTER, p.afterMinutes])).sort((a, b) => a - b).map((m) => <option key={m} value={m}>{afterLabel(m)}</option>)}
                        </Select>
                      </td>
                      <td className="px-3 py-2">
                        <Select size_="sm" aria-label={`Backup for ${p.groupName}`} className="w-36" value={p.backupGroupId} disabled={!canEdit || setEsc.pending}
                          onChange={(e) => user && escRun(p.groupId, { backupGroupId: e.target.value }, `${p.groupName} now escalates to ${esc.groups.find((g) => g.id === e.target.value)?.name}`)}>
                          {esc.groups.filter((g) => g.id !== p.groupId).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </Select>
                      </td>
                      <td className="px-3 py-2"><Switch label={`Escalation for ${p.groupName}`} showState={false} checked={p.enabled} disabled={!canEdit || setEsc.pending} onChange={(v) => user && escRun(p.groupId, { enabled: v }, `Escalation for ${p.groupName} ${v ? 'on' : 'off'}`)} /></td>
                      <td className="px-3 py-2 text-right num">{p.triggered}{p.lastTriggeredAt && <span className="block text-xs text-muted">{relative(p.lastTriggeredAt)}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="mt-6 grid gap-6 lg:grid-cols-12">
        {sov ? (
          <Banner tone="info" className="lg:col-span-7 self-start" title="No approvals in chat on this deployment">
            Egress is denied, so nothing is approved in Slack or WhatsApp. A rule marked approvable in chat sends a signed, single-use email link through your internal relay instead; every decision opens the console, where a fresh sign-in is asked for. The channel is recorded on the approval receipt.
          </Banner>
        ) : (
        <Banner tone="info" className="lg:col-span-7 self-start" title="Approve buttons in chat are limited on purpose">
          Slack and WhatsApp messages show Approve and Reject only for rules marked approvable in chat, and only to the approver they were sent to: the person with that confirmed Slack email or that verified WhatsApp number. They never do for calls tagged deletes, access changes, production changes or personal data, or where approving asks for the password again (a call that cannot be reversed, or an amount at or above the step-up limit). Any other chat message carries a link instead, which opens the console, where a fresh sign-in is asked for. The channel is recorded on the approval receipt.
        </Banner>
        )}
        <Panel className="lg:col-span-5" title="Rules approvable in chat" actions={<Badge>{chatRules.length}</Badge>} flush>
          {rbLoading && !rulebooks ? <div className="p-5"><Skeleton className="h-16" /></div> : chatRules.length === 0 ? (
            <p className="p-5 text-sm text-muted">No published rule is marked approvable in chat. Every held action opens the console.</p>
          ) : (
            <ul className="divide-y divide-line max-h-64 overflow-y-auto">
              {chatRules.map((r) => (
                <li key={`${r.slug}:${r.id}`} className="px-5 py-2.5">
                  <Link to={`/rulebooks/${r.slug}`} className="text-sm font-medium hover:underline"><span className="font-mono text-[12.5px]">{r.id}</span></Link>
                  <span className="text-xs text-muted"> · {r.slug}{r.approver && ` · ${r.approver}`}</span>
                  <p className="text-xs text-muted truncate">{r.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Dialog open={!!install} onClose={() => setInstall(undefined)} title="Add Elan1 Govern to Slack" description="Slack asks a workspace admin to allow these permissions. Nothing is connected until they do."
        footer={<><Button variant="ghost" loading={complete.pending} onClick={() => finishSlack('deny')}>Cancel install</Button><Button variant="primary" loading={complete.pending} disabled={workspace.trim().length < 2} onClick={() => finishSlack('allow')}>Allow</Button></>}>
        {install && (
          <div className="space-y-4 text-sm">
            <Field label="Workspace" htmlFor="slack-ws"><Input id="slack-ws" value={workspace} onChange={(e) => setWorkspace(e.target.value)} data-autofocus /></Field>
            <div>
              <p className="label mb-1.5">Permissions</p>
              <ul className="space-y-1">
                {install.scopes.map((x) => <li key={x} className="flex items-center gap-2"><span className="font-mono text-[12.5px]">{x}</span><span className="text-xs text-muted">{x === 'chat:write' ? 'post held actions' : x === 'commands' ? 'Approve and Reject buttons' : 'match people by work email'}</span></li>)}
              </ul>
            </div>
            <p className="text-xs text-muted">The install is checked with a one-time state value; cancelling records the attempt and connects nothing.</p>
          </div>
        )}
      </Dialog>
    </div>
  );
}
