import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArrowUpRight, Database, Download, Eraser, FileJson, FlaskConical, Timer } from 'lucide-react';
import { api } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useRole, useUser, useOrgLevel } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { date, n, plural } from '@/lib/format';
import { Banner, Button, Dialog, Input, Field, LegalDraft, Panel, Select, Skeleton, Stat, Switch, toast } from '@/components/ui';
import { ReadOnlyNote, SectionHeader, SettingRow, UpgradePath, downloadFile, errText, receiptNote } from '../shared';
import { MIN_RETENTION_YEARS, orgApi } from '../orgApi';
import { useCanDo } from '../permissions';
import { ExportPackDialog } from '@/features/evidence/ExportPackDialog';
import { SmartLink } from '@/shell/access';

export function DataSection() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const level = useOrgLevel();
  const l2 = atLeast(level, 'l2');
  const canEdit = useCanDo('data.retention');
  const canExport = useCan('evidence.export');
  const canConfig = useCan('members.manage');
  const [confirmOff, setConfirmOff] = useState(false);
  const [typed, setTyped] = useState('');
  const { data, loading } = useQuery((o) => api.evidence(o), [], { kinds: ['checkpoint', 'key'] });
  const { data: policy, error: policyErr, refetch } = useQuery((o) => orgApi.dataPolicy(o), [], { kinds: ['settings', 'receipt'] });
  const { data: dep } = useQuery((o) => api.deployment(o), [], { kinds: ['deployment', 'key'] });
  const { data: residency } = useQuery((o) => api.residency(o), [], { kinds: ['deployment', 'key'] });
  const { data: erasures } = useQuery((o) => api.erasures(o), [], { kinds: ['erasure', 'receipt'] });
  const setReplay = useMutation(orgApi.setReplay);
  const setRetention = useMutation(orgApi.setRetention);
  // the evidence export is the guarded export dialog (ZIP, size split, residency and consent checks, charge shown first)
  const [exportOpen, setExportOpen] = useState(false);
  const exportConfig = useMutation(orgApi.exportConfiguration);

  const replay = async (on: boolean) => {
    if (!on) { setTyped(''); setConfirmOff(true); return; }
    if (!user) return;
    try { const r = await setReplay.mutate(orgId, true, user.id); toast.ok('Replay store on', `New calls are kept, encrypted, for 30 days. ${receiptNote(r.seq)}`); } catch (e) { toast.bad('Not changed', errText(e)); }
  };
  const turnOff = async () => {
    if (!user) return;
    try {
      const r = await setReplay.mutate(orgId, false, user.id);
      setConfirmOff(false);
      toast.held('Replay store off', `${plural(r.rows, 'stored call')} deleted. ${receiptNote(r.seq)}`);
    } catch (e) { toast.bad('Not changed', errText(e)); }
  };
  const retention = async (v: string) => {
    if (!user) return;
    try { const r = await setRetention.mutate(orgId, Number(v), user.id); toast.ok(`Receipts kept for ${v} years`, receiptNote(r.seq)); } catch (e) { toast.bad('Not changed', errText(e)); }
  };
  const doExportConfig = async () => {
    if (!user) return;
    try { const r = await exportConfig.mutate(orgId, user.id); downloadFile(r.filename, r.json); toast.ok('Configuration downloaded', receiptNote(r.seq)); } catch (e) { toast.bad('Export failed', errText(e)); }
  };

  const years = Math.max(MIN_RETENTION_YEARS, policy?.retention.years ?? MIN_RETENTION_YEARS);
  const lockYears = policy?.lock.mode === 'compliance' ? policy.lock.years : 0;
  const openErasures = erasures?.requests.filter((r) => r.status === 'awaiting_approval' || r.status === 'approved').length ?? 0;

  return (
    <div>
      <SectionHeader
        title="Data and retention"
        description="What Elan1 Govern keeps, for how long, where, and how to take it all with you. Retention is set and recorded (control EG-19)."
        marks={<LegalDraft />}
      />
      {!canEdit && <ReadOnlyNote role={role} who="Owners and admins" />}
      {policyErr && <Banner tone="bad" className="mb-6" title="Data settings could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{policyErr.message}</Banner>}

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 mb-6">
        <Stat label="Receipts" value={loading && !data ? '—' : n(data?.total ?? 0)} sub={data ? `Since ${date(data.first.ts)}` : undefined} />
        <Stat label="Checkpoints" value={loading && !data ? '—' : n(data?.checkpoints.length ?? 0)} sub={l2 ? 'Signed chain heads' : 'Sealed chain heads'} />
        <Stat label="Retention" value={policy ? `${years} y` : '—'} sub={lockYears ? `Write-once lock ${lockYears} y` : 'Receipts and checkpoints'} />
        <Stat label="Replay store" value={policy ? (policy.replay.on ? 'On' : 'Off') : '—'} sub={policy?.replay.on ? `${n(policy.storedCalls)} calls, 30 days` : 'Nothing stored'} />
      </div>

      <div className="grid gap-6 xl:grid-cols-12">
        <div className="xl:col-span-8 space-y-6 min-w-0">
          <Panel title={<span className="inline-flex items-center gap-2"><FlaskConical className="h-4 w-4" aria-hidden />Replay store</span>}>
            <SettingRow label="Keep past arguments for replay" help="Test on past actions replays an encrypted 30-day store of past arguments. Receipts keep only an argument summary and hash either way.">
              {!policy ? <Skeleton className="h-8 w-40" /> : canEdit ? <Switch label="Replay store" checked={policy.replay.on} disabled={setReplay.pending} onChange={replay} /> : <p className="text-sm font-medium">{policy.replay.on ? 'On' : 'Off'}</p>}
              {policy && !policy.replay.on && <Banner tone="held" className="mt-3">Stored arguments were deleted{policy.replay.clearedRows !== undefined && <> ({plural(policy.replay.clearedRows, 'call')})</>}. New calls start filling the store from the moment it is switched on.</Banner>}
              <p className="mt-3 text-xs text-muted">Used by <Link to="/rulebooks" className="link">Rulebooks → Test on past actions</Link> (7 or 30 days; writes no receipt).</p>
            </SettingRow>
          </Panel>

          <Panel title={<span className="inline-flex items-center gap-2"><Archive className="h-4 w-4" aria-hidden />Retention</span>}>
            <SettingRow label="Receipt retention" htmlFor="ret-years" help={lockYears ? `Receipts are written under ${policy?.lock.backend} in compliance mode for ${lockYears} years: nobody, including elan1, can delete them sooner, so retention cannot be shorter.` : `Receipts, checkpoints and ${l2 ? 'signed' : 'sealed'} rulebook versions. Never shorter than ${MIN_RETENTION_YEARS} years: proof is kept at least as long as the books of account it evidences (MCA). Shortening it never deletes receipts inside a checkpoint range still under audit.`}>
              {canEdit ? (
                <Select id="ret-years" value={String(years)} disabled={!policy || setRetention.pending} onChange={(e) => retention(e.target.value)}>
                  {['8', '10', '12'].map((y) => <option key={y} value={y} disabled={Number(y) < lockYears}>{y} years{y === '8' ? ' — Indian books of account (the minimum)' : ''}{Number(y) < lockYears ? ' (below the lock)' : ''}</option>)}
                </Select>
              ) : <p className="text-sm font-medium">{policy ? `${years} years` : '…'}</p>}
              <p className="mt-2 text-xs text-muted">Shorter periods are not offered: proof is kept for at least {MIN_RETENTION_YEARS} years, as the MCA requires for books of account.</p>
              {policy?.retention.updatedAt && <p className="mt-2 text-xs text-muted">Last changed {date(policy.retention.updatedAt)}.</p>}
            </SettingRow>
            <SettingRow label="Held-action arguments" help="Full arguments of a held action are encrypted while it waits, and wiped when it is decided or expires. The receipt keeps the summary and hash.">
              <p className="text-sm font-medium inline-flex items-center gap-1.5"><Timer className="h-4 w-4 text-muted" aria-hidden />Wiped on decision or expiry</p>
            </SettingRow>
            <SettingRow label="Personal data erasure (DPDP)" help="From the first L1 record, personal data is hashed with a per-record salt. Destroying the salt makes the hash unlinkable to the person; the chain still verifies. Available at every level.">
              <p className="text-sm inline-flex items-center gap-1.5"><Eraser className="h-4 w-4 text-muted" aria-hidden />Two approvers, a 72-hour clock, then salt destruction.</p>
              <p className="mt-1 text-xs text-muted">{erasures ? <>{plural(openErasures, 'request')} open · {plural(erasures.destroyedSalts, 'salt')} destroyed so far</> : '…'}</p>
              <Link to="/records/erasure" className="mt-2 inline-flex items-center gap-1 text-sm link">Open erasure requests<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
            </SettingRow>
          </Panel>
        </div>

        <div className="xl:col-span-4 space-y-6 min-w-0">
          <Panel title={<span className="inline-flex items-center gap-2"><Database className="h-4 w-4" aria-hidden />Take it with you</span>}>
            <p className="text-sm text-muted">{l2 ? 'The 8-member evidence bundle as a ZIP: receipts, seals, checkpoints, timestamps with Merkle proofs, public keys, declarations, the verifier profile and VERIFY.txt. The residency, consent and declarations checks come first, a long chain is split into parts, and you can verify it yourself before it is generated. The offline verifier reads it. ₹2,500 per bundle, shown before you generate it.' : 'The auditor pack as a ZIP: every receipt in the hash chain, the sealed checkpoints and the public keys, a PDF summary, a compliance map and a README, under a sealed manifest that lists each file’s SHA-256. Sealed in a hash chain by Elan1 Govern, not yet externally timestamped. Free.'}</p>
            {canExport && <Button className="mt-4" variant="primary" block icon={<Download className="h-4 w-4" />} onClick={() => setExportOpen(true)}>{l2 ? 'Export the evidence bundle' : 'Export the auditor pack'}</Button>}
            {canConfig && <Button className="mt-2" variant="secondary" block icon={<FileJson className="h-4 w-4" />} loading={exportConfig.pending} onClick={doExportConfig}>Export configuration</Button>}
            <p className="mt-3 text-xs text-muted">The configuration file holds settings, members, agents and rulebooks — not evidence. Credentials are withheld. Each export is a receipt. For a range, use <Link to="/assurance/exports" className="link">Exports</Link>.</p>
          </Panel>
          <Panel title="Where data lives" tone="sunken">
            {!dep || !residency ? <Skeleton className="h-40" /> : (
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-muted shrink-0">Residency domain</dt><dd className="text-right">{residency.domain}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted shrink-0">Receipts and approvals</dt><dd className="text-right">{dep.database.engine}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted shrink-0">Evidence store</dt><dd className="text-right">{dep.storage.backend}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted shrink-0">Write-once lock</dt><dd className="text-right">{dep.storage.objectLock === 'compliance' ? `Compliance mode, ${dep.storage.retentionYears} years` : 'Versioned, no compliance lock'}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted shrink-0">{l2 ? 'Signing key' : 'Sealing key'}</dt><dd className="text-right">Ed25519 · {dep.hsm.provider}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted shrink-0">Timestamps</dt><dd className="text-right">{dep.tsa.length ? dep.tsa.map((t) => t.name).join(' and ') : 'None at L1'}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted shrink-0">Backups</dt><dd className="text-right">{dep.backup.site}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted shrink-0">Held arguments</dt><dd className="text-right">Encrypted, then wiped</dd></div>
              </dl>
            )}
            <SmartLink to="/agents/organisation?tab=residency" hideWhenBlocked className="mt-4 inline-flex items-center gap-1 text-sm link">Residency statement<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></SmartLink>
          </Panel>
          {!l2 && <UpgradePath to="l2">Write-once storage (S3 Object Lock), keys in AWS KMS and timestamps from two authorities start at L2.</UpgradePath>}
        </div>
      </div>

      <ExportPackDialog open={exportOpen} onClose={() => setExportOpen(false)} title={l2 ? 'Export the evidence bundle' : 'Export the auditor pack'} />

      <Dialog open={confirmOff}onClose={() => setConfirmOff(false)} tone="danger" title="Switch off the replay store"
        description="This deletes the stored past arguments now. It cannot be undone."
        footer={<><Button variant="ghost" onClick={() => setConfirmOff(false)}>Cancel</Button><Button variant="danger" loading={setReplay.pending} disabled={typed !== 'DELETE'} onClick={turnOff}>Delete and switch off</Button></>}>
        <div className="space-y-4 text-sm">
          <ul className="list-[square] pl-5 space-y-1 text-muted">
            <li>{policy ? plural(policy.storedCalls, 'stored call') : 'Stored calls'} deleted; Test on past actions has nothing to replay.</li>
            <li>Receipts are not affected — they never held full arguments.</li>
            <li>Switching it on again starts an empty store.</li>
          </ul>
          <Field label={<>Type <span className="font-mono font-semibold">DELETE</span> to confirm</>} htmlFor="replay-confirm">
            <Input id="replay-confirm" mono value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="DELETE" data-autofocus />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
