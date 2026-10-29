import { useId, useState } from 'react';
import { Check, KeyRound, ShieldAlert, X } from 'lucide-react';
import { api } from '@/api';
import { useNow, useQuery } from '@/hooks/useQuery';
import { useOrgId, useRole, useUser } from '@/store/session';
import { countdown, dateTime } from '@/lib/format';
import { userName } from '@/mock/users';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, Dialog, Field, Panel, Select, StatusChip, Textarea, toast } from '@/components/ui';
import { Person, ReceiptLink, When } from '@/components/domain';
import { BREAK_GLASS_MINUTES, type BreakGlass } from '@/mock/ops';

const mins = (m: number) => (m >= 60 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'}` : `${m} minutes`);
const STATUS: Record<BreakGlass['status'], { label: string; tone: 'bad' | 'held' | 'ok' | 'neutral' | 'info' }> = {
  pending: { label: 'Waiting for a second person', tone: 'held' },
  active: { label: 'Active', tone: 'bad' },
  declined: { label: 'Declined', tone: 'neutral' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  ended: { label: 'Ended early', tone: 'ok' },
  expired: { label: 'Time ran out', tone: 'ok' },
};

/**
 * Break-glass: emergency access for an owner or admin — password sign-in while SSO is enforced or the provider is
 * down. One person asks, a different owner or admin approves; it is time-boxed and ends by itself. Every step is a
 * receipt. Shown in Organisation › Sessions, on Incidents, and waiting requests are in the Reviews queue and on Today.
 */
export function BreakGlassPanel({ className, compact }: { className?: string; compact?: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const now = useNow(15_000);
  const fid = useId();
  const canAct = role === 'owner' || role === 'admin';
  const q = useQuery(async (o) => api.ops.breakGlassList(o), [], { kinds: ['session', 'receipt', 'member'] });
  const [asking, setAsking] = useState(false);
  const [forUser, setForUser] = useState('');
  const [minutes, setMinutes] = useState<number>(60);
  const [reason, setReason] = useState('');
  const [declining, setDeclining] = useState<BreakGlass>();
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState<string>();

  const list = q.data ?? [];
  const live = list.filter((b) => b.status === 'pending' || b.status === 'active');
  const past = list.filter((b) => b.status !== 'pending' && b.status !== 'active').slice(0, compact ? 3 : 8);
  const people = api.ops.ownersAndAdmins(orgId);

  const run = async (key: string, fn: () => BreakGlass, ok: (b: BreakGlass) => [string, string]) => {
    setBusy(key);
    try {
      const b = fn();
      const [t, d] = ok(b);
      toast.ok(t, d);
      q.refetch();
    } catch (e) {
      toast.bad('Not recorded', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const ask = () => user && run('ask', () => api.ops.requestBreakGlass(orgId, user.id, { forUser: forUser || user.id, reason, minutes }), (b) => {
    setAsking(false); setReason('');
    return ['Emergency access requested', `Receipt #${b.requestSeq}. A different owner or admin approves it in Reviews or here.`];
  });

  return (
    <Panel className={className} title="Emergency access (break-glass)" kicker="Two people · time-boxed"
      actions={canAct ? <Button size="sm" variant="secondary" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => { setForUser(user?.id ?? ''); setAsking(true); }}>Ask for access</Button> : undefined}>
      <p className="text-sm text-muted leading-relaxed">Password sign-in for an owner or admin while SSO is enforced or your provider is down — for example, to engage the emergency stop. One person asks, a different owner or admin approves, and it ends by itself. There is no admin mode: every step is a receipt.</p>

      {q.loading && !q.data ? <p className="mt-4 text-sm text-muted">Loading…</p> : (
        <>
          {live.length > 0 && (
            <ul className="mt-4 space-y-3">
              {live.map((b) => {
                const self = b.requestedBy === user?.id || b.forUser === user?.id;
                return (
                  <li key={b.id} className={cn('border border-line bg-surface px-4 py-3', b.status === 'active' && 'border-l-[3px] border-l-bad')}>
                    <div className="flex flex-wrap items-center gap-2">
                      <ShieldAlert className="h-4 w-4 text-bad-fg" aria-hidden />
                      <span className="text-sm font-medium">{userName(b.forUser)}</span>
                      <StatusChip tone={STATUS[b.status].tone} size="sm">{STATUS[b.status].label}</StatusChip>
                      <span className="ml-auto text-xs text-muted num">{b.status === 'active' && b.expiresAt ? `ends in ${countdown(b.expiresAt, now)}` : mins(b.minutes)}</span>
                    </div>
                    <p className="mt-1.5 text-sm">“{b.reason}”</p>
                    <p className="mt-1 text-xs text-muted">Asked by {userName(b.requestedBy)} <When iso={b.requestedAt} />{b.requestSeq !== undefined && <> · <ReceiptLink seq={b.requestSeq} /></>}{b.approvedBy && <> · approved by {userName(b.approvedBy)}{b.approveSeq !== undefined && <> · <ReceiptLink seq={b.approveSeq} /></>}</>}</p>
                    {canAct && (
                      <div className="mt-3 flex flex-wrap justify-end gap-2">
                        {b.status === 'pending' && b.requestedBy === user?.id && <Button size="sm" variant="ghost" loading={busy === `w_${b.id}`} onClick={() => run(`w_${b.id}`, () => api.ops.withdrawBreakGlass(orgId, b.id, user!.id), () => ['Request withdrawn', 'Recorded.'])}>Withdraw</Button>}
                        {b.status === 'pending' && !self && (
                          <>
                            <Button size="sm" variant="secondary" icon={<X className="h-3.5 w-3.5" />} onClick={() => { setWhy(''); setDeclining(b); }}>Decline</Button>
                            <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={busy === `a_${b.id}`} onClick={() => run(`a_${b.id}`, () => api.ops.approveBreakGlass(orgId, b.id, user!.id), (g) => ['Emergency access approved', `${userName(g.forUser)} can sign in with a password until ${g.expiresAt ? dateTime(g.expiresAt) : 'the time runs out'}. Receipt #${g.approveSeq}.`])}>Approve as second person</Button>
                          </>
                        )}
                        {b.status === 'pending' && self && b.requestedBy !== user?.id && <span className="text-xs text-muted">A second person approves — not the person who gets access.</span>}
                        {b.status === 'active' && <Button size="sm" variant="danger" loading={busy === `e_${b.id}`} onClick={() => run(`e_${b.id}`, () => api.ops.endBreakGlass(orgId, b.id, user!.id), () => ['Emergency access ended', 'Password sign-in is refused again while SSO is enforced. Recorded.'])}>End now</Button>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {live.length === 0 && <p className="mt-4 text-sm"><Badge>None active</Badge> <span className="text-muted">Nobody has emergency access now.</span></p>}
          {past.length > 0 && (
            <>
              <p className="label mt-5 mb-1">History</p>
              <ul className="divide-y divide-line border-y border-line">
                {past.map((b) => (
                  <li key={b.id} className="py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Person id={b.forUser} size={20} />
                    <StatusChip tone={STATUS[b.status].tone} size="sm">{STATUS[b.status].label}</StatusChip>
                    <span className="text-xs text-muted">{dateTime(b.requestedAt)} · {mins(b.minutes)}{b.approvedBy ? ` · approved by ${userName(b.approvedBy)}` : ''}</span>
                    {b.endSeq !== undefined && <ReceiptLink seq={b.endSeq} className="text-xs" />}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {!canAct && <p className="mt-4 text-xs text-muted">Owners and admins ask for and approve emergency access.</p>}

      <Dialog open={asking} onClose={() => setAsking(false)} title="Ask for emergency access"
        description="A different owner or admin must approve. Access starts when they do and ends by itself."
        footer={<><Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button><Button variant="primary" loading={busy === 'ask'} disabled={reason.trim().length < 10} onClick={ask}>Ask a second person</Button></>}>
        <div className="space-y-4">
          <Field label="Access for" htmlFor={`${fid}-for`}>
            <Select id={`${fid}-for`} value={forUser || user?.id || ''} onChange={(e) => setForUser(e.target.value)}>
              {people.map((u) => <option key={u} value={u}>{userName(u)}{u === user?.id ? ' (you)' : ''}</option>)}
            </Select>
          </Field>
          <Field label="For how long" htmlFor={`${fid}-min`}>
            <Select id={`${fid}-min`} value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))}>
              {BREAK_GLASS_MINUTES.map((m) => <option key={m} value={m}>{mins(m)}</option>)}
            </Select>
          </Field>
          <Field label="Why" htmlFor={`${fid}-why`} required hint="Recorded on the breakglass.requested receipt.">
            <Textarea id={`${fid}-why`} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Okta is down and the treasury agent must be stopped." data-autofocus />
          </Field>
          {people.length < 2 && <Banner tone="held">This organisation has only one owner or admin, so nobody can be the second person. Invite one in People and roles.</Banner>}
        </div>
      </Dialog>

      <Dialog open={!!declining} onClose={() => setDeclining(undefined)} size="sm" title="Decline emergency access"
        footer={<><Button variant="ghost" onClick={() => setDeclining(undefined)}>Cancel</Button><Button variant="danger" loading={busy === 'decline'} disabled={why.trim().length < 6} onClick={() => declining && user && run('decline', () => api.ops.declineBreakGlass(orgId, declining.id, user.id, why), () => { setDeclining(undefined); return ['Emergency access declined', 'Recorded with your reason.']; })}>Decline</Button></>}>
        <Field label="Why" htmlFor={`${fid}-dec`} required><Textarea id={`${fid}-dec`} rows={2} value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
      </Dialog>
    </Panel>
  );
}
