import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, CircleSlash, FlaskConical, Hourglass, PackageCheck, Settings2, XCircle } from 'lucide-react';
import type { AdmissionGate, LevelId, RegulatoryPack } from '@/types';
import { api } from '@/api';
import { useOrgId, useRole, useUser } from '@/store/session';
import { LEVEL_INFO } from '@/lib/levels';
import { rupees } from '@/lib/format';
import { Banner, Button, Checkbox, Dialog, Field, Input, StatusChip, toast } from '@/components/ui';
import { ensurePackConnectors, PACK_CONNECTORS } from '@/features/connectors/ops';
import { PACK_PARAMS, configurePack, packConfig } from './config';

export function GateChip({ gate }: { gate: Pick<AdmissionGate, 'state'> }) {
  return gate.state === 'met'
    ? <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Met</StatusChip>
    : gate.state === 'provisional'
      ? <StatusChip size="sm" tone="held" icon={<Hourglass className="h-3 w-3" aria-hidden />}>Provisional</StatusChip>
      : <StatusChip size="sm" tone="bad" icon={<XCircle className="h-3 w-3" aria-hidden />}>Not met</StatusChip>;
}

export function InstalledChip({ pack }: { pack: Pick<RegulatoryPack, 'installed' | 'dryRun'> }) {
  return pack.installed && pack.dryRun ? <DryRunChip /> : pack.installed
    ? <StatusChip size="sm" tone="ok" icon={<PackageCheck className="h-3 w-3" aria-hidden />}>Installed</StatusChip>
    : <StatusChip size="sm" tone="neutral" icon={<CircleSlash className="h-3 w-3" aria-hidden />}>Not installed</StatusChip>;
}

/** Why the current person cannot install, or undefined when they can. Packs install from L1 as a dry run. */
export function installBlock(_level: LevelId, role: string | undefined): string | undefined {
  if (role !== 'owner' && role !== 'admin') return 'Owners and admins install packs. Your role can read them.';
  return undefined;
}

/** Below L2 a pack is a dry run: its rules run and its reports are produced, with no regulatory claim and no charge. */
export function DryRunChip() {
  return <StatusChip size="sm" tone="info" icon={<FlaskConical className="h-3 w-3" aria-hidden />}>Dry run</StatusChip>;
}

export const DRY_RUN_LINE = `Dry run — no regulatory claim until ${LEVEL_INFO.l2.label}.`;

export function InstallDialog({ pack, open, onClose }: { pack: RegulatoryPack; open: boolean; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const role = useRole();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  // from L2 the verifier profile is its own ₹3,00,000 line; an owner can order it with the pack
  const canOrder = !pack.dryRun && role === 'owner';
  const [orderToo, setOrderToo] = useState(true);
  useEffect(() => { if (open) { setErr(undefined); setOrderToo(true); } }, [open]);
  const go = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      await api.installPack(orgId, pack.id, user.id);
      const added = ensurePackConnectors(orgId, user.id);
      let ordered = false;
      if (canOrder && orderToo) {
        const lc = await api.profileLifecycle(orgId, pack.profileId);
        if (!lc.entitlement.ordered) { await api.orderProfile(orgId, pack.profileId, user.id); ordered = true; }
      }
      toast.ok(pack.dryRun ? `${pack.name} installed as a dry run` : `${pack.name} installed`, `${pack.dryRun ? 'Its rules run and its reports are marked dry run, with no regulatory claim until L2.' : ordered ? 'Declaration, verifier profile and export are on; the profile is ordered on its own line.' : 'Declaration and export are on. Order the verifier profile before it is run or claimed.'} ${added.length ? `Its connector was added in demo mode.` : ''}`, { label: `Open ${pack.name}`, onClick: () => nav(`/records/packs/${pack.id}`) });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={pack.dryRun ? `Install ${pack.name} as a dry run?` : `Install ${pack.name}?`} description={pack.regime}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={go}>{pack.dryRun ? 'Install as a dry run' : `Install for ${rupees(pack.price)} a year`}</Button></>}>
      <div className="space-y-4 text-sm">
        {err && <Banner tone="bad" title="Could not install">{err}</Banner>}
        {pack.dryRun && <Banner tone="info" title={DRY_RUN_LINE}>At {LEVEL_INFO.l1.label} the declaration runs on every governed write and the reports are produced, each marked dry run. Checks that need L2 evidence, such as timestamps, read not applicable. Nothing is charged until the organisation moves to {LEVEL_INFO.l2.label}; from then the pack is live and billed.</Banner>}
        <p>{pack.summary}</p>
        <ul className="border border-line divide-y divide-line">
          <li className="px-4 py-2.5"><span className="font-medium">Declaration</span> <span className="font-mono text-muted">{pack.declaration.id} v{pack.declaration.version}</span> — {pack.declaration.writeTypes.length} write types, run through pre-write checks G1–G9.</li>
          <li className="px-4 py-2.5"><span className="font-medium">Verifier profile</span> <span className="font-mono text-muted">{pack.profileId}</span> — the auditor runs it against your evidence bundle. Billed as its own line ({rupees(300000)} a year), not included with the pack.</li>
          <li className="px-4 py-2.5"><span className="font-medium">Regime export</span> — {pack.exports.map((x) => x.label).join(', ')}.</li>
          <li className="px-4 py-2.5"><span className="font-medium">Connector</span> — {PACK_CONNECTORS[pack.id].name}, in demo mode with writes switched off.</li>
        </ul>
        <p className="text-muted">{pack.dryRun ? <>Adds a {pack.name} line of {rupees(pack.price)} a year to your invoices from the move to {LEVEL_INFO.l2.label}, not before.</> : <>Adds a {pack.name} line of {rupees(pack.price)} a year to your invoices from today.</>} Installing writes a <span className="font-mono">pack.installed</span> receipt.</p>
        {canOrder && <Checkbox id={`order-${pack.id}`} checked={orderToo} onChange={setOrderToo} label={`Also order the verifier profile ${pack.profileId} (${rupees(300000)} a year)`} description="Without an order the profile cannot be run against the chain or claimed in a bundle. Writes a billing.addon_ordered receipt." />}
        {!pack.dryRun && !canOrder && <p className="text-xs text-muted">The verifier profile is ordered separately by an owner before it is run or claimed.</p>}
      </div>
    </Dialog>
  );
}

export function ConfigureDialog({ pack, open, onClose }: { pack: RegulatoryPack; open: boolean; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const params = PACK_PARAMS[pack.id];
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    if (!open) return;
    const cur = packConfig(orgId, pack.id).values;
    setVals(Object.fromEntries(params.map((p) => [p.id, String(cur[p.id])])));
    setErr(undefined);
  }, [open, orgId, pack.id, params]);
  const go = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await configurePack(orgId, pack.id, Object.fromEntries(params.map((p) => [p.id, Number(vals[p.id])])), user.id);
      toast.ok(`${pack.name} declaration v${r.version} saved`, 'The pre-write checks use the new parameters from the next call. The change is a receipt.');
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Configure ${pack.name}`} description="Each save is a new declaration version, recorded as a receipt. Never-skippable checks stay on."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Settings2 className="h-4 w-4" />} loading={busy} onClick={go}>Save as a new version</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Could not save">{err}</Banner>}
        {params.map((p) => (
          <Field key={p.id} label={`${p.label} (${p.unit})`} htmlFor={`pp-${p.id}`} hint={`${p.help} Between ${p.min.toLocaleString('en-IN')} and ${p.max.toLocaleString('en-IN')}.`}>
            <Input id={`pp-${p.id}`} type="number" inputMode="numeric" min={p.min} max={p.max} step={p.step} value={vals[p.id] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [p.id]: e.target.value }))} className="max-w-[220px] num" />
          </Field>
        ))}
      </div>
    </Dialog>
  );
}
