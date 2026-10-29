import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Calculator, Check, CheckCircle2, MapPin, Minus } from 'lucide-react';
import type { Plan, PlanId } from '@/types';
import { PLANS, REFUSAL_FACTOR, GST_RATE } from '@/lib/pricing';
import { levelRank } from '@/lib/levels';
import { n, pct } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Panel, Field, Input, Select, Badge, Button, StatusChip } from '@/components/ui';
import { money, rate, estimateYear, lineOf, type Currency } from './model';
import { LIST_PRICE, listPriceFactor } from '@/mock/billing';
import { useScreenAccess } from '@/shell/access';

export const PLAN_QUESTION: Record<PlanId, string> = {
  l1: 'Can I let this run without it doing something I cannot undo?',
  l2: 'Can I hand this over and have it checked without us in the room?',
  l3: 'Does this survive the vendor?',
  sovereign: 'Can we run all of it on our own infrastructure?',
};

/* ── Plan comparison ─────────────────────────────────────── */

export function PlanComparison({ plans, currentId, cur, canUpgrade, owners: _owners, onUpgrade }: {
  plans: Plan[]; currentId: PlanId; cur: Currency; canUpgrade: boolean; owners: string; onUpgrade: (id: PlanId) => void;
}) {
  const rows: { k: string; cell: (p: Plan) => React.ReactNode }[] = [
    {
      k: 'Here', cell: (p) => (p.id === currentId
        ? <StatusChip size="sm" tone="inverse" icon={<MapPin className="h-3 w-3" aria-hidden />}>Your plan</StatusChip>
        : levelRank(p.id) < levelRank(currentId)
          ? <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Included in yours</StatusChip>
          : <StatusChip size="sm" tone="neutral" icon={<Minus className="h-3 w-3" aria-hidden />}>Available</StatusChip>),
    },
    { k: 'Who buys it', cell: (p) => <span className="text-sm">{p.buyer}</span> },
    { k: 'The question it answers', cell: (p) => <span className="text-sm italic text-fg/90">“{PLAN_QUESTION[p.id]}”</span> },
    { k: 'Platform floor a year', cell: (p) => <span className="num font-display text-lg font-semibold">{money(p.floorPerYear, cur)}</span> },
    { k: LIST_PRICE.label, cell: (p) => <span className="text-sm"><span className="font-medium">{LIST_PRICE.targetShort[p.id]}</span><span className="block text-xs text-muted">Flat to March 2029, then +4% a year ({money(p.floorPerYear * listPriceFactor('2029-04'), cur)} from April 2029)</span></span> },
    { k: 'Included actions a year', cell: (p) => <span className="num">{p.includedPerYear ? n(p.includedPerYear) : 'None — every action metered'}</span> },
    { k: 'Per action beyond allowance', cell: (p) => <span className="num">{rate(p.overageRate, cur)}</span> },
    { k: `Refused action (${pct(REFUSAL_FACTOR)})`, cell: (p) => <span className="num">{rate(p.refusalRate, cur)}</span> },
    {
      k: 'What it proves', cell: (p) => (
        <ul className="space-y-1">
          {p.proves.map((x) => <li key={x} className="flex gap-1.5 text-sm"><Check className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted" aria-hidden />{x}</li>)}
        </ul>
      ),
    },
    // only an owner changes the plan: other roles see no upgrade row at all (not a disabled button)
    ...(canUpgrade ? [{
      k: '', cell: (p: Plan) => (levelRank(p.id) > levelRank(currentId) ? (
        <Button size="sm" variant={levelRank(p.id) === levelRank(currentId) + 1 ? 'primary' : 'secondary'} iconRight={<ArrowRight className="h-3.5 w-3.5" />}
          onClick={() => onUpgrade(p.id)}>
          Upgrade to {p.name}
        </Button>
      ) : null),
    }] : []),
  ];
  return (
    <div className="overflow-x-auto border border-line bg-surface">
      <table className="w-full min-w-[820px] text-sm border-collapse">
        <caption className="sr-only">Plan comparison</caption>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="w-[180px] p-4 text-left align-bottom label">Plan</th>
            {plans.map((p) => (
              <th key={p.id} scope="col" className={cn('p-4 text-left align-bottom border-l border-line', p.id === currentId && 'bg-sunken/70 shadow-[inset_0_3px_0_rgb(var(--fg))]')}>
                <span className="label block">{p.level}</span>
                <span className="mt-1 flex items-center gap-2 font-display text-xl font-semibold">{p.name}{p.id === currentId && <Badge tone="inverse">Your plan</Badge>}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.k || i} className="border-b border-line last:border-b-0 align-top">
              <th scope="row" className="p-4 text-left font-medium text-muted">{r.k || <span className="sr-only">Change plan</span>}</th>
              {plans.map((p) => <td key={p.id} className={cn('p-4 border-l border-line', p.id === currentId && 'bg-sunken/70')}>{r.cell(p)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Cost calculator ─────────────────────────────────────── */

export function CostCalculator({ cur, defaultPlan, defaultActions, defaultShare }: { cur: Currency; defaultPlan: PlanId; defaultActions?: number; defaultShare?: number }) {
  const [actions, setActions] = useState(String(defaultActions ?? 72000));
  const [share, setShare] = useState(String(defaultShare ?? 6));
  const [planId, setPlanId] = useState<PlanId>(defaultPlan);
  const ids = { a: useId(), s: useId(), p: useId() };
  const a = Math.max(0, Math.min(50_000_000, Math.round(Number(actions.replace(/[, ]/g, '')) || 0)));
  const sh = Math.max(0, Math.min(100, Number(share) || 0)) / 100;
  const plan = PLANS[planId];
  const est = useMemo(() => estimateYear(plan, a, sh), [plan, a, sh]);
  // the preview link is for a plan above the organisation's, and only for the owner, who can change the plan
  const access = useScreenAccess();
  const showAdds = access.isOwner && levelRank(planId) > levelRank(access.level);
  const cIn = lineOf(est.lines, 'Governed actions inside');
  const rIn = lineOf(est.lines, 'Refused actions inside');
  const cOver = lineOf(est.lines, 'Governed actions beyond');
  const rOver = lineOf(est.lines, 'Refused actions beyond');
  const invalidA = actions.trim() !== '' && Number.isNaN(Number(actions.replace(/[, ]/g, '')));

  const Row = ({ k, v, strong, sub }: { k: React.ReactNode; v: React.ReactNode; strong?: boolean; sub?: React.ReactNode }) => (
    <div className={cn('flex items-baseline justify-between gap-4 py-2 border-b border-line last:border-b-0', strong && 'font-semibold')}>
      <div className="min-w-0"><p className="text-sm">{k}</p>{sub && <p className="text-xs text-muted">{sub}</p>}</div>
      <p className="text-sm num text-right whitespace-nowrap">{v}</p>
    </div>
  );

  return (
    <Panel title="Cost calculator" kicker="Same rules as the invoice" actions={<Calculator className="h-4 w-4 text-muted" aria-hidden />}>
      <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <div className="lg:col-span-4 space-y-4 min-w-0">
          <Field label="Governed actions a month" htmlFor={ids.a} hint="One tool call decided by Elan1 Govern." error={invalidA ? 'Enter a number.' : undefined}>
            <Input id={ids.a} inputMode="numeric" value={actions} onChange={(e) => setActions(e.target.value)} className="num" invalid={invalidA} />
          </Field>
          <Field label="Share refused" htmlFor={ids.s} hint="Include approvals that expired — an expiry is a refusal.">
            <div className="flex items-center gap-3">
              <input id={ids.s} type="range" min={0} max={50} step={0.5} value={Math.min(50, sh * 100)} onChange={(e) => setShare(e.target.value)} className="flex-1 accent-[rgb(var(--fg))]" aria-label="Share refused, percent" />
              <div className="w-[88px]"><Input value={share} onChange={(e) => setShare(e.target.value)} inputMode="decimal" className="num text-right" aria-label="Share refused, percent value" /></div>
              <span className="text-sm text-muted">%</span>
            </div>
          </Field>
          <Field label="Plan" htmlFor={ids.p}>
            <Select id={ids.p} value={planId} onChange={(e) => setPlanId(e.target.value as PlanId)}>
              {Object.values(PLANS).map((p) => <option key={p.id} value={p.id}>{p.level} · {p.name}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 gap-px bg-line border border-line [&>*]:min-w-0">
            <div className="bg-surface p-3">
              <p className="label">A month, average</p>
              <p className="mt-1 font-display text-xl sm:text-2xl font-semibold num break-words">{money(est.monthly, cur)}</p>
              <p className="text-xs text-muted">before GST</p>
            </div>
            <div className="bg-surface p-3">
              <p className="label">A year</p>
              <p className="mt-1 font-display text-xl sm:text-2xl font-semibold num break-words">{money(est.subtotal, cur)}</p>
              <p className="text-xs text-muted">{money(est.total, cur)} with GST</p>
            </div>
          </div>
          {est.firstOverMonth && plan.includedPerYear > 0 && <p className="text-xs text-muted">The allowance runs out in month {est.firstOverMonth} of the year; monthly bills rise from {money(est.firstMonth, cur)} to {money(est.lastMonth, cur)}.</p>}
        </div>

        <div className="lg:col-span-8 min-w-0">
          <p className="label mb-2">The arithmetic</p>
          <div className="border border-line bg-surface px-4">
            <Row k={planId === 'sovereign' ? 'Sovereign deployment licence' : `${plan.name} platform floor`} sub={planId === 'sovereign' ? 'Per deployment per year, in advance' : 'Never discounted'} v={money(plan.floorPerYear, cur)} />
            <Row k="Actions a year" sub={`${n(a)} × 12 — ${n(est.committed * 12)} allowed or approved, ${n(est.refused * 12)} refused`} v={n(a * 12)} />
            {plan.includedPerYear > 0 && (
              <Row
                k="Allowance used"
                sub={`${n(est.committed * 12)} × 1 + ${n(est.refused * 12)} × ${REFUSAL_FACTOR} of ${n(plan.includedPerYear)} included`}
                v={<>{n(Math.round(est.unitsPerYear))}<span className="text-muted"> ({pct(Math.min(9.99, est.unitsPerYear / plan.includedPerYear))})</span></>}
              />
            )}
            {plan.includedPerYear > 0 && <Row k="Allowed and approved inside allowance" sub="Included" v={<span className="text-muted">{n(cIn?.quantity ?? 0)} · {money(0, cur)}</span>} />}
            {plan.includedPerYear > 0 && <Row k="Refused inside allowance" sub={`Uses ${REFUSAL_FACTOR} of an included action each`} v={<span className="text-muted">{n(rIn?.quantity ?? 0)} · {money(0, cur)}</span>} />}
            <Row k={plan.includedPerYear ? 'Allowed and approved beyond allowance' : 'Allowed and approved actions'} sub={`${n(cOver?.quantity ?? 0)} × ${rate(plan.overageRate, cur)}`} v={money(cOver?.amount ?? 0, cur)} />
            <Row k={plan.includedPerYear ? 'Refused beyond allowance' : 'Refused actions'} sub={`${n(rOver?.quantity ?? 0)} × ${rate(plan.refusalRate, cur)} (${pct(REFUSAL_FACTOR)} of ${rate(plan.overageRate, cur)})`} v={money(rOver?.amount ?? 0, cur)} />
            <Row k="Subtotal" v={money(est.subtotal, cur)} strong />
            <Row k={`GST ${pct(GST_RATE)}`} v={money(est.gst, cur)} />
            <Row k="Total a year" v={money(est.total, cur)} strong />
          </div>
          <p className="mt-2 text-xs text-muted">Worked month by month: allowed and approved actions draw the allowance first, then refusals at {REFUSAL_FACTOR} each.{showAdds && <> <Link className="underline underline-offset-2" to={`/assurance/upgrade?to=${planId}`}>What {plan.name} adds</Link>.</>}</p>
        </div>
      </div>
    </Panel>
  );
}
