import { useMemo } from 'react';
import { CheckCircle2, OctagonX, Stamp } from 'lucide-react';
import type { TimestampToken, TsaAuthority } from '@/types';
import { dateTime } from '@/lib/format';
import { Hash, StatusChip } from '@/components/ui';
import { TARGET_SECONDS, tokenVerifies, tsaShort, walkPath } from './anchorLocal';

export function delayText(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m} min ${s} s` : `${s} s`;
}

export function Check({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return ok
    ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>{yes}</StatusChip>
    : <StatusChip tone="bad" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>{no}</StatusChip>;
}

/** One RFC 3161 token per authority, each checked here: signature, imprint and delay. */
export function TokenCards({ tokens, authorities, root }: { tokens: TimestampToken[]; authorities: TsaAuthority[]; root: string }) {
  const checks = useMemo(() => tokens.map((t) => ({ t, sig: tokenVerifies(t, authorities), imprint: t.imprint === root, inTime: t.delaySeconds <= TARGET_SECONDS })), [tokens, authorities, root]);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {checks.map(({ t, sig, imprint, inTime }) => {
        const a = authorities.find((x) => x.id === t.tsaId);
        return (
          <div key={t.tsaId + t.serial} className="border border-line bg-surface p-4 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="label">RFC 3161 token{a ? ` · ${a.scope}` : ''}</p>
                <p className="mt-1 font-medium truncate" title={t.tsaName}><Stamp className="inline h-3.5 w-3.5 mr-1 text-muted" aria-hidden />{tsaShort(t.tsaName)}</p>
              </div>
              {t.status === 'granted_late' && <StatusChip tone="held" size="sm">Late</StatusChip>}
            </div>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-muted">genTime</dt><dd className="num text-right">{dateTime(t.genTime)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">After batch close</dt><dd className="num">{delayText(t.delaySeconds)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Serial</dt><dd className="font-mono text-[12px] break-all text-right">{t.serial}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Policy</dt><dd className="font-mono text-[12px] text-right">{t.policyOid}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Imprint</dt><dd><Hash value={t.imprint} len={14} /></dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Signature</dt><dd><Hash value={t.sig} len={14} /></dd></div>
            </dl>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Check ok={sig} yes="Signature verifies" no="Signature does not verify" />
              <Check ok={imprint} yes="Imprint is the root" no="Imprint is not the root" />
              <Check ok={inTime} yes="Within 15 minutes" no="Over 15 minutes" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The audit path recomputed step by step in this browser, ending at the batch root. */
export function ProofSteps({ receiptHash, path, root, leafIndex, treeSize }: { receiptHash: string; path: { hash: string; side: 'left' | 'right' }[]; root: string; leafIndex: number; treeSize: number }) {
  const walk = useMemo(() => walkPath(receiptHash, path), [receiptHash, path]);
  const ok = walk.root === root;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Check ok={ok} yes="Recomputed root matches the batch root" no="Recomputed root does not match" />
        <span className="text-xs text-muted num">Leaf {leafIndex + 1} of {treeSize} · {path.length} {path.length === 1 ? 'step' : 'steps'}</span>
      </div>
      <ol className="border border-line divide-y divide-line text-sm">
        <li className="px-3 py-2 grid gap-1 sm:grid-cols-[120px_1fr]">
          <span className="text-muted">Leaf</span>
          <span className="min-w-0"><span className="text-xs text-muted">SHA-256(0x00 ‖ receipt hash) = </span><Hash value={walk.leaf} len={20} /></span>
        </li>
        {walk.steps.map((s) => (
          <li key={s.index} className="px-3 py-2 grid gap-1 sm:grid-cols-[120px_1fr]">
            <span className="text-muted">Step {s.index} · sibling {s.side}</span>
            <span className="min-w-0 space-y-0.5">
              <span className="block"><span className="text-xs text-muted">Sibling </span><Hash value={s.sibling} len={20} /></span>
              <span className="block"><span className="text-xs text-muted">SHA-256(0x01 ‖ {s.side === 'right' ? 'node ‖ sibling' : 'sibling ‖ node'}) = </span><Hash value={s.output} len={20} /></span>
            </span>
          </li>
        ))}
        <li className="px-3 py-2 grid gap-1 sm:grid-cols-[120px_1fr] bg-sunken/50">
          <span className="text-muted">Batch root</span>
          <span className="min-w-0"><Hash value={root} len={20} /></span>
        </li>
      </ol>
    </div>
  );
}
