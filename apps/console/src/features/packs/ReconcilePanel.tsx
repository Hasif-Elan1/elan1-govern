import { useRef, useState } from 'react';
import { ArrowLeftRight, CheckCircle2, FileUp, MessageSquareText } from 'lucide-react';
import type { PackId } from '@/types';
import { api } from '@/api';
import { useOrgId, useRole, useUser } from '@/store/session';
import { PACK_TEMPLATE } from '@/lib/packs';
import { dateTime, n, plural } from '@/lib/format';
import { userName } from '@/mock/users';
import type { ReconRow, Reconciliation } from '@/mock/packsFactory';
import { Badge, Button, EmptyState, Panel, Select, Stat, StatusChip, Tooltip, toast } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { FormDialog } from './FormDialog';

/**
 * Two-way reconciliation (E11 test 3): the chain against the target system's own audit trail. Every change in the
 * target for the governed record types must have an elan1 record, and every committed record a change in the
 * target. A change in the target with no record is the finding that matters: it did not go through the pre-write checks.
 */
export function ReconcilePanel({ packId, installed, recons, id }: { packId: PackId; installed: boolean; recons: Reconciliation[]; id?: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [explaining, setExplaining] = useState<{ rec: Reconciliation; row: ReconRow }>();
  const [shown, setShown] = useState<string>();
  const file = useRef<HTMLInputElement>(null);
  // reconciliation runs and explanations are owner/admin writes on the client's chain
  const can = role === 'owner' || role === 'admin';
  const t = PACK_TEMPLATE[packId].target;
  const rec = recons.find((r) => r.id === shown) ?? recons[0];

  const run = async (csv?: string) => {
    if (!user) return;
    setBusy(true);
    try {
      const r = await api.reconcilePack(orgId, packId, user.id, { days: Number(days), csv });
      setShown(r.id);
      if (r.targetOnly.length || r.chainOnly.length) toast.held('Reconciled with exceptions', `${plural(r.targetOnly.length, 'change')} in ${t.name} with no record; ${plural(r.chainOnly.length, 'record')} with no change. Receipt #${r.seq}.`);
      else toast.ok('Reconciled — no exceptions', `${n(r.matched)} matched both ways. Receipt #${r.seq}.`);
    } catch (e) {
      toast.bad('The reconciliation could not run', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const onFile = async (f?: File) => {
    if (!f) return;
    const text = await f.text();
    await run(text);
    if (file.current) file.current.value = '';
  };

  const row = (r: Reconciliation, x: ReconRow, dir: 'target' | 'chain') => {
    const ex = r.explained[x.key];
    return (
      <li key={x.key} className="px-5 py-2.5 grid gap-x-4 gap-y-1 sm:grid-cols-[1fr_auto] items-start text-sm">
        <span className="min-w-0">
          <span className="font-mono text-[12.5px]">{x.recordId}</span> <span className="text-muted">· {x.type} · {dateTime(x.at)} · {x.by}</span>{x.seq !== undefined && <> · <ReceiptLink seq={x.seq} /></>}
          {ex && <span className="block text-xs text-muted mt-0.5">Explained by {userName(ex.by)} <When iso={ex.at} />{ex.seq !== undefined && <> · <ReceiptLink seq={ex.seq} /></>}: {ex.note}</span>}
        </span>
        {ex ? <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Explained</StatusChip>
          : can ? <Button size="sm" variant="ghost" icon={<MessageSquareText className="h-3.5 w-3.5" />} onClick={() => setExplaining({ rec: r, row: x })}>{dir === 'target' ? 'Explain' : 'Explain'}</Button>
          : <StatusChip size="sm" tone="held">Not explained</StatusChip>}
      </li>
    );
  };

  return (
    <Panel id={id} kicker={`E11 test 3 · against ${t.name}`} title="Two-way reconciliation" flush
      // owners and admins run it (a write on the chain); other roles read the runs
      actions={can ? (
        <>
          <label htmlFor={`rc-days-${packId}`} className="sr-only">Period</label>
          <Select id={`rc-days-${packId}`} size_="sm" value={days} onChange={(e) => setDays(e.target.value)} className="w-[130px]">
            <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
          </Select>
          <input ref={file} type="file" accept=".csv,text/csv" className="sr-only" id={`rc-file-${packId}`} onChange={(e) => onFile(e.target.files?.[0])} aria-label={`Load ${t.name}'s audit-trail export (CSV)`} />
          <Tooltip content={!installed ? 'Install the pack first' : `Load ${t.name}’s own audit-trail export: a CSV with record_id, changed_at, changed_by, change`}>
            <Button size="sm" variant="ghost" icon={<FileUp className="h-3.5 w-3.5" />} disabled={!installed || busy} onClick={() => file.current?.click()}>Load a CSV</Button>
          </Tooltip>
          <Tooltip content={!installed ? 'Install the pack first' : `Read ${t.trail} through its connector and compare both ways`}>
            <Button size="sm" variant="secondary" icon={<ArrowLeftRight className="h-3.5 w-3.5" />} loading={busy} disabled={!installed} onClick={() => run()}>Reconcile</Button>
          </Tooltip>
        </>
      ) : undefined}
      footer={<>Exceptions in the first direction — a change in {t.name} with no record — are changes that did not go through the pre-write checks or the rules. Each run and each explanation is a receipt.</>}>
      {!rec ? (
        <EmptyState compact title="Not reconciled yet" disc="trail">Compare the chain with {t.trail}. At L1 this is the check that does the real work: it is the only one that does not depend on trusting the chain itself.</EmptyState>
      ) : (
        <>
          <div className="px-5 py-3 border-b border-line flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Run <When iso={rec.at} /> by {userName(rec.by)}{rec.seq !== undefined && <> · <ReceiptLink seq={rec.seq} /></>} · {rec.source === 'upload' ? 'uploaded export' : 'via the connector'} · {rec.target}</span>
            {recons.length > 1 && (
              <Select size_="sm" aria-label="Earlier runs" value={rec.id} onChange={(e) => setShown(e.target.value)} className="ml-auto w-[200px]">
                {recons.map((r) => <option key={r.id} value={r.id}>{dateTime(r.at)}</option>)}
              </Select>
            )}
          </div>
          <div className="grid gap-px bg-line grid-cols-2 lg:grid-cols-4">
            <Stat className="!border-0" label="Committed records" value={n(rec.chainCommitted)} sub={`${dateTime(rec.from)} – ${dateTime(rec.to)}`} />
            <Stat className="!border-0" label={`Changes in ${t.name}`} value={n(rec.targetChanges)} />
            <Stat className="!border-0" label="Matched both ways" value={n(rec.matched)} />
            <Stat className="!border-0" label="Exceptions" value={n(rec.targetOnly.length + rec.chainOnly.length)} sub={`${Object.keys(rec.explained).length} explained`} />
          </div>
          <div className="border-t border-line">
            <p className="px-5 pt-3 pb-1 text-sm font-medium flex items-center gap-2">In {t.name}, with no record <Badge tone={rec.targetOnly.length ? 'bad' : 'ok'}>{rec.targetOnly.length}</Badge></p>
            {rec.targetOnly.length ? <ul className="divide-y divide-line">{rec.targetOnly.map((x) => row(rec, x, 'target'))}</ul> : <p className="px-5 pb-3 text-sm text-muted">Every change in {t.name} for these record types has a record.</p>}
          </div>
          <div className="border-t border-line">
            <p className="px-5 pt-3 pb-1 text-sm font-medium flex items-center gap-2">On the chain, with no change in {t.name} <Badge tone={rec.chainOnly.length ? 'held' : 'ok'}>{rec.chainOnly.length}</Badge></p>
            {rec.chainOnly.length ? <ul className="divide-y divide-line">{rec.chainOnly.map((x) => row(rec, x, 'chain'))}</ul> : <p className="px-5 pb-3 text-sm text-muted">Every committed record has its change in {t.name}.</p>}
          </div>
        </>
      )}
      <FormDialog open={!!explaining} onClose={() => setExplaining(undefined)} title={`Explain ${explaining?.row.recordId ?? ''}`}
        description="The exception stays on the reconciliation; the explanation is recorded beside it, never instead of it."
        fields={[{ id: 'note', kind: 'textarea', label: 'What happened', min: 12, rows: 3, placeholder: 'Edited directly in the accounting system by the accountant at year end; outside the write path.' }]}
        submitLabel="Record the explanation"
        onSubmit={async (v) => {
          if (!user || !explaining) return;
          await api.explainReconException(orgId, explaining.rec.id, explaining.row.key, user.id, String(v.note));
          toast.ok('Explanation recorded', 'The exception keeps its place in the reconciliation.');
        }} />
    </Panel>
  );
}
