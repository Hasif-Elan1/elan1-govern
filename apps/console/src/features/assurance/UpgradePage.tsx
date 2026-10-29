import { useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, BadgeCheck, Check, CheckCircle2, Download, KeyRound, Layers, Lock, MapPin, OctagonX, Play, Plus, Server, ShieldCheck, Trash2, UserCheck, X,
} from 'lucide-react';
import { api, db } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser, markReauth } from '@/store/session';
import type { CounterpartyKind, LevelId, Receipt, TsaAuthority } from '@/types';
import { PLANS } from '@/lib/pricing';
import { LEVEL_INFO, levelRank } from '@/lib/levels';
import { verifyChain, type VerifyReport } from '@/lib/crypto';
import { date, dateTime, n, plural, rupees, rupeesShort, seqLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { cn } from '@/lib/cn';
import {
  Banner, Button, Checkbox, CopyButton, Dialog, EmptyState, Field, Input, KeyValue, PageHeader, Panel, RadioCards, Select, Skeleton, StatusChip, toast,
} from '@/components/ui';
import { ExportPackDialog } from '@/features/evidence/ExportPackDialog';
import { claimFor, currentRun, keyHolders, LEVEL_COPY, lastUpgrade, levelsAbove, recordStep, stagesFor, type StageDef, type StageId, type UpgradeRun } from './levelModel';
import { KeyBindStage } from './upgrade/KeyBindStage';
import { NoticesPanel } from './upgrade/NoticesPanel';
import { SignOnConfirm } from './upgrade/SignOnConfirm';
import { CloseoutCard } from './upgrade/CloseoutCard';
import { useCloseout } from './upgrade/shared';
import { ListPriceTag } from '@/features/billing/ListPriceTag';
import { useCanSee, useScreenAccess } from '@/shell/access';

/**
 * Door 04 · Assurance — the upgrade wizard. L1 → L2 → L3 → Sovereign. Every stage writes a receipt in the
 * organisation's chain; dual control (a second person at L2, the 3 of 5 key ceremony from L3) is enforced
 * before an owner confirms with a password and the organisation's name.
 */
export default function UpgradePage() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const user = useUser();
  const role = useRole();

  const { data, loading, error, refetch } = useQuery(async (o) => {
    const [lv, members] = await Promise.all([api.level(o), api.members(o)]);
    const d = db.getDB(o);
    return { lv, members, run: currentRun(d.receipts), last: lastUpgrade(d.receipts), orgName: d.org.name, slug: d.org.slug, fingerprint: d.org.keyFingerprint };
  }, []);

  const level = data?.lv.level;
  const doneTo = sp.get('done') as LevelId | null;
  const asked = sp.get('to') as LevelId | null;
  const choices = level ? levelsAbove(level) : [];
  const to: LevelId | undefined = data?.run?.to ?? (asked && choices.includes(asked) ? asked : choices[0]);
  const setTo = (l: LevelId) => { const next = new URLSearchParams(sp); next.set('to', l); next.delete('done'); setSp(next, { replace: true }); };

  const canPrepare = role === 'owner' || role === 'admin';
  const isOwner = role === 'owner';
  const owners = data?.members.filter((m) => m.role === 'owner' && m.status === 'active').map((m) => m.user?.name ?? m.userId) ?? [];

  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title={doneTo && level === doneTo ? `Now on ${LEVEL_INFO[doneTo].name}` : to ? `Upgrade to ${LEVEL_INFO[to].name}` : 'Upgrade'}
        description="Move this organisation up a level: what it adds, what it costs, where the boundary falls and what has to be ready first. Every stage is a receipt."
        crumbs={[{ label: 'Assurance levels', to: '/assurance/levels' }, { label: 'Upgrade' }]}
        meta={level && <StatusChip tone="inverse" icon={<MapPin className="h-3.5 w-3.5" aria-hidden />}>Now {LEVEL_INFO[level].label}</StatusChip>}
        actions={<Button variant="secondary" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => nav('/assurance/levels')}>The ladder</Button>}
      />

      {error && <Banner tone="bad" className="mb-6" title="The upgrade could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      {loading && !data && <div className="grid gap-6 lg:grid-cols-12"><Skeleton className="h-80 lg:col-span-4" /><Skeleton className="h-80 lg:col-span-8" /></div>}

      {data && level && (
        doneTo && levelRank(level) >= levelRank(doneTo) ? (
          <DoneView level={doneTo} data={data} />
        ) : !to ? (
          <TopLevel orgName={data.orgName} />
        ) : data.run ? (
          <>
            {asked && asked !== data.run.to && choices.includes(asked) && (
              <Banner tone="held" className="mb-6" title={`An upgrade to ${LEVEL_INFO[data.run.to].name} is already in progress`}>Finish or cancel it before choosing {LEVEL_INFO[asked].name}.</Banner>
            )}
            <Wizard run={data.run} level={level} orgName={data.orgName} slug={data.slug} members={data.members} canPrepare={canPrepare} isOwner={isOwner} owners={owners}
              onDone={(l) => { const next = new URLSearchParams(); next.set('done', l); setSp(next, { replace: true }); }} />
          </>
        ) : (
          <ChooseView level={level} to={to} choices={choices} setTo={setTo} canPrepare={canPrepare} owners={owners} userId={user?.id} />
        )
      )}
    </div>
  );
}

/* ── Choose a level and review what changes ────────────────── */

function ChooseView({ level, to, choices, setTo, canPrepare, owners, userId }: { level: LevelId; to: LevelId; choices: LevelId[]; setTo: (l: LevelId) => void; canPrepare: boolean; owners: string[]; userId?: string }) {
  const orgId = useOrgId();
  const [busy, setBusy] = useState(false);
  const plan = useQuery((o) => api.upgradePlan(o, to, userId), [to, userId]);
  const p = plan.data;
  const stages = stagesFor(level, to);
  const begin = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      recordStep(orgId, userId, 'level.upgrade_started', { from: level, to });
      toast.ok(`Upgrade to ${LEVEL_INFO[to].name} started`, 'Recorded in the chain. Anyone with owner or admin rights can continue it.');
    } catch (e) { toast.bad('The upgrade could not start', (e as Error).message); } finally { setBusy(false); }
  };
  const groups = useMemo(() => (p ? (['l2', 'l3', 'sovereign'] as LevelId[]).map((l) => ({ l, caps: p.adds.filter((c) => c.level === l) })).filter((g) => g.caps.length) : []), [p]);

  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-7 space-y-6">
        <Panel title="Choose the level" kicker={`From ${LEVEL_INFO[level].label}`}>
          <RadioCards<LevelId> name="target" value={to} onChange={setTo} cols={choices.length > 2 ? 3 : 2} options={choices.map((l) => ({
            value: l,
            label: <span className="font-semibold">{LEVEL_INFO[l].short !== PLANS[l].name ? `${LEVEL_INFO[l].short} · ` : ''}{PLANS[l].name}</span>,
            description: <span className="block">{LEVEL_COPY[l].question}<span className="block mt-1 num">{l === 'sovereign' ? rupeesShort(PLANS[l].floorPerYear) + ' per deployment' : rupees(PLANS[l].floorPerYear)} a year</span><ListPriceTag planId={l} /></span>,
          }))} />
        </Panel>

        <Panel title="What changes" kicker={`${LEVEL_INFO[level].short} → ${LEVEL_INFO[to].short}`}>
          {plan.error && <Banner tone="bad" title="The upgrade plan could not be loaded">{plan.error.message}</Banner>}
          {!p ? <Skeleton className="h-48" /> : (
            <>
              <div className="grid sm:grid-cols-3 gap-px bg-line border border-line mb-5">
                <Fig k="Platform floor a year" v={`${rupeesShort(p.priceBefore.floorPerYear)} → ${rupeesShort(p.priceAfter.floorPerYear)}`} sub={`${p.floorDifference >= 0 ? '+' : ''}${rupees(p.floorDifference)} a year`} />
                <Fig k="Per action" v={`${rupees(p.priceBefore.overageRate, { paise: true })} → ${rupees(p.priceAfter.overageRate, { paise: true })}`} sub={`Refused: ${rupees(p.priceAfter.refusalRate, { paise: true })}`} />
                <Fig k="Included a year" v={p.priceAfter.includedPerYear ? n(p.priceAfter.includedPerYear) : 'None'} sub={to === 'sovereign' ? 'Every action metered' : `from ${n(p.priceBefore.includedPerYear)}`} />
              </div>
              <ListPriceTag planId={to} long className="-mt-3 mb-5" />
              <p className="label mb-2">Adds {plural(p.adds.length, 'capability', 'capabilities')}</p>
              <div className="space-y-4">
                {groups.map((g) => (
                  <div key={g.l}>
                    <p className="text-sm font-semibold mb-1.5">{LEVEL_INFO[g.l].label}</p>
                    <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 text-sm">
                      {g.caps.map((c) => <li key={c.id} className="flex gap-2"><Plus className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted" aria-hidden /><span><span className="font-medium">{c.label}</span><span className="block text-xs text-muted">{c.description}</span></span></li>)}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="mt-5 border-l-[3px] border-fg pl-3">
                <p className="font-medium">The boundary, and your existing records</p>
                <p className="mt-0.5 text-sm text-muted leading-relaxed">{p.boundaryNote} From the boundary, records are {claimFor(to)}.</p>
              </div>
            </>
          )}
        </Panel>
      </div>

      <div className="lg:col-span-5 space-y-6">
        <Panel title="Prerequisites" kicker={`${stages.length + 1} stages, each a receipt`}
          footer={to === 'l2' ? 'Dual control: a second owner or admin confirms before the switch.' : 'Dual control: the key ceremony needs 3 of 5 named key holders.'}>
          <ol className="space-y-3">
            {stages.map((s, i) => (
              <li key={s.id} className="flex gap-3">
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-line-strong font-mono text-[12px]">{i}</span>
                <div className="min-w-0"><p className="font-medium text-sm">{s.title}{s.level !== 'all' && <span className="ml-1.5 label">{LEVEL_INFO[s.level].tag}</span>}</p><p className="text-xs text-muted leading-relaxed">{s.summary}</p></div>
              </li>
            ))}
            <li className="flex gap-3">
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center bg-fg text-canvas font-mono text-[12px]">✓</span>
              <div><p className="font-medium text-sm">Owner confirms</p><p className="text-xs text-muted">{level === 'l1' && to === 'l2'
                ? 'With a password and the organisation’s name typed out, at the record the screen names for signing to start. Then the close-out: the first-ten check, your first bundle, the notices and the closing record. Until that record, a failed upgrade can be rolled back.'
                : 'With a password and the organisation’s name typed out. This sets the boundary and cannot be undone.'}</p></div>
            </li>
          </ol>
          <div className="mt-5">
            {canPrepare && p && !p.allowed && p.whyNot && !p.whyNot.startsWith('Only an owner') && <Banner tone="held" className="mb-3">{p.whyNot}</Banner>}
            {/* viewers and auditors read the plan; only owners and admins see the button that starts it */}
            {canPrepare ? (
              <Button variant="primary" block icon={<Play className="h-4 w-4" />} loading={busy} disabled={!userId} onClick={begin}>
                Start preparing the upgrade
              </Button>
            ) : <p className="text-xs text-muted">Owners here: {owners.join(', ') || '—'}.</p>}
          </div>
        </Panel>
      </div>
    </div>
  );
}

/* ── The wizard ─────────────────────────────────────────────── */

type Member = { userId: string; role: string; status: string; user?: { name: string } };

function Wizard({ run, level, orgName, slug, members, canPrepare, isOwner, owners, onDone }: {
  run: UpgradeRun; level: LevelId; orgName: string; slug: string; members: Member[]; canPrepare: boolean; isOwner: boolean; owners: string[]; onDone: (l: LevelId) => void;
}) {
  const orgId = useOrgId();
  const user = useUser();
  const stages = stagesFor(level, run.to);
  const firstOpen = stages.findIndex((s) => !run.stages[s.id]);
  const [active, setActive] = useState<StageId | 'confirm'>(firstOpen < 0 ? 'confirm' : stages[firstOpen].id);
  const [cancelOpen, setCancelOpen] = useState(false);
  const doneCount = stages.filter((s) => run.stages[s.id]).length;
  const allDone = doneCount === stages.length;

  const complete = (stage: StageId, details: Record<string, string | number | boolean>) => {
    if (!user) return;
    try {
      const r = recordStep(orgId, user.id, stage === 'second' ? 'level.upgrade_seconded' : 'level.upgrade_stage', { to: run.to, stage, ...details });
      toast.ok(`${stages.find((s) => s.id === stage)?.title ?? 'Stage'} recorded`, `Receipt ${seqLabel(r.seq)}.`);
      const i = stages.findIndex((s) => s.id === stage);
      const nextOpen = stages.find((s, j) => j > i && !run.stages[s.id]);
      setActive(nextOpen ? nextOpen.id : 'confirm');
    } catch (e) { toast.bad('Could not record the stage', (e as Error).message); }
  };

  const cancel = () => {
    if (!user) return;
    recordStep(orgId, user.id, 'level.upgrade_cancelled', { to: run.to, stages_done: doneCount });
    toast.info('Upgrade cancelled', 'Recorded in the chain. Nothing about the organisation changed.');
    setCancelOpen(false);
  };

  const stage = stages.find((s) => s.id === active);
  const rec = stage ? run.stages[stage.id] : undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-4 space-y-4">
        <Panel kicker={`${LEVEL_INFO[run.from].short} → ${LEVEL_INFO[run.to].short}`} title="Stages" flush
          footer={<span>Started by {userName(run.startedBy)} {dateTime(run.startedAt)} · <Link className="link font-mono" to={`/activity/${run.startedSeq}`}>{seqLabel(run.startedSeq)}</Link></span>}>
          <ol className="divide-y divide-line" aria-label="Upgrade stages">
            {stages.map((s, i) => {
              const r = run.stages[s.id];
              return (
                <li key={s.id}>
                  <button type="button" onClick={() => setActive(s.id)} aria-current={active === s.id ? 'step' : undefined}
                    className={cn('w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-sunken/50', active === s.id && 'bg-sunken/70 shadow-[inset_3px_0_0_rgb(var(--fg))]')}>
                    <span className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center border text-[11px] font-mono', r ? 'bg-ok-bg border-ok/40 text-ok-fg' : 'border-line-strong text-muted')}>{r ? <Check className="h-3.5 w-3.5" aria-label="Done" /> : i}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{s.title}</span>
                      <span className="block text-xs text-muted">{r ? `Done · ${userName(r.actor)} · ${seqLabel(r.seq)}` : s.id === 'second' ? 'Waiting for a second person' : 'To do'}</span>
                    </span>
                  </button>
                </li>
              );
            })}
            <li>
              <button type="button" onClick={() => setActive('confirm')} aria-current={active === 'confirm' ? 'step' : undefined}
                className={cn('w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-sunken/50', active === 'confirm' && 'bg-sunken/70 shadow-[inset_3px_0_0_rgb(var(--fg))]')}>
                <span className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center text-[11px] font-mono', allDone ? 'bg-fg text-canvas' : 'border border-line-strong text-muted')}>✓</span>
                <span><span className="block text-sm font-medium">Owner confirms</span><span className="block text-xs text-muted">{allDone ? 'Ready' : `${stages.length - doneCount} stage${stages.length - doneCount === 1 ? '' : 's'} first`}</span></span>
              </button>
            </li>
          </ol>
        </Panel>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted num">{doneCount} of {stages.length} stages done</span>
          {canPrepare && <Button size="sm" variant="quiet-danger" icon={<X className="h-3.5 w-3.5" />} onClick={() => setCancelOpen(true)}>Cancel the upgrade</Button>}
        </div>
      </div>

      <div className="lg:col-span-8 min-w-0">
        {!canPrepare && <Banner tone="neutral" className="mb-4" title="You can follow this upgrade but not change it">Owners and admins record the stages; only an owner confirms. Owners here: {owners.join(', ') || '—'}.</Banner>}
        {active === 'confirm' ? (
          run.from === 'l1' && run.to === 'l2'
            ? <SignOnConfirm run={run} stages={stages} orgName={orgName} isOwner={isOwner} owners={owners} />
            : <ConfirmStage run={run} level={level} stages={stages} orgName={orgName} isOwner={isOwner} owners={owners} onDone={onDone} />
        ) : stage && (
          <Panel kicker={`Stage ${stages.indexOf(stage)} of ${stages.length - 1}${stage.level !== 'all' ? ` · ${LEVEL_INFO[stage.level].tag}` : ''}`} title={stage.title}>
            <p className="text-sm text-muted leading-relaxed mb-5">{stage.summary}</p>
            {rec && <Recorded r={rec} final={finalNote(stage.id)} />}
            <StageBody stage={stage.id} run={run} slug={slug} members={members} canAct={canPrepare} complete={complete} recorded={!!rec} />
          </Panel>
        )}
      </div>

      <Dialog open={cancelOpen} onClose={() => setCancelOpen(false)} tone="danger" title={`Cancel the upgrade to ${LEVEL_INFO[run.to].name}?`}
        description="The stages already recorded stay in the chain as receipts. Nothing about the organisation changes."
        footer={<><Button variant="ghost" onClick={() => setCancelOpen(false)}>Keep going</Button><Button variant="danger" onClick={cancel}>Cancel the upgrade</Button></>} />
    </div>
  );
}

/**
 * Stages whose record cannot be made again in the same upgrade: the bound key (L1 → L2; the kms stage exists on no
 * other path) and the sent 14-day notice. Every other stage can be recorded again, and the newest record counts.
 */
function finalNote(stage: StageId): string | undefined {
  if (stage === 'kms') return 'This record is final for this upgrade: the bound key cannot be replaced or bound again. To use a different key, cancel this upgrade and start again.';
  if (stage === 'notice') return 'A sent notice stays sent and cannot be recorded again. To name a different date or contact, cancel this upgrade and start again.';
  return undefined;
}

function Recorded({ r, final }: { r: Receipt; final?: string }) {
  const facts = Object.entries(r.details ?? {}).filter(([k]) => !['to', 'stage'].includes(k));
  return (
    <div className="mb-5 border border-ok/30 bg-ok-bg/40 p-4">
      <p className="text-sm font-medium inline-flex items-center gap-1.5 text-ok-fg"><CheckCircle2 className="h-4 w-4" aria-hidden />Recorded by {userName(r.actor)} · {dateTime(r.ts)} · <Link className="link font-mono" to={`/activity/${r.seq}`}>{seqLabel(r.seq)}</Link></p>
      {facts.length > 0 && <KeyValue className="mt-3" items={facts.map(([k, v]) => ({ k: k.replace(/_/g, ' '), v: <span className="break-words">{String(v)}</span> }))} />}
      <p className="mt-2 text-xs text-muted">{final ?? 'You can record it again; the newest record counts.'}</p>
    </div>
  );
}

function StageBody(props: { stage: StageId; run: UpgradeRun; slug: string; members: Member[]; canAct: boolean; complete: (s: StageId, d: Record<string, string | number | boolean>) => void; recorded: boolean }) {
  switch (props.stage) {
    case 'preflight': return <PreflightStage {...props} />;
    // L1 → L2 only (stagesFor): the key is created and its fingerprint compared before the switch (upgrade/KeyBindStage)
    case 'kms': return <KeyBindStage canAct={props.canAct} slug={props.slug} />;
    case 'notice': return <NoticeStage canAct={props.canAct} />;
    case 'tsa': return <TsaStage {...props} />;
    case 'worm': return <WormStage {...props} />;
    case 'profile': return <ProfileStage {...props} />;
    case 'second': return <SecondStage {...props} />;
    case 'ceremony': return <CeremonyStage {...props} />;
    case 'counterparties': return <CounterpartiesStage {...props} />;
    case 'autonomy': return <AutonomyStage {...props} />;
    case 'infra': return <InfraStage {...props} />;
    case 'local_tsa': return <LocalTsaStage {...props} />;
    case 'bundle': return <BundleStage {...props} />;
    case 'egress': return <EgressStage {...props} />;
  }
}

type SP = Parameters<typeof StageBody>[0];

function Act({ canAct, disabled, why, onClick, children, loading }: { canAct: boolean; disabled?: boolean; why?: string; onClick: () => void; children: ReactNode; loading?: boolean }) {
  // only owners and admins record stages: other roles follow the upgrade without a button
  if (!canAct) return null;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <Button variant="primary" icon={<Check className="h-4 w-4" />} disabled={disabled} loading={loading} onClick={onClick}
        title={disabled ? why : undefined}>{children}</Button>
      {disabled && why && <span className="text-xs text-muted">{why}</span>}
    </div>
  );
}

function PreflightStage({ canAct, complete }: SP) {
  const orgId = useOrgId();
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const sigWord = useOrgLevel() === 'l1' ? 'Ed25519 seal' : 'signature';
  const [report, setReport] = useState<VerifyReport>();
  const [running, setRunning] = useState(false);
  const runIt = () => {
    setRunning(true);
    window.setTimeout(() => {
      const d = db.getDB(orgId);
      const rep = verifyChain(d.receipts, d.publicKeys, d.checkpoints);
      setReport(rep);
      setRunning(false);
      if (rep.result === 'verified') complete('preflight', { result: 'verified', receipts: rep.receipts, first_seq: rep.firstSeq ?? 0, last_seq: rep.lastSeq ?? 0, checkpoints: `${rep.checkpoints.valid} of ${rep.checkpoints.total} valid`, ms: Math.round(rep.ms) });
    }, 30);
  };
  return (
    <div>
      {report && (
        report.result === 'verified'
          // "Continuous" is never shown with a tick: the replay vouches only for the range it ran over
          ? <Banner tone="neutral" title={`No break found over ${n(report.receipts)} receipts, ${seqLabel(report.firstSeq ?? 0)}–${seqLabel(report.lastSeq ?? 0)}`}>Every hash link and {sigWord} checked in this browser in {n(Math.round(report.ms))} ms; {report.checkpoints.valid} of {report.checkpoints.total} checkpoints valid. Records written after {seqLabel(report.lastSeq ?? 0)} are not checked over by this replay.</Banner>
          : <Banner tone="bad" title="The chain did not pass">{report.brokenAt ? `First problem at ${seqLabel(report.brokenAt)}: ${report.brokenReason}` : report.summary.map((s) => s.detail).join(' ')} Fix this before upgrading; open the chain explorer to see where.</Banner>
      )}
      <Act canAct={canAct} loading={running} onClick={runIt}>Replay the chain now</Act>
      <p className="mt-2 text-xs text-muted">The pre-flight is recorded only if the chain passes.</p>
    </div>
  );
}

/** L1 → L2: the 14-day notice to a named contact completes this stage; the other two notices are scheduled for the boundary. */
function NoticeStage({ canAct }: { canAct: boolean }) {
  const q = useCloseout();
  if (q.error) return <Banner tone="bad" title="The notices could not be loaded" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>;
  if (!q.data) return <Skeleton className="h-48" />;
  return (
    <div>
      <NoticesPanel view={q.data} canAct={canAct} />
      <p className="mt-3 text-xs text-muted">The stage is done when the 14-day notice has gone. Schedule the boundary-day confirmation and the auditor note now so they go the moment signing starts; the closing record needs all three.</p>
    </div>
  );
}

function TsaStage({ canAct, complete }: SP) {
  const a = useQuery((o) => api.anchors(o, 1), [], { live: false });
  const auths: TsaAuthority[] = a.data?.authorities ?? [];
  const india = auths.find((x) => x.scope === 'India');
  const global = auths.find((x) => x.scope === 'Global');
  return (
    <div>
      {a.error && <Banner tone="bad" title="The authorities could not be loaded">{a.error.message}</Banner>}
      {!a.data ? <Skeleton className="h-28" /> : (
        <ul className="border border-line divide-y divide-line">
          {auths.map((t) => (
            <li key={t.id} className="px-4 py-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><p className="font-medium">{t.name} <span className="label ml-1">{t.scope}</span></p><p className="text-xs text-muted font-mono break-all">{t.url} · policy {t.policyOid}</p></div>
              <StatusChip size="sm" tone={t.status === 'operational' ? 'ok' : 'held'} icon={t.status === 'operational' ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <OctagonX className="h-3 w-3" aria-hidden />}>{t.status === 'operational' ? 'Reachable' : 'Degraded'}</StatusChip>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-sm text-muted">Every 15 minutes the batch’s Merkle root (32 bytes, nothing else) goes to both. Target: both tokens within 15 minutes. If one is down, the other keeps stamping and the late token is added when it returns.</p>
      <Act canAct={canAct} disabled={!india || !global} why="An Indian and a global authority are both needed." onClick={() => complete('tsa', { india: india?.name ?? '', global: global?.name ?? '', target_minutes: 15 })}>Record both authorities</Act>
    </div>
  );
}

function WormStage({ canAct, complete, slug }: SP) {
  const [ack, setAck] = useState(false);
  return (
    <div>
      <KeyValue items={[
        { k: 'Storage', v: 'Amazon S3 with Object Lock' },
        { k: 'Bucket', v: <span className="font-mono text-[12.5px]">eg-{slug}-evidence-aps1</span> },
        { k: 'Mode', v: 'Compliance' },
        { k: 'Retention', v: '8 years from each record' },
      ]} />
      {canAct && <div className="mt-4"><Checkbox checked={ack} onChange={setAck} label="I understand nobody — including elan1 — can delete a record before its retention ends" description="Erasure under DPDP works by destroying the salt, not the record: the chain still verifies." /></div>}
      <Act canAct={canAct} disabled={!ack} why="Tick the retention statement first." onClick={() => complete('worm', { mode: 'compliance', retention_years: 8 })}>Record the storage</Act>
    </div>
  );
}

function ProfileStage({ canAct, complete }: SP) {
  const pr = useQuery((o) => api.profiles(o), [], { live: false });
  const [pick, setPick] = useState<string>('none');
  return (
    <div>
      {pr.error && <Banner tone="bad" title="Profiles could not be loaded">{pr.error.message}</Banner>}
      {!pr.data ? <Skeleton className="h-40" /> : !canAct ? (
        <ul className="border border-line divide-y divide-line text-sm">{pr.data.map((p) => <li key={p.id} className="px-4 py-2.5"><span className="font-medium">{p.name}</span> <span className="text-muted">· {p.regime} · {p.jurisdiction}</span></li>)}</ul>
      ) : (
        <RadioCards<string> name="profile" value={pick} onChange={setPick} cols={2} options={[
          { value: 'none', label: 'No profile claimed', description: 'Bundles verify for integrity; no regime is claimed.' },
          ...pr.data.map((p) => ({ value: p.id, label: p.name, description: `${p.regime} · ${p.jurisdiction}${p.packId ? ` · with ${p.packId}` : ''}` })),
        ]} />
      )}
      <Act canAct={canAct} onClick={() => complete('profile', { profile: pick })}>Record the profile choice</Act>
    </div>
  );
}

function SecondStage({ run, members, canAct, complete, recorded }: SP) {
  const user = useUser();
  const [ack, setAck] = useState(false);
  const others = members.filter((m) => (m.role === 'owner' || m.role === 'admin') && m.status === 'active' && m.userId !== run.startedBy);
  const isStarter = user?.id === run.startedBy;
  const url = typeof window !== 'undefined' ? `${window.location.origin}/assurance/upgrade?to=${run.to}` : '';
  if (recorded) return null;
  return (
    <div>
      {isStarter ? (
        <>
          <Banner tone="held" title="Waiting for a second person">You started this upgrade, so a different owner or admin confirms it. Ask {others.map((m) => m.user?.name ?? m.userId).join(' or ') || 'another owner or admin'} to open this page.</Banner>
          <div className="mt-3 flex items-center gap-2 border border-line bg-sunken/60 px-3 py-2"><span className="font-mono text-[12.5px] break-all flex-1">{url}</span><CopyButton text={url} label="Copy link" /></div>
        </>
      ) : (
        <>
          <p className="text-sm">{userName(run.startedBy)} started this upgrade on {date(run.startedAt)}.{canAct ? ' Review the recorded stages, then confirm as the second person.' : ' A different owner or admin confirms as the second person.'}</p>
          {canAct && <div className="mt-4"><Checkbox checked={ack} onChange={setAck} label={`I have reviewed the stages and agree to move to ${LEVEL_INFO[run.to].name}`} /></div>}
          <Act canAct={canAct} disabled={!ack} why="Tick the review statement first." onClick={() => complete('second', { from: run.from, started_by: run.startedBy })}>
            <span className="inline-flex items-center gap-1.5"><UserCheck className="h-4 w-4" aria-hidden />Confirm as second person</span>
          </Act>
        </>
      )}
    </div>
  );
}

function CeremonyStage({ run, canAct, complete }: SP) {
  const orgId = useOrgId();
  const holders = keyHolders(orgId);
  const [present, setPresent] = useState<string[]>([]);
  const provider = run.to === 'sovereign' ? 'Entrust nShield Connect XC (on premises)' : 'AWS CloudHSM (your cluster, ap-south-1)';
  const attending = holders.filter((h) => h.attends);
  const ready = attending.every((h) => present.includes(h.id));
  return (
    <div>
      <KeyValue items={[{ k: 'HSM', v: provider }, { k: 'Quorum', v: '3 of 5 key holders' }, { k: 'Also supported', v: 'Thales Luna and Entrust nShield, the same way' }]} />
      <p className="label mt-5 mb-2">Key holders</p>
      <ul className="border border-line divide-y divide-line">
        {holders.map((h) => (
          <li key={h.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
            {h.attends && canAct ? (
              <Checkbox checked={present.includes(h.id)} onChange={(v) => setPresent((p) => (v ? [...p, h.id] : p.filter((x) => x !== h.id)))} label={`${h.name} — present with their card`} description={h.role} />
            ) : (
              <span className="text-sm text-muted">{h.name} · {h.role} {!h.attends && <span className="label ml-1">Reserve</span>}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">The key is generated inside the HSM when the owner confirms. Elan1 Govern asks the HSM to sign; it never holds the key.</p>
      <Act canAct={canAct} disabled={!ready} why="All three attending key holders must be present." onClick={() => complete('ceremony', { provider, quorum: '3 of 5', present: attending.map((h) => h.name).join('; ') })}>Record the ceremony quorum</Act>
    </div>
  );
}

const KINDS: CounterpartyKind[] = ['customer', 'vendor', 'insurer', 'lender', 'regulator'];

function CounterpartiesStage({ canAct, complete }: SP) {
  const ids = { n: useId(), d: useId(), k: useId(), c: useId() };
  const [list, setList] = useState<{ name: string; domain: string; kind: CounterpartyKind; contact: string }[]>([]);
  const [f, setF] = useState({ name: '', domain: '', kind: 'customer' as CounterpartyKind, contact: '' });
  const domainOk = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(f.domain.trim());
  const contactOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.contact.trim());
  const add = () => { setList((l) => [...l, { name: f.name.trim(), domain: f.domain.trim().toLowerCase(), kind: f.kind, contact: f.contact.trim() }]); setF({ name: '', domain: '', kind: 'customer', contact: '' }); };
  return (
    <div>
      {canAct && <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Organisation" htmlFor={ids.n}><Input id={ids.n} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Northbank Industrial Ltd" /></Field>
        <Field label="Domain" htmlFor={ids.d} error={f.domain && !domainOk ? 'Enter a domain such as northbank.co.in' : undefined}><Input id={ids.d} value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} placeholder="northbank.co.in" mono /></Field>
        <Field label="Kind" htmlFor={ids.k}><Select id={ids.k} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as CounterpartyKind })}>{KINDS.map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}</Select></Field>
        <Field label="Contact email" htmlFor={ids.c} error={f.contact && !contactOk ? 'Enter an email address' : undefined}><Input id={ids.c} value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} placeholder="assurance@northbank.co.in" /></Field>
      </div>
      <Button className="mt-3" size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} disabled={!f.name.trim() || !domainOk || !contactOk} onClick={add}>Add to the list</Button>
      </>}
      {list.length > 0 && (
        <ul className="mt-4 border border-line divide-y divide-line">
          {list.map((c, i) => (
            <li key={i} className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0"><span className="font-medium">{c.name}</span> <span className="text-muted">· {c.kind} · <span className="font-mono">{c.domain}</span></span></span>
              <button type="button" className="text-muted hover:text-bad-fg" aria-label={`Remove ${c.name}`} onClick={() => setList((l) => l.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">They are registered with 1 seat each (₹45,000 a year) when the owner confirms; invitations go to the contact address.</p>
      <Act canAct={canAct} disabled={!list.length} why="Name at least 1 counterparty." onClick={() => complete('counterparties', { count: list.length, list: list.map((c) => `${c.name}|${c.domain}|${c.kind}|${c.contact}`).join(';') })}>Record {plural(list.length, 'counterparty', 'counterparties')}</Act>
    </div>
  );
}

function AutonomyStage({ canAct, complete }: SP) {
  const ag = useQuery((o) => api.agents(o), [], { live: false });
  const [ack, setAck] = useState(false);
  const tools = ag.data?.reduce((s, a) => s + a.tools.length, 0) ?? 0;
  return (
    <div>
      {ag.error && <Banner tone="bad" title="Agents could not be loaded">{ag.error.message}</Banner>}
      {!ag.data ? <Skeleton className="h-16" /> : <p className="text-sm">{plural(ag.data.length, 'agent')} with {plural(tools, 'tool')}: each write type will start at <span className="font-medium">A2 Propose</span>, so a person approves every write. No one sets a level; a write type reaches A3 only by a graduation one owner or admin proposes and a different one approves, once its record shows 90 days, 200 records and 100 approvals.</p>}
      {canAct && <div className="mt-4"><Checkbox checked={ack} onChange={setAck} label="I understand autonomy is graduation only: every write type starts at A2, and A4 and A5 are not yet available" /></div>}
      <Act canAct={canAct} disabled={!ack || !ag.data} why="Tick the statement first." onClick={() => complete('autonomy', { agents: ag.data?.length ?? 0, tools, starts_at: 'A2' })}>Record the starting level</Act>
    </div>
  );
}

const INFRA = [
  { id: 'k8s', label: 'Kubernetes 1.29 or later: 3 control-plane and 4 worker nodes, plus storage nodes' },
  { id: 'pg', label: 'PostgreSQL 16 with row-level security, 3 nodes' },
  { id: 'bao', label: 'OpenBao for secrets, unsealed by your operators' },
  { id: 'backup', label: 'A second site for backups with a restore drill' },
];

function InfraStage({ canAct, complete }: SP) {
  const [ticks, setTicks] = useState<string[]>([]);
  const [store, setStore] = useState('Ceph');
  const sid = useId();
  return (
    <div>
      {canAct ? <>
        <ul className="space-y-2.5">{INFRA.map((x) => <li key={x.id}><Checkbox checked={ticks.includes(x.id)} onChange={(v) => setTicks((t) => (v ? [...t, x.id] : t.filter((y) => y !== x.id)))} label={x.label} /></li>)}</ul>
        <Field className="mt-4 max-w-xs" label="Object-lock storage" htmlFor={sid}><Select id={sid} value={store} onChange={(e) => setStore(e.target.value)}><option>Ceph</option><option>SeaweedFS</option><option>Garage</option></Select></Field>
      </> : <ul className="space-y-1.5 text-sm list-disc pl-5">{INFRA.map((x) => <li key={x.id}>{x.label}</li>)}</ul>}
      <Act canAct={canAct} disabled={ticks.length < INFRA.length} why={`${INFRA.length - ticks.length} item${INFRA.length - ticks.length === 1 ? '' : 's'} not ticked.`} onClick={() => complete('infra', { kubernetes: 'ready', postgresql: '16 with RLS', secrets: 'OpenBao', storage: `${store} with object lock`, backup_site: 'ready' })}>Record the infrastructure</Act>
    </div>
  );
}

const HOST = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z0-9-]{2,}$/i;

function LocalTsaStage({ canAct, complete }: SP) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const ids = { a: useId(), b: useId() };
  const okA = HOST.test(a.trim());
  const okB = HOST.test(b.trim());
  const distinct = a.trim().toLowerCase() !== b.trim().toLowerCase();
  return (
    <div>
      {canAct ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First authority (host inside your network)" htmlFor={ids.a} error={a && !okA ? 'Enter a host name' : undefined}><Input id={ids.a} mono value={a} onChange={(e) => setA(e.target.value)} placeholder="tsa1.govern.bank.internal" /></Field>
          <Field label="Second authority" htmlFor={ids.b} error={b && !okB ? 'Enter a host name' : b && !distinct ? 'Use a different authority' : undefined}><Input id={ids.b} mono value={b} onChange={(e) => setB(e.target.value)} placeholder="tsa2.govern.bank.internal" /></Field>
        </div>
      ) : <p className="text-sm text-muted">Two timestamp authorities inside your network, named by an owner or admin.</p>}
      <Act canAct={canAct} disabled={!okA || !okB || !distinct} why="Two different host names are needed." onClick={() => complete('local_tsa', { tsa_1: a.trim().toLowerCase(), tsa_2: b.trim().toLowerCase() })}>Record the local authorities</Act>
    </div>
  );
}

function BundleStage({ canAct, complete }: SP) {
  const dep = useQuery((o) => api.deployment(o), [], { live: false });
  const [ack, setAck] = useState(false);
  const rel = dep.data?.release;
  return (
    <div>
      {dep.error && <Banner tone="bad" title="The release key could not be loaded">{dep.error.message}</Banner>}
      {!rel ? <Skeleton className="h-20" /> : (
        <KeyValue items={[{ k: 'elan1 release key', v: <span className="font-mono">{rel.kid}</span> }, { k: 'Fingerprint', v: <span className="font-mono tracking-wide">{rel.fingerprint}</span> }]} />
      )}
      {canAct && <div className="mt-4"><Checkbox checked={ack} onChange={setAck} label="The fingerprint printed on the media matches the one above" description="After the upgrade, each bundle’s Ed25519 signature is checked against this key before it is staged; a bundle signed by any other key is rejected." /></div>}
      <Act canAct={canAct} disabled={!ack || !rel} why="Compare the fingerprint first." onClick={() => complete('bundle', { release_kid: rel!.kid, release_fingerprint: rel!.fingerprint, transport: 'air-gapped media' })}>Record the bundle check</Act>
    </div>
  );
}

function EgressStage({ canAct, complete }: SP) {
  const [ack, setAck] = useState(false);
  return (
    <div>
      <KeyValue items={[{ k: 'Policy', v: 'Deny all' }, { k: 'Allow-list', v: 'Empty' }, { k: 'Telemetry', v: 'None' }]} />
      {canAct && <div className="mt-4"><Checkbox checked={ack} onChange={setAck} label="Our network denies egress from the cluster by default" /></div>}
      <Act canAct={canAct} disabled={!ack} why="Tick the egress statement first." onClick={() => complete('egress', { policy: 'deny_all', allow_list: 0, telemetry: 'none' })}>Record the egress policy</Act>
    </div>
  );
}

/* ── Confirm ────────────────────────────────────────────────── */

function ConfirmStage({ run, level, stages, orgName, isOwner, owners, onDone }: { run: UpgradeRun; level: LevelId; stages: StageDef[]; orgName: string; isOwner: boolean; owners: string[]; onDone: (l: LevelId) => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const ids = { p: useId(), t: useId() };
  const [pw, setPw] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const plan = useQuery((o) => api.upgradePlan(o, run.to, user?.id), [run.to, user?.id], { live: false });
  const missing = stages.filter((s) => !run.stages[s.id]);
  const nameOk = typed.trim() === orgName;
  const ready = isOwner && missing.length === 0 && nameOk && pw.length >= 4;

  const confirm = async () => {
    if (!user) return;
    setBusy(true);
    setErr(undefined);
    try {
      try { await api.signIn(user.email, pw); } catch { throw new Error('That password is not right. Nothing was changed.'); }
      markReauth();
      const st = await api.upgradeLevel(orgId, run.to, user.id);
      // register the counterparties named in the wizard
      const cp = run.stages.counterparties?.details?.list;
      let added = 0;
      if (cp && levelRank(st.level) >= levelRank('l3')) {
        for (const row of String(cp).split(';').filter(Boolean)) {
          const [name, domain, kind, contact] = row.split('|');
          try { await api.addCounterparty(orgId, { name, domain, kind: kind as CounterpartyKind, seats: 1, contact }, user.id); added++; } catch (e) { toast.bad(`${name} could not be registered`, (e as Error).message); }
        }
      }
      toast.ok(`${orgName} is now on ${LEVEL_INFO[run.to].name}`, added ? `${plural(added, 'counterparty', 'counterparties')} registered.` : 'The boundary is recorded in the chain.');
      onDone(run.to);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <Panel kicker="Final stage · owner only" title={`Confirm the move to ${LEVEL_INFO[run.to].name}`}>
      {plan.data && (
        <div className="grid sm:grid-cols-3 gap-px bg-line border border-line mb-5">
          <Fig k="From → to" v={`${LEVEL_INFO[level].short} → ${LEVEL_INFO[run.to].short}`} sub={`${plural(plan.data.adds.length, 'capability', 'capabilities')} added`} />
          <Fig k="Floor a year" v={rupeesShort(plan.data.priceAfter.floorPerYear)} sub={`${plan.data.floorDifference >= 0 ? '+' : ''}${rupees(plan.data.floorDifference)}`} />
          <Fig k="Per action" v={rupees(plan.data.priceAfter.overageRate, { paise: true })} sub={`Refused ${rupees(plan.data.priceAfter.refusalRate, { paise: true })}`} />
        </div>
      )}
      {plan.data && <ListPriceTag planId={run.to} long className="-mt-3 mb-5" />}
      <ul className="space-y-2 text-sm mb-5">
        <li className="flex gap-2"><Lock className="h-4 w-4 mt-0.5 shrink-0 text-muted" aria-hidden />The boundary is the moment you confirm. Records before it stay {LEVEL_INFO[level].label} and keep verifying; records after it are {claimFor(run.to)}.</li>
        <li className="flex gap-2"><KeyRound className="h-4 w-4 mt-0.5 shrink-0 text-muted" aria-hidden />{run.to === 'l2' ? 'Signing moves into AWS KMS (ap-south-1); the old key is kept for verification.' : run.to === 'l3' ? 'A key ceremony creates the signing key in your HSM; the old key is kept for verification.' : 'Signing moves into your on-premises HSM in a key ceremony; the deployment switches to your infrastructure.'}</li>
        <li className="flex gap-2"><Layers className="h-4 w-4 mt-0.5 shrink-0 text-muted" aria-hidden />Moving down a level is not offered: records sealed at a level stay at that level.</li>
      </ul>

      {missing.length > 0 && <Banner tone="held" className="mb-4" title={`${plural(missing.length, 'stage')} still to record`}>{missing.map((s) => s.title).join(', ')}.</Banner>}
      {!isOwner && <Banner tone="neutral" className="mb-4" title="Only an owner confirms">Owners here: {owners.join(', ') || '—'}. Ask one of them to open this page.</Banner>}

      {/* the confirm form is an owner's: other roles see who confirms, not a disabled form */}
      {isOwner && <>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={<>Type <span className="font-mono">{orgName}</span> to confirm</>} htmlFor={ids.t} error={typed && !nameOk ? 'The name must match exactly.' : undefined}>
            <Input id={ids.t} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Your password" htmlFor={ids.p} hint="Checked again before a change that cannot be undone.">
            <Input id={ids.p} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
          </Field>
        </div>
        {err && <Banner tone="bad" className="mt-4">{err}</Banner>}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" icon={<ShieldCheck className="h-4 w-4" />} disabled={!ready} loading={busy} onClick={confirm}
            title={missing.length ? 'Record every stage first.' : undefined}>
            Move to {LEVEL_INFO[run.to].name} now
          </Button>
          <span className="text-xs text-muted">Writes level.upgraded and sets the boundary.</span>
        </div>
      </>}
    </Panel>
  );
}

/* ── Done ───────────────────────────────────────────────────── */

function DoneView({ level, data }: { level: LevelId; data: { lv: Awaited<ReturnType<typeof api.level>>; orgName: string; slug: string; fingerprint: string; last?: Receipt } }) {
  const nav = useNavigate();
  const orgId = useOrgId();
  const user = useUser();
  const boundary = [...data.lv.boundaries].reverse().find((b) => b.to === level);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<{ code: string; label: string; headline: string; exitCode: number; json: string; receipts: number }>();
  const [vErr, setVErr] = useState<string>();
  const [exportOpen, setExportOpen] = useState(false);

  const firstBundle = async () => {
    if (!user || !boundary?.firstSeq) return;
    setVerifying(true);
    setVErr(undefined);
    try {
      // built exactly as it would be exported, but nothing is written or billed: "Export it" goes through the guarded export
      const out = await api.previewPack(orgId, user.id, boundary.firstSeq);
      const res = await api.verifyBundle(out.bundle, { expectedFingerprint: db.getDB(orgId).org.keyFingerprint });
      setResult({ code: res.code, label: res.label, headline: res.headline, exitCode: res.exitCode, json: out.json, receipts: res.counts?.receipts ?? 0 });
    } catch (e) { setVErr((e as Error).message); } finally { setVerifying(false); }
  };

  const { canSee, can } = useScreenAccess();
  const allSteps: { title: string; body: string; to: string; cta: string }[] = level === 'l2' ? [
    { title: 'Watch the first timestamps', body: 'The first batch is timestamped by both authorities within 15 minutes of the boundary.', to: '/assurance/anchors', cta: 'Timestamps' },
    { title: 'Run a verifier profile', body: 'Check the chain against the regime your auditor uses.', to: '/assurance/profiles', cta: 'Verifier profiles' },
    { title: 'Name second reviewers', body: 'From now on a rulebook is published only after a different person approves its review.', to: '/work/reviews', cta: 'Reviews' },
    { title: 'Install a regulatory pack', body: 'ledger1, invoice1 or collect1, with the admission gates G-A to G-E.', to: '/records/packs', cta: 'Regulatory packs' },
  ] : level === 'l3' ? [
    { title: 'Issue a receipt to a counterparty', body: 'Your registered counterparties can verify receipts you issue to them, and you theirs.', to: '/assurance/counterparties', cta: 'Counterparties' },
    { title: 'Share with selective disclosure', body: 'Reveal only the fields a counterparty needs.', to: '/assurance/disclosure', cta: 'Disclosure' },
    { title: 'Review autonomy', body: 'Every write type is at A2 Propose. Propose a graduation to A3 where the record meets the thresholds; a different owner or admin approves.', to: '/agents/autonomy', cta: 'Autonomy' },
    { title: 'See the key ceremony', body: 'The new key, its quorum and the log are under Keys.', to: '/agents/keys', cta: 'Keys' },
  ] : [
    { title: 'Your cluster and updates', body: 'Verify, stage and apply signed update bundles; each step is a receipt.', to: '/agents/deployment', cta: 'Deployment' },
    { title: 'Your HSM and ceremonies', body: 'The signing key lives in your HSM.', to: '/agents/keys', cta: 'Keys' },
    { title: 'Local timestamps', body: 'Batches are timestamped by your own two authorities.', to: '/assurance/anchors', cta: 'Timestamps' },
  ];
  // only the next steps this role can open
  const steps = allSteps.filter((s) => canSee(s.to));

  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-7 space-y-6">
        <Panel tone="inverse" bodyClassName="p-6">
          <p className="label text-ink-300 mb-2">Done</p>
          <p className="font-display text-2xl font-semibold text-paper leading-snug">{data.orgName} is on {LEVEL_INFO[level].label}. Records from the boundary on are {claimFor(level)}.</p>
          {data.last && <p className="mt-3 text-sm text-ink-200">Recorded as <Link className="underline underline-offset-2 font-mono" to={`/activity/${data.last.seq}`}>{seqLabel(data.last.seq)}</Link> by {userName(data.last.actor)} · {dateTime(data.last.ts)}</p>}
        </Panel>
        <Panel title="The boundary" kicker="Records each side">
          {!boundary ? <EmptyState compact title="No boundary found">The level history has no boundary into {LEVEL_INFO[level].name}.</EmptyState> : (
            <div className="grid sm:grid-cols-3 gap-px bg-line border border-line">
              <Fig k="At" v={date(boundary.at)} sub={dateTime(boundary.at)} />
              <Fig k={`Before · ${LEVEL_INFO[boundary.from].short}`} v={n(boundary.recordsBefore)} sub="stay at their level and keep verifying" />
              <Fig k={`After · ${LEVEL_INFO[boundary.to].short}`} v={n(boundary.recordsAfter)} sub={boundary.firstSeq ? `from ${seqLabel(boundary.firstSeq)}` : 'none yet'} />
            </div>
          )}
        </Panel>
        {level === 'l2' && <CloseoutCard />}
        {/* building the bundle needs evidence.export (api.previewPack): hidden for roles without it */}
        {levelRank(level) >= 1 && can('evidence.export') && (
          <Panel title="Export the first bundle and verify it" kicker="Before anyone else does" footer="If it does not pass for you, it will not pass for them.">
            <p className="text-sm text-muted">Builds the evidence bundle from the boundary to the head exactly as it would be exported and runs the six-code verifier on it here, with the key fingerprint as an outsider would hold it. Nothing is written or billed until you export it.</p>
            {vErr && <Banner tone="bad" className="mt-3">{vErr}</Banner>}
            {result && (
              <div className="mt-4 border border-line p-4">
                <StatusChip tone={result.exitCode === 0 ? 'ok' : 'bad'} icon={result.exitCode === 0 ? <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> : <OctagonX className="h-3.5 w-3.5" aria-hidden />}>{result.code} · exit {result.exitCode}</StatusChip>
                <p className="mt-2 text-sm">{result.headline}</p>
                <Button className="mt-3" size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={() => setExportOpen(true)}>Export it · {rupees(2500)} a bundle</Button>
              </div>
            )}
            <Button className="mt-4" variant="primary" icon={<ShieldCheck className="h-4 w-4" />} loading={verifying} disabled={!boundary?.firstSeq} onClick={firstBundle}>{result ? 'Build and verify again' : 'Build and verify'}</Button>
            <ExportPackDialog open={exportOpen} onClose={() => setExportOpen(false)} initialFrom={boundary?.firstSeq} title="Export the first bundle" />
          </Panel>
        )}
      </div>
      {steps.length > 0 && <div className="lg:col-span-5">
        <Panel title="Next steps" kicker={LEVEL_INFO[level].label} flush>
          <ul className="divide-y divide-line">
            {steps.map((s) => (
              <li key={s.to} className="px-5 py-4">
                <p className="font-medium">{s.title}</p>
                <p className="text-sm text-muted">{s.body}</p>
                <Button className="mt-2" size="sm" variant="secondary" iconRight={<ArrowRight className="h-3.5 w-3.5" />} onClick={() => nav(s.to)}>{s.cta}</Button>
              </li>
            ))}
          </ul>
        </Panel>
      </div>}
    </div>
  );
}

function TopLevel({ orgName }: { orgName: string }) {
  const nav = useNavigate();
  const showDeployment = useCanSee('/agents/deployment');
  return (
    <Panel title="Sovereign is the top level" kicker="Nothing to upgrade">
      <p className="text-sm text-muted max-w-[68ch]">{orgName} runs Elan1 Govern on its own infrastructure, with its own HSM and timestamp authorities and no egress. Updates arrive as signed bundles you verify and apply yourself.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {showDeployment && <Button variant="primary" icon={<Server className="h-4 w-4" />} onClick={() => nav('/agents/deployment')}>Deployment and updates</Button>}
        <Button variant="secondary" onClick={() => nav('/assurance/levels')}>The ladder</Button>
      </div>
    </Panel>
  );
}

function Fig({ k, v, sub }: { k: string; v: ReactNode; sub?: ReactNode }) {
  return (
    <div className="bg-surface p-3 min-w-0">
      <p className="label">{k}</p>
      <p className="mt-1 font-display text-lg font-semibold num break-words">{v}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}

