import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, CheckCircle2, Download, Fingerprint, Link2, OctagonX, PackageOpen, ShieldCheck, Waypoints } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import { atLeast, LEVEL_INFO } from '@/lib/levels';
import { CODE_LABELS, EXIT_CODES, VERIFY_LIMITS } from '@/lib/verify6';
import { date, dateTime, n, pct, plural, relative, seqLabel, timeShort } from '@/lib/format';
import type { LevelBoundary, LevelId, VerifyCode } from '@/types';
import { Badge, Banner, Button, CodeBlock, CopyButton, DataTable, EmptyState, LegalDraft, PageHeader, Panel, Skeleton, Stat, Tabs, toast, type Column } from '@/components/ui';
import { Person, ReceiptLink, When } from '@/components/domain';
import { downloadText } from '@/features/activity/shared';
import { tsaShort } from '@/features/anchors/anchorLocal';
import { ExportPackDialog, packFilename } from './ExportPackDialog';
import { CLAIM, CUSTODY_LABEL, UpgradeCallout, levelStartMs } from './levelGate';
import { exportReceiptSeq, type ExportRow } from './exportSeqs';
import { CheckpointsPanel } from './CheckpointsPanel';
import { KeysCustody } from './KeysCustody';
import { SealTab } from './SealTab';
import { ChainGapsPanel } from '@/features/records/gaps';
import { IntegrityRunsPanel, useIntegrity } from './IntegrityRuns';
import { ContinuityLine } from './ContinuityLine';
import { cn } from '@/lib/cn';
import { PlanUpsell, SmartLink, useScreenAccess } from '@/shell/access';

/** Raw 32-byte Ed25519 public key → SubjectPublicKeyInfo PEM, as `govern verify --key` expects. */
export function ed25519Pem(hex: string) {
  const der = '302a300506032b6570032100' + hex;
  const bytes = der.match(/../g)!.map((h) => parseInt(h, 16));
  return `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PUBLIC KEY-----\n`;
}

type Tab = 'overview' | 'checkpoints' | 'integrity' | 'keys' | 'seal' | 'exports';
const TABS: Tab[] = ['overview', 'checkpoints', 'integrity', 'keys', 'seal', 'exports'];

export default function EvidencePage() {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const level = useOrgLevel();
  const l2 = atLeast(level, 'l2');
  const [sp, setSp] = useSearchParams();
  const canExport = useCan('evidence.export');
  const canCheckpoint = useCan('evidence.checkpoint');
  const { data, loading, error, refetch } = useQuery((o) => api.evidence(o), [level], { kinds: ['receipt', 'checkpoint', 'key', 'level'] });
  const lvl = useQuery((o) => api.level(o), [level], { kinds: ['level', 'receipt'] });
  const anchors = useQuery((o) => (l2 ? api.anchors(o, 100000) : Promise.resolve(undefined)), [l2], { kinds: ['receipt', 'level'] });
  const custody = useQuery((o) => api.custody(o), [level], { kinds: ['key', 'level'] });
  const profiles = useQuery((o) => api.profiles(o), [level], { kinds: ['level', 'receipt'] });
  const integrity = useIntegrity();
  const access = useScreenAccess();
  // Keys and custody follows the menu: roles that cannot open Keys (viewers) do not get it here either
  const canKeys = access.canSee('/agents/keys');
  // the dialog only opens for roles that can export (a viewer never gets a dialog of disabled buttons)
  const [exportOpen, setExportOpen] = useState(sp.get('export') === '1' && canExport);
  const [signing, setSigning] = useState(false);
  // Seal v6 is part of the plan from L2; the exports list is for the roles that can open Exports (not viewers)
  const tabs = TABS.filter((t) => (t === 'seal' ? l2 : t === 'exports' ? canExport : t === 'keys' ? canKeys : true));
  const tab = (tabs.includes(sp.get('tab') as Tab) ? sp.get('tab') : 'overview') as Tab;
  const setTab = (t: Tab) => { const x = new URLSearchParams(sp); if (t === 'overview') x.delete('tab'); else x.set('tab', t); setSp(x, { replace: true }); };

  useEffect(() => { if (sp.get('export') === '1' && canExport) setExportOpen(true); }, [sp, canExport]);
  const closeExport = () => {
    setExportOpen(false);
    if (sp.get('export') || sp.get('profile')) { const next = new URLSearchParams(sp); next.delete('export'); next.delete('profile'); setSp(next, { replace: true }); }
  };

  const signNow = async () => {
    if (!user) return;
    setSigning(true);
    try {
      const c = await api.signCheckpoint(orgId, user.id);
      // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
      toast.ok(`Checkpoint ${l2 ? 'signed' : 'sealed'} at ${seqLabel(c.seq)}`, `The chain head is now fixed by ${l2 ? 'a signature' : 'an Ed25519 seal'} from ${c.kid}.`);
    } catch (e) { toast.bad(`The checkpoint could not be ${l2 ? 'signed' : 'sealed'}`, (e as Error).message); }
    finally { setSigning(false); }
  };

  const activeKeys = data?.signingKeys.filter((k) => k.status === 'active') ?? [];
  const activeKey = activeKeys[activeKeys.length - 1];
  const activePub = activeKey ? data?.publicKeys[activeKey.kid] : undefined;
  const lastCp = data?.checkpoints[0];
  const uncheckpointed = data?.head && lastCp ? data.head.seq - lastCp.seq : undefined;
  const sealedFrom = l2 ? levelStartMs(orgId, 'l2') : undefined;
  const empty = !!data && !data.head;

  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Proof"
        description={l2
          ? 'The chain’s proof: signed checkpoints, timestamps, signing keys and their custody, and the evidence an auditor checks offline.'
          : 'The chain’s proof: sealed checkpoints, the keys that seal them and their custody, and the evidence an auditor checks offline.'}
        meta={<Badge>{LEVEL_INFO[level].label}</Badge>}
        actions={
          <>
            <Button variant="secondary" icon={<Waypoints className="h-4 w-4" />} onClick={() => nav('/activity/chain')}>Chain explorer</Button>
            {canExport && <Button variant="primary" icon={<PackageOpen className="h-4 w-4" />} onClick={() => setExportOpen(true)} disabled={empty} title={empty ? 'There are no receipts to export yet.' : undefined}>{l2 ? 'Export evidence bundle' : 'Export auditor pack'}</Button>}
          </>
        }
      />

      {error && <Banner tone="bad" title="Evidence could not be loaded" className="mb-6" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      {/* hero */}
      <Panel tone="inverse" className="mb-6">
        {loading && !data ? <Skeleton className="h-20 opacity-20" /> : error && !data ? (
          <p className="text-ink-200 text-sm">The chain status is not available until the evidence loads.</p>
        ) : data && (
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="min-w-0">
              <p className="label text-ink-300 mb-2">Chain status · {data.org.name} · {LEVEL_INFO[level].label}</p>
              <p className="font-display text-3xl font-semibold tracking-tighter2 text-paper">{empty ? 'No receipts yet' : l2 ? `${n(data.total)} signed receipts, hash-chained` : `${n(data.total)} receipts, sealed in a hash chain`}</p>
              {data.head && (
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-200">
                  {/* never "continuous" over a range the integrity runs have not reached */}
                  <ContinuityLine inverse headSeq={data.head.seq} firstSeq={data.first?.seq} report={integrity.data} onOpenRuns={() => setTab('integrity')} />
                  {lastCp && <span>Last {l2 ? 'signed' : 'sealed'} checkpoint {relative(lastCp.ts)}</span>}
                  <span className="inline-flex items-center gap-1"><Link2 className="h-3.5 w-3.5" aria-hidden />{CLAIM[level]}</span>
                </div>
              )}
            </div>
            <Button variant="inverse" icon={<ShieldCheck className="h-4 w-4" />} onClick={() => nav('/activity/chain')} disabled={empty} title={empty ? 'There is nothing to verify yet.' : undefined}>Verify in this browser</Button>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 mb-6">
        <Stat label="Receipts in window" value={data ? n(data.total) : '—'} sub={data?.first ? `Since ${date(data.first.ts)}` : data ? 'None yet' : undefined} />
        <Stat label="First and last" value={data?.first ? <span className="font-mono text-2xl">{seqLabel(data.first.seq)}</span> : '—'} sub={data?.head ? <>to <Link className="font-mono hover:underline underline-offset-2" to={`/activity/${data.head.seq}`}>{seqLabel(data.head.seq)}</Link></> : undefined} />
        <Stat label="Checkpoints" value={data ? n(data.checkpoints.length) : '—'} sub={lastCp ? `Last ${relative(lastCp.ts)}${uncheckpointed ? ` · ${plural(uncheckpointed, 'receipt')} since` : ''}` : data ? 'None yet' : undefined} />
        <Stat label="Signing keys" value={data ? n(data.signingKeys.length) : '—'} sub={data && `${n(data.signingKeys.filter((k) => k.status === 'retired').length)} retired · ${n(activeKeys.length)} signing`} />
      </div>

      <Tabs<Tab> className="mb-6" label="Proof sections" value={tab} onChange={setTab} items={([
        { value: 'overview', label: 'Overview' },
        { value: 'checkpoints', label: l2 ? 'Checkpoints and timestamps' : 'Checkpoints', count: data?.checkpoints.length },
        { value: 'integrity', label: 'Integrity runs' },
        { value: 'keys', label: 'Keys and custody', count: data?.signingKeys.length },
        { value: 'seal', label: 'Seal v6 and test vectors' },
        { value: 'exports', label: 'Exports', count: data?.exports.length },
      ] as { value: Tab; label: string; count?: number }[]).filter((x) => tabs.includes(x.value))} />

      {tab === 'overview' && (
        <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
          <div className="lg:col-span-8 space-y-6">
            <BoundaryPanel orgId={orgId} level={level} boundaries={lvl.data?.boundaries} history={lvl.data?.history} total={data?.total} firstSeq={data?.first?.seq} loading={lvl.loading && !lvl.data} error={lvl.error?.message} />
            <AssuranceNow level={level} anchors={anchors.data} custody={custody.data} profiles={profiles.data} onKeys={canKeys ? () => setTab('keys') : undefined} loading={(anchors.loading && l2) || custody.loading || profiles.loading} />            <ChainGapsPanel compact />
          </div>
          <div className="lg:col-span-4 space-y-6">
            <Panel title="Public key fingerprint" kicker="Publish it out of band">
              {loading && !data ? <Skeleton className="h-28" /> : error && !data ? (
                <p className="text-sm text-muted">Not available while the evidence cannot be loaded. <button className="underline underline-offset-2" onClick={refetch}>Try again</button></p>
              ) : !activeKey ? (
                <EmptyState compact title="No signing key is active" disc="registration">Every key is retired, so new receipts cannot be {l2 ? 'signed' : 'sealed'}. An owner can create one under Keys and custody.</EmptyState>
              ) : data && (
                <>
                  <div className="flex items-center gap-2 border border-line bg-sunken/60 px-3 py-3">
                    <Fingerprint className="h-5 w-5 text-muted shrink-0" aria-hidden />
                    <span className="font-mono text-md tracking-wide break-all flex-1">{data.org.keyFingerprint}</span>
                    <CopyButton text={data.org.keyFingerprint} label="Copy" />
                  </div>
                  <p className="mt-2 text-xs text-muted">Key <span className="font-mono">{activeKey.kid}</span>{custody.data ? ` · ${CUSTODY_LABEL[custody.data.mode]}` : ''} · SHA-256 of the public key, first 16 hex characters.</p>
                  <p className="mt-3 text-sm leading-relaxed">Publish this fingerprint where an auditor can find it without asking Elan1 Govern — your website, the engagement letter, the annual report. {l2 ? 'Given with --fingerprint, the verifier can return PASS instead of PASS_KEY_FROM_BUNDLE.' : 'An auditor compares it with the key inside a pack.'}</p>
                  {activePub ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadText('org-public-key.pem', ed25519Pem(activePub), 'application/x-pem-file')}>Download public key (.pem)</Button>
                      <CopyButton text={activePub} label="Copy key hex" className="h-8" />
                    </div>
                  ) : <p className="mt-3 text-xs text-muted">The public key for {activeKey.kid} is not in this window.</p>}
                </>
              )}
            </Panel>
            <VerifyHowTo level={level} data={data} unanchored={anchors.data?.totals.unanchoredTail} loading={loading && !data} />
            <LimitsPanel level={level} />
          </div>
        </div>
      )}

      {tab === 'checkpoints' && (
        <div className="space-y-6">
          {!l2 && <UpgradeCallout orgId={orgId} to="l2" caps={['rfc3161_anchors', 'merkle_batches', 'seal_v6']}>From L2 each checkpoint’s batch is timestamped by two authorities within 15 minutes, and this table gains a column per authority, the time to anchor, the Merkle root and the inclusion proof of the head receipt.</UpgradeCallout>}
          <CheckpointsPanel checkpoints={data?.checkpoints} loading={loading} level={level} anchors={anchors.data} sealedFrom={sealedFrom} canCheckpoint={canCheckpoint} signing={signing} onSign={signNow} unanchored={uncheckpointed} />
        </div>
      )}

      {tab === 'integrity' && <IntegrityRunsPanel />}

      {tab === 'keys' && canKeys && <KeysCustody level={level} signingKeys={data?.signingKeys} loading={loading} />}

      {tab === 'seal' && <SealTab level={level} headSeq={data?.head?.seq} />}

      {tab === 'exports' && <ExportsPanel rows={data?.exports as ExportRow[] | undefined} loading={loading} canExport={canExport && !empty} onNew={() => setExportOpen(true)} />}

      <ExportPackDialog open={exportOpen && canExport} onClose={closeExport} initialProfile={sp.get('profile') ?? undefined} />
    </div>
  );
}

/* ── L1 → L2 boundary ──────────────────────────────────────── */

const RECORD_KIND: Record<LevelId, string> = {
  l1: 'sealed in a hash chain, no Seal v6 record',
  l2: 'sealed and timestamped, key in AWS KMS',
  l3: 'sealed and timestamped, key in your HSM',
  sovereign: 'sealed, your HSM, your timestamp authorities',
};

function BoundaryPanel({ orgId, level, boundaries, history, total, firstSeq, loading, error }: {
  orgId: string; level: LevelId; boundaries?: LevelBoundary[]; history?: { level: LevelId; from: string; by?: string; seq?: number }[]; total?: number; firstSeq?: number; loading: boolean; error?: string;
}) {
  if (loading) return <Panel title="Assurance levels in this chain"><Skeleton className="h-32" /></Panel>;
  if (error) return <Panel title="Assurance levels in this chain"><Banner tone="bad">{error}</Banner></Panel>;
  if (level === 'l1') {
    return (
      <div className="space-y-6">
        <Panel title="Assurance levels in this chain" kicker="One level">
          <p className="text-sm leading-relaxed">Every record here — <span className="num font-medium">{n(total ?? 0)}</span> in this window — is <span className="font-medium">{LEVEL_INFO.l1.label}</span>: {RECORD_KIND.l1}. If the organisation moves to L2, the moment it confirms becomes the boundary: records before it stay L1 and keep verifying; records after it are sealed and timestamped. This panel then shows the boundary with the count on each side.</p>
        </Panel>
        <UpgradeCallout orgId={orgId} to="l2" caps={['seal_v6', 'rfc3161_anchors', 'kms_custody', 'evidence_bundle_8', 'six_code_verifier', 'verifier_profiles']} />
      </div>
    );
  }
  const shown = (boundaries ?? []).filter((b) => b.recordsAfter > 0 || b.recordsBefore > 0);
  return (
    <Panel title="Assurance levels in this chain" kicker={shown.length ? plural(shown.length, 'boundary', 'boundaries') : 'One level in this window'}>
      {!shown.length ? (
        <p className="text-sm leading-relaxed">Every record in this window — <span className="num font-medium">{n(total ?? 0)}</span> from {firstSeq ? seqLabel(firstSeq) : 'the first'} — is <span className="font-medium">{LEVEL_INFO[level].label}</span>: {RECORD_KIND[level]}{history?.[0] ? `, since ${date(history[history.length - 1].from)}` : ''}.</p>
      ) : (
        <ol className="space-y-5">
          {shown.map((b) => {
            const sum = Math.max(1, b.recordsBefore + b.recordsAfter);
            return (
              <li key={`${b.from}-${b.to}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{LEVEL_INFO[b.from].short} → {LEVEL_INFO[b.to].short} on {date(b.at)} <span className="text-muted text-sm font-normal">{timeShort(b.at)} IST</span></p>
                  {b.firstSeq !== undefined && <span className="text-sm text-muted">First {LEVEL_INFO[b.to].short} record <ReceiptLink seq={b.firstSeq} /></span>}
                </div>
                <div className="mt-2 flex h-2 w-full overflow-hidden border border-line" aria-hidden>
                  <div className="bg-line-strong" style={{ width: `${(b.recordsBefore / sum) * 100}%` }} />
                  <div className="bg-fg" style={{ width: `${(b.recordsAfter / sum) * 100}%` }} />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-4 text-sm">
                  <div><p className="num font-display text-2xl font-semibold">{n(b.recordsBefore)}</p><p className="text-xs text-muted">Before · {LEVEL_INFO[b.from].label} — {RECORD_KIND[b.from]}</p></div>
                  <div className="text-right"><p className="num font-display text-2xl font-semibold">{n(b.recordsAfter)}</p><p className="text-xs text-muted">From the boundary · {LEVEL_INFO[b.to].label} — {RECORD_KIND[b.to]}</p></div>
                </div>
                {b.beforeWindow && <p className="mt-1 text-xs text-muted">The boundary is before the first receipt this console holds, so every record in this window is on the later level.</p>}
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-4 text-xs text-muted">Records before a boundary are shown as what they are, not as failures: they keep verifying with the same verifier.</p>
    </Panel>
  );
}

/* ── What this level gives now (live) ──────────────────────── */

function AssuranceNow({ level, anchors, custody, profiles, onKeys, loading }: {
  level: LevelId; anchors?: Awaited<ReturnType<typeof api.anchors>>; custody?: Awaited<ReturnType<typeof api.custody>>; profiles?: Awaited<ReturnType<typeof api.profiles>>; onKeys?: () => void; loading: boolean;
}) {
  const l2 = level !== 'l1';
  const latest = anchors?.batches[0];
  const runs = (profiles ?? []).filter((p) => p.lastRun);
  const failing = runs.filter((p) => p.lastRun!.result === 'fail').length;
  const card = 'bg-surface p-5 min-w-0 flex flex-col';
  // timestamps and verifier profiles are part of the plan from L2: at L1 only custody is shown
  return (
    <Panel title={l2 ? `What ${LEVEL_INFO[level].name} adds, live` : 'Key custody'} kicker={LEVEL_INFO[level].label} flush>
      <div className={cn('grid gap-px bg-line', l2 && 'sm:grid-cols-3')}>
        {l2 && <div className={card}>
          <p className="label">Timestamps</p>
          {loading && !anchors && l2 ? <Skeleton className="mt-3 h-16" /> : l2 && latest ? (
            <>
              <p className="mt-2 text-sm">Last batch closed {timeShort(latest.windowEnd)} IST</p>
              <ul className="mt-2 space-y-1 text-xs text-muted">{latest.tokens.map((t) => <li key={t.tsaId}>{tsaShort(t.tsaName)} · {timeShort(t.genTime)}</li>)}</ul>
              <p className="mt-2 text-xs text-muted num">{pct(anchors!.totals.withinTargetPct, anchors!.totals.withinTargetPct < 1 ? 1 : 0)} of batches within 15 minutes · {n(anchors!.totals.unanchoredTail)} waiting</p>
            </>
          ) : <p className="mt-2 text-sm text-muted">The first batch is timestamped when its 15-minute window closes.</p>}
          <SmartLink to="/assurance/anchors" hideWhenBlocked className="mt-auto pt-3 text-sm font-medium hover:underline underline-offset-2">Open timestamps →</SmartLink>
        </div>}
        <div className={card}>
          <p className="label">Key custody</p>
          {!custody ? <Skeleton className="mt-3 h-16" /> : (
            <>
              <p className="mt-2 text-sm font-medium">{custody.provider}</p>
              <p className="mt-1 text-xs text-muted">{custody.location}</p>
              <p className="mt-1 text-xs text-muted">{custody.heldBy === 'customer' ? 'Held by you' : 'Held by elan1'} · {custody.residencyDomain}{custody.quorum ? ` · ${custody.quorum.required} of ${custody.quorum.of} holders` : ''}</p>
            </>
          )}
          {onKeys && <button onClick={onKeys} className="mt-auto pt-3 text-left text-sm font-medium hover:underline underline-offset-2">Keys and custody →</button>}
        </div>
        {l2 && <div className={card}>
          <p className="label">Verifier profiles</p>
          {!profiles ? <Skeleton className="mt-3 h-16" /> : (
            <>
              <p className="mt-2 text-sm">{plural(profiles.length, 'profile')} available to claim</p>
              {runs.length ? (
                <ul className="mt-2 space-y-1 text-xs">
                  {runs.slice(0, 3).map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2"><span className="truncate text-muted">{p.name}</span>{p.lastRun!.result === 'pass' ? <span className="inline-flex items-center gap-1 text-ok-fg"><CheckCircle2 className="h-3 w-3" aria-hidden />Pass</span> : <span className="inline-flex items-center gap-1 text-bad-fg"><OctagonX className="h-3 w-3" aria-hidden />Fail</span>}</li>
                  ))}
                </ul>
              ) : <p className="mt-2 text-xs text-muted">None run yet.</p>}
              {failing > 0 && <p className="mt-1 text-xs text-bad-fg">{plural(failing, 'profile')} with a failing rule</p>}
            </>
          )}
          <SmartLink to="/assurance/profiles" hideWhenBlocked className="mt-auto pt-3 text-sm font-medium hover:underline underline-offset-2">Run a profile →</SmartLink>
        </div>}
      </div>
    </Panel>
  );
}

/* ── How an auditor verifies ───────────────────────────────── */

const SIX: { code: VerifyCode; detail: string }[] = [
  { code: 'PASS', detail: 'Every check passed with the fingerprint you supplied.' },
  { code: 'PASS_UNANCHORED_TAIL', detail: 'Passes; the newest sealed records are not yet timestamped.' },
  { code: 'PASS_KEY_FROM_BUNDLE', detail: 'Passes, but the key came from the bundle itself.' },
  { code: 'PASS_L1_INTERNAL', detail: 'Passes. L1 records only: internal evidence, sealed in a hash chain, not timestamped.' },
  { code: 'PASS_PAYLOAD_UNBOUND', detail: 'Passes. An erasure destroyed a salt, so some payload hashes cannot be recomputed.' },
  { code: 'FAIL_INTEGRITY', detail: 'A hash, link, signature, seal, root or token fails. Names the first.' },
  { code: 'FAIL_PROFILE', detail: 'Integrity holds; a rule of the claimed profile fails.' },
  { code: 'INCOMPLETE', detail: 'Something needed is missing: a member, a seal, a key.' },
  { code: 'UNSUPPORTED', detail: 'A format or profile this verifier does not know.' },
  { code: 'USAGE', detail: 'Not a bundle, or wrong options.' },
];

function VerifyHowTo({ level, data, unanchored, loading }: { level: LevelId; data?: Awaited<ReturnType<typeof api.evidence>>; unanchored?: number; loading: boolean }) {
  const nav = useNavigate();
  const l2 = level !== 'l1';
  const file = data ? packFilename(data.org.slug, data.first?.seq, data.head?.seq, level, 'zip') : '';
  const cli = !data?.head ? '' : l2 ? [
    '# On the auditor’s own machine — offline, no account',
    `$ govern verify ${file} --fingerprint ${data.org.keyFingerprint}`,
    unanchored ? `PASS_UNANCHORED_TAIL  ${CODE_LABELS.PASS_UNANCHORED_TAIL.replace('Pass — ', '')} (${n(unanchored)})` : 'PASS',
    `  records ${seqLabel(data.first.seq)}–${seqLabel(data.head.seq)}: ${n(data.total)}, ${n(data.checkpoints.length)} checkpoints`,
    `  organisation: ${data.org.name}`,
    `  key fingerprint: ${data.org.keyFingerprint} (supplied)`,
    '$ echo $?',
    '0',
  ].join('\n') : [
    '# On the auditor’s own machine — offline, no account',
    `$ govern verify ${file} --fingerprint ${data.org.keyFingerprint}`,
    `PASS_L1_INTERNAL  ${n(data.total)} receipts — L1: internal evidence only`,
    `  receipts ${seqLabel(data.first.seq)}–${seqLabel(data.head.seq)}, ${n(data.checkpoints.length)} sealed checkpoints`,
    '  sealed manifest: 7 files, counts and last hash match',
    `  organisation: ${data.org.name}`,
    `  key fingerprint: ${data.org.keyFingerprint} (supplied)`,
    '$ echo $?',
    '0',
  ].join('\n');
  return (
    <Panel title="How an auditor verifies it">
      <ol className="list-decimal pl-5 space-y-1.5 text-sm text-muted mb-4">
        <li>Receive the {l2 ? 'bundle' : 'pack'}, and the fingerprint by a separate channel.</li>
        <li>Run the open verifier on their own machine — no account, no network.</li>
        <li>Read the {l2 ? 'result code, the nine-section report' : 'exit code'} and the first broken receipt, if any.</li>
      </ol>
      {loading ? <Skeleton className="h-40" /> : cli ? <CodeBlock title="Terminal · what an intact run prints" code={cli} wrap /> : <p className="text-sm text-muted">There is nothing to verify until the first receipt is written.</p>}
      {l2 ? (
        <dl className="mt-4 border border-line divide-y divide-line text-sm">
          {SIX.map((r) => (
            <div key={r.code} className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 px-3 py-2">
              <dt className="font-mono font-semibold">{EXIT_CODES[r.code]}</dt>
              <dd className="min-w-0"><span className="font-mono text-[12px] font-medium break-all">{r.code}</span> <span className="text-muted">— {r.detail}</span></dd>
            </div>
          ))}
        </dl>
      ) : (
        <>
          <dl className="mt-4 border border-line divide-y divide-line text-sm">
            {[['0', 'PASS_L1_INTERNAL', 'Intact. L1: internal evidence only — sealed in a hash chain, not externally timestamped.'], ['0', 'PASS_KEY_FROM_BUNDLE', 'Intact, but no fingerprint was supplied, so the key came from the pack itself.'], ['1', 'FAIL_INTEGRITY', 'Names the first broken receipt, an edited manifest or a cut-off tail.'], ['3', 'INCOMPLETE', 'Something needed is missing: a file, a key, or the manifest seal on a pack made from 28 October 2026. Neither a pass nor a fail.'], ['5', 'USAGE', 'Not a pack, or wrong arguments.']].map(([c, l, d]) => (
              <div key={l}className="flex items-baseline gap-3 px-3 py-2"><dt className="font-mono font-semibold w-6">{c}</dt><dd><span className="font-medium">{l}</span> <span className="text-muted">— {d}</span></dd></div>
            ))}
          </dl>
          <PlanUpsell to="l2" what="From L2 the verifier reports six result codes and a nine-section report." className="mt-2" />
        </>
      )}
      <Button className="mt-4" size="sm" variant="secondary" icon={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => nav('/verify')}>Verify a file in the browser</Button>
    </Panel>
  );
}

function LimitsPanel({ level }: { level: LevelId }) {
  const items: [string, string][] = [
    level === 'l1'
      ? ['The pack carries its own key.', 'A fabricated pack with its own key would also verify — unless the auditor passes --key or compares the fingerprint published out of band.']
      : ['The bundle carries its own key.', 'Without --fingerprint the best result is PASS_KEY_FROM_BUNDLE. The auditor should compare the fingerprint you published out of band.'],
  ];
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  if (level === 'l1') items.push(['The key-holder is Elan1 Govern.', 'Receipts are sealed in a hash chain by Elan1 Govern and are not yet externally timestamped. The key-holder could re-seal a rewritten chain; external timestamps (from L2) close that gap.']);
  if (level === 'l2') items.push(['The key is in AWS KMS, operated by elan1.', 'elan1 could ask KMS to sign a new record, but cannot back-date one: two authorities fixed the time of every batch. Records before the L2 boundary are L1, where that gap remains.']);
  if (level === 'l3') items.push(['The key is in your HSM.', 'Elan1 Govern can ask your HSM to sign but cannot sign without it. Records before your L3 boundary were signed with a key elan1 held in AWS KMS.']);
  if (level === 'sovereign') items.push(['Your own two timestamp authorities.', 'Timestamps are as independent as the two authorities you run. Give auditors their certificates, or add an external authority for batches you will share outside the bank.']);
  if (level !== 'l1') items.push(['The newest records wait up to 15 minutes.', 'Until their batch is timestamped, a run reports PASS_UNANCHORED_TAIL and says how many records are waiting.']);
  return (
    <Panel title={level === 'l1' ? '2 honest limits' : `${items.length} honest limits`} tone="sunken">
      <ol className="space-y-3 text-sm leading-relaxed">
        {items.map(([t, d]) => <li key={t}><span className="font-semibold">{t}</span> <span className="text-muted">{d}</span></li>)}
      </ol>
      {level !== 'l1' && <p className="mt-3 text-xs text-muted leading-relaxed">{VERIFY_LIMITS.replace(/\s*Draft — needs legal review\.?$/, '')}</p>}
      <div className="mt-3"><LegalDraft /></div>
    </Panel>
  );
}

/* ── Exports ───────────────────────────────────────────────── */

function ExportsPanel({ rows, loading, canExport, onNew }: { rows?: ExportRow[]; loading: boolean; canExport: boolean; onNew: () => void }) {
  const orgId = useOrgId();
  const level = useOrgLevel();
  // the Data tab of Exports is for owners and admins, Webhooks for settings.integrations (not auditors): ExportsPage
  const access = useScreenAccess();
  const canIntegrations = access.isStaff && access.can('settings.integrations');
  const seqs = useMemo(() => new Map((rows ?? []).map((r) => [r.id, exportReceiptSeq(orgId, r)])), [rows, orgId]);
  const cols: Column<ExportRow>[] = [
    { key: 'ts', header: 'Exported', cell: (x) => <When iso={x.ts} className="text-sm" />, sort: (x) => x.ts },
    { key: 'by', header: 'By', cell: (x) => <Person id={x.by} size={20} /> },
    { key: 'format', header: 'Format', cell: (x) => x.format === 'elan1.evidence.bundle.v1' ? <Badge tone="inverse">Evidence bundle · 8</Badge> : <Badge>Auditor pack</Badge>, hideBelow: 'sm' },
    { key: 'profile', header: 'Profile', cell: (x) => x.profileId ? <SmartLink className="font-mono text-[12px] hover:underline" plainClassName="font-mono text-[12px]" to={`/assurance/profiles?id=${x.profileId}`}>{x.profileId}</SmartLink> : <span className="text-subtle">—</span>, hideBelow: 'lg' },
    { key: 'range', header: 'Range', cell: (x) => <span className="font-mono text-[12px] whitespace-nowrap">{seqLabel(x.firstSeq)}–{seqLabel(x.lastSeq)}</span>, hideBelow: 'md' },
    { key: 'receipts', header: 'Receipts', align: 'right', cell: (x) => n(x.receipts) },
    { key: 'size', header: 'Size', align: 'right', cell: (x) => `${n(x.sizeKb)} KB`, hideBelow: 'md' },
    { key: 'receipt', header: 'Recorded as', cell: (x) => { const s = seqs.get(x.id); return s && 'seq' in s ? <ReceiptLink seq={s.seq} /> : s && 'beforeWindow' in s ? <span className="text-xs text-muted" title={`Exported ${dateTime(x.ts)}, before the first receipt this console holds.`}>Before this window</span> : <span className="text-subtle">—</span>; }, hideBelow: 'sm' },
  ];
  return (
    <Panel title={atLeast(level, 'l2') ? 'Evidence exports' : 'Auditor packs'} kicker="Every export is itself a receipt" flush
      actions={canExport ? <Button size="sm" variant="primary" icon={<PackageOpen className="h-3.5 w-3.5" />} onClick={onNew}>New export</Button> : undefined}
      footer={canIntegrations ? <span>Data retention and webhooks for exports are in the Assurance door, under <SmartLink className="underline underline-offset-2" to="/assurance/exports">Exports</SmartLink>.</span> : undefined}>
      <DataTable caption="Exports" className="border-0" columns={cols} rows={rows} loading={loading} rowKey={(x) => x.id}
        empty={<EmptyState compact title="Nothing exported yet" disc="trail" action={canExport ? <Button size="sm" icon={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={onNew}>Export the first one</Button> : undefined}>{atLeast(level, 'l2') ? 'An evidence bundle holds 8 members an auditor verifies offline.' : 'An auditor pack bundles receipts, checkpoints and keys for offline verification.'}</EmptyState>} />
    </Panel>
  );
}
