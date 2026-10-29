import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Check, CheckCircle2, Circle, Clock3, FlaskConical, KeyRound, Layers, MapPin, Minus, Server, ShieldCheck, Stamp, Waypoints } from 'lucide-react';
import { api } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useRole } from '@/store/session';
import type { CapabilityId, LevelId, TestVectorSuite } from '@/types';
import { PLANS, REFUSAL_FACTOR } from '@/lib/pricing';
import { LEVELS, LEVEL_INFO, levelRank } from '@/lib/levels';
import { date, n, plural, relative, rupees, rupeesShort, seqLabel } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, Disc, EmptyState, PageHeader, Panel, Segmented, Skeleton, StatusChip } from '@/components/ui';
import { claimFor, LEVEL_COPY } from './levelModel';
import { CloseoutCard } from './upgrade/CloseoutCard';
import { ListPriceTag } from '@/features/billing/ListPriceTag';
import { PlanUpsell, SmartLink, useScreenAccess } from '@/shell/access';

type Filter = 'all' | LevelId;

/** Rows the capability catalogue does not carry as separate ids but a buyer asks about. */
const EXTRA_ROWS: { id: string; label: string; level: LevelId; route: string; description: string; requires: CapabilityId }[] = [
  { id: 'check_and_record', label: 'Check and record (REST and SDK)', level: 'l1', route: '/developers', description: 'Elan1 Govern decides and records; the agent runs the call. Blocking happens only on the MCP governed run.', requires: 'governed_run' },
  { id: 'meter', label: 'Meter from the chain', level: 'l1', route: '/billing', description: 'One meter event per governed action, read from the receipts; a refusal counts 0.4.', requires: 'signed_receipts' },
  { id: 'boundary', label: 'Level boundary with counts', level: 'l2', route: '/assurance/levels#boundaries', description: 'The moment the organisation moved up, the first record at the new level, and how many records sit each side.', requires: 'seal_v6' },
];

export default function AssurancePage() {
  const nav = useNavigate();
  const role = useRole();
  const [filter, setFilter] = useState<Filter>('all');

  const { data, loading, error, refetch } = useQuery(async (o) => {
    const [lv, ev, custody, anchors, members] = await Promise.all([api.level(o), api.evidence(o), api.custody(o), api.anchors(o, 2), api.members(o)]);
    return { lv, ev, custody, anchors, owners: members.filter((m) => m.role === 'owner' && m.status === 'active').map((m) => m.user?.name ?? m.userId) };
  }, []);

  const lv = data?.lv;
  const level = lv?.level ?? 'l1';
  const next = lv?.next;
  const isOwner = role === 'owner';
  // owners and admins prepare an upgrade (start it and record its stages); only an owner confirms it, in the wizard
  const canPrepare = isOwner || role === 'admin';
  const ownerNames = data?.owners.join(', ') || 'an owner';

  const rows = useMemo(() => {
    if (!lv) return [];
    const caps = lv.capabilities.map((c) => ({ id: c.id as string, label: c.label, level: c.level, route: c.route, description: c.description, enabled: c.enabled, since: c.since }));
    const extras = EXTRA_ROWS.map((x) => ({ ...x, enabled: lv.capabilities.find((c) => c.id === x.requires)?.enabled ?? false, since: lv.capabilities.find((c) => c.id === x.requires)?.since }));
    return [...caps, ...extras].sort((a, b) => levelRank(a.level) - levelRank(b.level));
  }, [lv]);
  const shown = rows.filter((r) => filter === 'all' || r.level === filter);

  // In-page anchors such as #boundaries (the 'Level boundary with counts' row links here): React Router changes
  // the hash but does not scroll, so scroll once the section has rendered.
  const { hash, pathname } = useLocation();
  const onRowLink = (route: string) => {
    const [path, id] = route.split('#');
    if (id && path === pathname) document.getElementById(id)?.scrollIntoView({ block: 'start' }); // same hash twice: no location change
  };
  useEffect(() => {
    if (!hash || !lv) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (el) window.setTimeout(() => el.scrollIntoView({ block: 'start' }), 0);
  }, [hash, lv]);
  const onCount = rows.filter((r) => r.enabled).length;
  // Seal v6 test vectors: shown once the plan includes them (from L2); below it owners get one line
  // (nothing renders until the level is known, so no higher-level section flashes in and out while it loads)
  const vectorsOn = !!lv?.capabilities.find((c) => c.id === 'two_implementations')?.enabled;
  // the "Move to" panel is for owners and admins, who prepare an upgrade; the Sovereign note is for everyone
  const showMove = !!lv && (!next || canPrepare);

  const { canSee } = useScreenAccess();
  // viewers and auditors cannot prepare an upgrade: they see no upgrade button at all
  const startBtn = (to: LevelId | undefined, size: 'sm' | 'md' = 'md') => to && canPrepare && (
    <Button size={size} variant="primary" icon={<Layers className="h-4 w-4" />}
      title={!isOwner ? `You can prepare the upgrade; only an owner confirms it. Owners here: ${ownerNames}.` : undefined}
      onClick={() => nav(`/assurance/upgrade?to=${to}`)}>
      {isOwner ? 'Start the upgrade to' : 'Prepare the upgrade to'} {LEVEL_INFO[to].name}
    </Button>
  );

  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Assurance levels"
        description="What Elan1 Govern proves at each level, which of it this organisation has switched on, and what moving up adds, costs and changes."
        meta={lv && (
          <>
            <StatusChip tone="inverse" icon={<MapPin className="h-3.5 w-3.5" aria-hidden />}>{LEVEL_INFO[level].label}</StatusChip>
            <span className="text-sm text-muted">Since {date(lv.since)} · {lv.deployment === 'sovereign' ? 'on your own infrastructure' : 'hosted by elan1'} · {lv.residency}</span>
          </>
        )}
        actions={next ? startBtn(next) : lv && canSee('/agents/deployment') && <Button variant="secondary" icon={<Server className="h-4 w-4" />} onClick={() => nav('/agents/deployment')}>Your deployment</Button>}
      />

      {error && <Banner tone="bad" className="mb-6" title="The assurance level could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      {/* Current position */}
      <section aria-labelledby="pos-h" className="mb-8 grid lg:grid-cols-12 border border-line bg-surface">
        <div className="lg:col-span-7 p-5 sm:p-6 border-b lg:border-b-0 lg:border-r border-line min-w-0">
          <p className="label mb-2 flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" aria-hidden />Where this organisation stands</p>
          {!lv ? <div className="space-y-2"><Skeleton className="h-7 w-full" /><Skeleton className="h-7 w-2/3" /></div> : (
            <>
              <h2 id="pos-h" className="text-xl sm:text-2xl font-semibold leading-snug max-w-[58ch]">
                {data!.ev.org.name} is on {LEVEL_INFO[level].name}{LEVEL_INFO[level].short !== LEVEL_INFO[level].name ? ` (${LEVEL_INFO[level].short})` : ''}. Every record written since {date(lv.since)} is {claimFor(level)}.
              </h2>
              <p className="mt-3 text-sm text-muted max-w-[64ch]">{LEVEL_COPY[level].wouldSay}</p>
              <ol className="mt-4 flex flex-wrap gap-2" aria-label="Levels">
                {LEVELS.map((l) => {
                  const reached = lv.history.find((h) => h.level === l);
                  const here = l === level;
                  return (
                    <li key={l}>
                      <StatusChip size="sm" tone={here ? 'inverse' : reached || levelRank(l) < levelRank(level) ? 'ok' : 'neutral'}
                        icon={here ? <MapPin className="h-3 w-3" aria-hidden /> : levelRank(l) < levelRank(level) ? <Check className="h-3 w-3" aria-hidden /> : <Circle className="h-3 w-3" aria-hidden />}>
                        {LEVEL_INFO[l].short !== LEVEL_INFO[l].name ? `${LEVEL_INFO[l].short} ` : ''}{LEVEL_INFO[l].name}{here ? ' · here' : levelRank(l) < levelRank(level) ? ' · included' : ' · available'}
                      </StatusChip>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>
        <div className="lg:col-span-5 p-5 sm:p-6 bg-sunken/40 min-w-0">
          <p className="label mb-3">What you can check on your own chain now</p>
          {loading && !data ? (
            <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-6" />)}</div>
          ) : data && (data.ev.total === 0 || !data.ev.head ? (
            <EmptyState compact disc="trail" title="No receipts yet">The first governed call writes the first receipt. Connect an agent from the Agents door.</EmptyState>
          ) : (
            <ul className="space-y-2.5 text-sm">
              <Fact icon={<Waypoints className="h-4 w-4" aria-hidden />}>{n(data.ev.total)} receipts, hash-chained to <Link to={`/activity/${data.ev.head.seq}`} className="font-mono hover:underline underline-offset-2">{seqLabel(data.ev.head.seq)}</Link>; {n(data.ev.checkpoints.length)} {level === 'l1' ? 'sealed' : 'signed'} checkpoints{data.ev.checkpoints[0] ? `, the last ${relative(data.ev.checkpoints[0].ts)}` : ''}</Fact>
              <Fact icon={<KeyRound className="h-4 w-4" aria-hidden />}>
                {/* L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided. */}
                {level === 'l1' ? 'Sealed with the' : 'Signed in'} {data.custody.provider} ·{data.custody.heldBy === 'customer' ? 'held by you' : 'held by elan1'}{data.custody.quorum ? ` · ${data.custody.quorum.required} of ${data.custody.quorum.of} quorum` : ''}
                <span className="block font-mono text-[12px] text-muted break-all">{data.custody.kid} · {data.custody.fingerprint}</span>
              </Fact>
              {data.anchors.enabled ? (
                <Fact icon={<Stamp className="h-4 w-4" aria-hidden />}>
                  {data.anchors.batches[0] ? <>Last batch {seqLabel(data.anchors.batches[0].firstSeq)}–{seqLabel(data.anchors.batches[0].lastSeq)} timestamped by {data.anchors.batches[0].tokens.map((t) => t.tsaName).join(' and ')} {relative(data.anchors.batches[0].windowEnd)}</> : 'No batch timestamped yet'}
                  <span className="block text-muted">{plural(data.anchors.totals.unanchoredTail, 'record')} in the unanchored tail · {Math.round(data.anchors.totals.withinTargetPct * 100)}% of batches within {data.anchors.totals.targetMinutes} minutes</span>
                </Fact>
              ) : (
                <Fact icon={<Stamp className="h-4 w-4" aria-hidden />}>Not externally timestamped.{isOwner && <> Two-authority timestamps start at L2 — <Link className="link" to="/assurance/upgrade?to=l2">see what the upgrade adds</Link>.</>}</Fact>
              )}
              <li className="flex flex-wrap gap-x-4 gap-y-1 pt-2">
                <Link to="/evidence" className="inline-flex items-center gap-1 font-medium hover:underline underline-offset-2">Proof and keys<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
                {data.anchors.enabled && <Link to="/assurance/anchors" className="inline-flex items-center gap-1 font-medium hover:underline underline-offset-2">Timestamps<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>}
                <Link to="/verify" className="inline-flex items-center gap-1 font-medium hover:underline underline-offset-2">Verify a bundle<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
              </li>
            </ul>
          ))}
        </div>
      </section>

      {/* Ladder */}
      <section aria-labelledby="ladder-h" className="mb-10">
        <div className="flex items-end justify-between gap-4 mb-4">
          <div>
            <p className="label mb-1">The ladder</p>
            <h2 id="ladder-h" className="text-xl font-semibold">Guarded → Attested → Proven → Sovereign</h2>
            <p className="mt-1 text-sm text-muted max-w-[68ch]">Each level answers a harder question for a different reader and includes everything below it. Sovereign is Proven, run on your own infrastructure.</p>
          </div>
          <Disc kind="trail" size={64} title="Rising through the levels" className="hidden sm:block" />
        </div>
        <ol className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4 md:items-stretch">
          {LEVELS.map((id, i) => {
            const plan = PLANS[id];
            const copy = LEVEL_COPY[id];
            const here = id === level;
            const below = levelRank(id) < levelRank(level);
            const reachedAt = lv?.history.find((h) => h.level === id)?.from;
            const capOn = (cap: CapabilityId) => lv?.capabilities.find((c) => c.id === cap)?.enabled ?? false;
            return (
              <li key={id} className={cn('relative flex flex-col border bg-surface min-w-0', here ? 'border-fg shadow-[inset_0_3px_0_rgb(var(--fg))]' : 'border-line')}>
                <div className="flex items-start justify-between gap-3 px-5 pt-5">
                  <div>
                    <p className="label">{LEVEL_INFO[id].short} · Step {i + 1} of 4</p>
                    <h3 className="mt-1 text-2xl font-semibold">{plan.name}</h3>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    {here ? <Badge tone="inverse" icon={<MapPin className="h-3 w-3" aria-hidden />}>You are here</Badge>
                      : below ? <Badge tone="ok" icon={<Check className="h-3 w-3" aria-hidden />}>Included</Badge>
                        : <Badge icon={<ArrowUpRight className="h-3 w-3" aria-hidden />}>Available</Badge>}
                    {reachedAt && <span className="text-[11px] text-muted">from {date(reachedAt)}</span>}
                  </div>
                </div>
                <p className="px-5 mt-3 text-md font-medium leading-snug">“{copy.question}”</p>
                <p className="px-5 mt-2 text-sm text-muted">{copy.forWhom}</p>
                <div className="mt-4 px-5 py-4 border-t border-line">
                  <p className="label mb-2">What it proves</p>
                  <ul className="space-y-1.5 text-sm">
                    {plan.proves.map((p) => <li key={p} className="flex gap-2"><Check className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted" aria-hidden />{p}</li>)}
                  </ul>
                </div>
                <div className="px-5 py-4 border-t border-line">
                  <p className="label mb-2">What must be true{lv ? ' — here' : ''}</p>
                  <ul className="space-y-1.5 text-sm">
                    {copy.mustBeTrue.map((p) => {
                      const on = capOn(p.cap);
                      return (
                        <li key={p.text} className="flex gap-2">
                          {on ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-ok-fg" aria-label="On for this organisation" /> : <Minus className="h-3.5 w-3.5 mt-0.5 shrink-0 text-subtle" aria-label="Starts at this level" />}
                          <span className={on ? '' : 'text-muted'}>{p.text}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {copy.deployment && (
                    <details className="mt-3 text-sm">
                      <summary className="cursor-pointer font-medium">Deployment checklist ({copy.deployment.length})</summary>
                      <ul className="mt-2 space-y-1 text-muted list-disc pl-5">{copy.deployment.map((x) => <li key={x}>{x}</li>)}</ul>
                    </details>
                  )}
                </div>
                <div className="px-5 py-4 border-t border-line bg-sunken/40">
                  <p className="label mb-1">The evidence claim</p>
                  <p className="text-sm leading-relaxed">Records are {copy.claim}.</p>
                </div>
                <div className="mt-auto px-5 py-4 border-t border-line">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-muted">{id === 'sovereign' ? 'Per deployment' : 'Platform floor'}</span>
                    <span><span className="font-display text-xl font-semibold num">{id === 'sovereign' ? rupeesShort(plan.floorPerYear) : rupees(plan.floorPerYear)}</span><span className="text-sm text-muted"> a year</span></span>
                  </div>
                  <p className="mt-1 text-xs text-muted num">
                    {plan.includedPerYear ? `${n(plan.includedPerYear)} actions included · ` : 'No allowance · '}{rupees(plan.overageRate, { paise: true })} an action · refused {rupees(plan.refusalRate, { paise: true })}
                  </p>
                  <ListPriceTag planId={id} className="mt-1" />
                  {!here && !below && canPrepare && (
                    <Button className="mt-3" size="sm" block variant={id === next ? 'primary' : 'secondary'}
                      title={!isOwner ? `Only an owner confirms the upgrade. Owners here: ${ownerNames}.` : undefined}
                      onClick={() => nav(`/assurance/upgrade?to=${id}`)} iconRight={<ArrowRight className="h-3.5 w-3.5" />}>
                      {isOwner ? `Upgrade to ${plan.name}` : `Prepare the upgrade to ${plan.name}`}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        <p className="mt-3 text-xs text-muted">Prices before GST. A refused action costs {Math.round(REFUSAL_FACTOR * 100)}% of the per-action rate; inside the allowance it uses {REFUSAL_FACTOR} of an included action.{canSee('/billing') && <> <Link to="/billing" className="underline underline-offset-2 hover:text-fg">The meter</Link> has the full price book.</>}</p>
      </section>

      {/* Boundaries */}
      <section id="boundaries" aria-labelledby="bnd-h" className="mb-10 scroll-mt-24">
        <Panel title={<span id="bnd-h">Level boundaries</span>} kicker="Records keep the level they were written at" flush
          footer="Records before a boundary are not failures: they stay at their level and keep verifying with the same verifier.">
          {!lv ? <div className="p-5"><Skeleton className="h-20" /></div> : lv.boundaries.length === 0 ? (
            <div className="p-5 text-sm text-muted">
              {LEVEL_INFO[level].label} since {date(lv.since)} — no boundary yet. {next ? <>Moving to {LEVEL_INFO[next].name} sets one at the moment an owner confirms{isOwner ? <>; <Link className="link" to={`/assurance/upgrade?to=${next}`}>see the upgrade</Link></> : ''}.</> : null}
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {lv.boundaries.map((b) => (
                <li key={b.at} className="px-5 py-4 grid gap-3 sm:grid-cols-12 sm:items-center">
                  <div className="sm:col-span-4">
                    <p className="font-semibold">{LEVEL_INFO[b.from].short} → {LEVEL_INFO[b.to].short}</p>
                    <p className="text-sm text-muted">{date(b.at)} · {relative(b.at)}</p>
                  </div>
                  <div className="sm:col-span-3 text-sm">
                    <p className="label">First record at {LEVEL_INFO[b.to].short}</p>
                    {b.firstSeq ? <Link to={`/activity/${b.firstSeq}`} className="font-mono link">{seqLabel(b.firstSeq)}</Link> : <span className="text-muted">None yet</span>}
                  </div>
                  <div className="sm:col-span-5 grid grid-cols-2 gap-px bg-line border border-line">
                    <div className="bg-surface p-2.5"><p className="label">Before · {LEVEL_INFO[b.from].short}</p><p className="font-display text-lg font-semibold num">{n(b.recordsBefore)}</p></div>
                    <div className="bg-surface p-2.5"><p className="label">After · {LEVEL_INFO[b.to].short}</p><p className="font-display text-lg font-semibold num">{n(b.recordsAfter)}</p></div>
                  </div>
                  {b.beforeWindow && <p className="sm:col-span-12 text-xs text-muted">The boundary is before the first receipt this console holds, so every record here is at {LEVEL_INFO[b.to].short} or above.</p>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <CloseoutCard className="mt-4" />
      </section>

      {/* Capabilities */}
      <section aria-labelledby="caps-h" className="mb-10">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
          <div>
            <p className="label mb-1">Capability by capability</p>
            <h2 id="caps-h" className="text-xl font-semibold">What is on for this organisation</h2>
            <p className="mt-1 text-sm text-muted num" aria-live="polite">{lv ? `${n(onCount)} of ${n(rows.length)} on at ${LEVEL_INFO[level].short}` : ' '}</p>
          </div>
          <Segmented<Filter> size="sm" label="Level" value={filter} onChange={setFilter} options={[
            { value: 'all', label: 'All', count: rows.length },
            ...LEVELS.map((l) => ({ value: l as Filter, label: LEVEL_INFO[l].tag, count: rows.filter((r) => r.level === l).length })),
          ]} />
        </div>
        <div className="overflow-x-auto border border-line bg-surface">
          <table className="w-full text-sm border-collapse">
            <caption className="sr-only">Capabilities by assurance level, on or off for this organisation</caption>
            <thead className="bg-sunken/90">
              <tr className="border-b border-line">
                <th scope="col" className="label text-left px-4 h-9">Capability</th>
                <th scope="col" className="label text-left px-4 h-9 w-[70px]">From</th>
                <th scope="col" className="label text-left px-4 h-9 w-[170px]">Here</th>
                <th scope="col" className="label text-left px-4 h-9 hidden md:table-cell">What it does</th>
              </tr>
            </thead>
            <tbody>
              {!lv && Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={4} className="px-4 py-3"><Skeleton className="h-5" /></td></tr>)}
              {shown.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-b-0 align-top">
                  <th scope="row" className="px-4 py-3 text-left font-medium">
                    <SmartLink to={c.route} onClick={() => onRowLink(c.route)} className="hover:underline underline-offset-2">{c.label}</SmartLink>
                    <p className="md:hidden mt-1 font-normal text-xs text-muted">{c.description}</p>
                  </th>
                  <td className="px-4 py-3 font-mono text-[12px]">{LEVEL_INFO[c.level].tag}</td>
                  <td className="px-4 py-3">
                    {c.enabled ? (
                      <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>On{c.since && levelRank(c.level) > 0 ? ` since ${date(c.since)}` : ''}</StatusChip>
                    ) : isOwner ? (
                      // previews of a higher level are for the owner, who can change the plan
                      <Link to={`/assurance/upgrade?to=${c.level}`} className="inline-flex"><StatusChip size="sm" tone="neutral" icon={<ArrowUpRight className="h-3 w-3" aria-hidden />}>With {LEVEL_INFO[c.level].tag} — preview</StatusChip></Link>
                    ) : (
                      <StatusChip size="sm" tone="neutral">From {LEVEL_INFO[c.level].tag}</StatusChip>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted hidden md:table-cell">{c.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* the Seal v6 vectors are part of the plan from L2; the move panel is for the people who prepare an upgrade */}
      {lv && !vectorsOn && <PlanUpsell to="l2" what="Seal v6 and its 64 test vectors start at L2 Attested." className="mb-4" />}
      {(vectorsOn || showMove) && (
      <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        {vectorsOn && <TestVectorsPanel className={showMove ? 'lg:col-span-7' : 'lg:col-span-12'} />}
        {showMove && <Panel className={vectorsOn ? 'lg:col-span-5' : 'lg:col-span-12'} kicker={next ? `${LEVEL_INFO[level].short} → ${LEVEL_INFO[next].short}` : 'Top of the ladder'} title={next ? `Move to ${LEVEL_INFO[next].name}` : 'Sovereign is the top level'}>
          {!lv ? <Skeleton className="h-32" /> : next ? (
            <>
              <p className="text-sm text-muted leading-relaxed">Adds {plural(lv.capabilities.filter((c) => c.level === next).length, 'capability', 'capabilities')}. The platform floor moves from {rupeesShort(PLANS[level].floorPerYear)} to {rupeesShort(PLANS[next].floorPerYear)} a year; per action from {rupees(PLANS[level].overageRate, { paise: true })} to {rupees(PLANS[next].overageRate, { paise: true })}.</p>
              <ListPriceTag planId={next} className="mt-1" long />
              <p className="mt-2 text-sm text-muted leading-relaxed">The wizard checks the chain, walks the prerequisites, writes a receipt for every stage and asks for {next === 'l2' ? 'a second person' : 'a 3 of 5 key ceremony'} before an owner confirms with a password.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {startBtn(next, 'sm')}
                {isOwner && <Button size="sm" variant="secondary" onClick={() => nav(`/assurance/upgrade?to=${next}`)}>Preview what changes</Button>}
              </div>
              {!isOwner && <p className="mt-2 text-xs text-muted">You can prepare the upgrade and record its stages; only an owner confirms it. Owners here: {ownerNames}.</p>}
            </>
          ) : (
            <>
              <p className="text-sm text-muted leading-relaxed">This organisation runs Elan1 Govern on its own infrastructure: your cluster, your HSM, your timestamp authorities, no egress. The receipts and the verifier are the same as every other level.</p>
              {(canSee('/agents/deployment') || canSee('/agents/keys')) && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {canSee('/agents/deployment') && <Button size="sm" variant="primary" icon={<Server className="h-4 w-4" />} onClick={() => nav('/agents/deployment')}>Deployment and updates</Button>}
                  {canSee('/agents/keys') && <Button size="sm" variant="secondary" icon={<KeyRound className="h-4 w-4" />} onClick={() => nav('/agents/keys')}>Keys and ceremonies</Button>}
                </div>
              )}
            </>
          )}
        </Panel>}
      </div>
      )}
    </div>
  );
}

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <li className="flex items-start gap-2"><span className="mt-0.5 text-muted shrink-0">{icon}</span><span className="min-w-0">{children}</span></li>;
}

/* ── Two implementations: the 64 Seal v6 test vectors ─────── */

/** Rendered only when the plan includes Seal v6 (from L2): never as a preview of a higher level. */
function TestVectorsPanel({ className }: { className?: string }) {
  const run = useMutation(() => api.testVectors());
  const [suite, setSuite] = useState<TestVectorSuite>();
  const go = async () => { try { setSuite(await run.mutate()); } catch { /* shown below */ } };
  const groups = suite ? Object.entries(suite.summary.byGroup) : [];
  return (
    <Panel className={className} kicker="On here · Seal v6" title="Two implementations agree"
      actions={<Button size="sm" variant="secondary" icon={<FlaskConical className="h-3.5 w-3.5" />} loading={run.pending} onClick={go}>{suite ? 'Run again' : 'Run the 64 vectors'}</Button>}
      footer={suite ? `The TypeScript column ran in this browser just now. ${suite.implementations.find((i) => i.id === 'python')?.how ?? ''}` : 'Seal v6 is specified once and implemented twice; the vectors are the contract between them.'}>
      {run.error && <Banner tone="bad" className="mb-4" title="The test vectors could not run">{run.error.message}</Banner>}
      {!suite ? (
        <p className="text-sm text-muted leading-relaxed">A seal is SHA-256 over a length-prefixed preimage of 16 frozen fields (F01 tenant_id … F16 recorded_at), signed with Ed25519. A TypeScript and a Python implementation must produce the same bytes for all 64 published vectors — 12 structure, 12 chain, 12 Merkle and anchor, 28 that must be rejected. Run them here.</p>
      ) : (
        <div>
          <div className="grid grid-cols-3 gap-px bg-line border border-line">
            <div className="bg-surface p-3"><p className="label">TypeScript</p><p className="font-display text-2xl font-semibold num">{suite.summary.typescript}/{suite.summary.total}</p></div>
            <div className="bg-surface p-3"><p className="label">Python</p><p className="font-display text-2xl font-semibold num">{suite.summary.python}/{suite.summary.total}</p></div>
            <div className="bg-surface p-3"><p className="label">Same bytes</p><p className="font-display text-2xl font-semibold num">{suite.summary.agree}/{suite.summary.total}</p></div>
          </div>
          <ul className="mt-3 flex flex-wrap gap-2 text-xs">
            {groups.map(([g, c]) => <li key={g}><Badge>{g.replace('_', ' and ')} · {c}</Badge></li>)}
          </ul>
          <div className="mt-3">
            {suite.summary.typescript === suite.summary.total && suite.summary.agree === suite.summary.total
              ? <StatusChip tone="ok" icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden />}>All {suite.summary.total} pass and agree</StatusChip>
              : <StatusChip tone="bad" icon={<Clock3 className="h-3.5 w-3.5" aria-hidden />}>{suite.summary.total - suite.summary.agree} disagree</StatusChip>}
          </div>
          <ul className="mt-3 text-xs text-muted space-y-1">
            {suite.implementations.map((i) => <li key={i.id}><span className="font-medium text-fg">{i.name} {i.version}</span> · {i.source}</li>)}
          </ul>
        </div>
      )}
    </Panel>
  );
}
