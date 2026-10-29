import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Download, PackageMinus, Plug, Plus, Settings2 } from 'lucide-react';
import type { PackId } from '@/types';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { date, n, plural, rupees } from '@/lib/format';
import { userName } from '@/mock/users';
import { ADDON_STOP_RULE } from '@/mock/packsFactory';
import { Banner, Button, KeyValue, LegalDraft, PageHeader, Panel, Skeleton, Tooltip, toast } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { downloadText } from '@/features/records/level';
import { PACK_CONNECTORS } from '@/features/connectors/ops';
import { ConnectorStatus } from '@/features/connectors/parts';
import { PACK_PARAMS, packConfig, preGatesFor } from './config';
import { ConfigureDialog, DRY_RUN_LINE, InstallDialog, InstalledChip, installBlock } from './parts';
import { BlockIndex, BuyerBlock, DeclarationBlock, GateScoresBlock, IdentityBlock, ObligationBlock, PreGatesBlock, PromiseBlock, WriteTypesBlock, type BlockId } from './blocks';
import { ProfileBlock } from './ProfileBlock';
import { TestsBlock } from './TestsBlock';
import { PilotBlock } from './PilotBlock';
import { ReconcilePanel } from './ReconcilePanel';
import { FormDialog } from './FormDialog';
import { SmartLink } from '@/shell/access';

const IDS: PackId[] = ['ledger1', 'invoice1', 'collect1'];

/** Records › Regulatory pack — laid out as the pack factory's eleven blocks, with its export, coverage, connector and history. */
export default function PackPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const level = useOrgLevel();
  const valid = IDS.includes(id as PackId);
  const packId = id as PackId;
  const q = useQuery(async (o) => {
    if (!valid) throw new Error(`There is no pack called “${id}”. The packs are ledger1, invoice1 and collect1.`);
    const [pk, lv, cons, rs, f] = await Promise.all([api.pack(o, packId), api.level(o), api.connectors(o), api.receipts(o, { kind: 'admin', q: packId }), api.packFactory(o, packId)]);
    return { ...pk, level: lv, factory: f, connector: cons.find((c) => c.id === `con_pack_${packId}`), history: rs.items.filter((r) => (r.action?.startsWith('pack.') || r.action?.startsWith('billing.addon')) && (r.details?.pack === packId || r.details?.with_pack === packId || r.details?.profile === pk.pack.profileId)).slice(0, 14) };
  }, [id, level]);
  const [dialog, setDialog] = useState<'install' | 'configure' | 'uninstall'>();
  const [exporting, setExporting] = useState<string>();
  const l2 = atLeast(level, 'l2');
  const manager = role === 'owner' || role === 'admin';

  if (q.error) {
    return (
      <div>
        <PageHeader kicker="Records · Regulatory pack" title="Pack not found" crumbs={[{ label: 'Records', to: '/records' }, { label: 'Regulatory packs', to: '/records/packs' }, { label: id }]} />
        <Banner tone="bad" title="This pack could not be opened" actions={<Button size="sm" onClick={() => nav('/records/packs')}>All packs</Button>}>{q.error.message}</Banner>
      </div>
    );
  }
  if (!q.data) {
    return (
      <div className="space-y-6" aria-busy>
        <Skeleton className="h-4 w-48" /><Skeleton className="h-10 w-80" /><Skeleton className="h-24" />
        <div className="grid gap-6 lg:grid-cols-12"><Skeleton className="h-96 lg:col-span-8" /><Skeleton className="h-96 lg:col-span-4" /></div>
      </div>
    );
  }

  const { pack, profile, connector, history, factory: f } = q.data;
  const cfg = packConfig(orgId, pack.id);
  const gates = preGatesFor(pack.id, cfg.values, q.data.level.residency);
  const block = installBlock(level, role);
  const removed = f.removed[f.removed.length - 1];

  const doExport = async (exportId: string) => {
    if (!user) return;
    setExporting(exportId);
    try {
      const x = await api.packExport(orgId, pack.id, exportId, user.id);
      downloadText(x.filename, x.text, x.mime);
      toast.ok(`${x.filename} saved`, `${plural(x.rows, 'row')} from the chain. The export is receipt #${n(x.seq)}.`);
    } catch (e) {
      toast.bad('Could not generate the export', (e as Error).message);
    } finally {
      setExporting(undefined);
    }
  };
  const scrollTo = (el: string) => document.getElementById(el)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // which of the eleven blocks are complete in this organisation
  const states: Partial<Record<BlockId, 'ok' | 'open' | 'na'>> = {
    gate_scores: f.gates.some((g) => g.state === 'not_met') ? 'open' : f.gates.some((g) => g.state === 'provisional') ? 'open' : 'ok',
    write_types: f.tests.find((t) => t.id === 'T3')?.state === 'pass' ? 'ok' : 'open',
    profile_binding: profile?.status === 'certified' ? 'ok' : 'open',
    tests: f.tests.every((t) => t.state === 'pass' || t.state === 'not_applicable') ? 'ok' : 'open',
    pilot: !f.pilot ? 'na' : f.pilot.status === 'closed' ? 'ok' : 'open',
  };

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Records · Regulatory pack"
        crumbs={[{ label: 'Records', to: '/records' }, { label: 'Regulatory packs', to: '/records/packs' }, { label: pack.name }]}
        title={<span className="font-mono">{pack.name}</span>}
        description={pack.regime}
        meta={<><InstalledChip pack={pack} /><span className="text-sm text-muted num">{rupees(pack.price)} a year</span>{pack.installed && <span className="text-sm text-muted">· declaration <span className="font-mono">{pack.declaration.id} v{cfg.version}</span></span>}<LegalDraft /></>}
        actions={
          <>
            {profile && <SmartLink to={`/assurance/profiles?profile=${profile.id}`} hideWhenBlocked className="inline-flex items-center gap-2 h-10 px-4 font-medium border border-line-strong/70 bg-surface hover:border-fg">Verifier profile <ArrowRight className="h-4 w-4" aria-hidden /></SmartLink>}
            {/* owners and admins configure, remove and install; other roles read the pack */}
            {pack.installed ? (manager && (
              <>
                <Tooltip content="Change the declaration parameters (a new version)">
                  <Button variant="secondary" icon={<Settings2 className="h-4 w-4" />} onClick={() => setDialog('configure')}>Configure</Button>
                </Tooltip>
                <Tooltip content={f.pilot?.status === 'running' ? 'Close or stop the running pilot first' : 'Stop the declaration and the export; it is billed to the end of this month, and not from next month'}>
                  <Button variant="quiet-danger" icon={<PackageMinus className="h-4 w-4" />} disabled={f.pilot?.status === 'running'} onClick={() => setDialog('uninstall')}>Remove</Button>
                </Tooltip>
              </>
            )) : !block && (
              <Tooltip content={pack.dryRun ? `A dry run until L2; billed ${rupees(pack.price)} a year from then` : `Adds ${rupees(pack.price)} a year`}>
                <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setDialog('install')}>Install {pack.name}</Button>
              </Tooltip>
            )}
          </>
        }
      />

      {!l2 && (
        <Banner tone="info" className="mb-6" title={DRY_RUN_LINE}>
          {pack.installed ? `${pack.name} runs here as a dry run` : `At ${LEVEL_INFO.l1.label} ${pack.name} installs as a dry run`}: the declaration runs before every governed write, the profile runs against the chain as a preview and the export is generated, each marked dry run. Checks that need L2 evidence read not applicable. It goes live, and is billed, from the move to {LEVEL_INFO.l2.label}. The 90-day pilot starts here.
        </Banner>
      )}
      {!pack.installed && (
        <Banner tone="neutral" className="mb-6" title={removed ? `Removed ${date(removed.at)}` : 'Not installed — this is what it would do'} actions={!block ? <Button size="sm" variant="primary" onClick={() => setDialog('install')}>{removed ? 'Install again' : 'Install'}</Button> : undefined}>
          {removed ? <>Removed by {userName(removed.by)} — {removed.reason} (<ReceiptLink seq={removed.seq} />). The declaration no longer runs. {removed.billedTo ? <>It is billed to the end of the month it was removed in ({date(removed.billedTo)}), and not from the next{removed.profileCancelled ? '; the verifier profile order was cancelled with it, on the same terms' : ''}.</> : <>{removed.installedAt === undefined ? 'It is billed to the end of the month it was removed in, and not from the next' : 'It was a dry run and never billed'}{removed.profileCancelled ? '; the verifier profile order was cancelled with it, billed to the end of that month' : ''}.</>} Its receipts stay on the chain.</> :<>The declaration below is not enforced and the export is not available until {pack.name} is installed.</>}
        </Banner>
      )}

      <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <div className="lg:col-span-8 space-y-6">
          <IdentityBlock pack={pack} version={cfg.version} />
          <ObligationBlock pack={pack} />
          <BuyerBlock pack={pack} />
          <GateScoresBlock gates={f.gates} />
          <DeclarationBlock pack={pack} version={cfg.version} canConfigure={manager} onConfigure={() => setDialog('configure')} />
          <WriteTypesBlock packId={pack.id} drills={f.drills} canDrill={manager} installed={pack.installed} />
          <PreGatesBlock gates={gates} />
          <ProfileBlock packId={pack.id} installed={pack.installed} profile={profile} entitlement={f.entitlement} />
          <PromiseBlock pack={pack} profile={profile} />
          <TestsBlock packId={pack.id} installed={pack.installed} tests={f.tests} lastRun={f.lastTestRun} auditorName={f.pilot?.auditor.name} />
          <PilotBlock pack={pack} pilot={f.pilot} earlier={f.earlierPilots} onReconcile={() => scrollTo(`reconcile-${pack.id}`)} />
          <ReconcilePanel id={`reconcile-${pack.id}`} packId={pack.id} installed={pack.installed} recons={f.reconciliations} />
        </div>

        <div className="lg:col-span-4 space-y-6">
          <BlockIndex states={states} />

          <Panel title="Regime export" kicker="Generated from the chain">
            <ul className="space-y-3">
              {pack.exports.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm min-w-0">{x.label}</span>
                  {(manager || role === 'auditor') && (
                    <Tooltip content={!pack.installed ? `Install ${pack.name} first` : `Generate ${x.format.toUpperCase()} from every matching receipt and save it`}>
                      <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} loading={exporting === x.id} disabled={!pack.installed} onClick={() => doExport(x.id)}>Download</Button>
                    </Tooltip>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">Each export is recorded as a <span className="font-mono">pack.exported</span> receipt. {l2 ? 'The auditor checks it against the evidence bundle with the profile in block 8.' : 'At L1 each file’s first line says “dry run — no regulatory claim until L2”.'}</p>
          </Panel>

          <Panel title="Coverage" kicker="Receipts this declaration applies to">
            <KeyValue items={[
              { k: 'Governed writes', v: <span className="num font-medium">{n(pack.coverage?.writes ?? 0)}</span> },
              { k: 'Refused', v: <span className="num">{n(pack.coverage?.refusals ?? 0)}</span> },
              { k: 'Last write', v: pack.coverage?.lastAt ? <When iso={pack.coverage.lastAt} /> : '—' },
              { k: 'Installed', v: pack.installed ? <>{pack.installedAt ? date(pack.installedAt) : ''} · {userName(pack.installedBy)}</> : 'No' },
            ]} />
            <p className="mt-3 text-xs text-muted">A count of receipts, not a test that a control works.</p>
          </Panel>

          <Panel title="Connector" kicker={PACK_CONNECTORS[pack.id].name}>
            {connector ? (
              <div className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2"><ConnectorStatus c={connector} /><span className="text-muted num">{connector.tools.filter((t) => t.enabled).length} of {plural(connector.tools.length, 'tool')} on</span></div>
                <SmartLink to={`/connectors/${connector.id}`} hideWhenBlocked className="inline-flex items-center gap-1.5 font-medium hover:underline underline-offset-2"><Plug className="h-4 w-4" aria-hidden />Open the connector</SmartLink>
              </div>
            ) : (
              <p className="text-sm text-muted">{PACK_CONNECTORS[pack.id].purpose} It is added in demo mode when {pack.name} is installed.</p>
            )}
          </Panel>

          {pack.installed && (
            <Panel title="Configuration" kicker={`Declaration v${cfg.version}`}
              actions={manager ? <Button size="sm" variant="ghost" onClick={() => setDialog('configure')}>Change</Button> : undefined}>
              <KeyValue items={PACK_PARAMS[pack.id].map((p) => ({ k: p.label, v: <span className="num">{p.unit === '₹' ? rupees(cfg.values[p.id]) : `${cfg.values[p.id].toLocaleString('en-IN')} ${p.unit}`}</span> }))} />
              {cfg.updatedAt && <p className="mt-3 text-xs text-muted">Changed by {userName(cfg.updatedBy)} <When iso={cfg.updatedAt} />.</p>}
            </Panel>
          )}

          <Panel title="Pack history" kicker="Receipts" flush>
            {history.length === 0 ? <p className="px-5 py-4 text-sm text-muted">No pack receipts yet.</p> : (
              <ul className="divide-y divide-line">
                {history.map((r) => (
                  <li key={r.seq} className="px-5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span><span className="font-mono text-[12.5px]">{r.action}</span> <span className="text-muted">· {userName(r.actor)}</span></span>
                    <span className="flex items-center gap-2 text-xs text-muted"><When iso={r.ts} /><ReceiptLink seq={r.seq} /></span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      {dialog === 'install' && <InstallDialog pack={pack} open onClose={() => setDialog(undefined)} />}
      {dialog === 'configure' && <ConfigureDialog pack={pack} open onClose={() => setDialog(undefined)} />}
      <FormDialog open={dialog === 'uninstall'} onClose={() => setDialog(undefined)} tone="danger" title={`Remove ${pack.name}?`}
        description="The declaration stops running before governed writes and the regime export stops. Receipts already written stay on the chain."
        intro={<p className="text-muted">{pack.dryRun ? 'It is a dry run, so nothing has been billed and nothing is.' : `The ${pack.name} line is ${ADDON_STOP_RULE} (this month’s line is ${rupees(pack.price / 12)} for a whole month).`} The removal is a <span className="font-mono">pack.uninstalled</span> receipt.</p>}
        fields={[
          { id: 'reason', kind: 'textarea', label: 'Why it is removed', min: 8, rows: 3 },
          ...(f.entitlement?.ordered ? [{ id: 'cancel', kind: 'checkbox' as const, label: `Also cancel the verifier profile ${pack.profileId}`, hint: role === 'owner' ? `Its ${rupees(300000)}-a-year line is ${ADDON_STOP_RULE}.` : 'Only an owner can cancel the order.', initial: role === 'owner' }] : []),
        ]}
        submitLabel={`Remove ${pack.name}`}
        onSubmit={async (v) => {
          if (!user) return;
          const r = await api.uninstallPack(orgId, pack.id, user.id, String(v.reason), !!v.cancel);
          toast.ok(`${pack.name} removed`, `${pack.dryRun ? 'A dry run, never billed' : `Billed to the end of this month, and not from next month`}${r.profileCancelled ? '; the profile order was cancelled on the same terms' : ''}. Receipt #${r.seq}.`);
        }} />
    </div>
  );
}
