import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarClock, KeyRound, ServerCrash, ShieldAlert, UserMinus, UserPlus, Users } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { can } from '@/lib/permissions';
import { userName } from '@/mock/users';
import { dateTime, rupees } from '@/lib/format';
import { Badge, Banner, Button, EmptyState, Field, Input, PageHeader, Panel, RadioCards, Select, Skeleton, StatusChip, Switch, Textarea, toast } from '@/components/ui';
import { Person, ReceiptLink, When } from '@/components/domain';
import {
  MAX_DELEGATION_DAYS, OUTAGE_SENTENCE, addDelegation, delegations, endOutage, outageState, revokeDelegation, sameActorMode, sealWord, setSameActorMode, setStepUpPolicy,
  startOutage, stepUpPolicy, type SameActorMode,
} from '@/mock/approvalsExt';
import { twoPersonPolicy } from '@/features/work/backend';
import { outageStatusLink } from './OutageNotice';
import { SmartLink } from '@/shell/access';

const STEP_UP_OPTIONS = [100000, 200000, 500000, 1000000, 2500000];
const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms));

/**
 * /approvals/settings — the safeguards around deciding: named, time-boxed delegates; whether an agent's owner may
 * approve its action (flag or forbid); step-up for high-value and irreversible approvals; and, for the demonstration,
 * the approvals-service outage that shows the fail-closed state. Every change is a receipt.
 */
export default function ApprovalSettingsPage() {
  const _orgId = useOrgId();
  const role = useRole();
  const admin = role === 'owner' || role === 'admin';
  const level = useOrgLevel();
  const q = useQuery(async (o) => ({
    sameActor: sameActorMode(o), stepUp: stepUpPolicy(o), delegations: delegations(o), outage: outageState(o), two: twoPersonPolicy(o),
    members: await api.members(o),
  }), [], { kinds: ['approval', 'receipt', 'member'] });

  return (
    <div>
      <PageHeader
        kicker="Work · Approvals"
        crumbs={[{ label: 'Approvals', to: '/approvals' }, { label: 'Delegates and safeguards' }]}
        title="Delegates and safeguards"
        description={`Who can stand in for an approver, whether an agent’s owner may approve its action, and when approving asks for a password again. Every change is a receipt, ${sealWord(level)}.`}
      />
      {q.error && <Banner tone="bad" title="Settings could not be loaded" className="mb-4">{q.error.message}</Banner>}
      {!q.data ? (
        <div className="grid gap-6 lg:grid-cols-12"><Skeleton className="h-64 lg:col-span-7" /><Skeleton className="h-64 lg:col-span-5" /></div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7 space-y-6 min-w-0">
            <Delegates data={q.data} admin={admin} onChange={q.refetch} />
            <SameActor mode={q.data.sameActor} admin={admin} onChange={q.refetch} />
          </div>
          <div className="lg:col-span-5 space-y-6 min-w-0">
            <StepUp policy={q.data.stepUp} admin={admin} onChange={q.refetch} />
            <Panel title="Two people" kicker="Dual control">
              <ul className="space-y-2 text-sm">
                <li className="flex items-start gap-2"><Users className="h-4 w-4 mt-0.5 shrink-0 text-muted" aria-hidden /><span>{q.data.two.enabled ? <>Payments of <span className="font-medium">{rupees(q.data.two.above)}</span> or more need two different approvers.</> : 'The two-person rule for large payments is off.'}{admin && <> <Link to="/work/reviews" className="underline underline-offset-2">Change it in Reviews</Link>.</>}</span></li>
                <li className="flex items-start gap-2"><Users className="h-4 w-4 mt-0.5 shrink-0 text-muted" aria-hidden /><span>A call whose blast radius is the whole organisation or crosses a boundary always needs two different approvers, at every level.</span></li>
              </ul>
            </Panel>
            <OutagePanel outage={q.data.outage} admin={admin} onChange={q.refetch} />
          </div>
        </div>
      )}
    </div>
  );
}

type Data = { sameActor: SameActorMode; stepUp: ReturnType<typeof stepUpPolicy>; delegations: ReturnType<typeof delegations>; outage: ReturnType<typeof outageState>; members: Awaited<ReturnType<typeof api.members>> };

function Delegates({ data, admin, onChange }: { data: Data; admin: boolean; onChange: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const deciders = useMemo(() => data.members.filter((m) => m.status === 'active' && can(m.role, 'approvals.decide')).map((m) => m.userId), [data.members]);
  const canDelegate = !!user && can(role, 'approvals.decide');
  const fromOptions = admin ? deciders : user ? [user.id] : [];
  const [from, setFrom] = useState(user?.id ?? '');
  const toOptions = deciders.filter((u) => u !== from);
  const [to, setTo] = useState('');
  const defaultUntil = new Date(Date.now() + 3 * 864e5 + 5.5 * 36e5).toISOString().slice(0, 10);
  const [until, setUntil] = useState(defaultUntil);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const toValue = toOptions.includes(to) ? to : toOptions[0] ?? '';
  const fromValue = fromOptions.includes(from) ? from : fromOptions[0] ?? '';
  const maxDate = new Date(Date.now() + MAX_DELEGATION_DAYS * 864e5).toISOString().slice(0, 10);

  const add = async () => {
    if (!user) return;
    setBusy('add');
    setErr(undefined);
    try {
      await pause();
      // the end of the chosen day in India Standard Time
      const end = new Date(`${until}T23:59:00+05:30`).toISOString();
      const dl = addDelegation(orgId, { from: fromValue, to: toValue, until: end, reason }, user.id);
      toast.ok(`${userName(dl.to)} decides for ${userName(dl.from)}`, `Until ${dateTime(dl.until)}. Recorded as receipt #${dl.seq}.`);
      setReason('');
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const revoke = async (id: string) => {
    if (!user) return;
    setBusy(id);
    try {
      await pause();
      revokeDelegation(orgId, id, user.id);
      toast.info('Delegation ended', 'The delegate can no longer decide for that approver. Recorded on the chain.');
      onChange();
    } catch (e) {
      toast.bad('Not ended', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Panel title="Delegates" kicker="Named and time-boxed" actions={<Badge>{data.delegations.filter((d) => d.active).length} active</Badge>}>
      <p className="text-sm text-muted">An approver who is away names one person to decide in their place until a date. The delegate decides what the approver could, the receipt records that they decided under the delegation, and it ends by itself on the date.</p>
      {data.delegations.length ? (
        <ul className="mt-4 divide-y divide-line border border-line">
          {data.delegations.map((d) => {
            const mayRevoke = d.active && !!user && (admin || d.from === user.id || d.to === user.id);
            return (
              <li key={d.id} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Person id={d.from} size={20} />
                  <ArrowRight className="h-3.5 w-3.5 text-muted" aria-hidden />
                  <Person id={d.to} size={20} />
                  {d.active ? <StatusChip size="sm" tone="info" icon={<CalendarClock className="h-3 w-3" aria-hidden />}>Until {dateTime(d.until)}</StatusChip> : <StatusChip size="sm" tone="neutral">{d.revokedAt ? 'Ended early' : 'Ended'}</StatusChip>}
                  {mayRevoke && <Button size="sm" variant="ghost" className="ml-auto" icon={<UserMinus className="h-3.5 w-3.5" aria-hidden />} loading={busy === d.id} onClick={() => revoke(d.id)}>End now</Button>}
                </div>
                <p className="mt-1 text-xs text-muted">“{d.reason}” · set up by {userName(d.createdBy)} <When iso={d.createdAt} />{d.seq !== undefined && <> · <ReceiptLink seq={d.seq} /></>}{d.revokedAt && <> · ended by {userName(d.revokedBy)} <When iso={d.revokedAt} />{d.revokedSeq !== undefined && <> · <ReceiptLink seq={d.revokedSeq} /></>}</>}</p>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState compact title="No delegations">Nobody is standing in for an approver.</EmptyState>
      )}

      {/* roles that decide no approvals (viewers, auditors) read the list only */}
      {canDelegate && (
        <div className="mt-5 border-t border-line pt-4 space-y-3">
          <p className="text-sm font-medium flex items-center gap-1.5"><UserPlus className="h-4 w-4 text-muted" aria-hidden />Delegate approvals</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Approver" htmlFor="dlg-from" hint={admin ? 'Owners and admins set one up for anyone.' : 'You delegate your own approvals.'}>
              {admin ? (
                <Select id="dlg-from" value={fromValue} onChange={(e) => setFrom(e.target.value)}>
                  {fromOptions.map((u) => <option key={u} value={u}>{userName(u)}</option>)}
                </Select>
              ) : (
                <p id="dlg-from" className="h-9 flex items-center text-sm font-medium">{userName(fromValue)}</p>
              )}
            </Field>
            <Field label="Decides in their place" htmlFor="dlg-to" hint="An approver, admin or owner here.">
              <Select id="dlg-to" value={toValue} onChange={(e) => setTo(e.target.value)}>
                {toOptions.map((u) => <option key={u} value={u}>{userName(u)}</option>)}
              </Select>
            </Field>
            <Field label="Until the end of" htmlFor="dlg-until" hint={`At most ${MAX_DELEGATION_DAYS} days.`}>
              <Input id="dlg-until" type="date" value={until} min={new Date().toISOString().slice(0, 10)} max={maxDate} onChange={(e) => setUntil(e.target.value)} />
            </Field>
            <Field label="Why" htmlFor="dlg-why" required>
              <Textarea id="dlg-why" rows={2} className="min-h-[40px]" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="On leave until Friday" />
            </Field>
          </div>
          {err && <p className="text-sm text-bad-fg" role="alert">{err}</p>}
          <Button variant="primary" icon={<UserPlus className="h-4 w-4" aria-hidden />} loading={busy === 'add'} disabled={!fromValue || !toValue || reason.trim().length < 5} onClick={add}>Delegate</Button>
        </div>
      )}
    </Panel>
  );
}

function SameActor({ mode, admin, onChange }: { mode: SameActorMode; admin: boolean; onChange: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [busy, setBusy] = useState(false);
  const set = async (m: SameActorMode) => {
    if (!user || m === mode) return;
    setBusy(true);
    try {
      await pause();
      const r = setSameActorMode(orgId, m, user.id);
      toast.ok(m === 'forbid' ? 'Self-approval is now forbidden' : 'Self-approval is now flagged', `Recorded as receipt #${r.seq}. It applies to calls already waiting.`);
      onChange();
    } catch (e) {
      toast.bad('Not changed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="When an agent’s owner is the approver" kicker="Same person" actions={<ShieldAlert className="h-4 w-4 text-muted" aria-hidden />}>
      {admin ? (
        <>
          <RadioCards<SameActorMode>
            name="same-actor" cols={2} value={mode} onChange={!busy ? set : () => undefined}
            options={[
              { value: 'flag', label: 'Flag it', description: 'They may approve; the receipt records that they approved their own agent’s action.' },
              { value: 'forbid', label: 'Forbid it', description: '“You proposed this, so you cannot also approve it.” They may reject, or send it to someone else.' },
            ]}
          />
          <p className="mt-3 text-xs text-muted">Owners and admins change this. It applies at once, to calls already waiting.</p>
        </>
      ) : (
        // read-only for other roles: the rule in force, not a set of greyed-out choices
        <p className="text-sm">
          <span className="font-medium">{mode === 'forbid' ? 'Forbidden.' : 'Flagged.'}</span>{' '}
          <span className="text-muted">{mode === 'forbid' ? '“You proposed this, so you cannot also approve it.” They may reject, or send it to someone else.' : 'They may approve; the receipt records that they approved their own agent’s action.'}</span>
        </p>
      )}
    </Panel>
  );
}

function StepUp({ policy, admin, onChange }: { policy: ReturnType<typeof stepUpPolicy>; admin: boolean; onChange: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [busy, setBusy] = useState(false);
  const save = async (patch: Partial<typeof policy>) => {
    if (!user) return;
    setBusy(true);
    try {
      await pause();
      const r = setStepUpPolicy(orgId, patch, user.id);
      toast.ok('Step-up saved', `Recorded as receipt #${r.seq}.`);
      onChange();
    } catch (e) {
      toast.bad('Not saved', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Step-up" kicker="Password again" actions={<KeyRound className="h-4 w-4 text-muted" aria-hidden />}>
      <p className="text-sm text-muted">Every approval asks for the password when the sign-in is more than 10 minutes old. These approvals ask for it every time, whatever the sign-in’s age:</p>
      {admin ? (
        <div className="mt-3 space-y-3">
          <Field label="Amount at or above" htmlFor="su-above">
            <Select id="su-above" value={String(policy.above)} disabled={busy} onChange={(e) => save({ above: Number(e.target.value) })}>
              {Array.from(new Set([...STEP_UP_OPTIONS, policy.above])).sort((x, y) => x - y).map((v) => <option key={v} value={v}>{rupees(v)}</option>)}
            </Select>
          </Field>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">Any call that cannot be reversed (an external transfer, a sent email)</span>
            <Switch label="Step-up for irreversible calls" checked={policy.irreversible} disabled={busy} onChange={(v) => save({ irreversible: v })} />
          </div>
        </div>
      ) : (
        <ul className="mt-3 space-y-1.5 text-sm">
          <li>Amounts of <span className="font-medium">{rupees(policy.above)}</span> or more</li>
          <li>{policy.irreversible ? 'Any call that cannot be reversed (an external transfer, a sent email)' : 'Irreversible calls follow the 10-minute rule like any other'}</li>
        </ul>
      )}
    </Panel>
  );
}

function OutagePanel({ outage, admin, onChange }: { outage: ReturnType<typeof outageState>; admin: boolean; onChange: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const statusLink = outageStatusLink(orgId);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await pause(300);
      if (outage.active) {
        const o = endOutage(orgId, user.id);
        toast.ok('Approvals are back', `Down for ${o.pausedMinutes ?? 0} minutes; waiting approvals’ expiry moved by that much.`);
      } else {
        startOutage(orgId, user.id);
        toast.held('Approvals are down (demonstration)', OUTAGE_SENTENCE);
      }
      onChange();
    } catch (e) {
      toast.bad('Not changed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Approvals service" kicker="Fail closed · demonstration" actions={outage.active ? <StatusChip size="sm" tone="bad" icon={<ServerCrash className="h-3 w-3" aria-hidden />}>Down</StatusChip> : <StatusChip size="sm" tone="ok">Running</StatusChip>}>
      <p className="text-sm text-muted">If the approvals service cannot check a change, nothing is approved: every decide screen and single-use link shows “{OUTAGE_SENTENCE}”, held calls keep waiting, nothing is re-routed and nothing expires until it is back. Start an outage here to see it; {statusLink.place} shows it too.</p>
      {outage.active && outage.since && <p className="mt-2 text-sm">Down since {dateTime(outage.since)}{outage.seq !== undefined && <> · <ReceiptLink seq={outage.seq} /></>}.</p>}
      {outage.history.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {outage.history.slice(0, 3).map((h) => <li key={h.since}>{dateTime(h.since)} · {h.minutes} minutes · {h.extended} waiting {h.extended === 1 ? 'approval' : 'approvals'} had their expiry moved</li>)}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {admin && (
          <Button variant={outage.active ? 'primary' : 'quiet-danger'} loading={busy} onClick={toggle} icon={<ServerCrash className="h-4 w-4" aria-hidden />}>{outage.active ? 'End the simulated outage' : 'Simulate an approvals outage'}</Button>
        )}
        <SmartLink to={statusLink.to} hideWhenBlocked className="text-sm underline underline-offset-2">{statusLink.to === '/status' ? 'Status page' : 'Local status'}</SmartLink>
      </div>
    </Panel>
  );
}
