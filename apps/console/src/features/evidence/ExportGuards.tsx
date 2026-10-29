/**
 * The guards an L2+ export passes before it leaves the console:
 *  - size: a range over the limit for one bundle is split into parts, each verifiable on its own;
 *  - range problems: a break in the chain, no completed integrity run over the range ("Run the integrity check now"),
 *    or an unanchored tail, with "export the clean range instead";
 *  - the residency, retention and consent gate, naming any missing declarations;
 *  - "Verify it yourself first": the exact bundle is built (nothing written) and verified in this browser.
 * L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
 */
import type { ReactNode } from 'react';
import { CheckCircle2, CircleSlash, Info, OctagonX, ScanSearch, Scissors, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { VerifyBundleResult } from '@/lib/verify6';
import type { MissingDeclaration } from '@/mock/evidence';
import { n, plural, rupees, seqLabel } from '@/lib/format';
import { Button, Checkbox, Field, Select, Spinner, StatusChip } from '@/components/ui';
import { cn } from '@/lib/cn';

// the size and range rules live with the export itself (mock/evidenceGuards.ts), which api.exportPack enforces
import { BUNDLE_LIMIT_KB, type Part } from '@/mock/evidenceGuards';
export { BUNDLE_LIMIT_KB, planParts, firstBreak, type Part } from '@/mock/evidenceGuards';

export interface RangeProblem { id: 'break' | 'tail' | 'preflight' | 'integrity'; title: string; text: string; clean?: { from: number; to: number }; blocking: boolean; action?: { label: string; onClick: () => void; loading?: boolean; disabled?: boolean } }

export const TRANSFER_BASES = [
  'Required by law or by a regulator’s order',
  'Contract with the recipient that keeps the data protected',
  'The data principals consented to the transfer',
];
export const PURPOSES = ['Statutory audit', 'Regulatory inspection or request', 'Legal claim or dispute', 'Internal audit'];

export interface GateState { residency: 'inside' | 'outside'; transferBasis: string; purpose: string; acknowledged: boolean }

/** What still stops the export, in plain words (empty when it can go). */
export function gateBlocks(g: GateState, personal: number, missing: MissingDeclaration[]): string[] {
  const out: string[] = [];
  if (g.residency === 'outside' && !g.transferBasis) out.push('Choose the basis for sending it outside the residency domain.');
  if (personal > 0 && !g.purpose) out.push('Say why records with personal data are being disclosed.');
  if (missing.length && !g.acknowledged) out.push('Acknowledge the missing declarations, or add them first.');
  return out;
}

function Row({ state, title, children }: { state: 'pass' | 'warn' | 'fail' | 'info'; title: ReactNode; children?: ReactNode }) {
  const Icon = state === 'pass' ? CheckCircle2 : state === 'fail' ? OctagonX : state === 'warn' ? TriangleAlert : Info;
  return (
    <li className="flex gap-3 px-4 py-3">
      <Icon className={cn('h-4 w-4 shrink-0 mt-0.5', state === 'pass' && 'text-ok-fg', state === 'fail' && 'text-bad-fg', state === 'warn' && 'text-held-fg', state === 'info' && 'text-muted')} aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{title}<span className="sr-only"> — {state === 'pass' ? 'passes' : state === 'fail' ? 'stops the export' : state === 'warn' ? 'needs attention' : 'information'}</span></p>
        {children && <div className="mt-1 text-muted leading-relaxed">{children}</div>}
      </div>
    </li>
  );
}

/** Size, range problems and the residency, retention and consent gate. */
export function GuardsPanel({ parts, problems, onClean, gate, setGate, residencyDomain, personal, missing, retention, charge }: {
  parts: Part[];
  problems: RangeProblem[];
  onClean: (from: number, to: number) => void;
  gate: GateState;
  setGate: (g: GateState) => void;
  residencyDomain?: string;
  personal: number;
  missing: MissingDeclaration[];
  retention: { years: number; oldest?: string; ok: boolean };
  charge: number;
}) {
  const totalKb = parts.reduce((s, p) => s + p.estKb, 0);
  return (
    <div className="border border-line">
      <p className="label px-4 pt-3">Before it leaves</p>
      <ul className="divide-y divide-line">
        {parts.length > 1 ? (
          <Row state="warn" title={<span className="inline-flex items-center gap-1.5"><Scissors className="h-3.5 w-3.5" aria-hidden />About {n(Math.round(totalKb))} KB — split into {parts.length} bundles</span>}>
            <p>One bundle is kept under {n(BUNDLE_LIMIT_KB)} KB so it travels as an attachment and opens in a browser verifier. Each part has its own signed manifest and verifies on its own; together they cover the range without a gap.</p>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2 font-mono text-[12px] text-fg">
              {parts.map((p) => <li key={p.index}>Part {p.index}: {seqLabel(p.from)}–{seqLabel(p.to)} · {n(p.count)} records · ~{n(Math.round(p.estKb))} KB</li>)}
            </ul>
            <p className="mt-2">{parts.length} bundles × {rupees(2500)} = <span className="text-fg font-medium">{rupees(charge)}</span>, or narrow the range.</p>
          </Row>
        ) : (
          <Row state="pass" title={`About ${n(Math.round(totalKb))} KB — one bundle`}>Under the {n(BUNDLE_LIMIT_KB)} KB limit for one bundle.</Row>
        )}

        {problems.length === 0 ? (
          <Row state="pass" title="No problem in this range">The sequence and hash links are continuous, a completed integrity run covers the range, and every sealed record is in a timestamped batch.</Row>
        ) : problems.map((p) => (
          <Row key={p.id} state={p.blocking ? 'fail' : 'warn'} title={p.title}>
            <p>{p.text}</p>
            <div className="flex flex-wrap gap-2">
              {p.action && (
                <Button size="sm" variant="primary" className="mt-2" icon={<ScanSearch className="h-3.5 w-3.5" />} loading={p.action.loading} disabled={p.action.disabled} onClick={p.action.onClick}>{p.action.label}</Button>
              )}
              {p.clean && p.clean.to >= p.clean.from && (
                <Button size="sm" variant="secondary" className="mt-2" icon={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => onClean(p.clean!.from, p.clean!.to)}>
                  Export the clean range instead ({seqLabel(p.clean.from)}–{seqLabel(p.clean.to)})
                </Button>
              )}
            </div>
          </Row>
        ))}

        <Row state={gate.residency === 'outside' && !gate.transferBasis ? 'fail' : 'pass'} title="Residency">
          <div className="grid gap-3 sm:grid-cols-2 mt-1 [&>*]:min-w-0">
            <Field label="Where will the recipient hold it?" htmlFor="gate-res">
              <Select id="gate-res" value={gate.residency} onChange={(e) => setGate({ ...gate, residency: e.target.value as GateState['residency'] })}>
                <option value="inside">Inside {residencyDomain ?? 'the residency domain'}</option>
                <option value="outside">Outside it</option>
              </Select>
            </Field>
            {gate.residency === 'outside' && (
              <Field label="Basis for the transfer" htmlFor="gate-basis" error={!gate.transferBasis ? 'Needed to send it outside the residency domain.' : undefined}>
                <Select id="gate-basis" value={gate.transferBasis} onChange={(e) => setGate({ ...gate, transferBasis: e.target.value })}>
                  <option value="">Choose…</option>
                  {TRANSFER_BASES.map((b) => <option key={b} value={b}>{b}</option>)}
                </Select>
              </Field>
            )}
          </div>
          <p className="mt-1.5 text-xs">The answer is written into the signed manifest and the export receipt.</p>
        </Row>

        <Row state={retention.ok ? 'pass' : 'warn'} title="Retention">
          {retention.ok
            ? <>Every record is inside the {retention.years}-year WORM retention{retention.oldest ? ` (the oldest is from ${retention.oldest})` : ''}. Erased fields leave redacted.</>
            : <>Some records are past the {retention.years}-year retention and are kept only under a hold. Check before sending.</>}
        </Row>

        <Row state={personal > 0 && !gate.purpose ? 'fail' : personal > 0 ? 'pass' : 'pass'} title={personal > 0 ? `Consent and purpose — ${plural(personal, 'record')} with personal data` : 'Consent and purpose — no personal data in range'}>
          {personal > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 mt-1 [&>*]:min-w-0">
              <Field label="Why are they being disclosed?" htmlFor="gate-purpose" error={!gate.purpose ? 'Needed for records with personal data.' : undefined}>
                <Select id="gate-purpose" value={gate.purpose} onChange={(e) => setGate({ ...gate, purpose: e.target.value })}>
                  <option value="">Choose…</option>
                  {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
              </Field>
              <p className="text-xs self-end pb-2">Receipts hold only the values the rules inspected; email addresses are domains. The purpose is recorded with the export.</p>
            </div>
          ) : <>None of these records was tagged as personal data.</>}
        </Row>

        <Row state={missing.length ? (gate.acknowledged ? 'warn' : 'fail') : 'pass'} title={missing.length ? `${plural(missing.length, 'declaration')} missing` : 'Declarations in place'}>
          {missing.length ? (
            <>
              <ul className="list-disc pl-5 space-y-0.5">
                {missing.slice(0, 8).map((m) => <li key={`${m.kind}:${m.subject}`}>{m.detail}</li>)}
                {missing.length > 8 && <li>and {n(missing.length - 8)} more</li>}
              </ul>
              <div className="mt-2">
                <Checkbox checked={gate.acknowledged} onChange={(v) => setGate({ ...gate, acknowledged: v })} label="Export anyway" description="The manifest names each missing declaration, so the recipient sees them." />
              </div>
            </>
          ) : <>Every agent in range has an AI system with an approved assessment, and every rulebook version has a recorded signer.</>}
        </Row>
      </ul>
    </div>
  );
}

/** "Verify it yourself first": the result of verifying the exact bundle in this browser. */
export function PreflightResult({ running, results, error, l2 }: { running?: boolean; results?: { label: string; result: VerifyBundleResult }[]; error?: string; l2: boolean }) {
  if (running) return <p className="inline-flex items-center gap-2 text-sm text-muted"><Spinner /> Building the {l2 ? 'bundle' : 'pack'} without writing anything, then recomputing every hash, {l2 ? 'signature, seal and timestamp' : 'seal and link'}…</p>;
  if (error) return <p className="text-sm text-bad-fg">{error}</p>;
  if (!results?.length) return null;
  return (
    <ul className="space-y-2">
      {results.map(({ label, result }) => (
        <li key={label} className="flex flex-wrap items-center gap-2 text-sm">
          <StatusChip tone={result.exitCode === 0 ? 'ok' : result.exitCode === 1 || result.exitCode === 2 ? 'bad' : 'held'} size="sm" icon={result.exitCode === 0 ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : result.exitCode === 1 ? <OctagonX className="h-3 w-3" aria-hidden /> : <CircleSlash className="h-3 w-3" aria-hidden />}>
            <span className="font-mono">{result.code}</span>
          </StatusChip>
          <span className="text-muted">{label}</span>
          <span className="min-w-0 basis-full sm:basis-auto sm:flex-1">{result.headline}</span>
        </li>
      ))}
    </ul>
  );
}
