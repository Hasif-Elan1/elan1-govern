import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgePercent, CalendarClock, CheckCircle2, DoorClosed, FlaskConical, Hourglass, OctagonX, PauseCircle, RefreshCw, ShieldAlert, Tag } from 'lucide-react';
import { useOrgId, useRole, useUser } from '@/store/session';
import type { PlanId } from '@/types';
import { n, pct, date, seqLabel } from '@/lib/format';
import { PLANS } from '@/lib/pricing';
import { LEVEL_INFO } from '@/lib/levels';
import {
  DISCOUNT_CAP, LIST_PRICE, PILOT, acceptDiscount, accountLeadOf, convertPilot, costPerAction, declineDiscount, discountState, endDiscount, endPilotNow,
  listPriceFactor, pilotPaused, requestDiscount, requestReopen, rerunReconciliation, startPilot, withdrawDiscountRequest,
  type Discount, type DiscountRequest, type PilotState, type ReconRun,
} from '@/mock/billing';
import { Banner, Button, Field, Input, Meter, Panel, StatusChip, Textarea, toast } from '@/components/ui';
import { money, rate, monthLabel, monthLabelLong, type Currency } from './model';
import type { ChainInvoice, ChainMeter } from './chainMeter';

const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const cap1 = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Run one recorded change and say what it wrote, or why it did not. */
function useRecorded() {
  const [busy, setBusy] = useState<string>();
  const run = (key: string, fn: () => { seq: number }, ok: string, sub: string, after?: () => void) => {
    setBusy(key);
    try { const r = fn(); toast.ok(ok, `${sub} Receipt ${seqLabel(r.seq)}.`); after?.(); } catch (e) { toast.bad('That did not work', (e as Error).message); } finally { setBusy(undefined); }
  };
  return { busy, run };
}

/* ── Pilot ────────────────────────────────────────────────── */

export function PilotPanel({ pilot, fresh, level, className }: { pilot?: PilotState; fresh: boolean; level: string; className?: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const owner = role === 'owner';
  const { busy, run } = useRecorded();
  const [ending, setEnding] = useState(false);
  const [why, setWhy] = useState('');
  if (!pilot) {
    if (!fresh || level !== 'l1') return null;
    return (
      <Panel className={className} kicker="Pilot" title="Start with the 90-day pilot">
        <p className="text-sm">Free for {PILOT.days} days and up to {n(PILOT.cap)} governed actions, at Guarded. At the limit, writes are paused ({PILOT.code}) and the organisation is read-only for {PILOT.readOnlyDays} days, then closed, unless it moves to the paid plan.</p>
        {owner && <div className="mt-4"><Button variant="primary" loading={busy === 'start'} disabled={!user} onClick={() => user && run('start', () => startPilot(orgId, user.id), 'Pilot started', `${PILOT.days} days and ${n(PILOT.cap)} governed actions, free.`)}>Start the pilot</Button></div>}
      </Panel>
    );
  }
  const share = pilot.cap ? Math.min(1, pilot.used / pilot.cap) : 0;
  const paused = pilotPaused(pilot);
  const closed = pilot.status === 'closed';
  const converted = pilot.status === 'converted';
  const title = converted ? 'Pilot finished — on the paid plan' : closed ? 'Organisation closed after the pilot' : paused ? 'Writes are paused' : 'Pilot — free for 90 days';
  const chip = pilot.status === 'active'
    ? <StatusChip size="sm" tone="info" icon={<FlaskConical className="h-3 w-3" aria-hidden />}>{pilot.daysLeft} days left</StatusChip>
    : converted ? <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Converted</StatusChip>
    : closed ? <StatusChip size="sm" tone="bad" icon={<DoorClosed className="h-3 w-3" aria-hidden />}>Closed</StatusChip>
    : <StatusChip size="sm" tone="bad" icon={<PauseCircle className="h-3 w-3" aria-hidden />}>Stopped</StatusChip>;
  const stopLink = pilot.stoppedSeq ? <Link className="link font-mono" to={`/activity/${pilot.stoppedSeq}`}>{seqLabel(pilot.stoppedSeq)}</Link> : null;
  return (
    <Panel className={className} kicker="Pilot · Guarded" title={title} actions={chip}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-display text-3xl font-semibold num">{n(pilot.used)} <span className="text-base text-muted font-normal">of {n(pilot.cap)}</span></p>
          <p className="text-sm text-muted">governed actions used · sandbox calls (sk_sbx_) do not count</p>
        </div>
        <p className="text-sm text-muted">{date(pilot.starts)} to {date(pilot.ends)}</p>
      </div>
      <Meter className="mt-3 h-2.5" value={Math.max(share, 0.004)} tone={share > 0.85 || paused ? 'held' : 'inverse'} label="Share of the pilot's governed actions used" />

      {paused && !closed && (
        <Banner tone="bad" className="mt-4" title={`${PILOT.code}: writes are paused`}>
          {pilot.stoppedWhy ? `${cap1(pilot.stoppedWhy)}. ` : ''}Every production call is refused before it runs and, as this code requires, no record is written for it{pilot.refusedAtStop ? ` (${n(pilot.refusedAtStop)} refused so far)` : ''}. The stop itself is {stopLink ?? 'recorded with the next call'}.
          {' '}The organisation is read-only until {pilot.readOnlyUntil ? date(pilot.readOnlyUntil) : `${PILOT.readOnlyDays} days after the stop`}: publishing a rulebook, editing an agent, inviting people, key changes and pack installs are refused. Signing in, exports and the bill still work. Then the organisation is closed unless an owner moves it to the paid plan.
        </Banner>
      )}
      {closed && (
        <Banner tone="bad" className="mt-4" title="Closed: the 30 read-only days have passed">
          The pilot stopped on {pilot.stoppedAt ? date(pilot.stoppedAt) : '—'} ({stopLink ?? PILOT.code}) and was not moved to the paid plan, so the organisation closed on {pilot.closedAt ? date(pilot.closedAt) : '—'}{pilot.closedSeq ? <> (<Link className="link font-mono" to={`/activity/${pilot.closedSeq}`}>{seqLabel(pilot.closedSeq)}</Link>)</> : null}. No call runs and nothing can be changed. The chain is kept and can still be exported from <Link className="link" to="/assurance/exports">Exports</Link>. Reopening is a new order with elan1.
        </Banner>
      )}

      {converted ? (
        <ol className="mt-4 border border-line divide-y divide-line text-sm">
          <li className="px-3 py-2 flex flex-wrap justify-between gap-2"><span>Pilot started, free at Guarded</span><span className="text-muted">{date(pilot.starts)} · <Link className="link font-mono" to={`/activity/${pilot.seq}`}>{seqLabel(pilot.seq)}</Link></span></li>
          {pilot.stoppedAt && pilot.stoppedSeq && (
            <li className="px-3 py-2">
              <div className="flex flex-wrap justify-between gap-2"><span>Hard stop — {PILOT.code}</span><span className="text-muted">{date(pilot.stoppedAt)} · {stopLink}</span></div>
              <p className="text-xs text-muted">{pilot.stoppedWhy ? `${cap1(pilot.stoppedWhy)}. ` : ''}Writes were paused and {n(pilot.refusedAtStop)} production {pilot.refusedAtStop === 1 ? 'call was' : 'calls were'} refused with no record written, as the code requires.</p>
            </li>
          )}
          <li className="px-3 py-2">
            <div className="flex flex-wrap justify-between gap-2"><span>Moved to the paid plan{pilot.convertedTo ? ` — ${LEVEL_INFO[pilot.convertedTo].label}` : ''}</span><span className="text-muted">{pilot.convertedAt ? date(pilot.convertedAt) : '—'} · {pilot.convertedSeq ? <Link className="link font-mono" to={`/activity/${pilot.convertedSeq}`}>{seqLabel(pilot.convertedSeq)}</Link> : '—'}</span></div>
            <p className="text-xs text-muted">{pilot.convertedVia === 'upgrade' ? 'An upgrade ended the pilot at its boundary; billing at the new level starts there.' : 'Billing starts on the day it moved; the first floor is pro rata.'} Invoices bill from that day.</p>
          </li>
        </ol>
      ) : (
        <ul className="mt-4 space-y-1.5 text-sm">
          <li>Free: no floor and no per-action charge while the pilot runs. It covers Guarded only; an upgrade ends it at the boundary.</li>
          <li>It discounts the Guarded list price in full: {money(PLANS.l1.floorPerYear, 'INR')} a year floor, {rate(PLANS.l1.overageRate, 'INR')} per action beyond {n(PLANS.l1.includedPerYear)} a year.</li>
          <li>Hard stop at {n(PILOT.cap)} governed actions or {PILOT.days} days, whichever comes first; {PILOT.readOnlyDays} days read-only, then closed.</li>
        </ul>
      )}

      {/* moving to the paid plan and ending the pilot are an owner's: other roles see no button */}
      {!converted && !closed && owner && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant={paused ? 'primary' : 'secondary'} loading={busy === 'convert'} disabled={!user}
            onClick={() => user && run('convert', () => convertPilot(orgId, user.id), 'Moved to Guarded', paused ? 'Billing starts today, the floor pro rata; writes resume.' : 'Billing starts today, the floor pro rata.')}>Move to the paid plan</Button>
          {pilot.status === 'active' && !ending && <Button variant="ghost" disabled={!user} onClick={() => setEnding(true)}>End the pilot now</Button>}
          <span className="text-xs text-muted">Billing starts on the day you move; the first floor is pro rata.</span>
        </div>
      )}
      {ending && pilot.status === 'active' && (
        <div className="mt-3 border border-line bg-sunken/40 p-3 space-y-3">
          <p className="text-sm">Ending the pilot is the same hard stop as reaching its limit: every production call is refused with {PILOT.code}, the organisation is read-only for {PILOT.readOnlyDays} days, then closed unless an owner moves it to the paid plan.</p>
          <Input aria-label="Why the pilot ends" placeholder="Why it ends (optional)" value={why} onChange={(e) => setWhy(e.target.value)} className="max-w-md" />
          <div className="flex gap-2">
            <Button size="sm" variant="danger" loading={busy === 'end'} onClick={() => user && run('end', () => endPilotNow(orgId, user.id, why), 'Pilot ended', 'Writes are paused.', () => { setEnding(false); setWhy(''); })}>End the pilot</Button>
            <Button size="sm" variant="ghost" onClick={() => setEnding(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {closed && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!pilot.reopenRequestedSeq && pilot.reopenDeclined && <span className="w-full text-sm text-muted">{pilot.reopenDeclined.by} declined the last request to reopen (<Link className="link font-mono" to={`/activity/${pilot.reopenDeclined.seq}`}>{seqLabel(pilot.reopenDeclined.seq)}</Link>){pilot.reopenDeclined.note ? ` — ${pilot.reopenDeclined.note}` : ''}.</span>}
          {pilot.reopenRequestedSeq
            ? <span className="text-sm inline-flex items-center gap-1.5"><Hourglass className="h-3.5 w-3.5" aria-hidden />Request to reopen is with {accountLeadOf(orgId).name}, your elan1 account lead (<Link className="link font-mono" to={`/activity/${pilot.reopenRequestedSeq}`}>{seqLabel(pilot.reopenRequestedSeq)}</Link>).</span>
            : owner && <Button variant="primary" loading={busy === 'reopen'} disabled={!user} onClick={() => user && run('reopen', () => requestReopen(orgId, user.id), 'Request sent to elan1', 'Reopening is a new order on the paid Guarded plan.')}>Ask elan1 to reopen</Button>}
        </div>
      )}
    </Panel>
  );
}

/* ── Discounts ────────────────────────────────────────────── */

export function DiscountsPanel({ offers, requests, cur, className }: { offers: Discount[]; requests: DiscountRequest[]; cur: Currency; className?: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const owner = role === 'owner';
  const { busy, run } = useRecorded();
  const [asking, setAsking] = useState(false);
  const [ending, setEnding] = useState<number>();
  const [declining, setDeclining] = useState<number>();
  const [reason, setReason] = useState('');
  const lead = accountLeadOf(orgId);
  const open = offers.filter((o) => o.status === 'offered');
  const accepted = offers.filter((o) => o.status === 'accepted');
  const answered = offers.filter((o) => o.status === 'declined' || o.status === 'lapsed');
  const pending = requests.filter((q) => q.status === 'with_elan1');
  const by = (o: Discount) => `${o.agreedName}, ${o.agreedTitle}`;
  return (
    <Panel className={className} kicker="Commercial terms" title="Discounts" flush
      actions={owner && !asking && !pending.length ? <Button size="sm" variant="secondary" icon={<BadgePercent className="h-3.5 w-3.5" />} onClick={() => setAsking(true)}>Ask elan1 for a discount</Button> : undefined}
      footer={<span>Only elan1 offers a discount, and an owner accepts it here; nobody in this organisation can write one down. Its authority comes from elan1’s own staff list: an account lead may agree up to {DISCOUNT_CAP.leadPct}% for up to {DISCOUNT_CAP.leadMonths} months; only a founder may go further. Only the per-action charge beyond the allowance is ever discounted — never the floor, the meter basis, the price of a refusal or the evidence line. Every discount has an end date.</span>}>
      {asking && <div className="px-5 py-4 border-b border-line"><RequestForm onDone={() => setAsking(false)} /></div>}

      {open.map((o) => (
        <div key={o.seq} className="px-5 py-4 border-b border-line text-sm bg-sunken/30">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-medium">Offer: {o.pct}% off governed actions beyond the allowance</p>
            <StatusChip size="sm" tone="info" icon={<Hourglass className="h-3 w-3" aria-hidden />}>Open until {dayLabel(o.validUntil)}</StatusChip>
          </div>
          <p className="mt-1 text-muted">{dayLabel(o.offeredFrom)} to <span className="font-medium text-fg">{dayLabel(o.until)}</span> · from {by(o)}{o.reference !== '—' ? ` · ${o.reference}` : ''} · <Link className="link font-mono" to={`/activity/${o.seq}`}>{seqLabel(o.seq)}</Link></p>
          <p className="text-xs text-muted">{o.agreedBy === 'founder' ? 'A founder’s offer: no cap.' : `Within the lead’s cap of ${DISCOUNT_CAP.leadPct}% for ${DISCOUNT_CAP.leadMonths} months.`} If accepted today it applies from {dayLabel(o.offeredFrom > todayIst() ? o.offeredFrom : todayIst())}.</p>
          {owner ? (declining === o.seq ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Input aria-label="Why you decline" placeholder="Why you decline (optional)" value={reason} onChange={(e) => setReason(e.target.value)} className="max-w-xs" />
              <Button size="sm" variant="secondary" loading={busy === `decline-${o.seq}`} onClick={() => user && run(`decline-${o.seq}`, () => declineDiscount(orgId, user.id, o.seq, reason), 'Offer declined', 'elan1 sees your answer.', () => { setDeclining(undefined); setReason(''); })}>Decline the offer</Button>
              <Button size="sm" variant="ghost" onClick={() => setDeclining(undefined)}>Cancel</Button>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" loading={busy === `accept-${o.seq}`} onClick={() => user && run(`accept-${o.seq}`, () => acceptDiscount(orgId, user.id, o.seq), 'Discount accepted', `${o.pct}% off actions beyond the allowance until ${dayLabel(o.until)}.`)}>Accept</Button>
              <Button size="sm" variant="ghost" onClick={() => setDeclining(o.seq)}>Decline</Button>
            </div>
          )) : <p className="mt-1 text-xs text-muted">An owner accepts or declines it.</p>}
        </div>
      ))}

      {pending.map((q) => (
        <div key={q.seq} className="px-5 py-4 border-b border-line text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-medium">Asked for {q.pct}% for {q.months} {q.months === 1 ? 'month' : 'months'}</p>
            <StatusChip size="sm" tone="neutral" icon={<Hourglass className="h-3 w-3" aria-hidden />}>With elan1</StatusChip>
          </div>
          <p className="mt-1 text-muted">“{q.reason}” · <Link className="link font-mono" to={`/activity/${q.seq}`}>{seqLabel(q.seq)}</Link></p>
          <p className="text-xs text-muted">{q.needs === 'founder' ? `Beyond a lead’s cap, so ${q.lead.name} passes it to an elan1 founder.` : `${q.lead.name}, your elan1 account lead, answers here with an offer an owner can accept.`} A request is not a discount.</p>
          {owner && <button type="button" className="mt-1 text-xs underline underline-offset-2 text-muted hover:text-fg" onClick={() => user && run(`withdraw-${q.seq}`, () => withdrawDiscountRequest(orgId, user.id, q.seq), 'Request withdrawn', 'elan1 will not answer it.')}>Withdraw the request</button>}
        </div>
      ))}

      {accepted.length === 0 && open.length === 0 && pending.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted">No discount agreed. Invoices carry the modelled list price. {owner ? `Ask ${lead.name}, your elan1 account lead, for one.` : ''}</p>
      ) : accepted.length > 0 && (
        <ul className="divide-y divide-line">
          {accepted.slice().reverse().map((ds) => {
            const st = discountState(ds);
            return (
              <li key={ds.seq} className="px-5 py-4 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{ds.pct}% off governed actions beyond the allowance</p>
                  <StatusChip size="sm" tone={st === 'active' ? 'ok' : st === 'scheduled' ? 'info' : 'neutral'} icon={<Tag className="h-3 w-3" aria-hidden />}>{st === 'active' ? 'Active' : st === 'scheduled' ? 'Scheduled' : 'Ended'}</StatusChip>
                </div>
                <p className="mt-1 text-muted">{dayLabel(ds.from)} to <span className="font-medium text-fg">{dayLabel(ds.until)}</span>{ds.endedAt ? ` · ended early on ${date(ds.endedAt)}${ds.endedReason ? ` — ${ds.endedReason}` : ''}` : ''}</p>
                <p className="text-xs text-muted">Offered by {by(ds)} ({ds.agreedBy === 'founder' ? 'founder — no cap' : `lead — within the ${DISCOUNT_CAP.leadPct}% / ${DISCOUNT_CAP.leadMonths}-month cap`}){ds.reference !== '—' ? ` · ${ds.reference}` : ''} in <Link className="link font-mono" to={`/activity/${ds.seq}`}>{seqLabel(ds.seq)}</Link>{ds.acceptedSeq ? <> · accepted in <Link className="link font-mono" to={`/activity/${ds.acceptedSeq}`}>{seqLabel(ds.acceptedSeq)}</Link></> : null}{ds.endedSeq ? <> · ended in <Link className="link font-mono" to={`/activity/${ds.endedSeq}`}>{seqLabel(ds.endedSeq)}</Link></> : null}</p>
                <p className="text-xs text-muted">{`At ${cur === 'INR' ? '₹' : 'US$'} list rates: `}{(['l1', 'l2', 'l3', 'sovereign'] as PlanId[]).map((p) => `${PLANS[p].name} ${rate(PLANS[p].overageRate * (1 - ds.pct / 100), cur)}`).join(' · ')} per action beyond the allowance.</p>
                {owner && st !== 'ended' && (ending === ds.seq ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Input aria-label="Why it ends early" placeholder="Why it ends early" value={reason} onChange={(e) => setReason(e.target.value)} className="max-w-xs" />
                    <Button size="sm" variant="primary" loading={busy === `end-${ds.seq}`} onClick={() => user && run(`end-${ds.seq}`, () => endDiscount(orgId, user.id, ds.seq, reason), 'Discount ended', 'It stops applying now.', () => { setEnding(undefined); setReason(''); })}>End the discount</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEnding(undefined)}>Cancel</Button>
                  </div>
                ) : <button type="button" className="mt-1 text-xs underline underline-offset-2 text-muted hover:text-fg" onClick={() => setEnding(ds.seq)}>End early</button>)}
              </li>
            );
          })}
        </ul>
      )}
      {requests.filter((q) => q.status === 'declined').map((q) => (
        <p key={q.seq} className="px-5 py-3 border-t border-line text-xs text-muted">
          Request for {q.pct}% for {q.months} {q.months === 1 ? 'month' : 'months'} (<Link className="link font-mono" to={`/activity/${q.seq}`}>{seqLabel(q.seq)}</Link>) declined by {q.declinedBy ?? 'elan1'}{q.declinedReason ? ` — ${q.declinedReason}` : ''}{q.closedSeq ? <> (<Link className="link font-mono" to={`/activity/${q.closedSeq}`}>{seqLabel(q.closedSeq)}</Link>)</> : null}. An owner may ask again.
        </p>
      ))}
      {answered.length > 0 && (
        <p className="px-5 py-3 border-t border-line text-xs text-muted">
          {answered.map((o) => `${o.pct}% from ${o.agreedName} ${o.status === 'declined' ? `declined${o.declinedReason && o.declinedReason !== 'Declined' ? ` (${o.declinedReason})` : ''}` : `lapsed on ${dayLabel(o.validUntil)}`}`).join(' · ')}.
        </p>
      )}
    </Panel>
  );
}

const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** The owner asks elan1 for a discount. elan1 answers with an offer; the request itself discounts nothing. */
function RequestForm({ onDone }: { onDone: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const ids = { p: useId(), m: useId(), r: useId() };
  const [pctS, setPct] = useState('10');
  const [monthsS, setMonths] = useState('12');
  const [why, setWhy] = useState('');
  const [err, setErr] = useState<string>();
  const p = Number(pctS);
  const months = Number(monthsS);
  const lead = accountLeadOf(orgId);
  const needsFounder = p > DISCOUNT_CAP.leadPct || months > DISCOUNT_CAP.leadMonths;
  const submit = () => {
    if (!user) return;
    try {
      const r = requestDiscount(orgId, user.id, { pct: p, months, reason: why });
      toast.ok('Request sent to elan1', `${lead.name} answers here with an offer. Receipt ${seqLabel(r.seq)}.`);
      onDone();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Ask elan1 for a discount on governed actions beyond the allowance. elan1 decides; if it agrees, an offer appears here for an owner to accept. Every discount has an end date.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Discount asked for, %" htmlFor={ids.p}><Input id={ids.p} inputMode="decimal" className="num" value={pctS} onChange={(e) => setPct(e.target.value)} /></Field>
        <Field label="For how many months" htmlFor={ids.m}><Input id={ids.m} inputMode="numeric" className="num" value={monthsS} onChange={(e) => setMonths(e.target.value)} /></Field>
      </div>
      <Field label="Why" htmlFor={ids.r} hint="Expected volume, a renewal or a competing quote. At least 10 characters."><Textarea id={ids.r} rows={2} value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
      <Banner tone={needsFounder ? 'held' : 'neutral'}>{needsFounder ? `Beyond an account lead’s cap (${DISCOUNT_CAP.leadPct}% for ${DISCOUNT_CAP.leadMonths} months): ${lead.name} passes it to an elan1 founder.` : `Within an account lead’s cap: ${lead.name}, your elan1 account lead, decides.`}</Banner>
      {err && <Banner tone="bad">{err}</Banner>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={why.trim().length < 10} onClick={submit}>Send the request</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

/* ── Reconciliation runs ──────────────────────────────────── */

export function ReconciliationRuns({ runs, invoices }: { runs: Map<string, ReconRun>; invoices: ChainInvoice[] }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const ownerAdmin = role === 'owner' || role === 'admin';
  const [busy, setBusy] = useState<string>();
  const list = [...runs.values()].sort((a, b) => b.period.localeCompare(a.period));
  if (!list.length) return <p className="mt-3 text-xs text-muted">No period has been reconciled yet; the first nightly run checks the open month.</p>;
  const rerun = (period: string) => {
    if (!user) return;
    setBusy(period);
    try { const r = rerunReconciliation(orgId, user.id, period); toast.ok(`${monthLabelLong(period)} reconciled`, `The meter was rebuilt from the chain. Receipt ${seqLabel(r.seq)}.`); } catch (e) { toast.bad('The reconciliation did not run', (e as Error).message); } finally { setBusy(undefined); }
  };
  return (
    <div className="mt-4">
      <p className="label mb-2">By period</p>
      <ul className="border border-line divide-y divide-line text-sm">
        {list.map((r) => {
          const inv = invoices.find((i) => i.kind === 'monthly' && i.period === r.period);
          return (
            <li key={r.period} className="px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{monthLabel(r.period)}</span>
                <StatusChip size="sm" tone={r.matched ? 'ok' : 'bad'} icon={r.matched ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <ShieldAlert className="h-3 w-3" aria-hidden />}>{r.matched ? 'Reconciled' : `Differs by ${n(r.chainDecisions - r.meterEvents)}`}</StatusChip>
              </div>
              <p className="text-xs text-muted num">Meter {n(r.meterEvents)} · chain {n(r.chainDecisions)} · <Link className="link font-mono" to={`/activity/${r.seq}`}>{seqLabel(r.seq)}</Link>{r.note ? ` · ${r.note}` : ''}</p>
              {!r.matched && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <span className="text-xs">{inv ? `Invoice ${inv.number} is held — not issued on either number.` : 'The invoice for this period is held.'}</span>
                  {ownerAdmin && <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy === r.period} onClick={() => rerun(r.period)}>Run again</Button>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── Published monthly: refusal share beside cost per governed action ── */

export function PublishedMonthly({ cm, invoices, cur, className }: { cm: ChainMeter; invoices: ChainInvoice[]; cur: Currency; className?: string }) {
  const rows = cm.months.slice().reverse().map((m) => {
    const actions = m.allowed + m.approved + m.refused + m.expired;
    const inv = invoices.find((i) => i.kind === 'monthly' && i.period === m.month);
    const refusalCharge = inv ? inv.lines.filter((l) => l.kind === 'refused_beyond').reduce((s, l) => s + l.amount, 0) : 0;
    return { month: m.month, actions, refusalShare: actions ? (m.refused + m.expired) / actions : 0, cost: costPerAction(m.month), refusalCharge, pilot: !!inv?.pilot };
  });
  return (
    <Panel className={className} kicker="Published every month" title="Refusal share beside cost per governed action" flush
      footer={<span>Cost per governed action is elan1’s modelled cost to run one (runtime cost plus 15%): ₹0.092 in October 2026, falling to ₹0.052 from April 2030. The refusal share is this organisation’s, from the chain. A refused action is billed at 40% of the per-action rate.</span>}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]">
          <caption className="sr-only">Refusal share and cost per governed action by month</caption>
          <thead className="bg-sunken/80"><tr className="border-b border-line">
            <th scope="col" className="label text-left px-4 h-9">Month</th>
            <th scope="col" className="label text-right px-4 h-9">Governed actions</th>
            <th scope="col" className="label text-right px-4 h-9">Refused</th>
            <th scope="col" className="label text-right px-4 h-9">Cost per governed action</th>
            <th scope="col" className="label text-right px-4 h-9">Refusals billed</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.month} className="border-b border-line last:border-b-0">
                <th scope="row" className="px-4 py-2 text-left font-medium">{monthLabel(r.month)}</th>
                <td className="px-4 py-2 text-right num">{n(r.actions)}</td>
                <td className="px-4 py-2 text-right num"><span className="inline-flex items-center gap-1"><OctagonX className="h-3 w-3 text-muted" aria-hidden />{pct(r.refusalShare, 1)}</span></td>
                <td className="px-4 py-2 text-right num">{rate(r.cost, cur)}</td>
                <td className="px-4 py-2 text-right num text-muted">{r.pilot ? 'Pilot, free' : r.refusalCharge ? money(r.refusalCharge, cur, true) : r.refusalShare === 0 ? '—' : 'Inside the allowance'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* ── Modelled list price ──────────────────────────────────── */

export function ListPriceNote({ planId, cur }: { planId: PlanId; cur: Currency }) {
  const plan = PLANS[planId];
  const y30 = listPriceFactor('2029-04');
  const y31 = listPriceFactor('2030-04');
  return (
    <div className="mt-4 border border-line bg-sunken/40 p-3 text-xs">
      <p className="font-medium text-fg inline-flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5" aria-hidden />{LIST_PRICE.label} · {LIST_PRICE.targets[planId]}</p>
      <p className="mt-1 text-muted">{LIST_PRICE.note} Flat to 31 March 2029, then +4% a year: the {plan.name} {planId === 'sovereign' ? 'licence' : 'floor'} becomes {money(plan.floorPerYear * y30, cur)} from April 2029 and {money(plan.floorPerYear * y31, cur)} from April 2030; {rate(plan.overageRate, cur)} per action becomes {rate(Math.round(plan.overageRate * y30 * 100) / 100, cur)}.</p>
    </div>
  );
}
