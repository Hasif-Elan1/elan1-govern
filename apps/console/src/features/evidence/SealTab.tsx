import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleSlash, OctagonX, Play, Search } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId } from '@/store/session';
import { runTestVectors, SEAL_FIELDS } from '@/lib/seal';
import { LEVEL_INFO } from '@/lib/levels';
import { dateTime, n, seqLabel } from '@/lib/format';
import type { LevelId, TestVector, TestVectorGroup, TestVectorSuite } from '@/types';
import { Badge, Banner, Button, DataTable, Field, Hash, Input, KeyValue, Panel, Segmented, Skeleton, StatusChip, toast, type Column } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { PreviewMark } from './levelGate';

const GROUP_LABEL: Record<TestVectorGroup, string> = { structure: 'Structure', chain: 'Chain', merkle_anchor: 'Merkle and anchor', negative: 'Must reject' };

function PassChip({ ok }: { ok: boolean }) {
  return ok ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Pass</StatusChip> : <StatusChip tone="bad" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>Fail</StatusChip>;
}

export function SealTab({ level, headSeq }: { level: LevelId; headSeq?: number }) {
  const sealed = level !== 'l1';
  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-7 space-y-6"><TestVectorsPanel preview={!sealed} /></div>
      <div className="lg:col-span-5 space-y-6">
        <SealLookup headSeq={headSeq} />
        <Panel title="The 16 frozen fields" kicker="Seal v6 · SHA-256 over a length-prefixed preimage, Ed25519" flush>
          <ol className="divide-y divide-line text-sm">
            {SEAL_FIELDS.map((f) => (
              <li key={f.id} className="px-5 py-2 grid grid-cols-[40px_minmax(0,1fr)] gap-2">
                <span className="font-mono text-[12px] text-muted">{f.id}</span>
                <span className="min-w-0"><span className="font-mono text-[12.5px]">{f.name}</span><span className="block text-xs text-muted">{f.description}</span></span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}

function TestVectorsPanel({ preview }: { preview: boolean }) {
  const { data, loading, error, refetch } = useQuery(() => api.testVectors(), [], { live: false });
  const [local, setLocal] = useState<{ suite: TestVectorSuite; ms: number }>();
  const [running, setRunning] = useState(false);
  const [group, setGroup] = useState<'all' | TestVectorGroup>('all');
  const suite = local?.suite ?? data;
  const rows = useMemo(() => suite?.vectors.filter((v) => group === 'all' || v.group === group), [suite, group]);

  const rerun = () => {
    setRunning(true);
    window.setTimeout(() => {
      const t0 = performance.now();
      const s = runTestVectors();
      const ms = Math.round(performance.now() - t0);
      setLocal({ suite: s, ms });
      setRunning(false);
      toast.ok(`${s.summary.typescript} of ${s.summary.total} vectors pass in this browser`, `${n(ms)} ms. Digests checked by two encoders.`);
    }, 30);
  };

  const cols: Column<TestVector>[] = [
    { key: 'id', header: 'Vector', cell: (v) => <span className="font-mono text-[12px] whitespace-nowrap">{v.id}</span>, width: 72 },
    { key: 'title', header: 'Case', cell: (v) => <span className="text-sm">{v.title}<span className="block text-xs text-muted">{GROUP_LABEL[v.group]} · expect {v.expect}</span></span> },
    { key: 'expected', header: 'Expected', cell: (v) => (v.expect === 'accept' ? <Hash value={v.expected} len={10} /> : <span className="text-xs text-muted">Rejected</span>), hideBelow: 'md' },
    { key: 'ts', header: 'TypeScript', cell: (v) => <PassChip ok={v.results.typescript === 'pass'} /> },
    { key: 'py', header: 'Python', cell: (v) => <PassChip ok={v.results.python === 'pass'} />, hideBelow: 'sm' },
    { key: 'agree', header: 'Same bytes', cell: (v) => (v.agree ? <span className="text-sm">Yes</span> : <span className="text-sm text-bad-fg">No</span>), hideBelow: 'sm' },
  ];

  return (
    <Panel title="Two implementations agree" kicker={suite ? `${suite.version} · ${suite.summary.total} vectors` : 'Seal v6 test vectors'} flush
      actions={<>{preview && <PreviewMark to="l2" />}<Button size="sm" icon={<Play className="h-3.5 w-3.5" />} loading={running} onClick={rerun}>Run again here</Button></>}>
      {error && <div className="p-5"><Banner tone="bad" title="The vectors could not be run" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner></div>}
      {loading && !suite ? <div className="p-5"><Skeleton className="h-40" /></div> : suite && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-line border-b border-line">
            <div className="bg-surface p-4"><p className="label">TypeScript</p><p className="mt-1 font-display text-2xl font-semibold num">{suite.summary.typescript}/{suite.summary.total}</p><p className="text-xs text-muted">run in this browser</p></div>
            <div className="bg-surface p-4"><p className="label">Python</p><p className="mt-1 font-display text-2xl font-semibold num">{suite.summary.python}/{suite.summary.total}</p><p className="text-xs text-muted">recorded run</p></div>
            <div className="bg-surface p-4"><p className="label">Byte for byte</p><p className="mt-1 font-display text-2xl font-semibold num">{suite.summary.agree}/{suite.summary.total}</p><p className="text-xs text-muted">same digests</p></div>
            <div className="bg-surface p-4"><p className="label">By group</p><p className="mt-1 text-sm num">{(Object.keys(GROUP_LABEL) as TestVectorGroup[]).map((g) => suite.summary.byGroup[g]).join(' · ')}</p><p className="text-xs text-muted">structure · chain · Merkle · reject</p></div>
          </div>
          <div className="px-5 py-3 border-b border-line space-y-1.5 text-xs text-muted">
            {suite.implementations.map((im) => (
              <p key={im.id}><span className="font-medium text-fg">{im.name} {im.version}</span> — {im.id === 'typescript' && local ? `run in this browser just now (${n(local.ms)} ms)` : im.source}, {dateTime(im.ranAt)}. {im.how}</p>
            ))}
            {preview && <p>Seal v6 starts at L2 Attested; at L1 these vectors show what the seal code does, but no record here is sealed.</p>}
          </div>
          <div className="px-5 py-3 border-b border-line overflow-x-auto">
            <Segmented size="sm" label="Filter vectors" value={group} onChange={setGroup} options={[
              { value: 'all', label: 'All', count: suite.summary.total },
              ...(Object.keys(GROUP_LABEL) as TestVectorGroup[]).map((g) => ({ value: g, label: GROUP_LABEL[g], count: suite.summary.byGroup[g] })),
            ]} />
          </div>
          <DataTable caption="Seal v6 test vectors" className="border-0" columns={cols} rows={rows} rowKey={(v) => v.id} maxHeight={560} />
        </>
      )}
    </Panel>
  );
}

type SealResult = Awaited<ReturnType<typeof api.seal>>;

function SealLookup({ headSeq }: { headSeq?: number }) {
  const orgId = useOrgId();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [res, setRes] = useState<SealResult>();
  useEffect(() => { setRes(undefined); setErr(undefined); if (headSeq) setQ(String(headSeq)); }, [orgId, headSeq]);
  const go = async () => {
    const seq = Number(q.replace(/[#,\s]/g, ''));
    setErr(undefined); setRes(undefined);
    if (!seq) { setErr('Enter a receipt number.'); return; }
    setBusy(true);
    try { setRes(await api.seal(orgId, seq)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Panel title="Seal of one receipt" kicker="Recomputed and checked here">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <Field label="Receipt number" htmlFor="seal-seq" className="flex-1 min-w-[160px]"><Input id="seal-seq" mono inputMode="numeric" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Button type="submit" icon={<Search className="h-4 w-4" />} loading={busy}>Show the seal</Button>
      </form>
      {err && <Banner className="mt-4" tone="bad">{err}</Banner>}
      {res && !res.sealed && (
        <Banner className="mt-4" tone="neutral" title={`${seqLabel(res.receipt.seq)} — L1: sealed in a hash chain, no Seal v6 record`}>{res.reason}</Banner>
      )}
      {res && res.sealed && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {(['structure', 'digest', 'signature', 'binding'] as const).map((k) => (
              res.check[k]
                ? <StatusChip key={k} tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>{k[0].toUpperCase() + k.slice(1)}</StatusChip>
                : <StatusChip key={k} tone="bad" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>{k[0].toUpperCase() + k.slice(1)} fails</StatusChip>
            ))}
            {res.payloadUnbound && <StatusChip tone="neutral" size="sm" icon={<CircleSlash className="h-3 w-3" aria-hidden />}>Payload unbound (erased)</StatusChip>}
            <Badge>Sealed at {LEVEL_INFO[res.seal.level].label}</Badge>
          </div>
          <KeyValue items={[
            { k: 'Receipt', v: <ReceiptLink seq={res.seal.seq} /> },
            { k: 'Digest', v: <Hash value={res.seal.digest} len={18} /> },
            { k: 'Preimage', v: `${n(res.seal.preimageBytes)} bytes` },
            { k: 'Key', v: res.seal.kid, mono: true },
            { k: 'Signature', v: <Hash value={res.seal.sig} len={18} /> },
          ]} />
          <details>
            <summary className="cursor-pointer text-sm font-medium">The 16 field values</summary>
            <ol className="mt-2 border border-line divide-y divide-line text-[12px]">
              {res.seal.fields.map((f) => <li key={f.id} className="px-3 py-1.5 grid grid-cols-[36px_minmax(0,1fr)] gap-2"><span className="font-mono text-muted">{f.id}</span><span className="min-w-0"><span className="text-muted">{f.name} </span><span className="font-mono break-all">{f.value || '—'}</span></span></li>)}
            </ol>
          </details>
        </div>
      )}
    </Panel>
  );
}
