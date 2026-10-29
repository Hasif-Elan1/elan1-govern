import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleSlash, History, ShieldCheck, Undo2 } from 'lucide-react';
import type { AdmissionGate, PackId, RegulatoryPack, VerifierProfile } from '@/types';
import { api } from '@/api';
import { useOrgId, useUser } from '@/store/session';
import { PACK_BLOCKS, PACK_TEMPLATE, PACK_WRITE_TYPES } from '@/lib/packs';
import { date, rupees } from '@/lib/format';
import { userName } from '@/mock/users';
import { Badge, Button, KeyValue, Panel, StatusChip, Tooltip, toast } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { GateChip } from './parts';
import { FormDialog } from './FormDialog';
import type { preGatesFor } from './config';

export type BlockId = (typeof PACK_BLOCKS)[number]['id'];

const meta = (id: BlockId) => PACK_BLOCKS.find((b) => b.id === id)!;

/** One of the eleven blocks of the pack template: numbered, named as in the template, with what it carries. */
export function BlockPanel({ id, children, actions, flush, footer, title }: { id: BlockId; children: ReactNode; actions?: ReactNode; flush?: boolean; footer?: ReactNode; title?: string }) {
  const b = meta(id);
  return (
    <Panel id={`block-${b.n}`} kicker={`Block ${b.n} · ${b.id}`} title={title ?? b.title} actions={actions} flush={flush} footer={footer ?? b.what}>
      {children}
    </Panel>
  );
}

/** The template's index: every block, so a pack missing one is visibly not a pack. */
export function BlockIndex({ states }: { states: Partial<Record<BlockId, 'ok' | 'open' | 'na'>> }) {
  return (
    <Panel title="The eleven blocks" kicker="A pack missing any block is not a pack" flush>
      <ol className="divide-y divide-line">
        {PACK_BLOCKS.map((b) => {
          const s = states[b.id] ?? 'ok';
          return (
            <li key={b.id}>
              <a href={`#block-${b.n}`} className="px-5 py-2 flex items-center justify-between gap-2 text-sm hover:bg-sunken/60">
                <span className="min-w-0 truncate"><span className="num text-xs text-muted mr-2 inline-block w-5">{b.n}</span>{b.title}</span>
                {s === 'ok' ? <CheckCircle2 className="h-3.5 w-3.5 text-ok-fg shrink-0" aria-label="Complete" /> : s === 'open' ? <History className="h-3.5 w-3.5 text-held-fg shrink-0" aria-label="Open" /> : <CircleSlash className="h-3.5 w-3.5 text-subtle shrink-0" aria-label="Not yet" />}
              </a>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

export function IdentityBlock({ pack, version }: { pack: RegulatoryPack; version: number }) {
  const t = PACK_TEMPLATE[pack.id];
  return (
    <BlockPanel id="pack_identity">
      <KeyValue items={[
        { k: 'Pack id', v: pack.id, mono: true },
        { k: 'Pack version', v: <span className="num">{t.version}</span> },
        { k: 'Owner role', v: t.ownerRole },
        { k: 'Domain', v: t.domain },
        { k: 'Declaration in force here', v: <span className="font-mono">{pack.declaration.id} v{version}</span> },
        { k: 'Plan go-live', v: t.goLive },
        { k: 'Price', v: <span className="num">{rupees(pack.price)} a year</span> },
      ]} />
    </BlockPanel>
  );
}

export function ObligationBlock({ pack }: { pack: RegulatoryPack }) {
  const o = PACK_TEMPLATE[pack.id].obligation;
  return (
    <BlockPanel id="obligation">
      <KeyValue items={[
        { k: 'Regime', v: o.regime },
        { k: 'Issuer', v: o.issuer },
        { k: 'In force from', v: date(`${o.inForceFrom}T00:00:00Z`) },
        { k: 'Clauses served', v: <span className="inline-flex flex-wrap justify-end gap-1">{o.clauses.map((c) => <Badge key={c}><span className="font-mono">{c}</span></Badge>)}</span> },
      ]} />
    </BlockPanel>
  );
}

export function BuyerBlock({ pack }: { pack: RegulatoryPack }) {
  const b = PACK_TEMPLATE[pack.id].buyer;
  return (
    <BlockPanel id="buyer">
      <KeyValue items={[{ k: 'Who signs', v: b.signs }, { k: 'Budget line', v: b.budgetLine }, { k: 'Auditor', v: b.auditor }]} />
    </BlockPanel>
  );
}

export function GateScoresBlock({ gates }: { gates: AdmissionGate[] }) {
  const met = gates.filter((g) => g.state !== 'not_met').length;
  return (
    <BlockPanel id="gate_scores" flush title={`Admission scores · ${met} of ${gates.length} pass`}
      actions={<Link to="/records/packs/portfolio" className="text-sm font-medium hover:underline underline-offset-2">Portfolio register →</Link>}>
      <ul className="divide-y divide-line">
        {gates.map((g) => (
          <li key={g.id} className="px-5 py-3 grid gap-x-4 gap-y-1 sm:grid-cols-[1fr_auto] items-start">
            <span className="min-w-0">
              <span className="text-sm font-medium"><span className="font-mono text-xs text-muted mr-2">{g.id}</span>{g.label}</span>
              <span className="block text-xs text-muted mt-0.5">{g.description}</span>
              <span className="block text-sm mt-1">{g.evidence}</span>
            </span>
            <GateChip gate={g} />
          </li>
        ))}
      </ul>
    </BlockPanel>
  );
}

export function DeclarationBlock({ pack, version, onConfigure, canConfigure }: { pack: RegulatoryPack; version: number; onConfigure: () => void; canConfigure: boolean }) {
  return (
    <BlockPanel id="declaration_ref" actions={pack.installed && canConfigure ? <Tooltip content="Change the parameters: a new declaration version"><Button size="sm" variant="ghost" onClick={onConfigure}>Configure</Button></Tooltip> : undefined}>
      <p className="text-sm">{pack.summary}</p>
      <KeyValue className="mt-4" items={[
        { k: 'Declaration', v: <span className="font-mono">{pack.declaration.id} v{pack.installed ? version : pack.declaration.version}</span> },
        { k: 'Fields every record carries', v: <span className="inline-flex flex-wrap justify-end gap-1">{pack.declaration.fields.map((f) => <Badge key={f}><span className="font-mono">{f}</span></Badge>)}</span> },
        ...(pack.declaration.dualControlAbove ? [{ k: 'Second person above', v: <span className="num">{rupees(pack.declaration.dualControlAbove)}</span> }] : []),
      ]} />
    </BlockPanel>
  );
}

/** Block 6: each write type with its blast radius and reversal plan; a reversible one is drilled (T3), and the drill is a receipt. */
export function WriteTypesBlock({ packId, drills, canDrill, installed }: { packId: PackId; drills: Record<string, { at: string; by: string; note: string; seq?: number }>; canDrill: boolean; installed: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const [drilling, setDrilling] = useState<string>();
  const wts = PACK_WRITE_TYPES[packId];
  return (
    <BlockPanel id="write_types" flush>
      <ul className="divide-y divide-line">
        {wts.map((w) => {
          const d = drills[w.name];
          return (
            <li key={w.name} className="px-5 py-3 grid gap-x-4 gap-y-1 sm:grid-cols-[1fr_auto] items-start">
              <span className="min-w-0">
                <span className="font-mono text-[13px] font-medium">{w.name}</span>
                <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                  <Badge>{w.blastRadius}</Badge>
                  {w.reversible ? <Badge tone="ok">Reversible</Badge> : <Badge tone="held">Declared irreversible</Badge>}
                  {w.dualControl && <Badge>Second person {w.dualControl}</Badge>}
                </span>
                <span className="block text-sm text-muted mt-1">{w.reversal}</span>
                {d && <span className="block text-xs text-muted mt-1">Drilled <When iso={d.at} /> by {userName(d.by)}{d.seq !== undefined && <> · <ReceiptLink seq={d.seq} /></>} — {d.note}</span>}
              </span>
              {w.reversible ? (
                d ? <StatusChip size="sm" tone="ok" icon={<Undo2 className="h-3 w-3" aria-hidden />}>Drilled {date(d.at)}</StatusChip>
                  : canDrill ? <Tooltip content={!installed ? 'Install the pack first' : 'Run the reversal plan once on a test record and record it (T3)'}>
                    <Button size="sm" variant="secondary" icon={<Undo2 className="h-3.5 w-3.5" />} disabled={!installed} onClick={() => setDrilling(w.name)}>Record a drill</Button>
                  </Tooltip>
                  : <StatusChip size="sm" tone="neutral">Not drilled yet</StatusChip>
              ) : <StatusChip size="sm" tone="neutral" icon={<ShieldCheck className="h-3 w-3" aria-hidden />}>Held for a person</StatusChip>}
            </li>
          );
        })}
      </ul>
      <FormDialog open={!!drilling} onClose={() => setDrilling(undefined)} title={`Record a reversal drill: ${drilling ?? ''}`}
        description="“A plan nobody has run is a plan that does not exist.” Record the drill once it has been run on a test record."
        intro={<p className="text-muted">{wts.find((w) => w.name === drilling)?.reversal}</p>}
        fields={[{ id: 'note', kind: 'textarea', label: 'What the drill did and what it showed', min: 12, placeholder: 'Submitted test invoice TEST-0042, cancelled it; the reversing GL entries posted and matched.' }]}
        submitLabel="Record the drill"
        onSubmit={async (v) => {
          if (!user || !drilling) return;
          await api.recordReversalDrill(orgId, packId, drilling, user.id, String(v.note));
          toast.ok('Drill recorded', `${drilling}: the reversal plan has been run once. The drill is a receipt.`);
        }} />
    </BlockPanel>
  );
}

export function PreGatesBlock({ gates }: { gates: ReturnType<typeof preGatesFor> }) {
  return (
    <BlockPanel id="gates" flush title="Pre-write checks G1–G9 this declaration sets"
      footer="6 checks are never skipped: consent, residency, retention, dual control, counterparty and precondition. The first failure sets the refusal; the rest still run and are recorded.">
      <ol className="divide-y divide-line">
        {gates.map((g) => (
          <li key={g.id} className="px-5 py-3 grid gap-x-4 gap-y-1 sm:grid-cols-[120px_1fr_auto] items-start">
            <span className="text-sm"><span className="font-mono text-xs text-muted mr-2">{g.id}</span><span className="font-medium">{g.name}</span></span>
            <span className="text-sm text-muted">{g.rule}</span>
            {g.off ? <StatusChip size="sm" tone="neutral">Declared off</StatusChip> : g.skippable ? <StatusChip size="sm" tone="info" icon={<ShieldCheck className="h-3 w-3" />}>On</StatusChip> : <StatusChip size="sm" tone="ok" icon={<ShieldCheck className="h-3 w-3" />}>Never skipped</StatusChip>}
          </li>
        ))}
      </ol>
    </BlockPanel>
  );
}

export function PromiseBlock({ pack, profile }: { pack: RegulatoryPack; profile?: VerifierProfile }) {
  const p = PACK_TEMPLATE[pack.id].promise;
  return (
    <BlockPanel id="buyer_promise">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="label mb-2">What the buyer receives</p>
          <ol className="space-y-2 text-sm list-decimal pl-5">{p.receives.map((x) => <li key={x}>{x}</li>)}</ol>
        </div>
        <div>
          <p className="label mb-2">What it does not establish</p>
          <ul className="space-y-2 text-sm list-disc pl-5">{p.doesNotEstablish.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      </div>
      {profile && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="label mb-1">Printed in every report, in the profile’s own words</p>
          <p className="text-sm text-muted leading-relaxed">{profile.limits}</p>
        </div>
      )}
    </BlockPanel>
  );
}
