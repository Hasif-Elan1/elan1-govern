import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CheckCircle2, Circle, CircleDot, CircleSlash, Flag, OctagonX, Play, Square } from 'lucide-react';
import type { PackId, RegulatoryPack } from '@/types';
import { api } from '@/api';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { date, n, plural } from '@/lib/format';
import { userName } from '@/mock/users';
import type { PilotView, earlierPilots } from '@/mock/packsFactory';
import { Badge, Banner, Button, KeyValue, StatusChip, Tooltip, toast } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { ExportPackDialog, type ExportedSummary } from '@/features/evidence/ExportPackDialog';
import { cn } from '@/lib/cn';
import { BlockPanel } from './blocks';
import { FormDialog, type FormField } from './FormDialog';
import { AirGapDialog } from './AirGapDialog';
import { OUTCOME_LABEL, PilotHistory } from './PilotHistory';

type DialogKind = 'start' | 'necessity' | 'export' | 'export-record' | 'airgap' | 'verdict' | 'gd' | 'stop';
type Step = PilotView['steps'][number];

/** Block 11: the 90-day pilot — one customer, one auditor, day 0 to day 85. Starts at L1; every step is a receipt. */
export function PilotBlock({ pack, pilot, earlier = [], onReconcile }: { pack: RegulatoryPack; pilot?: PilotView; earlier?: ReturnType<typeof earlierPilots>; onReconcile: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const level = useOrgLevel();
  const [dialog, setDialog] = useState<DialogKind>();
  // the self-export goes through the guarded export dialog; the pilot then records it with the help that was needed
  const [selfExport, setSelfExport] = useState<ExportedSummary>();
  const manager = role === 'owner' || role === 'admin';
  const auditorish = manager || role === 'auditor';
  const running = pilot?.status === 'running';
  const stepOf = (id: Step['id']) => pilot?.steps.find((s) => s.id === id);
  // a step whose planned day has not come is recorded only with the reason, and is marked early
  const earlyField = (id: Step['id']): FormField[] => {
    const s = stepOf(id);
    return s?.notYet ? [{ id: 'early', kind: 'textarea', label: `Why it is recorded before day ${s.day} (this is day ${pilot?.day ?? 0})`, hint: 'Kept with the step, which is marked early, and on the receipt.', min: 12, rows: 2 }] : [];
  };
  const earlyOf = (v: Record<string, string | boolean>) => (v.early ? String(v.early) : undefined);
  const lbl = (s: Step, text: string) => (s.notYet ? `${text} early` : text);

  // a step this role cannot record shows who it waits for, never a greyed-out button
  const waiting = (text: string) => <StatusChip size="sm" tone="neutral">{text}</StatusChip>;
  const action = (s: Step) => {
    if (!pilot || !running) return null;
    switch (s.id) {
      case 'necessity': return auditorish ? <Button size="sm" variant="primary" onClick={() => setDialog('necessity')}>Record the statement</Button> : waiting('Waiting for the auditor');
      // moving the organisation to L2 is a plan change: owners only
      case 'boundary': return role === 'owner'
        ? <Link to="/assurance/upgrade?to=l2" className="inline-flex items-center gap-1.5 h-8 px-3 text-sm font-medium border border-line-strong/70 hover:border-fg">Move to {LEVEL_INFO.l2.label}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
        : waiting('Waiting for an owner');
      case 'operation': return <span className="text-xs text-muted">Day {Math.min(pilot.day, 75)} of 75 · refusals stay as they fall</span>;
      case 'self_export': return !manager ? waiting('Waiting for the customer') : !atLeast(level, 'l2') ? waiting(`After the move to ${LEVEL_INFO.l2.short}`) : (
        <Tooltip content={s.notYet ? `Planned for day ${s.day}: exporting now is recorded early, with the reason` : 'Export the evidence bundle claiming this pack’s profile, and record whether help was needed'}>
          <Button size="sm" variant={s.notYet ? 'secondary' : 'primary'} onClick={() => setDialog('export')}>{lbl(s, 'Export the bundle')}</Button>
        </Tooltip>
      );
      case 'air_gap': return !auditorish ? waiting('Waiting for the auditor') : (
        <Tooltip content="Load the bundle the customer exported on day 76 and verify it, then a tampered copy of it">
          <Button size="sm" variant={s.notYet ? 'secondary' : 'primary'} icon={<Play className="h-3.5 w-3.5" />} onClick={() => setDialog('airgap')}>{lbl(s, 'Run the verifier offline')}</Button>
        </Tooltip>
      );
      // the reconciliation is run and explained by the customer's owners and admins (ReconcilePanel); auditors read its result
      case 'reconcile': return !manager ? waiting('Waiting for the customer') : <Button size="sm" variant={s.notYet ? 'secondary' : 'primary'} title={s.notYet ? `Planned for day ${s.day}; a run now is marked early` : undefined} onClick={onReconcile}>{lbl(s, 'Reconcile')}</Button>;
      case 'verdict': return !auditorish ? waiting('Waiting for the auditor') : <Button size="sm" variant={s.notYet ? 'secondary' : 'primary'} onClick={() => setDialog('verdict')}>{lbl(s, 'Record the verdict')}</Button>;
      case 'gd': return role !== 'owner' ? waiting('Waiting for the owner') : <Tooltip content="Ask the buyer and record the answer; it closes the pilot and scores G-D"><Button size="sm" variant={s.notYet ? 'secondary' : 'primary'} onClick={() => setDialog('gd')}>{lbl(s, 'Record the answer')}</Button></Tooltip>;
      default: return null;
    }
  };

  const detail = (s: PilotView['steps'][number]) => {
    if (!pilot) return null;
    switch (s.id) {
      case 'necessity': return pilot.necessity && (
        <div className="mt-2 text-sm space-y-2">
          <ol className="list-decimal pl-5 space-y-0.5">{pilot.necessity.questions.map((q) => <li key={q}>{q}</li>)}</ol>
          <p className="text-muted">“{pilot.necessity.statement}”</p>
          {pilot.necessity.notMeasurable.length > 0 && <p className="text-xs"><Badge tone="held">{plural(pilot.necessity.notMeasurable.length, 'not_measurable row')}</Badge> <span className="text-muted">added to the profile: {pilot.necessity.notMeasurable.map((x) => x.clause).join('; ')}.</span></p>}
        </div>
      );
      case 'boundary': return pilot.boundary && pilot.boundary.state === 'done'
        ? <p className="mt-1 text-sm text-muted">Boundary {date(pilot.boundary.at)}: <span className="num">{n(pilot.boundary.before)}</span> records before (L1, sealed in a hash chain), <span className="num">{n(pilot.boundary.after)}</span> after (L2, signed and timestamped). Shown to the customer and the auditor the same day.</p>
        : s.state === 'not_needed' ? <p className="mt-1 text-sm text-muted">Not needed: the pilot started at {LEVEL_INFO[pilot.startLevel].label}.</p>
        : <p className="mt-1 text-sm text-muted">The organisation is at {LEVEL_INFO[level].label}. The pilot runs as a dry run until the move to {LEVEL_INFO.l2.label}.</p>;
      case 'self_export': return pilot.selfExport && <p className="mt-1 text-sm text-muted">{n(pilot.selfExport.receipts)} records{pilot.selfExport.exportSeq !== undefined && <> · export <ReceiptLink seq={pilot.selfExport.exportSeq} /></>} · {pilot.selfExport.help ? <span className="text-held-fg">help was needed — {pilot.selfExport.note}</span> : 'no help needed'}.</p>;
      case 'air_gap': return pilot.airGap && <p className="mt-1 text-sm text-muted">The customer’s bundle{pilot.airGap.exportSeq !== undefined && <> (export <ReceiptLink seq={pilot.airGap.exportSeq} />{pilot.airGap.records !== undefined ? `, ${n(pilot.airGap.records)} records` : ''}{pilot.airGap.bundleDigest ? <>, digest <span className="font-mono">{pilot.airGap.bundleDigest.slice(0, 16)}</span></> : null})</>}: <span className="font-mono">exit {pilot.airGap.goodExit} {pilot.airGap.goodCode}</span>. Its tampered copy ({pilot.airGap.tamperedAt}): <span className="font-mono">exit {pilot.airGap.tamperedExit} {pilot.airGap.tamperedCode}</span>.</p>;
      case 'reconcile': return pilot.reconciliation && <p className="mt-1 text-sm text-muted">{n(pilot.reconciliation.matched)} matched · <span className={pilot.reconciliation.targetOnly.length ? 'text-held-fg' : ''}>{plural(pilot.reconciliation.targetOnly.length, 'change')} in {pilot.reconciliation.target.split(' — ')[0]} with no record</span> · {plural(pilot.reconciliation.chainOnly.length, 'record')} with no change in the target.</p>;
      case 'verdict': return pilot.verdict && <div className="mt-2 text-sm"><p><Badge tone={pilot.verdict.outcome === 'does_not_rely' ? 'bad' : pilot.verdict.outcome === 'relies' ? 'ok' : 'held'}>{OUTCOME_LABEL[pilot.verdict.outcome]}</Badge> <span className="text-muted">— {pilot.verdict.auditor}, verbatim:</span></p><blockquote className="mt-1 border-l-2 border-line-strong pl-3 text-muted">{pilot.verdict.words}</blockquote></div>;
      case 'gd': return pilot.gd && <p className="mt-1 text-sm"><Badge tone={pilot.gd.answer === 'yes' ? 'ok' : 'bad'}>{pilot.gd.answer === 'yes' ? 'Yes' : 'No'}</Badge> <span className="text-muted">“{pilot.gd.note}” — G-D is {pilot.gd.answer === 'yes' ? 'met' : 'not met; the pack returns to the portfolio register'}.</span></p>;
      default: return null;
    }
  };

  return (
    <BlockPanel id="pilot" flush
      title={pilot ? `Pilot · day ${Math.min(pilot.day, 90)} of 90` : 'Pilot'}
      actions={!manager ? undefined : !pilot || pilot.status !== 'running' ? (
        <Tooltip content={!pack.installed ? `Install ${pack.name} first — at L1 it installs as a dry run and the pilot starts there` : pilot ? 'One customer, one auditor, ninety days. This pilot stays on the page with its verdict and G-D answer.' : 'One customer, one auditor, ninety days'}>
          <Button size="sm" variant={pilot ? 'secondary' : 'primary'} icon={<Flag className="h-3.5 w-3.5" />} disabled={!pack.installed} onClick={() => setDialog('start')}>{pilot ? 'Start a new pilot' : 'Start the pilot'}</Button>
        </Tooltip>
      ) : <Button size="sm" variant="ghost" icon={<Square className="h-3.5 w-3.5" />} onClick={() => setDialog('stop')}>Stop the pilot</Button>}>
      {!pilot ? (
        <div className="px-5 py-4 text-sm space-y-2">
          <p>One customer, one auditor, ninety days, to find out whether G-D is real. It starts at {LEVEL_INFO.l1.label} with the auditor’s half day; on day 1 the organisation moves to {LEVEL_INFO.l2.label}; on day 76 the customer exports the bundle without help; on day 85 the buyer is asked whether they would pay for it on its own line.</p>
          <p className="text-muted">No pilot has been run for {pack.name} in this organisation.</p>
        </div>
      ) : (
        <>
          <div className="px-5 py-4 border-b border-line">
            {pilot.status === 'stopped' && <Banner tone="bad" className="mb-3" title="Stopped">{pilot.stoppedReason}</Banner>}
            {pilot.status === 'closed' && <Banner tone={pilot.gd?.answer === 'yes' ? 'ok' : 'held'} className="mb-3" title={`Closed on day ${pilot.gd ? Math.floor((new Date(pilot.gd.at).getTime() - new Date(pilot.startedAt).getTime()) / 86_400_000) : '—'}`}>The answer to the G-D question scores G-D in block 4. A new pilot keeps this one, its verdict and its answer on the page; G-D keeps this answer until the new pilot gives one.</Banner>}
            {pilot.status === 'running' && pilot.startLevel === 'l1' && pack.installedAt && new Date(pack.installedAt).getTime() <= new Date(pilot.startedAt).getTime() && (
              <p className="mb-3 text-xs text-muted">Started at {LEVEL_INFO.l1.label} on the dry-run install of {date(pack.installedAt)}; billed from the move to {LEVEL_INFO.l2.label}.</p>
            )}
            <KeyValue cols={2} items={[
              { k: 'Customer', v: pilot.customer },
              { k: 'Auditor', v: `${pilot.auditor.name}, ${pilot.auditor.firm}` },
              { k: 'Day 0', v: <>{date(pilot.startedAt)}{pilot.startSeq !== undefined && <> · <ReceiptLink seq={pilot.startSeq} /></>}</> },
              { k: 'Started at', v: <>{LEVEL_INFO[pilot.startLevel].label}{pilot.startLevel === 'l1' ? ' · dry-run install' : ''}</> },
              ...(pack.installedAt ? [{ k: 'Pack installed', v: date(pack.installedAt) }] : []),
              { k: 'Started by', v: userName(pilot.startedBy) },
              { k: 'Status', v: pilot.status === 'running' ? `Running · day ${pilot.day}` : pilot.status === 'closed' ? 'Closed' : 'Stopped' },
            ]} />
          </div>
          <ol className="divide-y divide-line">
            {pilot.steps.map((s) => (
              <li key={s.id} className={cn('px-5 py-3 grid gap-x-4 gap-y-1 sm:grid-cols-[64px_1fr_auto] items-start', s.state === 'open' && 'bg-sunken/40')}>
                <span className="text-sm"><span className="label block">Day</span><span className="num font-semibold">{s.id === 'operation' ? '2–75' : s.day}</span></span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {s.state === 'done' ? <CheckCircle2 className="h-4 w-4 text-ok-fg" aria-hidden /> : s.state === 'open' ? <CircleDot className="h-4 w-4 text-held-fg" aria-hidden /> : s.state === 'not_needed' ? <CircleSlash className="h-4 w-4 text-subtle" aria-hidden /> : <Circle className="h-4 w-4 text-subtle" aria-hidden />}
                    {s.title}
                  </span>
                  <span className="block text-xs text-muted mt-0.5">{s.what} Planned {date(s.plannedAt)}{s.id !== 'operation' && s.id !== 'boundary' ? ` (day ${s.day})` : ''}.{s.doneAt && <> Done <When iso={s.doneAt} />{s.seq !== undefined && <> · <ReceiptLink seq={s.seq} /></>}.</>}{s.notYet && <> Its day has not come: this is day {pilot.day}.</>}</span>
                  {s.early && <span className="mt-1 flex flex-wrap items-center gap-2 text-xs"><Badge tone="held">Early</Badge><span className="text-held-fg">Recorded on day {s.early.day}, planned for day {s.day}{s.early.reason ? ` — “${s.early.reason}”` : ''}.</span></span>}
                  {detail(s)}
                </span>
                <span className="sm:text-right">{s.state === 'done' ? <StatusChip size="sm" tone={s.early ? 'held' : 'ok'}>{s.early ? 'Done early' : 'Done'}</StatusChip> : s.state === 'not_needed' ? <StatusChip size="sm" tone="neutral">Not needed</StatusChip> : s.state === 'open' ? action(s) : <StatusChip size="sm" tone="neutral">Waiting</StatusChip>}</span>
              </li>
            ))}
          </ol>
          {pilot.status === 'stopped' && <p className="px-5 py-3 border-t border-line text-xs text-bad-fg inline-flex items-center gap-1.5"><OctagonX className="h-3.5 w-3.5" aria-hidden />A FAIL_INTEGRITY during the pilot is a P0.</p>}
        </>
      )}
      <PilotHistory pilots={earlier} />
      {pilot && <AirGapDialog open={dialog === 'airgap'} onClose={() => setDialog(undefined)} packId={pack.id} pilot={pilot} early={stepOf('air_gap')?.notYet ? { day: pilot.day } : undefined} />}

      <FormDialog open={dialog === 'start'} onClose={() => setDialog(undefined)} title={`Start the ${pack.name} pilot`}
        description={`Day 0 is today. ${atLeast(level, 'l2') ? `The organisation is already at ${LEVEL_INFO[level].label}, so the day-1 upgrade is not needed.` : `The organisation is at ${LEVEL_INFO.l1.label}: the pilot starts here as a dry run and day 1 is the move to ${LEVEL_INFO.l2.label}.`}${pilot ? ` The ${pilot.status} pilot that started ${date(pilot.startedAt)} is kept below with its timeline${pilot.gd ? `, verdict and G-D answer; G-D keeps that answer until this pilot gives one` : ''}.` : ''}`}
        fields={[
          { id: 'auditorName', kind: 'text', label: 'The named auditor', placeholder: 'Kavita Desai', min: 3 },
          { id: 'auditorFirm', kind: 'text', label: 'Their firm', placeholder: 'Desai & Rao, Chartered Accountants', min: 3 },
        ]}
        submitLabel="Start the pilot"
        onSubmit={async (v) => {
          if (!user) return;
          await api.startPilot(orgId, pack.id, user.id, { auditorName: String(v.auditorName), auditorFirm: String(v.auditorFirm) });
          toast.ok(`${pack.name} pilot started`, 'Day 0: the auditor’s half day comes first, before anything is shown.');
        }} />

      <FormDialog open={dialog === 'necessity'} onClose={() => setDialog(undefined)} title="Day 0 · the auditor’s necessity statement"
        description="Taken before anything is shown. Anything the profile cannot bind becomes a not_measurable row, never an omission."
        fields={[
          { id: 'q1', kind: 'text', label: 'Question 1 the auditor would ask', min: 10 },
          { id: 'q2', kind: 'text', label: 'Question 2', min: 10 },
          { id: 'q3', kind: 'text', label: 'Question 3', min: 10 },
          { id: 'statement', kind: 'textarea', label: 'What they would need to rely on a record like this', min: 40 },
          { id: 'nm1c', kind: 'text', label: 'A need the profile cannot bind (optional)', hint: 'Becomes a not_measurable row on the profile.' },
          { id: 'nm1r', kind: 'text', label: 'Why it cannot be measured' },
          { id: 'nm1w', kind: 'text', label: 'What would change that' },
        ]}
        submitLabel="Record the statement"
        onSubmit={async (v) => {
          if (!user) return;
          const rows = String(v.nm1c ?? '').trim() ? [{ clause: String(v.nm1c), reason: String(v.nm1r ?? ''), wouldChangeIf: String(v.nm1w ?? '') }] : [];
          await api.recordPilotNecessity(orgId, pack.id, user.id, { questions: [String(v.q1), String(v.q2), String(v.q3)], statement: String(v.statement), notMeasurable: rows });
          toast.ok('Necessity statement recorded', rows.length ? 'Its not_measurable row is now on the profile.' : 'Kept as written.');
        }} />

      <ExportPackDialog open={dialog === 'export'} onClose={() => setDialog(selfExport ? 'export-record' : undefined)} initialProfile={pack.profileId}
        title="Day 76 · the customer exports the bundle"
        note={<p>An 8-member evidence bundle of the whole chain, claiming {pack.profileId}. It passes the same checks as any export, is saved to this computer as a ZIP, recorded, and billed like any L2 bundle. Then the pilot records whether you needed help.</p>}
        onExported={(r) => setSelfExport(r)} />

      <FormDialog open={dialog === 'export-record'} onClose={() => { setDialog(undefined); setSelfExport(undefined); }} title="Day 76 · record the self-export"
        description={selfExport ? `${plural(selfExport.receipts, 'record')} exported${selfExport.parts > 1 ? ` in ${selfExport.parts} parts` : ''} and recorded on the chain. Now record for the pilot whether help was needed.` : 'Export the bundle first.'}
        fields={[
          { id: 'help', kind: 'checkbox', label: 'We needed help to do this', hint: 'Needing help is the finding — record it honestly.' },
          { id: 'note', kind: 'textarea', label: 'What help was needed (if any)', rows: 3 },
          ...earlyField('self_export'),
        ]}
        submitLabel="Record the self-export"
        onSubmit={async (v) => {
          if (!user || !selfExport) return;
          await api.recordPilotSelfExport(orgId, pack.id, user.id, { exportSeq: selfExport.seq ?? 0, receipts: selfExport.receipts, firstSeq: selfExport.firstSeq, lastSeq: selfExport.lastSeq, help: !!v.help, note: String(v.note ?? ''), early: earlyOf(v) });
          setSelfExport(undefined);
          toast.ok('Self-export recorded', `${n(selfExport.receipts)} records. Day 77: the auditor loads that file and runs the verifier offline.`);
        }} />

      <FormDialog open={dialog === 'verdict'} onClose={() => setDialog(undefined)} title="Day 80 · the auditor’s written verdict"
        description="In the auditor’s words, kept verbatim — including if it is unflattering."
        fields={[
          { id: 'auditor', kind: 'text', label: 'Auditor', initial: pilot?.auditor.name ?? '', min: 3 },
          { id: 'outcome', kind: 'select', label: 'Outcome', options: Object.entries(OUTCOME_LABEL).map(([value, label]) => ({ value, label })) },
          { id: 'words', kind: 'textarea', label: 'The verdict, verbatim', min: 40, rows: 6 },
          ...earlyField('verdict'),
        ]}
        submitLabel="Record the verdict"
        onSubmit={async (v) => {
          if (!user) return;
          await api.recordPilotVerdict(orgId, pack.id, user.id, { auditor: String(v.auditor), outcome: String(v.outcome) as keyof typeof OUTCOME_LABEL, words: String(v.words), early: earlyOf(v) });
          toast.ok('Verdict recorded', 'Day 85: ask the buyer the G-D question.');
        }} />

      <FormDialog open={dialog === 'gd'} onClose={() => setDialog(undefined)} title="Day 85 · would you pay for this on its own line?"
        description="The buyer’s answer closes the pilot and scores G-D. No endorsement, logo or quotation is asked for."
        fields={[
          { id: 'answer', kind: 'select', label: 'Answer', options: [{ value: 'yes', label: 'Yes — on its own line' }, { value: 'no', label: 'No' }] },
          { id: 'note', kind: 'textarea', label: 'In the buyer’s words', min: 12, rows: 3 },
          ...earlyField('gd'),
        ]}
        submitLabel="Record and close the pilot"
        onSubmit={async (v) => {
          if (!user) return;
          const r = await api.recordPilotGd(orgId, pack.id, user.id, { answer: String(v.answer) as 'yes' | 'no', note: String(v.note), early: earlyOf(v) });
          toast[r.gd?.answer === 'yes' ? 'ok' : 'held'](r.gd?.answer === 'yes' ? 'G-D met — pilot closed' : 'G-D not met — the pack returns to the register', 'The answer is a receipt.');
        }} />

      <FormDialog open={dialog === 'stop'} onClose={() => setDialog(undefined)} title={`Stop the ${pack.name} pilot`} tone="danger"
        description="The pilot ends without an answer to G-D. The stop is recorded with the reason."
        fields={[{ id: 'reason', kind: 'textarea', label: 'Why it stops', min: 12, rows: 3 }]}
        submitLabel="Stop the pilot"
        onSubmit={async (v) => {
          if (!user) return;
          await api.stopPilot(orgId, pack.id as PackId, user.id, String(v.reason));
          toast.held('Pilot stopped', 'The reason is on the chain.');
        }} />
    </BlockPanel>
  );
}
