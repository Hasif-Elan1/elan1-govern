import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, Stamp, TriangleAlert } from 'lucide-react';
import { SmartLink } from '@/shell/access';
import { api, db } from '@/api';
import { canonical, verifySig } from '@/lib/crypto';
import { dateTime, n, plural, seqLabel, timeShort } from '@/lib/format';
import type { AnchorsView, Checkpoint, InclusionProof, LevelId } from '@/types';
import { Badge, Banner, Button, DataTable, Drawer, Hash, KeyValue, Panel, Spinner, StatusChip, type Column } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { useOrgId } from '@/store/session';
import { TARGET_SECONDS, tsaShort } from '@/features/anchors/anchorLocal';
import { Check, ProofSteps, TokenCards, delayText } from '@/features/anchors/proof';

type Batch = AnchorsView['batches'][number];

/** The batch that timestamps a receipt, if any. */
function batchFor(batches: Batch[] | undefined, seq: number) {
  return batches?.find((b) => seq >= b.firstSeq && seq <= b.lastSeq);
}

export function CheckpointsPanel({ checkpoints, loading, level, anchors, sealedFrom, canCheckpoint, signing, onSign, unanchored }: {
  checkpoints?: Checkpoint[]; loading: boolean; level: LevelId; anchors?: AnchorsView; sealedFrom?: number; canCheckpoint: boolean; signing: boolean; onSign: () => void; unanchored?: number;
}) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Checkpoint>();
  const l2 = level !== 'l1';
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const verb = l2 ? 'sign' : 'seal';
  const auth = anchors?.authorities ?? [];
  const timestamped = (c: Checkpoint) => l2 && sealedFrom !== undefined && new Date(c.ts).getTime() >= sealedFrom;

  const cols: Column<Checkpoint>[] = [
    { key: 'seq', header: 'Head', cell: (c) => <ReceiptLink seq={c.seq} />, sort: (c) => c.seq },
    { key: 'ts', header: l2 ? 'Signed' : 'Sealed', cell: (c) => <span className="text-sm whitespace-nowrap">{dateTime(c.ts)}</span>, sort: (c) => c.ts, hideBelow: 'sm' },
    { key: 'type', header: 'Type', cell: (c) => (c.onDemand ? <Badge tone="info">On demand</Badge> : <Badge>Hourly</Badge>), hideBelow: 'md' },
    ...(l2 ? auth.map((a, i): Column<Checkpoint> => ({
      key: `tsa${i}`, header: tsaShort(a.name), hideBelow: i === 0 ? 'sm' : 'md',
      cell: (c) => {
        if (!timestamped(c)) return <span className="text-xs text-subtle">L1 · not timestamped</span>;
        const t = batchFor(anchors?.batches, c.seq)?.tokens[i];
        return t ? <span className="text-sm num whitespace-nowrap">{timeShort(t.genTime)}</span> : <span className="text-xs text-muted">Next batch</span>;
      },
    })) : []),
    ...(l2 ? [{
      key: 'lag', header: 'Time to anchor', hideBelow: 'lg' as const,
      cell: (c: Checkpoint) => {
        const b = timestamped(c) ? batchFor(anchors?.batches, c.seq) : undefined;
        if (!b) return <span className="text-subtle">—</span>;
        const worst = Math.max(...b.tokens.map((t) => t.delaySeconds));
        return worst <= TARGET_SECONDS
          ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>{delayText(worst)}</StatusChip>
          : <StatusChip tone="held" size="sm" icon={<TriangleAlert className="h-3 w-3" aria-hidden />}>{delayText(worst)}</StatusChip>;
      },
    }, {
      key: 'root', header: 'Merkle root', hideBelow: 'lg' as const,
      cell: (c: Checkpoint) => { const b = timestamped(c) ? batchFor(anchors?.batches, c.seq) : undefined; return b ? <Hash value={b.root} len={10} /> : <span className="text-subtle">—</span>; },
    }] : [
      { key: 'hash', header: 'Hash', cell: (c: Checkpoint) => <Hash value={c.hash} len={14} />, hideBelow: 'sm' as const },
      { key: 'kid', header: 'Key', cell: (c: Checkpoint) => <span className="font-mono text-[12px]">{c.kid}</span>, hideBelow: 'md' as const },
    ]),
  ];

  return (
    <Panel title="Checkpoints" kicker={l2 ? 'Signed chain heads, each timestamped with its batch' : 'Sealed chain heads · hourly and on demand'} flush
      actions={canCheckpoint ? <Button size="sm" variant="secondary" icon={<Stamp className="h-3.5 w-3.5" />} loading={signing} onClick={onSign}>{l2 ? 'Sign' : 'Seal'} a checkpoint now</Button> : undefined}
      footer={checkpoints && checkpoints.length > 12 ? (
        <div className="flex items-center justify-between gap-3">
          <span className="num">Showing {all ? n(checkpoints.length) : 12} of {n(checkpoints.length)}</span>
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : 'Show all'}</Button>
        </div>
      ) : undefined}>
      {unanchored ? <div className="px-5 pt-4"><Banner tone="neutral">{plural(unanchored, 'receipt')} since the last checkpoint. They are {verb}ed and linked{l2 ? ', and timestamped with their batch,' : ','} but a cut-off tail is only detectable once a checkpoint covers it.</Banner></div> : null}
      <div className="pt-4">
        <DataTable caption="Checkpoints" className="border-x-0 border-b-0" columns={cols} rows={checkpoints ? (all ? checkpoints : checkpoints.slice(0, 12)) : undefined} loading={loading} rowKey={(c) => c.id} maxHeight={all ? 520 : undefined} onRowClick={setOpen}
          empty={<p className="px-5 py-6 text-sm text-muted">No checkpoint yet. The first is {verb}ed within the hour{canCheckpoint ? `, or ${verb} one now` : ''}.</p>} />
      </div>
      <CheckpointDrawer cp={open} onClose={() => setOpen(undefined)} anchors={anchors} timestamped={open ? timestamped(open) : false} />
    </Panel>
  );
}

function CheckpointDrawer({ cp, onClose, anchors, timestamped }: { cp?: Checkpoint; onClose: () => void; anchors?: AnchorsView; timestamped: boolean }) {
  const orgId = useOrgId();
  const [proof, setProof] = useState<InclusionProof>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const batch = cp && timestamped ? batchFor(anchors?.batches, cp.seq) : undefined;
  const sigOk = useMemo(() => {
    if (!cp) return false;
    const pub = db.getDB(orgId).publicKeys[cp.kid];
    return !!pub && verifySig(canonical({ org: cp.org, seq: cp.seq, hash: cp.hash, ts: cp.ts, kid: cp.kid }), cp.sig, pub);
  }, [cp, orgId]);
  useEffect(() => {
    setProof(undefined); setErr(undefined);
    if (!cp || !batch) return;
    setBusy(true);
    api.inclusionProof(orgId, cp.seq).then(setProof).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  }, [cp, batch, orgId]);
  if (!cp) return null;
  // An L1 checkpoint (not timestamped) is "sealed", never "signed", until DR-017 is decided.
  const signed = timestamped;
  return (
    <Drawer open onClose={onClose} kicker="Checkpoint" title={`Head ${seqLabel(cp.seq)}`} width={640}>
      <KeyValue items={[
        { k: 'Head receipt', v: <ReceiptLink seq={cp.seq} /> },
        { k: 'Head hash', v: <Hash value={cp.hash} len={20} /> },
        { k: signed ? 'Signed' : 'Sealed', v: dateTime(cp.ts) },
        { k: 'Key', v: cp.kid, mono: true },
        { k: signed ? 'Signature' : 'Seal (Ed25519)', v: <Hash value={cp.sig} len={20} /> },
        { k: 'Type', v: cp.onDemand ? 'On demand' : 'Hourly' },
      ]} />
      <div className="mt-3"><Check ok={sigOk} yes={`Checkpoint ${signed ? 'signature' : 'seal'} verifies here`} no={`Checkpoint ${signed ? 'signature' : 'seal'} does not verify`} /></div>

      {!timestamped ? (
        <Banner className="mt-6" tone="neutral" title="L1 — sealed in a hash chain, not timestamped">This checkpoint was sealed before the organisation’s L2 boundary, or the organisation is on L1. It verifies as a chain head sealed by Elan1 Govern; no timestamp authority saw it.<SmartLink hideWhenBlocked className="underline underline-offset-2 ml-1" to="/assurance/anchors">How timestamps work</SmartLink></Banner>
      ) : !batch ? (
        <Banner className="mt-6" tone="neutral" title="In the open batch">The head receipt is in the current 15-minute window. Both authorities timestamp it when the window closes, or use Anchor now on the Timestamps page.</Banner>
      ) : (
        <>
          <div className="mt-6">
            <p className="label mb-2">RFC 3161 tokens over batch {batch.id}</p>
            <TokenCards tokens={batch.tokens} authorities={[...(anchors?.authorities ?? []), ...(anchors?.previousAuthorities ?? [])]} root={batch.root} />
          </div>
          <div className="mt-6">
            <p className="label mb-2">RFC 6962 inclusion proof for the head receipt</p>
            {busy ? <p className="text-sm text-muted inline-flex items-center gap-2"><Spinner /> Building the audit path…</p>
              : err ? <Banner tone="neutral">{err}</Banner>
              : proof && <ProofSteps receiptHash={proof.receiptHash} path={proof.path} root={proof.root} leafIndex={proof.leafIndex} treeSize={proof.treeSize} />}
          </div>
          <p className="mt-4 text-xs text-muted inline-flex items-center gap-1"><Clock3 className="h-3 w-3" aria-hidden />Batch {seqLabel(batch.firstSeq)}–{seqLabel(batch.lastSeq)} closed {dateTime(batch.windowEnd)}. <SmartLink hideWhenBlocked className="underline underline-offset-2" to={`/assurance/anchors?seq=${cp.seq}`}>Open on the Timestamps page</SmartLink></p>
        </>
      )}
    </Drawer>
  );
}
