import { useEffect, useState } from 'react';
import { FileUp } from 'lucide-react';
import type { PackId } from '@/types';
import { api } from '@/api';
import { useOrgId, useUser } from '@/store/session';
import { n, plural, seqLabel } from '@/lib/format';
import type { PilotView } from '@/mock/packsFactory';
import { Banner, Button, Dialog, Field, Textarea, toast } from '@/components/ui';
import { parseFile } from '@/features/verify/bundle';

/**
 * Day 77: the auditor loads the bundle the customer exported on day 76 — the file itself, not a fresh one — on a
 * disconnected machine, runs the verifier on it, then on a tampered copy of it. The file must be the customer's: its
 * digest is checked against the export receipt. A FAIL_INTEGRITY on it stops the pack, not just the pilot.
 */
export function AirGapDialog({ open, onClose, packId, pilot, early }: { open: boolean; onClose: () => void; packId: PackId; pilot: PilotView; early?: { day: number } }) {
  const orgId = useOrgId();
  const user = useUser();
  const [file, setFile] = useState<{ name: string; bundle: unknown; records: number }>();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setFile(undefined); setReason(''); setErr(undefined); } }, [open]);

  const choose = async (f?: File) => {
    setErr(undefined);
    setFile(undefined);
    if (!f) return;
    try {
      const l = await parseFile(f);
      if (l.kind !== 'bundle' || !l.bundle) throw new Error('This file is not an evidence bundle. Choose the ZIP or JSON the customer exported on day 76.');
      setFile({ name: f.name, bundle: l.bundle, records: l.bundle.receipts?.length ?? 0 });
    } catch (e) { setErr((e as Error).message); }
  };

  const go = async () => {
    if (!user || !file) return;
    if (early && reason.trim().length < 12) { setErr('Why it is run before day 77: at least 12 characters.'); return; }
    setBusy(true); setErr(undefined);
    try {
      const v = await api.recordPilotAirGap(orgId, packId, user.id, { bundle: file.bundle, fileName: file.name, early: early ? reason : undefined });
      if (v.status === 'stopped') toast.bad('FAIL_INTEGRITY on the customer’s bundle', 'It stops the pack, not just the pilot.');
      else toast.ok('The offline run is recorded', `The customer’s bundle: exit ${v.airGap?.goodExit} ${v.airGap?.goodCode}. Its tampered copy: exit ${v.airGap?.tamperedExit} ${v.airGap?.tamperedCode}.`);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const se = pilot.selfExport;
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Day 77 · the auditor runs the verifier offline"
      description="On a disconnected machine, on the bundle the customer exported on day 76, then on a tampered copy of it. elan1 is not in the room."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!file} onClick={go}>Run and record</Button></>}>
      <div className="space-y-4 text-sm">
        {err && <Banner tone="bad" title="Not recorded">{err}</Banner>}
        {early && <Banner tone="held" title={`Day ${early.day} — planned for day 77`}>Recording it early is allowed only with the reason, and the step is marked early on the pilot.</Banner>}
        <p className="text-muted">
          The customer’s export{se?.exportSeq !== undefined && <> (receipt <span className="font-mono">{seqLabel(se.exportSeq)}</span>)</>}: {se ? `${plural(se.receipts, 'record')}, ${seqLabel(se.firstSeq)}–${seqLabel(se.lastSeq)}` : '—'}. Load that file as the customer handed it over. Its bundle digest is compared with the export receipt, so a bundle built afresh is not accepted.
        </p>
        <Field label="The customer’s bundle (ZIP or JSON)" htmlFor="ag-file">
          <input id="ag-file" type="file" accept=".zip,.json,application/zip,application/json"
            className="block w-full text-sm file:mr-3 file:h-9 file:px-3 file:border file:border-line-strong/70 file:bg-surface file:text-fg file:font-medium hover:file:border-fg"
            onChange={(e) => choose(e.target.files?.[0])} />
        </Field>
        {file && <p className="inline-flex items-center gap-2"><FileUp className="h-4 w-4 text-muted" aria-hidden /><span className="font-mono break-all">{file.name}</span><span className="text-muted num">· {n(file.records)} records</span></p>}
        {early && (
          <Field label="Why it is run before day 77" htmlFor="ag-early" hint="At least 12 characters. Kept with the step and on the receipt.">
            <Textarea id="ag-early" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
