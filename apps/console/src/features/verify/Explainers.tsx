import { Link } from 'react-router-dom';
import { Check, Minus, ArrowRight } from 'lucide-react';
import type { LevelId } from '@/types';
import { LEVEL_INFO } from '@/lib/levels';
import { CodeBlock, Panel } from '@/components/ui';
import { ExitTable } from './ResultView';
import { LEVEL_CLAIM, reportText, type Result6 } from './bundle';

/** What a pass proves, for the levels present in what was loaded (L1 when nothing is loaded yet). */
export function ProvesPanel({ levels }: { levels: LevelId[] }) {
  const anchored = levels.some((l) => l !== 'l1');
  const custHsm = levels.some((l) => l === 'l3' || l === 'sovereign');
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const hasL1 = !levels.length || levels.includes('l1');
  const proves = [
    !anchored ? 'The receipts are unchanged since Elan1 Govern sealed them in the hash chain with the key named.'
      : hasL1 ? 'The receipts are unchanged since they were written: L1 records since Elan1 Govern sealed them in the hash chain, later records since they were signed by the key named.'
      : 'The receipts are unchanged since they were signed by the key named.',
    'The sequence has no gaps: nothing was removed, reordered or slipped in between.',
    'Each checkpoint matches the chain head it names.',
    ...(anchored ? [
      'Each sealed record’s 16 frozen fields recompute to the digest that was signed (Seal v6).',
      'Each batch’s Merkle root recomputes from its records, and two independent timestamp authorities signed that root — so the records existed by the time shown. A batch with only one valid timestamp is reported as degraded, not failed.',
    ] : []),
  ];
  const doesNot = [
    custHsm ? 'That the key holder could not have written different receipts before signing them. The organisation holds the signing key in its own HSM.' : anchored ? 'That the key holder could not have written different receipts before signing them. The key lives in AWS KMS in the organisation’s residency domain, used only by Elan1 Govern.' : 'That the key holder could not have written different receipts before sealing them. Elan1 Govern holds the key that seals the chain.',
    'That the file came from the organisation it names — unless you supply a fingerprint you obtained from them directly (their website, a signed letter, a call).',
    anchored ? 'When records in the unanchored tail were made: they are signed and chained, and wait for the next batch to be timestamped.' : 'When the receipts were made, to an outside party: L1 records are not externally timestamped. From L2 every 15-minute batch is timestamped by two authorities.',
    'That a decision was right. A receipt records what the rulebook decided and who approved it, not whether the rule was a good one.',
  ];
  return (
    <Panel title="What this proves, and what it does not" kicker="Read before you rely on it">
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <p className="label mb-3 text-ok-fg">Proves</p>
          <ul className="space-y-3">
            {proves.map((p) => (
              <li key={p} className="flex gap-2.5 text-sm leading-relaxed">
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center border border-ok/40 bg-ok-bg text-ok-fg"><Check className="h-3 w-3" strokeWidth={3} aria-hidden /></span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="label mb-3">Does not prove</p>
          <ul className="space-y-3">
            {doesNot.map((p) => (
              <li key={p} className="flex gap-2.5 text-sm leading-relaxed text-fg/90">
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center border border-line bg-sunken text-muted"><Minus className="h-3 w-3" aria-hidden /></span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="mt-6 border-t border-line pt-4 space-y-1.5 text-sm text-muted">
        {(levels.length ? levels : (['l1'] as LevelId[])).map((l) => <p key={l}><span className="text-fg font-medium">{LEVEL_INFO[l].label}:</span> records are {LEVEL_CLAIM[l]}.</p>)}
        <p>Records are tamper-evident: a change shows up here; it is not prevented.</p>
      </div>
    </Panel>
  );
}

const CLI = `# Offline, on your own machine. No account, no network.
govern verify bundle.zip --fingerprint <16 hex you obtained from the organisation>

# Check the records against a regime's rules as well
govern verify bundle.zip --fingerprint <hex> --profile in-mca-audit-trail

# A disclosure package or a receipt another organisation sent you
govern verify disclosure.json --fingerprint <issuer's hex>`;

const IDLE_OUT = `Load a sample or your own file above and the report
the verifier prints for it appears here — the same nine
sections and the same exit code.`;

export function OfflinePanel({ result, label }: { result?: Result6; label?: string }) {
  return (
    <Panel title="Verify offline" kicker="The same checks, on your machine">
      <div className="space-y-4">
        <p className="text-sm text-muted leading-relaxed max-w-[72ch]">
          This page runs the checks that <span className="font-mono text-fg">govern verify</span> runs. An auditor who would rather not use a website can run the command-line verifier on a machine with no network connection; a second implementation in Python agrees byte for byte on the 64 published test vectors.
        </p>
        <CodeBlock code={CLI} title="Terminal" />
        <CodeBlock code={result && label ? reportText(result, label) : IDLE_OUT} title={result ? 'Output for what you loaded' : 'Output'} maxHeight={320} />
        <ExitTable />
        <Link to="/developers/verifier" className="link inline-flex items-center gap-1 text-sm">The six result codes and verifier profiles <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
      </div>
    </Panel>
  );
}
