import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, CircleSlash, Download, FileJson, OctagonX, PackageOpen, Play, PlayCircle } from 'lucide-react';
import { api } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { dateTime, n, plural, seqLabel } from '@/lib/format';
import type { ProfileRuleResult, ProfileRunResult, VerifierProfile } from '@/types';
import { Badge, Banner, Button, DataTable, EmptyState, Hash, KeyValue, LegalDraft, PageHeader, Panel, Skeleton, StatusChip, toast, type Column } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { downloadText } from '@/features/activity/shared';
import { UpgradeCallout } from '@/features/evidence/levelGate';
import { cn } from '@/lib/cn';
import { RULE_STATE_LABEL } from '@/lib/profiles';
import type { Entitlement } from '@/mock/packsFactory';
import { LifecyclePanel, entitlementWhy } from './LifecyclePanel';
import { SmartLink } from '@/shell/access';

type ProfileRow = VerifierProfile & { enabled: boolean; viaPack?: boolean; lastRun?: ProfileRunResult; entitlement?: Entitlement };

/** Shown labels for a profile's status ('certified' is a banned word in copy, so it reads 'Issued'). Exported for other screens that name a profile. */
export const STATUS_LABEL: Record<VerifierProfile['status'], string> = { draft: 'Draft', certified: 'Issued', superseded: 'Superseded', withdrawn: 'Withdrawn' };
const KIND_LABEL: Record<ProfileRuleResult['kind'], string> = { integrity: 'Integrity', structural: 'Structure', binding: 'Binding', coverage: 'Coverage', temporal: 'Time' };

function RunChip({ result, size = 'sm' }: { result: 'pass' | 'fail'; size?: 'sm' | 'md' }) {
  return result === 'pass'
    ? <StatusChip tone="ok" size={size} icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Every rule passes</StatusChip>
    : <StatusChip tone="bad" size={size} icon={<OctagonX className="h-3 w-3" aria-hidden />}>A rule fails</StatusChip>;
}

function RuleChip({ state }: { state: ProfileRuleResult['state'] }) {
  if (state === 'pass') return <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Pass</StatusChip>;
  if (state === 'fail') return <StatusChip tone="bad" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>Fail</StatusChip>;
  return <StatusChip tone={state === 'not_measurable' ? 'held' : 'neutral'} size="sm" icon={<CircleSlash className="h-3 w-3" aria-hidden />}>{RULE_STATE_LABEL[state]}</StatusChip>;
}

const retention = (y: number) => (y === 0 ? 'Not set by the regime' : y < 1 ? `${Math.round(y * 12)} months` : `${n(y)} years`);

export default function ProfilesPage() {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const level = useOrgLevel();
  const enabled = atLeast(level, 'l2');
  const canRun = useCan('evidence.export');
  // auditors run profiles read-only: the result is shown to them and nothing is written to the client's chain
  const readOnlyRun = useRole() === 'auditor';
  const [sp, setSp] = useSearchParams();
  const { data, loading, error, refetch } = useQuery((o) => api.profiles(o), [level], { kinds: ['receipt', 'level', 'pack'] });
  const rows = data as ProfileRow[] | undefined;
  // Deep links use ?id= (EvidencePage) or ?profile= (Coverage, pack pages); accept both, and fall back to the first profile when the id is unknown.
  const wantedId = sp.get('id') ?? sp.get('profile');
  const selectedId = (wantedId && rows?.some((p) => p.id === wantedId) ? wantedId : undefined) ?? rows?.[0]?.id;
  const selected = rows?.find((p) => p.id === selectedId);
  const [runs, setRuns] = useState<Record<string, ProfileRunResult>>({});
  const [runningAll, setRunningAll] = useState(false);
  useEffect(() => { setRuns({}); }, [orgId]);

  const run = useMutation((o: string, id: string, uid?: string) => api.runProfile(o, id, uid));
  const runOne = async (p: ProfileRow) => {
    try {
      const r = await run.mutate(orgId, p.id, enabled && canRun ? user?.id : undefined);
      setRuns((m) => ({ ...m, [p.id]: r }));
      const failing = r.rules.filter((x) => x.state === 'fail').length;
      if (r.result === 'pass') toast.ok(`${p.name}: every rule passes`, r.seq ? <>Recorded as {seqLabel(r.seq)}.</> : readOnlyRun ? 'Run read-only — nothing was written to the chain.' : 'Preview run — not recorded.');
      else toast.held(`${p.name}: ${plural(failing, 'rule')} failing`, 'The failing receipts are listed under each rule.');
    } catch (e) { toast.bad('The profile could not be run', (e as Error).message); }
  };
  const runAll = async () => {
    if (!rows) return;
    // only the profiles this organisation may run: ordered (L2+), or every profile as an L1 trial; never a withdrawn one
    const runnable = rows.filter((p) => p.entitlement?.canRun ?? true);
    const skipped = rows.length - runnable.length;
    if (!runnable.length) { toast.held('No profile to run', 'Order a verifier profile before it is run against the chain.'); return; }
    setRunningAll(true);
    try {
      for (const p of runnable) {
        const r = await api.runProfile(orgId, p.id, enabled && canRun ? user?.id : undefined);
        setRuns((m) => ({ ...m, [p.id]: r }));
      }
      toast.ok(`${plural(runnable.length, 'profile')} run against the chain`, `${enabled && canRun ? (readOnlyRun ? 'Run read-only — nothing was written to the chain.' : 'Each run is recorded on the chain.') : 'Preview runs — not recorded.'}${skipped ? ` ${plural(skipped, 'profile')} not ordered or withdrawn, so not run.` : ''}`);
    } catch (e) { toast.bad('A profile could not be run', (e as Error).message); }
    finally { setRunningAll(false); }
  };

  const select = (id: string) => { const x = new URLSearchParams(sp); x.delete('profile'); x.set('id', id); setSp(x, { replace: true }); };
  const runWhy = !canRun ? 'Owners, admins and auditors can run profiles; others can read the results.' : undefined;

  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Verifier profiles"
        description="A profile names the fields a regime needs, how long records are kept and the rules the records must meet. Run it against the chain to see which receipts pass each rule; claim it in an evidence bundle so the auditor’s verifier checks the same rules."
        // viewers read the profiles and their last results; they see no run buttons
        actions={!runWhy && <Button variant="secondary" icon={<PlayCircle className="h-4 w-4" />} loading={runningAll} disabled={!rows?.length} onClick={runAll}>{enabled ? 'Run every profile' : 'Preview every profile'}</Button>}
        meta={<LegalDraft />}
      />
      {error && <Banner tone="bad" title="Profiles could not be loaded" className="mb-6" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      {!enabled && (
        <UpgradeCallout className="mb-6" orgId={orgId} to="l2" caps={['verifier_profiles', 'six_code_verifier', 'evidence_bundle_8', 'regulatory_packs', 'seal_v6']}>
          Profiles are checked by the verifier from L2 Attested, and an evidence bundle can claim one so an auditor’s run fails with FAIL_PROFILE if a rule is broken. On this level you can read every profile and preview a run against your own chain; preview runs are not recorded and are not part of any export.
        </UpgradeCallout>
      )}

      <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <div className="lg:col-span-4">
          <Panel title="Profiles" kicker={rows ? `${rows.length} regimes` : 'Regimes'} flush>
            {loading && !rows ? <div className="p-5 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div> : !rows?.length ? (
              <EmptyState compact title="No profiles" disc="registration">Profiles come with Elan1 Govern and the regulatory packs.</EmptyState>
            ) : (
              <ul role="listbox" aria-label="Verifier profiles" className="divide-y divide-line">
                {rows.map((p) => {
                  const last = runs[p.id] ?? p.lastRun;
                  const on = p.id === selectedId;
                  return (
                    <li key={p.id}>
                      <button role="option" aria-selected={on} onClick={() => select(p.id)}
                        className={cn('w-full text-left px-5 py-3.5 hover:bg-sunken/60 focus-visible:bg-sunken/80 transition-colors', on && 'bg-sunken shadow-[inset_3px_0_0_rgb(var(--fg))]')}>
                        <span className="flex items-start justify-between gap-2">
                          <span className="min-w-0">
                            <span className="block font-medium">{p.name}</span>
                            <span className="block text-xs text-muted mt-0.5">{p.jurisdiction} · v{p.version} · {STATUS_LABEL[p.status]}</span>
                          </span>
                          {last ? <RunChip result={last.result} /> : <span className="text-xs text-subtle whitespace-nowrap">Not run</span>}
                        </span>
                        <span className="mt-1.5 inline-flex flex-wrap gap-1">
                          {p.packId && <Badge tone={p.viaPack ? 'ok' : 'neutral'}>{p.packId}{p.viaPack ? ' · installed' : ''}</Badge>}
                          {p.entitlement && <Badge tone={p.entitlement.withdrawn ? 'bad' : p.entitlement.trial ? 'info' : p.entitlement.preview ? 'held' : p.entitlement.ordered ? 'ok' : 'held'}>{p.entitlement.withdrawn ? (p.entitlement.ordered ? 'Withdrawn · order open' : 'Withdrawn') : p.entitlement.trial ? 'Trial' : p.entitlement.preview ? 'Not issued · preview' : p.entitlement.ordered ? 'Ordered' : 'Not ordered'}</Badge>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <div className="lg:col-span-8 space-y-6">
          {loading && !selected ? <Skeleton className="h-96" /> : selected ? (
            <ProfileDetail p={selected} run={runs[selected.id] ?? selected.lastRun} enabled={enabled} canRun={canRun} running={run.pending}
              onRun={() => runOne(selected)} onExport={() => nav(`/evidence?export=1&profile=${selected.id}`)} />
          ) : !error && <EmptyState title="Choose a profile" disc="registration">Pick a regime on the left to read its rules and run it against the chain.</EmptyState>}
        </div>
      </div>
    </div>
  );
}

function ProfileDetail({ p, run, enabled, canRun, running, onRun, onExport }: { p: ProfileRow; run?: ProfileRunResult; enabled: boolean; canRun: boolean; running: boolean; onRun: () => void; onExport: () => void }) {
  const byId = useMemo(() => new Map(run?.rules.map((r) => [r.id, r])), [run]);
  const failing = run?.rules.filter((r) => r.state === 'fail').length ?? 0;
  const profileJson = () => { const { enabled: _e, viaPack: _v, lastRun: _l, entitlement: _n, ...profile } = p; return JSON.stringify(profile, null, 2); };
  const ent = p.entitlement;
  // the role decides whether the buttons show at all; the entitlement (not ordered, withdrawn) keeps them disabled with its reason
  // only an owner orders or cancels: other roles read the state without being told to
  const why = entitlementWhy(ent, useRole() === 'owner');
  const runWhy = ent && !ent.canRun ? why : undefined;
  const claimWhy = ent && !ent.canClaim ? why : undefined;

  const cols: Column<VerifierProfile['rules'][number]>[] = [
    { key: 'id', header: 'Rule', cell: (r) => <span className="font-mono text-[12.5px] font-semibold">{r.id}</span>, width: 64 },
    { key: 'text', header: 'What the records must show', cell: (r) => {
      const res = byId.get(r.id);
      return (
        <div className="py-2 min-w-0">
          <p className="text-sm">{r.text}</p>
          <p className="text-xs text-muted mt-0.5">{KIND_LABEL[r.kind]} · {r.clause}</p>
          {!res && r.disposition === 'not_measurable' && <p className="text-xs text-muted mt-1">Not measured: {r.reason} Would change if: {r.wouldChangeIf}</p>}
          {!res && r.disposition === 'out_of_scope' && <p className="text-xs text-muted mt-1">Out of scope under <span className="font-mono">{r.adr}</span>.</p>}
          {res && <p className={cn('text-xs mt-1', res.state === 'fail' ? 'text-bad-fg' : 'text-muted')}>{res.detail}</p>}
          {res && res.failingSeqs.length > 0 && (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className="text-muted">Failing:</span>
              {res.failingSeqs.slice(0, 8).map((s) => <ReceiptLink key={s} seq={s} className="text-[12px]" />)}
              {res.failingSeqs.length > 8 && <span className="text-muted">and {n(res.failingSeqs.length - 8)} more (in the JSON)</span>}
            </p>
          )}
        </div>
      );
    } },
    { key: 'state', header: 'Result', cell: (r) => { const res = byId.get(r.id); return res ? <RuleChip state={res.state} /> : r.disposition && r.disposition !== 'bound' ? <RuleChip state={r.disposition} /> : <span className="text-xs text-subtle">Not run</span>; }, align: 'right' },
  ];

  return (
    <>
      <Panel kicker={`${p.jurisdiction} · ${p.issuer}`} title={p.name}
        actions={<Button size="sm" variant="ghost" icon={<FileJson className="h-3.5 w-3.5" />} onClick={() => downloadText(`${p.id}-v${p.version}.json`, profileJson())}>Profile JSON</Button>}>
        <p className="text-sm leading-relaxed">{p.regime}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge>v{p.version}</Badge>
          <Badge tone={p.status === 'draft' ? 'held' : 'neutral'}>{STATUS_LABEL[p.status]}</Badge>
          <Badge>Keep {retention(p.retentionYears)}</Badge>
          <Badge>{plural(p.rules.length, 'rule')}</Badge>
        </div>
        <KeyValue className="mt-4" items={[
          { k: 'Profile id', v: p.id, mono: true },
          { k: 'Digest', v: <Hash value={p.digest} len={16} /> },
          { k: 'Retention', v: retention(p.retentionYears) },
          { k: 'Regulatory pack', v: p.packId ? <SmartLink to={`/records/packs/${p.packId}`} className="hover:underline underline-offset-2"><span className="font-mono">{p.packId}</span> · {p.viaPack ? 'installed' : 'not installed'} →</SmartLink> : <span className="text-muted">Stands alone (no pack)</span> },
        ]} />
        <div className="mt-4">
          <p className="label mb-2">Fields a bundle must carry</p>
          <div className="flex flex-wrap gap-1.5">{p.requiredFields.map((f) => <span key={f} className="font-mono text-[12px] px-1.5 h-6 inline-flex items-center border border-line bg-sunken/60">{f}</span>)}</div>
        </div>
        {(canRun || p.packId) && (
          <div className="mt-5 flex flex-wrap gap-2">
            {canRun && <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={running} disabled={!!runWhy} title={runWhy} onClick={onRun}>{enabled && !ent?.preview ? 'Run against the chain' : 'Preview a run'}</Button>}
            {canRun && enabled && <Button icon={<PackageOpen className="h-4 w-4" />} onClick={onExport} disabled={!!claimWhy} title={claimWhy}>Export a bundle claiming this profile</Button>}
            {p.packId && <SmartLink hideWhenBlocked to={`/records/packs/${p.packId}`} className="inline-flex items-center h-10 px-4 text-base border border-line-strong/70 hover:border-fg">Open the {p.packId} pack</SmartLink>}
          </div>
        )}
        {runWhy && canRun && <p className="mt-2 text-xs text-muted">{runWhy}</p>}
      </Panel>

      <LifecyclePanel profile={p} />

      {run && (
        <Panel kicker={run.seq ? `Recorded as ${seqLabel(run.seq)}` : 'Preview run · not recorded'} title={run.result === 'pass' ? 'Every rule passes on this chain' : `${plural(failing, 'rule')} failing on this chain`}
          actions={<Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadText(`${p.id}-run-${run.id}.json`, JSON.stringify(run, null, 2))}>Result JSON</Button>}>
          <div className="flex flex-wrap items-center gap-3">
            <RunChip result={run.result} size="md" />
            <span className="text-sm text-muted num">{dateTime(run.ranAt)} · {plural(run.range.count, 'receipt')}, {seqLabel(run.range.firstSeq)}–{seqLabel(run.range.lastSeq)}</span>
            {run.seq && <ReceiptLink seq={run.seq} />}
          </div>
          <p className="mt-3 text-xs text-muted">Result digest <span className="font-mono">{run.digest.slice(0, 24)}…</span>. In an evidence bundle that claims this profile, a failing rule makes the verifier return FAIL_PROFILE (exit 2); integrity failures always come first as FAIL_INTEGRITY (exit 1).</p>
        </Panel>
      )}

      <Panel title="Rules" kicker={run ? 'With the results of the last run' : 'Run the profile to see results'} flush>
        <DataTable caption={`Rules of ${p.name}`} className="border-0" columns={cols} rows={p.rules} rowKey={(r) => r.id} />
      </Panel>

      <Panel title="What a pass does not show" tone="sunken">
        <p className="text-sm leading-relaxed">{p.limits}</p>
        <div className="mt-3"><LegalDraft /></div>
      </Panel>
    </>
  );
}
