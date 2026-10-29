import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, Gauge, RefreshCw, Server } from 'lucide-react';
import { api, db } from '@/api';
import type { AnchorsView, ComponentStatus, KeyCustody, StatusComponent, StatusView } from '@/types';
import { LEVEL_INFO, levelOfOrg } from '@/lib/levels';
import { canonical, verifySig } from '@/lib/crypto';
import { dateTime, n, pct, relative, seqLabel, timeShort } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Banner, Button, Meter, Skeleton, StatusChip, Timeline } from '@/components/ui';
import { PublicChrome } from '@/features/verify/PublicChrome';
import { createdOrg } from '@/features/auth/registry';
import { useUser } from '@/store/session';
import { BUDGET_POLICY, errorBudget, slos, writerAndMeter, type ErrorBudget, type Slo } from '@/mock/statusSlo';
import { ComponentRow, STATUS_META, StatusLegend, daysFromTimes, worstOf, type StatusRow as Row } from './parts';

const GROUP_ORDER = ['Platform', 'Delivery', 'Key custody and storage', 'Timestamping', 'Chain integrity'];

interface Extra { anchors: Record<string, AnchorsView>; custody: Record<string, KeyCustody>; worm?: { backend: string; mode: string; years: number } }

async function load(): Promise<{ view: StatusView; rows: Row[]; slos: Slo[]; budget: ErrorBudget; sovereignCount: number }> {
  const view = await api.status();
  // Elan1 publishes only what it hosts. A Sovereign deployment runs in the customer's own network and shows its
  // own local status inside it (Agents › Deployment › Local status); it is never listed here.
  const seededAll = db.orgIds().filter((id) => !createdOrg(id));
  const seeded = seededAll.filter((id) => db.getDB(id).org.deployment !== 'sovereign');
  const extra: Extra = { anchors: {}, custody: {} };
  for (const id of seeded) {
    extra.anchors[id] = await api.anchors(id, 1);
    extra.custody[id] = await api.custody(id);
  }
  const dep = await api.deployment('org_northbank');
  extra.worm = { backend: dep.storage.backend, mode: dep.storage.objectLock, years: dep.storage.retentionYears };

  const rows: Row[] = view.components
    .filter((c) => c.group !== 'Chain integrity' || seeded.includes(c.id.replace(/^chain_/, '')))
    .map((c: StatusComponent) => ({ id: c.id, name: c.name, group: c.group, status: c.status, detail: c.detail, uptime: c.uptime90, days: c.days }));

  // the receipt writer and the meter, each a component of its own, after the decision API
  const wm = writerAndMeter();
  const at = rows.findIndex((r) => r.id === 'gate');
  rows.splice(at >= 0 ? at + 1 : 0, 0, ...wm.map((c) => ({ id: c.id, name: c.name, group: c.group, status: c.status, detail: c.detail, uptime: c.uptime, days: c.days })));

  // Chain integrity per organisation: the last checkpoint (re-verified here) and how far timestamps lag.
  for (const r of rows.filter((x) => x.group === 'Chain integrity')) {
    const orgId = r.id.replace(/^chain_/, '');
    const d = db.getDB(orgId);
    const cp = d.checkpoints[d.checkpoints.length - 1];
    const cpOk = !!cp && verifySig(canonical({ org: cp.org, seq: cp.seq, hash: cp.hash, ts: cp.ts, kid: cp.kid }), cp.sig, d.publicKeys[cp.kid]);
    const a = extra.anchors[orgId];
    const lv = levelOfOrg(d.org);
    const last = a?.batches[0];
    const lag = last ? Math.max(...last.tokens.map((t) => t.delaySeconds)) : undefined;
    r.name = d.org.name;
    r.level = LEVEL_INFO[lv].label;
    r.to = '/verify';
    r.days = daysFromTimes(d.checkpoints.map((c) => new Date(c.ts).getTime()));
    const withData = r.days.filter((x) => x.status !== 'nodata').length;
    r.uptime = undefined;
    // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided. L2 and above keep "signed".
    const l1 = lv === 'l1';
    r.facts = [
      { label: 'Last verified checkpoint', value: cp ? `${seqLabel(cp.seq)} · ${relative(cp.ts)} · ${l1 ? 'seal' : 'signature'} ${cpOk ? 'verifies' : 'does not verify'}` : 'none yet' },
      { label: 'Chain head', value: seqLabel(d.receipts[d.receipts.length - 1].seq) },
      { label: 'Timestamp lag', value: !a?.enabled ? 'Not timestamped — sealed in a hash chain by Elan1 Govern · not yet externally timestamped' : lag !== undefined ? `${Math.floor(Math.round(lag) / 60)} min ${Math.round(lag) % 60} s on the last batch · ${a.totals.unanchoredTail} records in the open window` : 'No batch yet' },
      { label: l1 ? 'Days with sealed checkpoints' : 'Days with signed checkpoints', value: `${withData} of 90` },
    ];
    if (!cpOk && cp) r.status = 'outage';
  }

  // Key custody: signing keys in AWS KMS per residency domain (hosted L2) and customer-held keys in CloudHSM (hosted L3).
  const custodyRows = seeded.map((id) => ({ id, c: extra.custody[id], d: db.getDB(id) })).filter((x) => x.c.mode !== 'env_master');
  for (const { id, c, d } of custodyRows) {
    const signedBy = d.receipts.filter((r) => r.kid === c.kid).map((r) => new Date(r.ts).getTime());
    const head = d.receipts[d.receipts.length - 1];
    const ok = verifySig(head.hash, head.sig, d.publicKeys[head.kid]);
    rows.push({
      id: `custody_${id}`, name: `${c.provider} — ${d.org.name}`, group: 'Key custody and storage', status: ok ? 'operational' : 'outage',
      detail: `${c.heldBy === 'customer' ? 'Held by the customer' : 'Used only by Elan1 Govern'} in ${c.residencyDomain}. The newest receipt (${seqLabel(head.seq)}) is signed by ${head.kid} and ${ok ? 'verifies' : 'does not verify'}.`,
      days: daysFromTimes(signedBy), facts: [{ label: 'Key', value: `${c.kid} · ${c.fingerprint}` }, { label: 'Rotation', value: c.rotation.policy }], level: LEVEL_INFO[levelOfOrg(d.org)].label,
    });
  }
  // Write-once storage: every batch is written under Object Lock; the days batches were written.
  const batchTimes = seeded.flatMap((id) => (extra.anchors[id]?.enabled ? db.getDB(id).receipts.filter((r) => new Date(r.ts).getTime() >= new Date(extra.anchors[id].since ?? 0).getTime()).map((r) => new Date(r.ts).getTime()) : []));
  if (extra.worm) rows.push({
    id: 'worm', name: `Write-once storage (${extra.worm.backend})`, group: 'Key custody and storage', status: 'operational',
    detail: `Receipts, seals and bundles for hosted L2 and L3 are stored under Object Lock in ${extra.worm.mode} mode for ${extra.worm.years} years.`,
    days: daysFromTimes(batchTimes), facts: [{ label: 'Lock', value: `${extra.worm.mode} mode · ${extra.worm.years} years` }],
  });

  rows.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return { view, rows, slos: slos(), budget: errorBudget(), sovereignCount: seededAll.length - seeded.length };
}

/**
 * /status — public. What Elan1 hosts: platform components (the decision API, the receipt writer and the meter
 * among them), delivery, key custody and write-once storage, the timestamp authorities and the integrity of each
 * hosted organisation's chain, each with 90 days of history; the service-level objectives with the error budget
 * and its policy; and the incident log. Sovereign deployments are not Elan1's to publish and never appear here.
 */
export default function StatusPage() {
  const user = useUser();
  const [data, setData] = useState<Awaited<ReturnType<typeof load>>>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [checkedAt, setCheckedAt] = useState<string>();

  const refresh = () => {
    setBusy(true);
    setError(undefined);
    // building each organisation's chain is real work; let the page paint first
    window.setTimeout(() => {
      load().then((d) => { setData(d); setCheckedAt(new Date().toISOString()); }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
    }, 40);
  };

  useEffect(() => { document.title = 'Status · Elan1 Govern'; refresh(); const t = window.setInterval(refresh, 120_000); return () => window.clearInterval(t); }, []);

  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of data?.rows ?? []) (m.get(r.group) ?? m.set(r.group, []).get(r.group)!).push(r);
    return [...m.entries()];
  }, [data]);

  const overall: ComponentStatus = data ? worstOf(data.rows) : 'operational';
  const meta = STATUS_META[overall];

  return (
    <PublicChrome>
      <div className="mx-auto max-w-[1080px] px-4 py-8 lg:px-8 lg:py-12">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-[70ch]">
            <p className="label text-accent-fg">Public status</p>
            <h1 className="mt-2 text-4xl sm:text-5xl font-bold tracking-tighter2 leading-[1.05]">Elan1 Govern status</h1>
            <p className="mt-3 text-md text-muted leading-relaxed">What Elan1 hosts: the decision service, the receipt writer and the meter, approvals and channels, key custody, write-once storage, the timestamp authorities and — as a component of its own — the integrity of each hosted organisation’s receipt chain, re-checked when this page loads.</p>
          </div>
          <Button variant="secondary" icon={<RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />} onClick={refresh} disabled={busy}>Check again</Button>
        </header>

        {error && <Banner tone="bad" title="Status could not be loaded" className="mt-8" actions={<Button size="sm" onClick={refresh}>Try again</Button>}>{error}</Banner>}

        <section aria-live="polite" className={cn('mt-8 border border-line border-l-[6px] bg-surface p-5 sm:p-6', data ? (overall === 'operational' ? 'border-l-ok' : overall === 'degraded' ? 'border-l-held' : overall === 'outage' ? 'border-l-bad' : 'border-l-info') : 'border-l-line-strong')}>
          {data ? (
            <div className="flex flex-wrap items-center gap-3">
              <meta.icon className={cn('h-6 w-6', { ok: 'text-ok-fg', held: 'text-held-fg', bad: 'text-bad-fg', info: 'text-info-fg' }[meta.tone])} aria-hidden />
              <p className="font-display text-2xl font-semibold">{overall === 'operational' ? 'Every component is operational' : overall === 'degraded' ? 'Some components are degraded' : overall === 'outage' ? 'A component is down' : 'Planned maintenance in progress'}</p>
              <span className="sm:ml-auto text-sm text-muted num">Checked {checkedAt ? `${timeShort(checkedAt)} IST` : '—'} · refreshes every 2 minutes</span>
              {data.rows.some((r) => r.status === 'maintenance') && (
                <Link to="/maintenance" className="basis-full inline-flex items-center gap-1 text-sm link">The console is in planned maintenance — what keeps working and when it is back<ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3 text-muted"><Clock3 className="h-5 w-5" aria-hidden />Opening each hosted organisation’s chain and re-checking its head and last checkpoint…</div>
          )}
        </section>

        {user && (
          <p className="mt-4 text-sm text-muted">Signed in: incident updates, post-incident notes and your daily chain-head statement reach your organisation’s named contact. <Link to="/agents/notices" className="link">Notices from Elan1</Link></p>
        )}

        {data && <SloSection slos={data.slos} />}
        {data && <BudgetSection b={data.budget} />}

        <div className="mt-12"><StatusLegend /></div>

        {!data && !error && (
          <div className="mt-8 space-y-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
        )}

        {groups.map(([group, rows]) => (
          <section key={group} className="mt-10" aria-labelledby={`g-${group}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
              <h2 id={`g-${group}`} className="text-xl font-semibold">{group}</h2>
              {group === 'Chain integrity' && <span className="text-xs text-muted">One component per hosted organisation. Re-verified in your browser when this page loads.</span>}
              {group === 'Timestamping' && <span className="text-xs text-muted">RFC 3161 · two authorities per batch, within 15 minutes</span>}
            </div>
            <ul className="divide-y divide-line border-x border-b border-line bg-surface">
              {rows.map((r) => <ComponentRow key={r.id} r={r} />)}
            </ul>
            {group === 'Chain integrity' && data && data.sovereignCount > 0 && (
              <p className="mt-3 flex items-start gap-2 text-sm text-muted"><Server className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Sovereign deployments are not listed. They run on the customer’s own infrastructure with egress denied, so Elan1 has nothing to measure and publishes nothing about them; each shows its own local status inside its network.</p>
            )}
          </section>
        ))}

        {data && (
          <section className="mt-12" aria-labelledby="inc-h">
            <h2 id="inc-h" className="text-xl font-semibold border-b border-line pb-2">Incident history</h2>
            <p className="mt-3 text-sm text-muted max-w-[72ch]">While an incident is open, each affected organisation’s named contact gets an update at least every 30 minutes, and a post-incident note within one working day of the fix.</p>
            {data.view.incidents.length ? (
              <div className="mt-4 space-y-6">
                {data.view.incidents.map((inc) => (
                  <article key={inc.id} className="border border-line bg-surface p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-md font-semibold">{inc.title}</h3>
                      <StatusChip size="sm" tone={inc.status === 'resolved' ? 'ok' : 'held'} icon={inc.status === 'resolved' ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <AlertTriangle className="h-3 w-3" aria-hidden />}>{inc.status === 'resolved' ? 'Resolved' : 'Monitoring'}</StatusChip>
                      <span className="text-xs text-muted sm:ml-auto num">{dateTime(inc.startedAt)}{inc.resolvedAt ? ` – ${timeShort(inc.resolvedAt)} IST` : ''}</span>
                    </div>
                    <div className="mt-4"><Timeline items={inc.updates.map((u) => ({ time: dateTime(u.at), title: u.text }))} /></div>
                  </article>
                ))}
              </div>
            ) : <p className="mt-4 text-sm text-muted">No incidents in the last 90 days.</p>}
          </section>
        )}

        <div className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6 text-sm text-muted">
          <p className="max-w-[70ch]">Agents keep being governed while the console is unavailable: the decision service and the chain run separately. Exported bundles always verify offline.</p>
          <span className="flex flex-wrap gap-4">
            <Link to="/verify" className="link inline-flex items-center gap-1">Verify a bundle <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
            <Link to="/legal/sub-processors" className="link">Sub-processors</Link>
            <a href="mailto:support@elan1.ai" className="link">support@elan1.ai</a>
          </span>
        </div>
      </div>
    </PublicChrome>
  );
}

/* ── Service-level objectives ───────────────────────────────────────────── */

function SloSection({ slos }: { slos: Slo[] }) {
  const met = slos.filter((s) => s.met).length;
  return (
    <section className="mt-10" aria-labelledby="slo-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
        <h2 id="slo-h" className="text-xl font-semibold inline-flex items-center gap-2"><Gauge className="h-5 w-5" aria-hidden />Service-level objectives</h2>
        <span className="text-xs text-muted">Targets, measured over the last 30 days · {met} of {slos.length} met</span>
      </div>
      <ul className="mt-4 grid gap-px bg-line border border-line sm:grid-cols-2 lg:grid-cols-3">
        {slos.map((s) => (
          <li key={s.id} className="bg-surface p-4 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold leading-snug">{s.name}</p>
              {s.met ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Met</StatusChip> : <StatusChip tone="held" size="sm" icon={<AlertTriangle className="h-3 w-3" aria-hidden />}>Missed</StatusChip>}
            </div>
            <p className="mt-2 font-display text-2xl font-semibold num">{s.measured}</p>
            <p className="text-xs text-muted">Target: {s.target}</p>
            <div className="mt-3 flex h-8 items-end gap-[2px]" role="img" aria-label={`${s.name}, last 30 days: ${s.daily.filter((v) => v > 1).length} days over target.`}>
              {s.daily.map((v, i) => <span key={i} className={cn('flex-1 min-w-[1px]', v > 1 ? 'bg-held' : 'bg-fg/70')} style={{ height: `${Math.max(6, Math.min(100, (v / 1.25) * 100))}%` }} />)}
            </div>
            <p className="mt-2 text-xs text-muted leading-relaxed">{s.how}</p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">Each bar is one day: the taller it is, the closer that day came to the target, and a highlighted bar missed it. These are targets we hold ourselves to, not contractual service credits.</p>
    </section>
  );
}

/* ── Error budget ───────────────────────────────────────────────────────── */

function BudgetSection({ b }: { b: ErrorBudget }) {
  const tone = b.stage === 'freeze' ? 'bad' : b.stage === 'caution' ? 'held' : 'ok';
  return (
    <section className="mt-10" aria-labelledby="eb-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2">
        <h2 id="eb-h" className="text-xl font-semibold">Error budget</h2>
        <span className="text-xs text-muted">Governed write path · {pct(b.objective, 1)} over {b.windowDays} days</span>
      </div>
      <div className="mt-4 grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5 border border-line bg-surface p-5">
          <p className="label">Spent in the last {b.windowDays} days</p>
          <p className="mt-1 font-display text-3xl font-semibold num">{n(b.spentMinutes)} <span className="text-lg text-muted font-normal">of {n(b.budgetMinutes)} minutes</span></p>
          <Meter className="mt-3" value={Math.min(1, b.spentShare)} tone={tone} label={`Error budget spent: ${pct(b.spentShare)}`} />
          <p className="mt-2 text-sm text-muted">{pct(b.spentShare)} spent · {n(b.remainingMinutes)} minutes left. A bad minute is one in which the decision API or the receipt writer did not answer within 450 ms.</p>
          <p className="mt-4 flex flex-wrap items-center gap-2 text-sm"><span className="label">Policy in force</span><StatusChip tone={tone} size="sm">{BUDGET_POLICY.find((p) => p.stage === b.stage)?.when}</StatusChip></p>
        </div>
        <div className="lg:col-span-7 min-w-0">
          <div className="overflow-x-auto border border-line bg-surface">
            <table className="w-full min-w-[520px] text-sm">
              <caption className="sr-only">Burn rate over several windows</caption>
              <thead className="bg-sunken/80"><tr className="border-b border-line">
                <th scope="col" className="h-9 px-4 text-left label font-semibold">Window</th>
                <th scope="col" className="h-9 px-3 text-right label font-semibold">Burn rate</th>
                <th scope="col" className="h-9 px-3 text-right label font-semibold">Alert at</th>
                <th scope="col" className="h-9 px-3 text-left label font-semibold">What happens</th>
              </tr></thead>
              <tbody>
                {b.burn.map((x) => (
                  <tr key={x.window} className="border-b border-line last:border-b-0">
                    <th scope="row" className="px-4 py-2 text-left font-normal">{x.window}</th>
                    <td className={cn('px-3 py-2 text-right num', x.over && 'text-bad-fg font-semibold')}>{x.rate.toFixed(2)}×</td>
                    <td className="px-3 py-2 text-right num text-muted">{x.threshold}×</td>
                    <td className="px-3 py-2 text-xs text-muted">{x.over ? <span className="text-bad-fg">Triggered — </span> : null}{x.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">A burn rate of 1× spends the whole budget in exactly {b.windowDays} days.</p>
        </div>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <h3 className="text-md font-semibold">Error-budget policy</h3>
          <ol className="mt-3 border border-line divide-y divide-line bg-surface">
            {BUDGET_POLICY.map((p) => (
              <li key={p.stage} className={cn('px-4 py-3', p.stage === b.stage && 'border-l-[4px] border-l-fg')}>
                <p className="text-sm font-semibold">{p.when}{p.stage === b.stage && <span className="ml-2 text-xs font-normal text-muted">in force now</span>}</p>
                <p className="mt-0.5 text-sm text-muted">{p.what}</p>
              </li>
            ))}
          </ol>
          <p className="mt-2 text-xs text-muted">Any single event that spends a tenth of the budget or more gets a post-incident note to every affected organisation’s named contact.</p>
        </div>
        <div className="lg:col-span-5 min-w-0">
          <h3 className="text-md font-semibold">What spent it</h3>
          <ul className="mt-3 border border-line divide-y divide-line bg-surface max-h-[280px] overflow-y-auto">
            {[...b.events].reverse().map((e) => (
              <li key={e.at} className="px-4 py-2.5 text-sm">
                <p className="flex flex-wrap items-baseline gap-x-2"><span className="num font-semibold">{e.minutes} min</span><span className="text-muted">{e.component}</span><span className="ml-auto text-xs text-muted num">{dateTime(e.at)}</span></p>
                <p className="text-xs text-muted">{e.cause}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
