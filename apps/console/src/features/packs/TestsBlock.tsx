import { useState } from 'react';
import { BookOpenCheck, CheckCircle2, CircleDashed, CircleSlash, FlaskConical, XCircle } from 'lucide-react';
import type { PackId } from '@/types';
import { api } from '@/api';
import { useOrgId, useRole, useUser } from '@/store/session';
import { userName } from '@/mock/users';
import type { PackTestResult, PackTestRun } from '@/mock/packsFactory';
import { REFUSAL_CODES, RUNGS } from '@/mock/devpathData';
import { PACK_FIXTURE_REFUSALS } from '@/lib/packs';
import { Button, StatusChip, Tooltip, toast } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { BlockPanel } from './blocks';
import { FormDialog } from './FormDialog';

export function TestChip({ state }: { state: PackTestResult['state'] }) {
  if (state === 'pass') return <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Pass</StatusChip>;
  if (state === 'fail') return <StatusChip size="sm" tone="bad" icon={<XCircle className="h-3 w-3" aria-hidden />}>Fail</StatusChip>;
  if (state === 'not_run') return <StatusChip size="sm" tone="held" icon={<CircleDashed className="h-3 w-3" aria-hidden />}>Not run</StatusChip>;
  return <StatusChip size="sm" tone="neutral" icon={<CircleSlash className="h-3 w-3" aria-hidden />}>Not applicable</StatusChip>;
}

/** Block 10: T1–T8. T5–T7 run the verifier on bundles built from this chain; T3 and T8 are human acts recorded as receipts. */
export function TestsBlock({ packId, installed, tests, lastRun, auditorName }: { packId: PackId; installed: boolean; tests: PackTestResult[]; lastRun?: PackTestRun; auditorName?: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  // the client's own people record these; an auditor's writes on the client's chain are limited to the J9 pilot steps
  const canRun = role === 'owner' || role === 'admin';
  const passed = tests.filter((t) => t.state === 'pass').length;
  const ships = tests.every((t) => t.state === 'pass' || t.state === 'not_applicable');

  const go = async () => {
    if (!user) return;
    setBusy(true);
    try {
      const r = await api.runPackTests(orgId, packId, user.id);
      const failed = r.results.filter((x) => x.state === 'fail');
      if (failed.length) toast.held(`${packId}: ${failed.length} of 8 tests fail`, `${failed.map((x) => x.id).join(', ')}. Receipt #${r.seq}.`);
      else toast.ok(`${packId}: no test fails`, `${r.results.filter((x) => x.state === 'pass').length} pass. Receipt #${r.seq}.`);
    } catch (e) {
      toast.bad('The tests could not run', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BlockPanel id="tests" flush title={`Tests T1–T8 · ${passed} of 8 pass`}
      // owners and admins record and run the tests; other roles read the results
      actions={canRun ? (
        <>
          <Tooltip content={!installed ? 'Install the pack first' : 'Record what the named auditor said the report does not prove (T8)'}>
            <Button size="sm" variant="ghost" icon={<BookOpenCheck className="h-3.5 w-3.5" />} disabled={!installed} onClick={() => setReading(true)}>Auditor’s reading</Button>
          </Tooltip>
          <Tooltip content={!installed ? 'Install the pack first' : 'Evaluate T1–T8 now; T5–T7 verify bundles from this chain offline, in this browser. Recorded.'}>
            <Button size="sm" variant="secondary" icon={<FlaskConical className="h-3.5 w-3.5" />} loading={busy} disabled={!installed} onClick={go}>Run the tests</Button>
          </Tooltip>
        </>
      ) : undefined}
      footer={<>{ships ? 'Every applicable test passes: the pack may ship.' : 'A pack passes all eight before it ships.'} {lastRun ? <>Last run <When iso={lastRun.at} /> by {userName(lastRun.by)}{lastRun.seq !== undefined && <> · <ReceiptLink seq={lastRun.seq} /></>}.</> : 'Not yet run in this organisation.'}</>}>
      <ul className="divide-y divide-line">
        {tests.map((t) => (
          <li key={t.id} className="px-5 py-3 grid gap-x-4 gap-y-1 sm:grid-cols-[56px_1fr_auto] items-start">
            <span className="font-mono text-[13px] font-semibold">{t.id}</span>
            <span className="min-w-0">
              <span className="text-sm font-medium">{t.title}</span>
              <span className="block text-xs text-muted mt-0.5">Passes when: {t.passesWhen}</span>
              <span className="block text-sm mt-1">{t.detail}</span>
              {t.id === 'T4' && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-muted hover:text-fg">The {PACK_FIXTURE_REFUSALS[packId].length} reference refusals</summary>
                  <ul className="mt-2 border border-line divide-y divide-line">
                    {PACK_FIXTURE_REFUSALS[packId].map((x) => {
                      const reg = REFUSAL_CODES.find((c) => c.wire === x.code);
                      return (
                        <li key={x.gate} className="px-3 py-2 grid gap-x-3 gap-y-0.5 sm:grid-cols-[40px_1fr]">
                          <span className="font-mono text-muted">{x.gate}</span>
                          <span className="min-w-0">
                            <span className="font-mono">{x.code}</span>{reg ? <span className="text-muted"> · {reg.ref} · rung {RUNGS[reg.rung].n}, {RUNGS[reg.rung].name.toLowerCase()}</span> : <span className="text-bad-fg"> · not in the refusal register</span>}
                            <span className="block text-muted">{x.operatorAction}</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}
            </span>
            <TestChip state={t.state} />
          </li>
        ))}
      </ul>
      <FormDialog open={reading} onClose={() => setReading(false)} title="Record the auditor’s reading (T8)"
        description="The named auditor reads a report unprompted and says what it does not prove. If they cannot, the limits statement is wrong."
        fields={[
          { id: 'auditor', kind: 'text', label: 'Auditor', initial: auditorName ?? '', min: 3 },
          { id: 'statement', kind: 'textarea', label: 'What the auditor said the report does not prove, in their words', min: 60, rows: 5 },
        ]}
        submitLabel="Record the reading"
        onSubmit={async (v) => {
          if (!user) return;
          await api.recordAuditorReading(orgId, packId, user.id, { auditor: String(v.auditor), statement: String(v.statement) });
          toast.ok('Reading recorded', 'T8 now passes. The reading is a receipt.');
        }} />
    </BlockPanel>
  );
}
