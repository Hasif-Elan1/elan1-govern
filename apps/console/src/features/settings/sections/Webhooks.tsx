import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CirclePause, Ellipsis, Inbox, KeyRound, Plus, RotateCw, Send, ShieldOff, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useRole, useUser } from '@/store/session';
import type { Webhook } from '@/types';
import { dateTime, n, plural } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, Checkbox, CodeBlock, CopyButton, DataTable, Dialog, EmptyState, Field, IconButton, Input, Menu, Panel, Segmented, StatusChip, Tabs, toast, type Column } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { ReadOnlyNote, SectionHeader, errText, receiptNote } from '../shared';
import { WEBHOOK_EVENTS, orgApi, type DeadLetter, type ExtEvent } from '../orgApi';
import { SmartLink } from '@/shell/access';
import { egressGuard, isSovereignOrg } from '@/features/deployment/sovereignApi';
import { blockedEndpointIds, internalHosts } from '@/mock/sovereign';

type Endpoint = Omit<Webhook, 'events'> & { events: ExtEvent[] };
type Delivery = Webhook['deliveries'][number];

function StatusOf({ w, blocked }: { w: Endpoint; blocked?: boolean }) {
  if (blocked && w.status !== 'disabled') return <StatusChip tone="bad" size="sm" icon={<ShieldOff className="h-3 w-3" />}>Blocked: egress denied</StatusChip>;
  if (w.status === 'active') return <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Active</StatusChip>;
  if (w.status === 'failing') return <StatusChip tone="bad" size="sm" icon={<AlertTriangle className="h-3 w-3" />}>Failing</StatusChip>;
  return <StatusChip tone="neutral" size="sm" icon={<CirclePause className="h-3 w-3" />}>Disabled</StatusChip>;
}

function Code({ status }: { status: number }) {
  const ok = status >= 200 && status < 300;
  return <StatusChip tone={ok ? 'ok' : 'bad'} size="sm" icon={ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}><span className="font-mono">{status}</span></StatusChip>;
}

export function WebhooksSection() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const canEdit = useCan('settings.integrations');
  // Sovereign: deny-all egress — only hosts on the internal allow-list can receive deliveries (mock/sovereign.ts)
  const sov = isSovereignOrg(orgId);
  const { data: allowed } = useQuery(async (o) => (isSovereignOrg(o) ? internalHosts(o) : []), [], { kinds: ['deployment'] });
  // Sovereign: read the allow-list state first, so seeded endpoints are already pointed inside the network
  const { data, loading, error, refetch } = useQuery((o) => { if (isSovereignOrg(o)) internalHosts(o); return orgApi.webhooks(o); }, [], { kinds: ['webhook', 'receipt', 'deployment'] });
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState<'all' | 'failed'>('all');
  const [addOpen, setAddOpen] = useState(false);
  const [secret, setSecret] = useState<{ url: string; secret: string; previousValidUntil?: string }>();
  const [del, setDel] = useState<Endpoint>();
  const [lang, setLang] = useState<'ts' | 'py'>('ts');
  const replay = useMutation(orgApi.replayDeadLetters);
  const add = useMutation(orgApi.addWebhook);
  // the add dialog's own error, cleared each time it opens (useMutation keeps its last error)
  const [addErr, setAddErr] = useState<string>();
  const openAdd = () => { setAddErr(undefined); setAddOpen(true); };

  const endpoints = data?.endpoints;
  useEffect(() => { if (endpoints?.length && !endpoints.some((w) => w.id === selected)) setSelected(endpoints[0].id); }, [endpoints, selected]);
  const current = endpoints?.find((w) => w.id === selected);
  const waiting = (data?.deadLetter ?? []).filter((l) => !l.replayedAt || (l.replayStatus ?? 0) >= 300);

  const act = async <T,>(fn: () => Promise<T>, ok: (r: T) => [string, string?], bad = 'Not changed') => {
    try { const r = await fn(); const [t, b] = ok(r); toast.ok(t, b); return r; } catch (e) { toast.bad(bad, errText(e)); }
  };

  // Sovereign: every action that would connect to an endpoint goes through the egress guard first. A host outside the
  // allow-list is refused before anything is sent, logged in the egress log and recorded as egress.blocked.
  const blocked = useMemo(() => new Set(sov && endpoints ? blockedEndpointIds(orgId, endpoints) : []), [sov, orgId, endpoints, allowed]);
  const guarded = <T,>(urls: string[], fn: () => Promise<T>): Promise<T> => {
    if (sov && user) {
      try { for (const u of new Set(urls)) egressGuard(orgId, u, 'Webhook dispatcher', user.id); } catch (e) { return Promise.reject(e); }
    }
    return fn();
  };

  const sendTest = (w: Endpoint) => user && guarded([w.url], () => orgApi.sendTestEvent(orgId, w.id, user.id)).then((d) => {
    if (d.status < 300) toast.ok('Test event delivered', `${d.event} · ${d.status} in ${n(d.ms)} ms. Test events carry "test": true and are not receipts.`);
    else toast.bad('Test event failed', `${d.event} · the endpoint answered ${d.status}. Fix the endpoint, then disable and enable it to clear the failing state.`);
  }).catch((e) => toast.bad('Not sent', errText(e)));

  const resend = (w: Endpoint, d: Delivery) => user && guarded([w.url], () => orgApi.resendDelivery(orgId, w.id, d.id, user.id)).then((nd) => {
    if (nd.status < 300) toast.ok('Delivery resent', `${nd.event} · ${nd.status} in ${n(nd.ms)} ms. Same event id, so your endpoint can de-duplicate.`);
    else toast.bad('Resend failed', `The endpoint answered ${nd.status}.`);
  }).catch((e) => toast.bad('Not resent', errText(e)));

  // disabling never connects anywhere; enabling would start deliveries, so it is guarded
  const setStatus = (w: Endpoint, status: 'active' | 'disabled') => user && act(() => guarded(status === 'active' ? [w.url] : [], () => orgApi.setWebhookStatus(orgId, w.id, status, user.id)), (r) => [status === 'disabled' ? 'Endpoint disabled' : 'Endpoint enabled', `${status === 'active' && w.status !== 'active' ? 'Deliveries are tried again; replay the dead letters below. ' : ''}${receiptNote(r.seq)}`]);
  const roll = (w: Endpoint) => user && act(() => orgApi.rollSecret(orgId, w.id, user.id), (r) => { setSecret({ url: w.url, secret: r.secret, previousValidUntil: r.previousValidUntil }); return ['Secret rolled', receiptNote(r.seq)]; });
  const remove = async () => {
    if (!del || !user) return;
    await act(() => orgApi.deleteWebhook(orgId, del.id, user.id), (r) => ['Endpoint deleted', receiptNote(r.seq)]);
    setDel(undefined);
  };
  // replay connects to every enabled endpoint that has a waiting dead letter (disabled endpoints are skipped)
  const replayTargets = (webhookId?: string) => waiting.filter((l) => !webhookId || l.webhookId === webhookId)
    .map((l) => endpoints?.find((w) => w.id === l.webhookId)).filter((w): w is Endpoint => !!w && w.status !== 'disabled').map((w) => w.url);
  const replayAll = (webhookId?: string) => user && act(() => guarded(replayTargets(webhookId), () => replay.mutate(orgId, user.id, webhookId)), (r) => [r.failed ? `${r.ok} delivered, ${r.failed} still failing` : `${plural(r.ok, 'event')} delivered`, receiptNote(r.seq)], 'Replay failed');

  const columns: Column<Endpoint>[] = [
    { key: 'url', header: 'Endpoint', cell: (w) => <span className="block py-2 min-w-0"><span className="block font-mono text-[12.5px] truncate max-w-[340px]" title={w.url}>{w.url}</span><span className="mt-1 flex flex-wrap gap-1">{w.events.map((e) => <Badge key={e}>{e}</Badge>)}</span></span> },
    { key: 'status', header: 'Status', cell: (w) => <StatusOf w={w} blocked={blocked.has(w.id)} /> },
    { key: 'secret', header: 'Secret', hideBelow: 'md', cell: (w) => { const r = data?.rolls.find((x) => x.webhookId === w.id && new Date(x.previousValidUntil).getTime() > Date.now()); return <span className="font-mono text-[12px] text-muted">{w.secretPrefix}…{r && <span className="block font-sans text-[11px]">old secret valid until {dateTime(r.previousValidUntil)}</span>}</span>; } },
    { key: 'last', header: 'Last delivery', hideBelow: 'sm', cell: (w) => w.deliveries[0] ? <span className="inline-flex items-center gap-2"><Code status={w.deliveries[0].status} /><When iso={w.deliveries[0].ts} className="text-xs text-muted" /></span> : <span className="text-subtle">—</span> },
    // roles that cannot change integrations read the endpoints without the actions menu
    ...(!canEdit ? [] : [{
      key: 'act', header: <span className="sr-only">Actions</span>, align: 'right' as const, width: 56,
      cell: (w: Endpoint) => (
        <Menu width={230} trigger={({ toggle }) => <IconButton label={`Actions for ${w.url}`} size="sm" onClick={(e) => { e.stopPropagation(); toggle(); }}><Ellipsis className="h-4 w-4" /></IconButton>} items={[
          { label: 'Send test event', icon: <Send className="h-4 w-4" />, onSelect: () => sendTest(w), disabled: w.status === 'disabled' },
          { label: 'Roll signing secret', icon: <KeyRound className="h-4 w-4" />, onSelect: () => roll(w) },
          { label: w.status === 'disabled' ? 'Enable' : 'Disable', icon: <CirclePause className="h-4 w-4" />, onSelect: () => setStatus(w, w.status === 'disabled' ? 'active' : 'disabled') },
          'sep',
          { label: 'Delete endpoint', icon: <Trash2 className="h-4 w-4" />, danger: true, onSelect: () => setDel(w) },
        ]} />
      ),
    }]),
  ];

  const deliveries = useMemo(() => (current?.deliveries ?? []).filter((d) => filter === 'all' || d.status >= 300), [current, filter]);
  const failed = current?.deliveries.filter((d) => d.status >= 300).length ?? 0;
  const delColumns: Column<Delivery>[] = [
    { key: 'event', header: 'Event', cell: (d) => <span className="font-mono text-[12.5px]">{d.event}</span> },
    { key: 'ts', header: 'Sent', sort: (d) => d.ts, cell: (d) => <When iso={d.ts} className="text-sm" /> },
    { key: 'status', header: 'Response', sort: (d) => d.status, cell: (d) => <Code status={d.status} /> },
    { key: 'attempts', header: 'Attempts', align: 'right', hideBelow: 'sm', sort: (d) => d.attempts, cell: (d) => <span className={cn(d.attempts > 1 && 'text-held-fg')}>{d.attempts} / 8</span> },
    { key: 'ms', header: 'Latency', align: 'right', hideBelow: 'sm', sort: (d) => d.ms, cell: (d) => `${n(d.ms)} ms` },
    { key: 'id', header: 'Delivery id', hideBelow: 'lg', cell: (d) => <span className="font-mono text-[12px] text-muted">{d.id}</span> },
    ...(!canEdit ? [] : [{ key: 'resend', header: <span className="sr-only">Resend</span>, align: 'right' as const, cell: (d: Delivery) => <Button size="sm" variant="ghost" icon={<RotateCw className="h-3.5 w-3.5" />} disabled={!current || current.status === 'disabled'} onClick={() => current && resend(current, d)}>Resend</Button> }]),
  ];
  const dlColumns: Column<DeadLetter>[] = [
    { key: 'event', header: 'Event', cell: (l) => <span className="font-mono text-[12.5px]">{l.event}</span> },
    { key: 'url', header: 'Endpoint', hideBelow: 'md', cell: (l) => <span className="font-mono text-[12px] truncate block max-w-[260px]" title={l.url}>{l.url}</span> },
    { key: 'ts', header: 'Gave up', sort: (l) => l.ts, cell: (l) => <When iso={l.ts} className="text-sm" /> },
    { key: 'status', header: 'Last response', cell: (l) => <Code status={l.replayStatus ?? l.lastStatus} /> },
    { key: 'seq', header: 'Receipt', hideBelow: 'sm', cell: (l) => l.seq ? <ReceiptLink seq={l.seq} /> : <span className="text-subtle">—</span> },
  ];

  const sample = lang === 'ts' ? TS_SAMPLE : PY_SAMPLE;
  const failingCount = endpoints?.filter((w) => w.status === 'failing' && !blocked.has(w.id)).length ?? 0;
  const blockedActive = endpoints?.filter((w) => blocked.has(w.id) && w.status !== 'disabled') ?? [];

  return (
    <div>
      <SectionHeader
        title="Webhooks"
        description="Send events to your own systems — a SIEM, a ticketing bridge, a data lake. Each delivery is signed with HMAC-SHA256 using the endpoint’s secret, and every event goes through a durable outbox."
        actions={canEdit ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={openAdd}>Add endpoint</Button> : undefined}
      />
      {!canEdit && <ReadOnlyNote role={role} who="Owners and admins" />}
      {sov && (
        <Banner tone="info" className="mb-6" title="Egress is denied: endpoints must be inside your network"
          actions={<SmartLink to="/agents/deployment?tab=egress" hideWhenBlocked className="text-sm link whitespace-nowrap">Internal allow-list</SmartLink>}>
          This deployment sends nothing to the internet, so an endpoint can only be a host on the internal allow-list{allowed?.length ? <>: {allowed.map((h, i) => <span key={h.host}>{i ? ', ' : ''}<span className="font-mono text-[12.5px]">{h.host}</span></span>)}</> : ''}. An outside address is refused and the attempt is recorded. Sending a test event, resending, enabling and replaying are checked the same way.
        </Banner>
      )}
      {sov && blockedActive.length > 0 && (
        <Banner tone="bad" className="mb-6" title={`${plural(blockedActive.length, 'endpoint')} cannot be reached under deny-all egress`}>
          {blockedActive.map((w, i) => <span key={w.id}>{i ? ', ' : ''}<span className="font-mono text-[12.5px] break-all">{w.url}</span></span>)} {blockedActive.length === 1 ? 'is' : 'are'} not on the internal allow-list, so nothing is delivered: the outbox skips {blockedActive.length === 1 ? 'it' : 'them'} and each attempt appears in the egress log. Disable or delete {blockedActive.length === 1 ? 'it' : 'them'}, or have an owner add the host to the allow-list if it is inside your network.
        </Banner>
      )}
      {error && <Banner tone="bad" className="mb-6" title="Webhooks could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      {failingCount > 0 && (
        <Banner tone="bad" className="mb-6" title={`${plural(failingCount, 'endpoint')} failing`}>
          Recent deliveries got 5xx responses. The outbox retries each event up to 8 times with backoff; anything still undelivered waits in the dead-letter list below, where you replay it once the endpoint is fixed. No event is dropped.
        </Banner>
      )}

      <DataTable
        caption="Webhook endpoints"
        columns={columns}
        rows={endpoints}
        loading={loading}
        rowKey={(w) => w.id}
        selectedKey={selected}
        onRowClick={(w) => setSelected(w.id)}
        empty={<EmptyState compact title="No endpoints yet" disc="control-plane" action={canEdit ? <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={openAdd}>Add endpoint</Button> : undefined}>Add an endpoint to receive approvals, escalations, the emergency stop or every receipt.</EmptyState>}
      />

      {current && (
        <Panel className="mt-6" kicker="Delivery log" title={<span className="font-mono text-[14px]">{current.url}</span>}
          actions={<>
            <Segmented size="sm" label="Filter deliveries" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All', count: current.deliveries.length }, { value: 'failed', label: 'Failed', count: failed }]} />
            {canEdit && <Button size="sm" variant="secondary" icon={<Send className="h-3.5 w-3.5" />} disabled={current.status === 'disabled'} onClick={() => sendTest(current)}>Send test event</Button>}
          </>} flush>
          <DataTable caption="Deliveries" columns={delColumns} rows={deliveries} rowKey={(d) => d.id} className="border-0" maxHeight={420}
            empty={<EmptyState compact title={filter === 'failed' ? 'No failed deliveries' : 'No deliveries yet'} disc="trail">{filter === 'failed' ? 'Every recent delivery got a 2xx response.' : canEdit ? 'Send a test event to check the endpoint.' : 'Nothing has been sent to this endpoint.'}</EmptyState>} />
        </Panel>
      )}

      <Panel className="mt-6" title={<span className="inline-flex items-center gap-2"><Inbox className="h-4 w-4" aria-hidden />Dead letters</span>} flush
        actions={canEdit && <Button size="sm" variant="secondary" icon={<RotateCw className="h-3.5 w-3.5" />} loading={replay.pending} disabled={waiting.length === 0} title={waiting.length === 0 ? 'Nothing waiting.' : undefined} onClick={() => replayAll()}>Replay all</Button>}
        footer="Events that ran out of retries, kept for 30 days. Replaying sends the same event id; endpoints that are still disabled are skipped.">
        <DataTable caption="Undelivered events" columns={dlColumns} rows={waiting} rowKey={(l) => l.id} className="border-0" maxHeight={320}
          empty={<EmptyState compact title="Nothing waiting" disc="trail">Every event reached its endpoint.</EmptyState>} />
      </Panel>

      <div className="mt-6 grid gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-5" title="How signing works">
          <ol className="space-y-3 text-sm">
            <li><span className="font-medium">1.</span> We send a POST with a JSON body and the header <span className="font-mono text-[12.5px]">elan1-signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</span>.</li>
            <li><span className="font-medium">2.</span> <span className="font-mono text-[12.5px]">v1</span> is HMAC-SHA256 over <span className="font-mono text-[12.5px]">"&lt;t&gt;.&lt;raw body&gt;"</span> with your endpoint secret. For 24 hours after a roll, a second <span className="font-mono text-[12.5px]">v1</span> signed with the old secret is added.</li>
            <li><span className="font-medium">3.</span> Recompute it, compare in constant time, and reject anything older than 5 minutes to stop replays.</li>
            <li><span className="font-medium">4.</span> Answer 2xx within 10 seconds. Anything else is retried with backoff, up to 8 attempts, then dead-lettered.</li>
          </ol>
          <p className="mt-4 text-xs text-muted">Receipt events carry the receipt’s seq and hash, so you can fetch the receipt itself and check it against the chain — the webhook signature only proves the delivery came from Elan1 Govern.</p>
        </Panel>
        <div className="xl:col-span-7 min-w-0">
          <Tabs className="mb-3" label="Sample language" value={lang} onChange={setLang} items={[{ value: 'ts', label: 'TypeScript (Node)' }, { value: 'py', label: 'Python' }]} />
          <CodeBlock title="Verify a delivery" code={sample} maxHeight={360} />
        </div>
      </div>

      <AddEndpointDialog open={addOpen} onClose={() => setAddOpen(false)} pending={add.pending} error={addErr} allowedHosts={sov ? (allowed ?? []).map((h) => h.host) : undefined}
        onAdd={async (url, events) => {
          if (!user) return;
          setAddErr(undefined);
          try {
            if (sov) egressGuard(orgId, url, 'Webhook dispatcher', user.id); // throws, logged and recorded, for an outside address
            const r = await add.mutate(orgId, url, events, user.id);
            setSelected(r.webhook.id);
            setAddOpen(false);
            setSecret({ url, secret: r.secret });
            toast.ok('Endpoint added', receiptNote(r.seq));
          } catch (e) { setAddErr(errText(e)); /* shown in the dialog */ }
        }} />

      <Dialog open={!!secret} onClose={() => setSecret(undefined)} title="Copy the signing secret now" description="This is the only time the full secret is shown. Store it where your endpoint can read it."
        footer={<Button variant="primary" onClick={() => setSecret(undefined)}>I have stored it</Button>}>
        {secret && (
          <div className="space-y-3">
            <p className="text-sm text-muted break-all">For <span className="font-mono text-fg">{secret.url}</span></p>
            <div className="flex items-center gap-2">
              <span className="h-10 flex-1 min-w-0 inline-flex items-center px-3 border border-line bg-sunken font-mono text-[12.5px] truncate">{secret.secret}</span>
              <CopyButton text={secret.secret} label="Copy secret" />
            </div>
            <Banner tone="held">{secret.previousValidUntil ? <>The previous secret keeps working until {dateTime(secret.previousValidUntil)} so you can switch without dropping deliveries.</> : <>After you close this, only the prefix {secret.secret.slice(0, 10)}… is shown. Roll the secret from the endpoint’s menu to change it.</>}</Banner>
          </div>
        )}
      </Dialog>

      <Dialog open={!!del} onClose={() => setDel(undefined)} size="sm" tone="danger" title="Delete endpoint"
        footer={<><Button variant="ghost" onClick={() => setDel(undefined)}>Cancel</Button><Button variant="danger" onClick={remove}>Delete endpoint</Button></>}>
        <p className="text-sm">Deliveries to <span className="font-mono break-all">{del?.url}</span> stop at once. Receipts are unaffected; they stay on the chain.</p>
      </Dialog>
    </div>
  );
}

function AddEndpointDialog({ open, onClose, onAdd, pending, error, allowedHosts }: { open: boolean; onClose: () => void; onAdd: (url: string, events: ExtEvent[]) => void; pending: boolean; error?: string; allowedHosts?: string[] }) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<ExtEvent[]>(['approval.pending', 'approval.resolved']);
  const [tried, setTried] = useState(false);
  useEffect(() => { if (open) { setUrl(''); setEvents(['approval.pending', 'approval.resolved']); setTried(false); } }, [open]);
  const urlErr = !/^https:\/\/[^\s/]+\.[^\s]+$/.test(url.trim()) ? 'Enter an https:// URL. Plain http is not accepted.' : undefined;
  const evErr = events.length === 0 ? 'Choose at least one event.' : undefined;
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Add endpoint" description="We sign every delivery. You will see the secret once, after adding."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={pending} icon={<WebhookIcon className="h-4 w-4" />} onClick={() => { setTried(true); if (!urlErr && !evErr) onAdd(url.trim(), events); }}>Add endpoint</Button></>}>
      <div className="space-y-5">
        <Field label="Endpoint URL" htmlFor="wh-url" required error={tried ? urlErr : undefined}
          hint={allowedHosts ? (allowedHosts.length ? `Egress is denied. Allowed internal hosts: ${allowedHosts.join(', ')}.` : 'Egress is denied and the internal allow-list is empty: add a host under Agents › Deployment › Egress first.') : undefined}>
          <Input id="wh-url" mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder={allowedHosts?.[0] ? `https://${allowedHosts[0]}/elan1` : 'https://hooks.example.com/elan1'} invalid={tried && !!urlErr} data-autofocus />
        </Field>
        <fieldset>
          <legend className="text-sm font-medium mb-2">Events</legend>
          <div className="border border-line divide-y divide-line max-h-[42vh] overflow-y-auto">
            {WEBHOOK_EVENTS.map((e) => (
              <div key={e.id} className="px-3 py-2.5">
                <Checkbox checked={events.includes(e.id)} onChange={(v) => setEvents((x) => (v ? [...x, e.id] : x.filter((y) => y !== e.id)))} label={<span className="font-mono text-[13px]">{e.id}</span>} description={e.what} />
              </div>
            ))}
          </div>
          {tried && evErr && <p className="mt-1.5 text-xs text-bad-fg" role="alert">{evErr}</p>}
        </fieldset>
        {error && <Banner tone="bad">{error}</Banner>}
      </div>
    </Dialog>
  );
}

const TS_SAMPLE = `import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody: the exact bytes received — verify before parsing JSON.
// During a secret roll the header carries two v1 values; accept either.
export function verifyElan1Webhook(rawBody: string, header: string, secret: string) {
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false; // 5-minute window

  const expected = Buffer.from(createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex'), 'hex');
  return parts.filter(([k]) => k === 'v1').some(([, v]) => {
    const got = Buffer.from(v, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

// Express
app.post('/elan1', express.raw({ type: 'application/json' }), (req, res) => {
  const ok = verifyElan1Webhook(req.body.toString('utf8'), req.get('elan1-signature') ?? '', process.env.ELAN1_WEBHOOK_SECRET!);
  if (!ok) return res.status(400).end();
  const event = JSON.parse(req.body.toString('utf8'));
  // event.id is stable across retries and replays — de-duplicate on it
  res.status(204).end();
});`;

const PY_SAMPLE = `import hmac, hashlib, time

def verify_elan1_webhook(raw_body: bytes, header: str, secret: str) -> bool:
    parts = [p.split("=", 1) for p in header.split(",")]
    t = int(next((v for k, v in parts if k == "t"), "0"))
    if abs(time.time() - t) > 300:          # 5-minute window
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    # during a secret roll the header carries two v1 values; accept either
    return any(hmac.compare_digest(expected, v) for k, v in parts if k == "v1")

# Flask
@app.post("/elan1")
def elan1():
    if not verify_elan1_webhook(request.get_data(), request.headers.get("elan1-signature", ""), SECRET):
        return "", 400
    event = request.get_json()   # de-duplicate on event["id"]
    return "", 204`;
