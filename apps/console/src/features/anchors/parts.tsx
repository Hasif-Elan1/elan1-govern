import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download, Search } from 'lucide-react';
import { api } from '@/api';
import { useOrgId } from '@/store/session';
import type { InclusionProof, TsaAuthority } from '@/types';
import { dateTime, n, seqLabel, timeShort } from '@/lib/format';
import { Banner, Button, Drawer, Field, Hash, Input, KeyValue, Spinner } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { SERIES, Legend } from '@/components/charts';
import { downloadText } from '@/features/activity/shared';
import { onDemandProof, recomputeRoot, tsaShort, type ViewBatch } from './anchorLocal';
import { Check, ProofSteps, TokenCards } from './proof';

/* ── Lag chart ─────────────────────────────────────────────── */

export function LagChart({ batches, authorities }: { batches: ViewBatch[]; authorities: TsaAuthority[] }) {
  const data = useMemo(() => batches.filter((b) => !b.onDemand).slice(0, 48).reverse().map((b) => {
    const row: Record<string, string | number> = { t: b.windowEnd };
    b.tokens.forEach((t, i) => { row[`a${i}`] = Math.round((t.delaySeconds / 60) * 10) / 10; });
    return row;
  }), [batches]);
  const colours = [SERIES.ink, SERIES.muted];
  if (!data.length) return <p className="text-sm text-muted">No completed batch yet. The first one is timestamped when its 15-minute window closes.</p>;
  const max = Math.max(16, ...data.flatMap((d) => authorities.map((_, i) => Number(d[`a${i}`] ?? 0))));
  return (
    <div>
      <div style={{ height: 220 }} role="img" aria-label={`Minutes from batch close to each timestamp, last ${data.length} batches, against the 15-minute target`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke={SERIES.grid} />
            <XAxis dataKey="t" tick={{ fontSize: 11, fill: 'rgb(var(--subtle))' }} axisLine={false} tickLine={false} tickFormatter={(v: string) => timeShort(v)} minTickGap={28} />
            <YAxis tick={{ fontSize: 11, fill: 'rgb(var(--subtle))' }} axisLine={false} tickLine={false} width={44} domain={[0, Math.ceil(max)]} tickFormatter={(v) => `${v}m`} />
            <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
              <div className="bg-ink-800 text-paper border border-ink-700 px-3 py-2 text-xs shadow-e3">
                <p className="text-ink-300 mb-1">Batch closed {dateTime(String(label))}</p>
                {payload.map((p) => <p key={String(p.dataKey)} className="flex justify-between gap-4"><span>{p.name}</span><span className="num">{p.value} min</span></p>)}
              </div>
            ) : null} />
            <ReferenceLine y={15} stroke="rgb(var(--held))" strokeDasharray="4 3" label={{ value: '15-minute target', position: 'insideTopRight', fontSize: 11, fill: 'rgb(var(--subtle))' }} />
            {authorities.map((a, i) => <Line key={a.id} type="monotone" dataKey={`a${i}`} name={tsaShort(a.name)} stroke={colours[i % 2]} strokeWidth={i === 0 ? 2 : 1.5} strokeDasharray={i === 0 ? undefined : '5 3'} dot={false} isAnimationActive={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <Legend items={authorities.map((a, i) => ({ label: tsaShort(a.name), color: colours[i % 2] }))} />
        <span className="text-xs text-muted">Dashed amber line: the 15-minute target</span>
      </div>
    </div>
  );
}

/* ── Batch drawer ──────────────────────────────────────────── */

export function BatchDrawer({ batch, authorities, onClose }: { batch?: ViewBatch; authorities: TsaAuthority[]; onClose: () => void }) {
  const orgId = useOrgId();
  const [re, setRe] = useState<{ root: string; count: number; hashes: string[] }>();
  useEffect(() => {
    setRe(undefined);
    if (!batch) return;
    const t = window.setTimeout(() => setRe(recomputeRoot(orgId, batch.firstSeq, batch.lastSeq)), 30);
    return () => window.clearTimeout(t);
  }, [batch, orgId]);
  if (!batch) return null;
  const download = () => downloadText(`anchor-batch-${batch.id}.json`, JSON.stringify({ ...batch, leaves: re?.hashes ?? [] }, null, 2));
  return (
    <Drawer open onClose={onClose} kicker={batch.onDemand ? 'Merkle batch · on demand' : 'Merkle batch · 15 minutes'} title={`${seqLabel(batch.firstSeq)}–${seqLabel(batch.lastSeq)}`} width={640}
      actions={<Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={download}>JSON</Button>}>
      <KeyValue items={[
        { k: 'Window', v: `${dateTime(batch.windowStart)} – ${timeShort(batch.windowEnd)}` },
        { k: 'Records', v: <>{n(batch.count)} · <ReceiptLink seq={batch.firstSeq} /> to <ReceiptLink seq={batch.lastSeq} /></> },
        { k: 'Merkle root (RFC 6962)', v: <Hash value={batch.root} len={24} /> },
        ...(batch.recordedSeq ? [{ k: 'Recorded as', v: <ReceiptLink seq={batch.recordedSeq} /> }] : []),
      ]} />
      <div className="mt-5">
        <p className="label mb-2">Root recomputed here from the chain</p>
        {!re ? <p className="text-sm text-muted inline-flex items-center gap-2"><Spinner /> Hashing {n(batch.count)} receipts…</p> : (
          <div className="space-y-2 text-sm">
            <Check ok={re.root === batch.root && re.count === batch.count} yes="Same root, same number of records" no="The root does not match the chain" />
            <p className="text-muted">Leaves are the {n(re.count)} receipt hashes in order; leaf hash SHA-256(0x00 ‖ hash), node hash SHA-256(0x01 ‖ left ‖ right).</p>
          </div>
        )}
      </div>
      <div className="mt-6">
        <p className="label mb-2">Timestamps from {batch.tokens.length} authorities</p>
        <TokenCards tokens={batch.tokens} authorities={authorities} root={batch.root} />
      </div>
      {batch.onDemand && batch.covered && <Banner className="mt-5" tone="neutral">The regular 15-minute batch has since timestamped these records as well. Both stay valid.</Banner>}
    </Drawer>
  );
}

/* ── Inclusion proof lookup ────────────────────────────────── */

type ProofView = Omit<InclusionProof, 'verified'> & { verified?: boolean; onDemand?: boolean };

export function InclusionLookup({ initialSeq, onDemand, authorities, sealedFromSeq }: { initialSeq?: number; onDemand: ViewBatch[]; authorities: TsaAuthority[]; sealedFromSeq?: number }) {
  const orgId = useOrgId();
  const [q, setQ] = useState(initialSeq ? String(initialSeq) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [proof, setProof] = useState<ProofView>();

  const run = async (raw = q) => {
    const seq = Number(raw.replace(/[#,\s]/g, ''));
    setErr(undefined); setProof(undefined);
    if (!seq) { setErr('Enter a receipt number, for example 4097.'); return; }
    setBusy(true);
    try {
      setProof(await api.inclusionProof(orgId, seq));
    } catch (e) {
      const od = onDemand.find((b) => seq >= b.firstSeq && seq <= b.lastSeq);
      if (od) {
        try { setProof({ ...onDemandProof(orgId, od, seq), onDemand: true }); } catch (e2) { setErr((e2 as Error).message); }
      } else setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  useEffect(() => { if (initialSeq) { setQ(String(initialSeq)); void run(String(initialSeq)); } }, [initialSeq, orgId]);

  return (
    <div>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <Field label="Receipt number" htmlFor="ip-seq" className="flex-1 min-w-[180px]" hint={sealedFromSeq ? `Sealed and timestamped from ${seqLabel(sealedFromSeq)}.` : undefined}>
          <Input id="ip-seq" mono inputMode="numeric" value={q} onChange={(e) => setQ(e.target.value)} placeholder="#4097" />
        </Field>
        <Button type="submit" variant="primary" icon={<Search className="h-4 w-4" />} loading={busy}>Get the proof</Button>
      </form>
      {err && <Banner className="mt-4" tone="neutral" title="No inclusion proof for that receipt">{err}</Banner>}
      {proof && (
        <div className="mt-5 space-y-5">
          <KeyValue items={[
            { k: 'Receipt', v: <ReceiptLink seq={proof.seq} /> },
            { k: 'Receipt hash', v: <Hash value={proof.receiptHash} len={20} /> },
            { k: 'Batch', v: <span className="font-mono text-[12px]">{proof.batchId}{proof.onDemand ? ' · on demand' : ''}</span> },
          ]} />
          <ProofSteps receiptHash={proof.receiptHash} path={proof.path} root={proof.root} leafIndex={proof.leafIndex} treeSize={proof.treeSize} />
          <div>
            <p className="label mb-2">The root was timestamped by</p>
            <TokenCards tokens={proof.tokens} authorities={authorities} root={proof.root} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadText(`inclusion-proof-${proof.seq}.json`, JSON.stringify(proof, null, 2))}>Download the proof (JSON)</Button>
            <Link to={`/activity/${proof.seq}`} className="inline-flex items-center h-8 px-3 text-sm border border-line hover:border-fg">Open the receipt</Link>
          </div>
        </div>
      )}
    </div>
  );
}
