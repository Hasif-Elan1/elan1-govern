import { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Clock3, KeyRound, Plus, ShieldCheck } from 'lucide-react';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { date, dateTime } from '@/lib/format';
import { userName } from '@/mock/users';
import { Badge, Banner, Button, Checkbox, CopyButton, DataTable, Dialog, Field, Input, Panel, RadioCards, Select, StatusChip, Textarea, toast, type Column } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { errText, receiptNote } from '@/features/settings/shared';
import { TOKEN_CLASSES, collectToken, decideToken, issueToken, listTokens, needsSecondPerson, revokeToken, tokenExpired, withdrawToken, type PlatformToken, type TokenClass } from './tokenStore';

/**
 * Agents › Keys › Platform tokens: the control token and the read-only operations token, beside the agent keys
 * (the tenant tokens). Owners and admins issue, list and revoke them; a control token from L2 needs a second
 * owner or admin. The secret is shown once. Every step is a receipt.
 */
export function PlatformTokensPanel() {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const canManage = useCan('agents.keys');
  const sovereign = level === 'sovereign';
  const dual = atLeast(level, 'l2');
  const { data, loading, error, refetch } = useQuery((o) => listTokens(o), [], { kinds: ['token', 'receipt'] });
  const [issuing, setIssuing] = useState(false);
  const [revoking, setRevoking] = useState<PlatformToken>();
  const [declining, setDeclining] = useState<PlatformToken>();
  const [secret, setSecret] = useState<{ secret: string; seq: number; label: string }>();
  const [busy, setBusy] = useState<string>();
  const [showClosed, setShowClosed] = useState(false);

  const act = async (id: string, fn: () => Promise<{ secret?: string; receipt: { seq: number }; token: PlatformToken }>, done: string) => {
    setBusy(id);
    try {
      const r = await fn();
      if (r.secret) setSecret({ secret: r.secret, seq: r.receipt.seq, label: r.token.label });
      else toast.ok(done, receiptNote(r.receipt.seq));
    } catch (e) { toast.bad('Not done', errText(e)); } finally { setBusy(undefined); }
  };

  const rows = (data ?? []).filter((t) => showClosed || t.status === 'active' || t.status === 'requested' || t.status === 'approved');

  const statusChip = (t: PlatformToken) => {
    if (tokenExpired(t)) return <StatusChip tone="neutral" size="sm" icon={<Clock3 className="h-3 w-3" />}>Expired</StatusChip>;
    switch (t.status) {
      case 'active': return <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Active</StatusChip>;
      case 'requested': return <StatusChip tone="held" size="sm" icon={<Clock3 className="h-3 w-3" />}>Waiting for a second person</StatusChip>;
      case 'approved': return <StatusChip tone="held" size="sm" icon={<ShieldCheck className="h-3 w-3" />}>Approved · collect once</StatusChip>;
      case 'revoked': return <StatusChip tone="neutral" size="sm" icon={<Ban className="h-3 w-3" />}>Revoked</StatusChip>;
      default: return <StatusChip tone="neutral" size="sm">{t.status === 'declined' ? 'Declined' : 'Withdrawn'}</StatusChip>;
    }
  };

  const columns: Column<PlatformToken>[] = [
    { key: 'token', header: 'Token', sort: (t) => t.label, cell: (t) => <span className="block py-1.5"><span className="font-mono text-[12.5px]">{t.prefix ? `${t.prefix}…` : `${TOKEN_CLASSES[t.cls].prefix}… (not issued)`}</span><span className="block text-xs text-muted truncate max-w-[240px]">{t.label}</span></span> },
    { key: 'class', header: 'Class', sort: (t) => t.cls, cell: (t) => <Badge tone={t.cls === 'control' ? 'inverse' : 'neutral'}>{t.cls === 'control' ? 'Control' : 'Read-only operations'}</Badge> },
    { key: 'status', header: 'Status', sort: (t) => t.status, cell: statusChip },
    {
      key: 'who', header: 'Asked · approved', hideBelow: 'lg',
      cell: (t) => <span className="text-xs text-muted">{userName(t.requestedBy)} {date(t.requestedAt)}{t.approvedBy ? <> · approved by {userName(t.approvedBy)}</> : null}{t.revokedBy ? <> · revoked by {userName(t.revokedBy)}</> : null}</span>,
    },
    { key: 'expires', header: 'Expires', hideBelow: 'md', sort: (t) => t.expiresAt ?? '9', cell: (t) => <span className="text-sm text-muted">{t.expiresAt ? date(t.expiresAt) : 'Never'}</span> },
    { key: 'seq', header: 'Receipt', hideBelow: 'sm', cell: (t) => { const s = t.seqs.revoked ?? t.seqs.closed ?? t.seqs.issued ?? t.seqs.approved ?? t.seqs.requested; return s ? <ReceiptLink seq={s} /> : <span className="text-subtle">—</span>; } },
    // The actions column exists only for roles that manage keys; read-only roles get no empty column.
    ...(!canManage ? [] : [{
      key: 'act', header: <span className="sr-only">Actions</span>, align: 'right' as const,
      cell: (t: PlatformToken) => {
        if (!user) return null;
        const mine = t.requestedBy === user.id;
        if (t.status === 'requested') return (
          <div className="flex justify-end gap-2">
            {mine
              ? <Button size="sm" variant="ghost" loading={busy === t.id} onClick={() => act(t.id, () => withdrawToken(orgId, t.id, user.id), 'Request withdrawn')}>Withdraw</Button>
              : <>
                <Button size="sm" variant="quiet-danger" disabled={!!busy} onClick={() => setDeclining(t)}>Decline</Button>
                <Button size="sm" variant="primary" loading={busy === t.id} onClick={() => act(t.id, () => decideToken(orgId, t.id, true, user.id), 'Control token approved')}>Approve</Button>
              </>}
          </div>
        );
        // approved: no Withdraw (only a request still waiting can be withdrawn, and only by the person who asked)
        if (t.status === 'approved') return (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="primary" icon={<KeyRound className="h-3.5 w-3.5" />} loading={busy === t.id} onClick={() => act(t.id, () => collectToken(orgId, t.id, user.id), 'Collected')}>Collect</Button>
          </div>
        );
        if (t.status === 'active') return <div className="flex justify-end"><Button size="sm" variant="quiet-danger" onClick={() => setRevoking(t)}>Revoke</Button></div>;
        return null;
      },
    } satisfies Column<PlatformToken>]),
  ];

  return (
    <Panel className="mt-8" title="Control and operations tokens" kicker="Platform tokens" flush
      actions={canManage ? <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setIssuing(true)}>Issue a token</Button> : undefined}
      footer={`Each token is shown once; Elan1 Govern keeps only a hash and the prefix. Issuing, approving, collecting and revoking are each recorded on the chain.${sovereign ? ' Issued and checked inside your network: nothing leaves it.' : ''}`}>
      <div className="grid gap-px bg-line border-b border-line sm:grid-cols-3 text-sm">
        <div className="bg-surface p-4"><p className="font-semibold">Tenant token <span className="font-mono text-[12px] font-normal text-muted">gk_ · sk_sbx_</span></p><p className="mt-1 text-xs text-muted">The agent keys above: one tenant, one actor, one autonomy level. The only class that reaches the write endpoints.</p></div>
        {(Object.keys(TOKEN_CLASSES) as TokenClass[]).map((c) => (
          <div key={c} className="bg-surface p-4"><p className="font-semibold">{TOKEN_CLASSES[c].label} <span className="font-mono text-[12px] font-normal text-muted">{TOKEN_CLASSES[c].prefix}</span></p><p className="mt-1 text-xs text-muted">{TOKEN_CLASSES[c].can} {TOKEN_CLASSES[c].cannot}{c === 'control' && dual ? ' Issuing one needs a second owner or admin.' : ''}</p></div>
        ))}
      </div>
      {error && <div className="p-5"><Banner tone="bad" title="Tokens could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner></div>}
      <div className="flex items-center justify-end px-5 py-2.5 border-b border-line">
        <Checkbox checked={showClosed} onChange={setShowClosed} label="Show revoked and closed" />
      </div>
      <DataTable caption="Control and operations tokens" columns={columns} rows={data ? rows : undefined} loading={loading} rowKey={(t) => t.id} className="border-0"
        empty={<p className="px-5 py-4 text-sm text-muted">No control or operations token. Agents use agent keys{canManage ? '; issue one of these only for a control-plane job or for monitoring' : ''}.</p>} />
      {issuing && <IssueTokenDialog onClose={() => setIssuing(false)} onSecret={(s) => { setIssuing(false); setSecret(s); }} />}
      {revoking && <RevokeTokenDialog token={revoking} onClose={() => setRevoking(undefined)} />}
      {declining && <DeclineTokenDialog token={declining} onClose={() => setDeclining(undefined)} />}
      {secret && <SecretOnceDialog value={secret} onClose={() => setSecret(undefined)} />}
    </Panel>
  );
}

function IssueTokenDialog({ onClose, onSecret }: { onClose: () => void; onSecret: (s: { secret: string; seq: number; label: string }) => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [cls, setCls] = useState<TokenClass>('operations');
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('90');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dual = needsSecondPerson(orgId, cls);
  const go = async () => {
    if (!user) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await issueToken(orgId, { cls, label, expiresDays: expiry === 'never' ? undefined : Number(expiry) }, user.id);
      if (r.secret) onSecret({ secret: r.secret, seq: r.receipt.seq, label: r.token.label });
      else { toast.held('Control token requested', `A different owner or admin approves it; then it is collected once. ${receiptNote(r.receipt.seq)}`); onClose(); }
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Issue a platform token"
      description="A control token or a read-only operations token. Agents never use these: an agent calls with its agent key."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<KeyRound className="h-4 w-4" />} disabled={label.trim().length < 3} loading={busy} onClick={go}>{dual ? 'Ask for a second person' : 'Issue token'}</Button></>}>
      <div className="space-y-4">
        <Field label="Class">
          <RadioCards name="token-class" cols={2} value={cls} onChange={setCls}
            options={(Object.keys(TOKEN_CLASSES) as TokenClass[]).map((c) => ({ value: c, label: `${TOKEN_CLASSES[c].label} (${TOKEN_CLASSES[c].prefix})`, description: `${TOKEN_CLASSES[c].can} ${TOKEN_CLASSES[c].cannot}` }))} />
        </Field>
        <Field label="Label" required htmlFor="tok-label" hint="Where the token is used, so you know what stops if you revoke it.">
          <Input id="tok-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={cls === 'control' ? 'For example: release pipeline — declarations' : 'For example: operations dashboard'} data-autofocus />
        </Field>
        <Field label="Expires" htmlFor="tok-expiry">
          <Select id="tok-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="never">No expiry</option>
          </Select>
        </Field>
        {dual && <Banner tone="held" title="Two people">From L2 a control token is dual control: your request is recorded, a different owner or admin approves it, and then it is collected once.</Banner>}
        {error && <Banner tone="bad" title="The token was not issued">{error}</Banner>}
      </div>
    </Dialog>
  );
}

function RevokeTokenDialog({ token, onClose }: { token: PlatformToken; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!user) return;
    setBusy(true);
    try { const r = await revokeToken(orgId, token.id, user.id, reason); toast.ok('Token revoked', `${token.prefix}… is refused from the next call. ${receiptNote(r.receipt.seq)}`); onClose(); }
    catch (e) { toast.bad('Not revoked', errText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} tone="danger" size="sm" title="Revoke this token?" description="Calls with this token are refused from now on. A revocation cannot be undone; issue a new token instead."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} onClick={go}>Revoke token</Button></>}>
      <p className="text-sm"><span className="font-mono">{token.prefix}…</span> · {token.label}</p>
      <Field className="mt-3" label="Reason (optional)" htmlFor="tok-rev-reason"><Textarea id="tok-rev-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Dialog>
  );
}

function DeclineTokenDialog({ token, onClose }: { token: PlatformToken; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!user) return;
    setBusy(true);
    try { const r = await decideToken(orgId, token.id, false, user.id, note); toast.ok('Request declined', receiptNote(r.receipt.seq)); onClose(); }
    catch (e) { toast.bad('Not declined', errText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} size="sm" title="Decline this control token?" description={`Asked by ${userName(token.requestedBy)} on ${dateTime(token.requestedAt)}: ${token.label}.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={note.trim().length < 6} loading={busy} onClick={go}>Decline</Button></>}>
      <Field label="Why" required htmlFor="tok-dec-note" hint="The requester reads it."><Textarea id="tok-dec-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus /></Field>
    </Dialog>
  );
}

function SecretOnceDialog({ value, onClose }: { value: { secret: string; seq: number; label: string }; onClose: () => void }) {
  const [stored, setStored] = useState(false);
  useEffect(() => setStored(false), [value.secret]);
  return (
    <Dialog open onClose={stored ? onClose : () => toast.held('Store the token first', 'Tick the box once it is in your secret manager. It will not be shown again.')}
      title="Copy the token now" description="This is the only time the full token is shown. Elan1 Govern keeps only a hash and the prefix."
      footer={<Button variant="primary" disabled={!stored} onClick={onClose}>Done</Button>}>
      <div className="space-y-4">
        <p className="text-sm">{value.label} · recorded on <ReceiptLink seq={value.seq} />.</p>
        <div className="flex items-center gap-2 border border-line bg-sunken/70 p-3">
          <code className="flex-1 min-w-0 break-all font-mono text-[13px]">{value.secret}</code>
          <CopyButton text={value.secret} label="Copy token" />
        </div>
        <Banner tone="held" title="It will not be shown again">If you lose it, revoke it and issue a new one. Never paste it into a chat or a ticket.</Banner>
        <Checkbox checked={stored} onChange={setStored} label="I have stored this token somewhere safe" />
      </div>
    </Dialog>
  );
}
