import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Layers, RefreshCw, Stamp, X } from 'lucide-react';
import type { InclusionProof, Receipt, SealField, SealRecord, TsaAuthority } from '@/types';
import { SEAL_FIELDS, digestOfFields, fieldValues, sealDigestAlt, sealPreimage, verifyDigestSig } from '@/lib/seal';
import { leafHash, nodeHash } from '@/lib/merkle';
import { tokenMessage } from '@/lib/verify6';
import { verifySig } from '@/lib/crypto';
import { LEVEL_INFO } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { dateTime, n, seqLabel } from '@/lib/format';
import { Badge, Banner, Button, Hash, KeyValue, Panel, Select, StatusChip } from '@/components/ui';
import type { ReceiptAssurance } from './receiptAssurance';
import { NavButton } from './shared';
import { UpgradeHint } from './UpgradeHint';

function Ok({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <StatusChip tone={ok ? 'ok' : 'bad'} size="sm" icon={ok ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}>{ok ? yes : no}</StatusChip>;
}

/** The Seal v6 tab: 16 frozen fields with values, the digest recomputed live, the signature, then the anchoring. */
export function SealTab({ r, a }: { r: Receipt; a: ReceiptAssurance }) {
  if (!a.seal.sealed) {
    const orgBelow = a.state.level === 'l1';
    const boundary = a.state.boundaries.find((b) => b.to !== 'l1');
    return (
      <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <div className="lg:col-span-7 space-y-4">
          {orgBelow ? (
            <UpgradeHint to="l2" title="Seal v6 starts at L2 Attested."
              preview={<SealFieldTable fields={SEAL_FIELDS.map((f) => ({ id: f.id, name: f.name, value: '' }))} preview />}>
              From the upgrade, every record is sealed with 16 frozen fields: SHA-256 over a length-prefixed preimage, signed with Ed25519 by a key in AWS KMS, batched into a Merkle tree every 15 minutes and timestamped by eMudhra and a global authority. This receipt stays as it is: sealed in a hash chain by Elan1 Govern.
            </UpgradeHint>
          ) : (
            <Banner tone="neutral" title="L1 — sealed in a hash chain, no Seal v6 record"
              actions={boundary?.firstSeq ? <NavButton size="sm" to={`/activity/${boundary.firstSeq}?tab=seal`}>First sealed record</NavButton> : undefined}>
              {a.seal.reason} It keeps verifying under L1 rules; that is not a failure.
            </Banner>
          )}
        </div>
        <div className="lg:col-span-5">
          <SealHowTo />
        </div>
      </div>
    );
  }
  return <SealedView r={r} a={a} seal={a.seal.seal} binding={a.seal.check.binding} />;
}

function SealedView({ r, a, seal, binding }: { r: Receipt; a: ReceiptAssurance; seal: SealRecord; binding: boolean }) {
  const [run, setRun] = useState(0);
  const live = useMemo(() => {
    const t0 = performance.now();
    const values = fieldValues(seal.fields);
    const digest = digestOfFields(seal.fields);
    const alt = sealDigestAlt(values);
    const bytes = sealPreimage(values).length;
    const sig = !!a.publicKeys[seal.kid] && verifyDigestSig(seal.digest, seal.sig, a.publicKeys[seal.kid]);
    return { digest, alt, bytes, sig, ms: Math.max(1, Math.round(performance.now() - t0)) };
  }, [seal, run]);
  const [tamper, setTamper] = useState<string>('');
  const tampered = useMemo(() => {
    if (!tamper) return undefined;
    const fields: SealField[] = seal.fields.map((f) => (f.id === tamper ? { ...f, value: f.id === 'F11' ? (f.value === 'A5' ? 'A4' : 'A5') : f.id === 'F16' ? new Date(new Date(f.value).getTime() + 1000).toISOString() : `${f.value}x` } : f));
    return { field: fields.find((f) => f.id === tamper)!, digest: digestOfFields(fields) };
  }, [tamper, seal]);
  const digestOk = live.digest === seal.digest;
  const agree = live.alt === live.digest;
  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <Panel className="lg:col-span-8" title="Sealed record" kicker={`elan1.seal.v6 · ${LEVEL_INFO[seal.level].label}`} flush
          actions={<Badge tone="neutral">{seal.fields.length} of 16 frozen fields</Badge>}>
          <SealFieldTable fields={seal.fields} highlight={tamper || undefined} />
          {seal.payloadUnbound && <div className="px-5 py-3 border-t border-line"><Banner tone="info" title="Payload unbound by an erasure request">The salt for F14 was destroyed under DPDP and cannot be derived again. The payload hash can no longer be linked to a person; the values the rules inspected were removed from the receipt, and the organisation signed what is left. The seal and the chain still verify.</Banner></div>}
        </Panel>
        <div className="lg:col-span-4 space-y-6">
          <Panel title="Digest and signature" kicker="Recomputed in this browser">
            <KeyValue items={[
              { k: 'Preimage', v: <span className="num">{n(live.bytes)} bytes, length-prefixed</span> },
              { k: 'Signed digest', v: <Hash value={seal.digest} len={14} /> },
              { k: 'Recomputed', v: <Hash value={live.digest} len={14} /> },
              { k: 'Digest', v: <Ok ok={digestOk} yes="Matches" no="Does not match" /> },
              { k: 'Second encoder', v: <Ok ok={agree} yes="Same bytes" no="Disagrees" /> },
              { k: 'Seal signature', v: <Ok ok={live.sig} yes={`Verifies (${seal.kid})`} no="Does not verify" /> },
              { k: 'Binds receipt', v: <Ok ok={binding} yes="F04 binds this hash" no="Another record" /> },
            ]} />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => setRun((x) => x + 1)}>Recompute</Button>
              <span className="text-xs text-muted num">{live.ms} ms</span>
            </div>
            <p className="mt-3 text-xs text-muted leading-relaxed">SHA-256 over lp(“elan1.seal.v6”) ‖ lp(F01) ‖ … ‖ lp(F16), each prefixed with its 4-byte length. A second, independent encoder recomputes the same bytes; the Python implementation agrees on all 64 test vectors.</p>
          </Panel>
          <Panel title="Change a field in a copy" tone="sunken">
            <Select aria-label="Field to change in a copy" value={tamper} onChange={(e) => setTamper(e.target.value)}>
              <option value="">Choose a field…</option>
              {seal.fields.filter((f) => ['F05', 'F09', 'F11', 'F12', 'F14', 'F16'].includes(f.id)).map((f) => <option key={f.id} value={f.id}>{f.id} {f.name}</option>)}
            </Select>
            {tampered && (
              <p className="mt-3 text-sm">In the copy, <span className="font-mono">{tampered.field.id}</span> becomes <span className="font-mono break-all">{tampered.field.value.slice(0, 40)}</span>. Its digest is <span className="font-mono text-bad-fg">{tampered.digest.slice(0, 16)}…</span>, not the signed <span className="font-mono">{seal.digest.slice(0, 16)}…</span>, so the seal no longer verifies. The stored record is untouched.</p>
            )}
          </Panel>
        </div>
      </div>
      <AnchoredPanel r={r} proof={a.proof} proofError={a.proofError} authorities={a.authorities} status={a.batchStatus} />
    </div>
  );
}

export function SealFieldTable({ fields, highlight, preview }: { fields: SealField[]; highlight?: string; preview?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Seal v6 fields F01 to F16</caption>
        <thead className="bg-sunken/70"><tr><th scope="col" className="text-left px-4 py-2 label w-14">Field</th><th scope="col" className="text-left px-2 py-2 label">Name</th>{!preview && <th scope="col" className="text-left px-2 py-2 label">Value</th>}<th scope="col" className="text-left px-2 py-2 label hidden md:table-cell">What it is</th></tr></thead>
        <tbody>
          {fields.map((f) => {
            const doc = SEAL_FIELDS.find((x) => x.id === f.id);
            return (
              <tr key={f.id} className={cn('border-t border-line align-top', highlight === f.id && 'bg-bad-bg')}>
                <td className="px-4 py-2 font-mono text-xs text-muted">{f.id}</td>
                <td className="px-2 py-2 font-mono text-[12.5px]">{f.name}</td>
                {!preview && <td className="px-2 py-2 font-mono text-[12px] break-all max-w-[340px]">{f.value === '' ? <span className="text-subtle">(empty)</span> : f.value}</td>}
                <td className="px-2 py-2 text-xs text-muted hidden md:table-cell">{doc?.description}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SealHowTo() {
  return (
    <Panel title="What a seal adds" tone="sunken">
      <ul className="space-y-2 text-sm text-muted leading-relaxed list-disc pl-4">
        <li>16 frozen fields, from tenant to recorded time, in a fixed order.</li>
        <li>The payload is bound by a salted hash (F14), so destroying the salt erases it without breaking the chain.</li>
        <li>Batched every 15 minutes into a Merkle tree; the root is timestamped by two independent authorities.</li>
        <li>Two implementations (TypeScript and Python) produce the same bytes on 64 published test vectors.</li>
      </ul>
    </Panel>
  );
}

/** Batch, inclusion proof recomputed step by step, and both timestamp tokens. */
export function AnchoredPanel({ r, proof, proofError, authorities, status, compact }: { r: Receipt; proof?: InclusionProof; proofError?: string; authorities: TsaAuthority[]; status?: 'anchored' | 'late'; compact?: boolean }) {
  const steps = useMemo(() => {
    if (!proof) return [];
    let h = leafHash(r.hash);
    const out = [{ label: 'Leaf', hash: h, note: 'SHA-256(0x00 ‖ receipt hash)' }];
    proof.path.forEach((s, i) => {
      h = s.side === 'right' ? nodeHash(h, s.hash) : nodeHash(s.hash, h);
      out.push({ label: `Step ${i + 1}`, hash: h, note: `sibling on the ${s.side}: ${s.hash.slice(0, 10)}…` });
    });
    return out;
  }, [proof, r.hash]);
  if (!proof) {
    return (
      <Panel title="Anchored" kicker="Merkle batch and timestamps">
        <Banner tone="held" title="In the newest batch — not yet timestamped" actions={<NavButton size="sm" to="/assurance/anchors">Timestamps</NavButton>}>{proofError ?? 'Batches close every 15 minutes; both authorities stamp the root within 15 minutes after that.'}</Banner>
      </Panel>
    );
  }
  const computed = steps[steps.length - 1]?.hash;
  const rootOk = computed === proof.root;
  const auth = new Map(authorities.map((x) => [x.id, x]));
  return (
    <Panel title="Anchored" kicker={`Batch ${proof.batchId}${status === 'late' ? ' · timestamped late' : ''}`} actions={<NavButton size="sm" to="/assurance/anchors" iconRight={<ArrowRight className="h-3.5 w-3.5" />}>All batches</NavButton>}>
      <div className={cn('grid gap-6', !compact && 'lg:grid-cols-2')}>
        <div className="min-w-0">
          <p className="label mb-2 flex items-center gap-1.5"><Layers className="h-3.5 w-3.5" aria-hidden />Merkle inclusion proof (RFC 6962)</p>
          <p className="text-sm text-muted mb-2">Leaf {n(proof.leafIndex + 1)} of {n(proof.treeSize)}. Each step hashes with one sibling; the last must equal the batch root that both authorities stamped.</p>
          <ol className="border border-line divide-y divide-line text-xs">
            {steps.map((s) => (
              <li key={s.label} className="grid grid-cols-[64px_1fr] gap-2 px-3 py-1.5"><span className="text-muted">{s.label}</span><span className="min-w-0"><span className="font-mono break-all">{s.hash.slice(0, 32)}…</span><span className="block text-subtle">{s.note}</span></span></li>
            ))}
            <li className="grid grid-cols-[64px_1fr] gap-2 px-3 py-1.5 bg-sunken/50"><span className="font-semibold">Root</span><span className="font-mono break-all">{proof.root.slice(0, 32)}…</span></li>
          </ol>
          <p className="mt-2"><Ok ok={rootOk} yes="Recomputed root matches the batch root" no="Recomputed root does not match" /></p>
        </div>
        <div className="min-w-0 space-y-3">
          <p className="label flex items-center gap-1.5"><Stamp className="h-3.5 w-3.5" aria-hidden />RFC 3161 timestamp tokens</p>
          {proof.tokens.map((t) => {
            const a = auth.get(t.tsaId);
            const sigOk = !!a && verifySig(tokenMessage(t), t.sig, a.publicKey);
            const late = t.delaySeconds > 15 * 60;
            return (
              <div key={t.serial} className="border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{t.tsaName}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <Ok ok={sigOk && t.imprint === proof.root} yes="Token verifies" no="Does not verify" />
                    <StatusChip tone={late ? 'held' : 'ok'} size="sm">{late ? `${Math.round(t.delaySeconds / 60)} min — late` : `${Math.max(1, Math.ceil(t.delaySeconds / 60))} min after close`}</StatusChip>
                  </div>
                </div>
                <dl className="mt-2 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
                  <div className="flex justify-between gap-2"><dt className="text-muted">Granted</dt><dd className="num">{dateTime(t.genTime)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-muted">Serial</dt><dd className="font-mono">{t.serial.slice(0, 12)}…</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-muted">Policy</dt><dd className="font-mono">{t.policyOid}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-muted">Imprint</dt><dd className="font-mono">{t.imprint.slice(0, 12)}…</dd></div>
                </dl>
                {a && <p className="mt-1.5 text-[11px] text-subtle">{a.scope} authority · {a.url} · key {a.fingerprint}</p>}
              </div>
            );
          })}
          {!compact && <p className="text-xs text-muted">Receipt <Link to={`/activity/${r.seq}?tab=seal`} className="font-mono underline underline-offset-2">{seqLabel(r.seq)}</Link> existed no later than the earlier of these two times.</p>}
        </div>
      </div>
    </Panel>
  );
}
