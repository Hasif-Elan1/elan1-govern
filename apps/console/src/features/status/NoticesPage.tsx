import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, BellRing, CalendarClock, Check, CheckCircle2, CircleAlert, FileText, Mail, Server, ShieldCheck, UserRound } from 'lucide-react';
import { api } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import { useMemberRole } from '@/features/settings/permissions';
import { acknowledgeNotice, checkChainHead, noticesView, setNoticeContact, type ChainHeadStatement, type IncidentThread } from '@/mock/tenantNotices';
import { userName } from '@/mock/users';
import { dateTime, plural, relative, shortHash, timeShort } from '@/lib/format';
import { Badge, Banner, Button, DataTable, EmptyState, PageHeader, Panel, Select, Skeleton, StatusChip, Timeline, toast, type Column } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { errText, receiptNote } from '@/features/settings/shared';

const wait = (min = 150, max = 320) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
const noticesApi = {
  async view(orgId: string) { await wait(); return noticesView(orgId); },
  async setContact(orgId: string, contactId: string, userId: string) { await wait(250, 450); return setNoticeContact(orgId, contactId, userId); },
  async ack(orgId: string, id: string, title: string, userId: string) { await wait(200, 350); return acknowledgeNotice(orgId, id, title, userId); },
  async checkHead(orgId: string, id: string, userId: string) { await wait(300, 600); return checkChainHead(orgId, id, userId); },
};

/**
 * Notices from Elan1 — Agents door. What Elan1 tells a hosted organisation about the service it runs for it:
 * to one named contact, an update at least every 30 minutes during an incident, a post-incident note once it
 * is fixed, planned maintenance, and a daily statement of the chain head to check against the organisation's
 * own chain. Every acknowledgement and check is a receipt. A Sovereign deployment gets none of this over the
 * network.
 */
export default function NoticesPage() {
  useEffect(() => { document.title = 'Notices from Elan1 · Elan1 Govern'; }, []);
  const user = useUser();
  const role = useMemberRole();
  const level = useOrgLevel();
  const l1 = level === 'l1';
  const { data: v, loading, error, refetch } = useQuery((o) => noticesApi.view(o), [], { kinds: ['notice', 'receipt', 'member'] });
  const { data: members } = useQuery((o) => api.members(o), [], { kinds: ['member'] });
  const [contact, setContact] = useState<string>();
  const setC = useMutation(noticesApi.setContact);
  const manage = role === 'owner' || role === 'admin';
  const isContact = !!user && v?.contact.userId === user.id;
  const canAck = manage || isContact;
  const orgId = useOrgId();

  if (v && !v.deliverable) {
    return (
      <div className="space-y-6 overflow-x-clip">
        <PageHeader kicker="Agents" title="Notices from Elan1" description="Incident updates, post-incident notes, maintenance and the daily chain-head statement Elan1 sends to the organisations it hosts." />
        <Banner tone="info" title="Elan1 cannot reach this deployment">
          {v.orgName} runs Elan1 Govern on its own infrastructure with egress denied, so nothing arrives from Elan1 over the network and Elan1 publishes nothing about it. Your own components, the integrity of your chain and your timestamp authorities are on your local status page; release notes arrive with each signed update bundle on media.
        </Banner>
        <div className="flex flex-wrap gap-3">
          <Link to="/agents/deployment?tab=status" className="inline-flex items-center gap-1 link text-sm"><Server className="h-4 w-4" aria-hidden />Local status<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
          <Link to="/agents/deployment" className="inline-flex items-center gap-1 link text-sm">Update bundles<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
        </div>
      </div>
    );
  }

  const open = v?.incidents.filter((i) => i.status === 'open') ?? [];
  const unacked = v ? [...v.incidents.map((i) => i.id), ...v.maintenance.map((m) => m.id)].filter((id) => !v.acks[id]).length : 0;

  return (
    <div className="space-y-6 overflow-x-clip">
      <PageHeader kicker="Agents" title="Notices from Elan1"
        description="What Elan1 tells your organisation about the service it runs for you: one named contact, an update at least every 30 minutes while an incident touches you, a post-incident note once it is fixed, planned maintenance, and a daily statement of your chain head to check against your own chain."
        meta={v && <>
          {open.length > 0 ? <StatusChip tone="held" icon={<CircleAlert className="h-3.5 w-3.5" aria-hidden />}>{plural(open.length, 'open incident')}</StatusChip> : <StatusChip tone="ok" icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}>No open incident</StatusChip>}
          {unacked > 0 && <Badge>{plural(unacked, 'notice')} not acknowledged</Badge>}
          <Link to="/status" className="text-sm link inline-flex items-center gap-1">Public status<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
        </>} />

      {error && <Banner tone="bad" title="Notices could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      {loading && !v ? <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-64" /></div> : v && (
        <div className="grid gap-6 xl:grid-cols-12">
          <div className="xl:col-span-8 space-y-6 min-w-0">
            <Panel title={<span className="inline-flex items-center gap-2"><BellRing className="h-4 w-4" aria-hidden />Incidents that touched you</span>} kicker="Last 90 days" flush>
              {v.incidents.length === 0 ? <EmptyState compact title="No incidents touched this organisation" disc="trail">When one does, the named contact hears within 5 minutes and every 30 minutes after.</EmptyState> : (
                <ul className="divide-y divide-line">{v.incidents.map((inc) => <IncidentItem key={inc.id} inc={inc} ack={v.acks[inc.id]} canAck={canAck} />)}</ul>
              )}
            </Panel>
            <HeadsPanel heads={v.heads} checks={v.headChecks} l1={l1} noticeKey={v.noticeKey} />
          </div>

          <div className="xl:col-span-4 space-y-6 min-w-0">
            <Panel title={<span className="inline-flex items-center gap-2"><UserRound className="h-4 w-4" aria-hidden />Named contact</span>}
              footer={<>Elan1 sends every notice to this person by email and shows it here. Changing the contact is recorded.</>}>
              <p className="text-md font-semibold">{v.contact.name}</p>
              <p className="text-xs text-muted">{v.contact.isDefault ? 'The owner, until someone is named' : <>Named <When iso={v.contact.since} /></>}{v.contact.seq !== undefined && <> · <ReceiptLink seq={v.contact.seq} /></>}</p>
              {manage ? (
                <div className="mt-4 flex flex-wrap items-end gap-2">
                  <div className="flex-1 min-w-[160px]">
                    <label className="label" htmlFor="nc-who">Change to</label>
                    <Select id="nc-who" value={contact ?? v.contact.userId} onChange={(e) => setContact(e.target.value)}>
                      {(members ?? []).filter((m) => m.status === 'active' && m.role !== 'auditor').map((m) => <option key={m.userId} value={m.userId}>{userName(m.userId)} ({m.role})</option>)}
                    </Select>
                  </div>
                  <Button variant="secondary" loading={setC.pending} disabled={!user || !contact || (contact === v.contact.userId && !v.contact.isDefault)}
                    onClick={async () => { if (!user || !contact) return; try { const r = await setC.mutate(orgId, contact, user.id); toast.ok(`${userName(contact)} now receives Elan1’s notices`, receiptNote(r.seq)); setContact(undefined); } catch (e) { toast.bad('Not changed', errText(e)); } }}>Save</Button>
                </div>
              ) : <p className="mt-3 text-xs text-muted">Owners and admins name the contact.</p>}
            </Panel>

            <Panel title={<span className="inline-flex items-center gap-2"><CalendarClock className="h-4 w-4" aria-hidden />Planned maintenance</span>} flush>
              {v.maintenance.length === 0 ? <p className="p-5 text-sm text-muted">Nothing planned.</p> : (
                <ul className="divide-y divide-line">
                  {v.maintenance.map((m) => (
                    <li key={m.id} className="px-5 py-4">
                      <p className="text-sm font-semibold">{m.title}</p>
                      <p className="text-xs text-muted num">{dateTime(m.from)} – {timeShort(m.to)} IST · sent {relative(m.sentAt)}</p>
                      <p className="mt-1 text-sm text-fg/85">{m.note}</p>
                      <AckButton id={m.id} title={m.title} ack={v.acks[m.id]} canAck={canAck} />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel tone="sunken" title="What Elan1 commits to">
              <ul className="list-[square] pl-5 space-y-1.5 text-sm text-fg/85">
                <li>First notice within 5 minutes of an incident that touches you.</li>
                <li>An update at least every 30 minutes until it is fixed.</li>
                <li>A post-incident note within one working day: what happened, what it meant for your records, what changes.</li>
                <li>Planned maintenance announced at least 7 days ahead.</li>
                <li>Every day, a statement of your chain head as Elan1 holds it.</li>
              </ul>
              <p className="mt-3 text-xs text-muted">Not for Sovereign deployments: nothing reaches them from outside.</p>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

function AckButton({ id, title, ack, canAck }: { id: string; title: string; ack?: { at: string; by: string; seq: number }; canAck: boolean }) {
  const user = useUser();
  const orgId = useOrgId();
  const m = useMutation(noticesApi.ack);
  if (ack) return <p className="mt-2 text-xs text-muted inline-flex flex-wrap items-center gap-1"><Check className="h-3.5 w-3.5" aria-hidden />Acknowledged by {userName(ack.by)} <When iso={ack.at} /> · <ReceiptLink seq={ack.seq} /></p>;
  return (
    <Button className="mt-2" size="sm" variant="secondary" loading={m.pending} disabled={!canAck || !user} title={!canAck ? 'The named contact, owners and admins acknowledge notices.' : undefined}
      onClick={async () => { if (!user) return; try { const r = await m.mutate(orgId, id, title, user.id); toast.ok('Acknowledged', receiptNote(r.seq)); } catch (e) { toast.bad('Not acknowledged', errText(e)); } }}>Acknowledge</Button>
  );
}

function IncidentItem({ inc, ack, canAck }: { inc: IncidentThread; ack?: { at: string; by: string; seq: number }; canAck: boolean }) {
  const [open, setOpen] = useState(inc.status === 'open');
  const gaps = inc.updates.slice(1).map((u, i) => (new Date(u.at).getTime() - new Date(inc.updates[i].at).getTime()) / 60_000);
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-md font-semibold">{inc.title}</h3>
        {inc.status === 'resolved' ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Resolved</StatusChip> : <StatusChip tone="held" size="sm" icon={<CircleAlert className="h-3 w-3" aria-hidden />}>Open</StatusChip>}
        <span className="text-xs text-muted sm:ml-auto num">{dateTime(inc.startedAt)}{inc.resolvedAt ? ` – ${timeShort(inc.resolvedAt)} IST` : ''}</span>
      </div>
      <p className="mt-1 text-sm text-fg/85">{inc.impact}</p>
      <p className="mt-1 text-xs text-muted inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" aria-hidden />{plural(inc.updates.length, 'notice')} to the named contact · longest gap between updates {Math.round(maxGap)} minutes{maxGap <= 30 ? ' (within the 30-minute commitment)' : ''}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen((x) => !x)} aria-expanded={open}>{open ? 'Hide updates' : 'Show updates'}</Button>
      </div>
      {open && <div className="mt-3"><Timeline items={inc.updates.map((u) => ({ time: dateTime(u.at), title: u.text, tone: u.kind === 'resolved' ? 'ok' : u.kind === 'opened' ? 'held' : 'neutral' }))} /></div>}
      {inc.postIncident && (
        <div className="mt-4 border border-line bg-sunken/40 p-4">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold"><FileText className="h-4 w-4" aria-hidden />Post-incident note
            {inc.postIncident.publishedAt ? <span className="text-xs font-normal text-muted">sent {dateTime(inc.postIncident.publishedAt)}</span> : <Badge tone="held">Due by {dateTime(inc.postIncident.dueBy)}</Badge>}</p>
          {inc.postIncident.publishedAt ? (
            <dl className="mt-2 space-y-2 text-sm">
              <div><dt className="label">What happened</dt><dd className="mt-0.5 text-fg/85">{inc.postIncident.summary}</dd></div>
              <div><dt className="label">Cause</dt><dd className="mt-0.5 text-fg/85">{inc.postIncident.cause}</dd></div>
              <div><dt className="label">What it meant for your records</dt><dd className="mt-0.5 text-fg/85">{inc.postIncident.impactHere}</dd></div>
              <div><dt className="label">Receipts</dt><dd className="mt-0.5 text-fg/85">{inc.postIncident.receiptsAffected}</dd></div>
              <div><dt className="label">What changes</dt><dd><ul className="mt-0.5 list-[square] pl-5 space-y-0.5 text-fg/85">{inc.postIncident.changes.map((c) => <li key={c}>{c}</li>)}</ul></dd></div>
            </dl>
          ) : <p className="mt-1 text-sm text-muted">Elan1 sends it within one working day of the fix.</p>}
        </div>
      )}
      <AckButton id={inc.id} title={inc.title} ack={ack} canAck={canAck} />
    </li>
  );
}

function HeadsPanel({ heads, checks, l1, noticeKey }: { heads: ChainHeadStatement[]; checks: Record<string, { at: string; by: string; result: 'matches' | 'differs'; seq: number }>; l1: boolean; noticeKey: { kid: string; fingerprint: string } }) {
  const user = useUser();
  const orgId = useOrgId();
  const m = useMutation(noticesApi.checkHead);
  const [busy, setBusy] = useState<string>();
  const run = async (h: ChainHeadStatement) => {
    if (!user) return;
    setBusy(h.id);
    try {
      const r = await m.mutate(orgId, h.id, user.id);
      if (r.result === 'matches') toast.ok(`${h.date}: matches your chain`, `Receipt #${h.seq} has the hash Elan1 stated. ${receiptNote(r.seq)}`);
      else toast.bad(`${h.date}: does not match`, `${r.sigOk ? 'Your chain holds a different hash at that position.' : 'The statement does not verify against Elan1’s notice key.'} Raise it with Elan1 support. ${receiptNote(r.seq)}`);
    } catch (e) { toast.bad('Not checked', errText(e)); } finally { setBusy(undefined); }
  };
  const cols: Column<ChainHeadStatement>[] = [
    { key: 'date', header: 'Day', sort: (h) => h.date, cell: (h) => <span className="num text-sm">{h.date}</span> },
    { key: 'seq', header: 'Head', cell: (h) => <span className="font-mono text-[12.5px]">#{h.seq}</span> },
    { key: 'hash', header: 'Hash', hideBelow: 'md', cell: (h) => <span className="font-mono text-[12px] text-muted">{shortHash(h.hash, 16)}</span> },
    { key: 'sent', header: 'Sent', hideBelow: 'lg', cell: (h) => <When iso={h.at} className="text-xs text-muted" /> },
    {
      key: 'check', header: 'Against your chain', cell: (h) => {
        const c = checks[h.date];
        if (c) return <span className="flex flex-col gap-0.5">{c.result === 'matches' ? <StatusChip tone="ok" size="sm" icon={<ShieldCheck className="h-3 w-3" aria-hidden />}>Matches</StatusChip> : <StatusChip tone="bad" size="sm" icon={<CircleAlert className="h-3 w-3" aria-hidden />}>Does not match</StatusChip>}<span className="text-xs text-muted">{userName(c.by)} · <ReceiptLink seq={c.seq} /></span></span>;
        return <Button size="sm" variant="secondary" loading={busy === h.id} disabled={!user} onClick={() => run(h)}>Check</Button>;
      },
    },
  ];
  return (
    <Panel title={<span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4" aria-hidden />Daily chain-head statement</span>} kicker="Last 14 days" flush
      footer={<>Each day at 00:15 IST Elan1 states the last receipt it holds for you on the day before, with its hash, under its notice key <span className="font-mono">{noticeKey.kid}</span> (fingerprint <span className="font-mono">{noticeKey.fingerprint}</span>). Checking compares it with your own chain {l1 ? '(sealed in a hash chain at L1)' : '(signed with your key)'}; a mismatch means someone holds a different history from you. Each check is a receipt.</>}>
      <DataTable caption="Daily chain-head statements" className="border-0" columns={cols} rows={heads} rowKey={(h) => h.id} maxHeight={420}
        empty={<EmptyState compact title="No statement yet" disc="trail">The first one arrives the morning after your first receipt.</EmptyState>} />
    </Panel>
  );
}
