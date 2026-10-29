import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, FileCheck2, Plus, Scale } from 'lucide-react';
import type { RegulatoryPack } from '@/types';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgLevel, useRole } from '@/store/session';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { date, n, plural, rupees } from '@/lib/format';
import { userName } from '@/mock/users';
import { Banner, Button, EmptyState, LegalDraft, PageHeader, Skeleton, Stat, Tooltip } from '@/components/ui';
import { When } from '@/components/domain';
import { DRY_RUN_LINE, GateChip, InstallDialog, InstalledChip, installBlock } from './parts';
import { SmartLink, useScreenAccess } from '@/shell/access';

/** Records › Regulatory packs — ledger1, invoice1 and collect1: a declaration, a verifier profile and a regime export each. */
export default function PacksPage() {
  const level = useOrgLevel();
  const role = useRole();
  const a = useScreenAccess();
  const q = useQuery((o) => api.packs(o), [level]);
  const [installing, setInstalling] = useState<RegulatoryPack>();
  const l2 = atLeast(level, 'l2');
  const packs = q.data;
  const installed = packs?.filter((p) => p.installed) ?? [];

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Records"
        title="Regulatory packs"
        description="One declaration, one verifier profile and one regime export under one dated obligation — for the MCA audit trail, GST e-invoicing and RBI collections conduct."
        actions={<>
          <Link to="/records/packs/portfolio" className="inline-flex items-center gap-2 h-10 px-4 font-medium border border-line-strong/70 bg-surface hover:border-fg">Portfolio register <ArrowRight className="h-4 w-4" aria-hidden /></Link>
          <SmartLink to="/assurance/profiles" hideWhenBlocked className="inline-flex items-center gap-2 h-10 px-4 font-medium border border-line-strong/70 bg-surface hover:border-fg">Verifier profiles <ArrowRight className="h-4 w-4" aria-hidden /></SmartLink>
        </>}
        meta={<LegalDraft />}
      />

      {!l2 && (
        <Banner tone="info" className="mb-6" title={DRY_RUN_LINE}>
          At {LEVEL_INFO.l1.label} a pack installs as a dry run: its declaration runs before every governed write and its reports are produced, each marked dry run. Checks that need L2 evidence (timestamps, Seal v6) read not applicable. Packs are billed from the move to {LEVEL_INFO.l2.label}, when they go live.
        </Banner>
      )}

      {q.error && <Banner tone="bad" title="The packs did not load" className="mb-6" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>}

      <div className="grid gap-4 grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-4 mb-6">
        {!packs ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px]" />) : (
          <>
            <Stat label="Installed" value={`${installed.length} of ${packs.length}`} sub={installed.length ? installed.map((p) => p.name).join(', ') : 'None yet'} />
            <Stat label="Yearly cost" value={rupees(l2 ? installed.reduce((t, p) => t + p.price, 0) : 0)} sub={l2 ? `${rupees(packs[0]?.price ?? 0)} per pack a year` : `Dry run — billed from ${LEVEL_INFO.l2.label}`} to={a.canSee('/billing') ? '/billing' : undefined} />
            <Stat label="Governed writes covered" value={n(installed.reduce((t, p) => t + (p.coverage?.writes ?? 0), 0))} sub="Receipts the installed declarations apply to" />
            <Stat label="Refused by these rules" value={n(installed.reduce((t, p) => t + (p.coverage?.refusals ?? 0), 0))} sub="Refused calls stay on the chain" to={a.canSee('/assurance/refusals') ? '/assurance/refusals' : undefined} />
          </>
        )}
      </div>

      {q.loading && !packs ? (
        <div className="grid gap-4 lg:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[420px]" />)}</div>
      ) : !packs?.length ? (
        <div className="border border-line bg-surface"><EmptyState title="No packs in the catalogue" disc="registration">The pack catalogue is empty for this deployment.</EmptyState></div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {packs.map((p) => <PackCard key={p.id} pack={p} block={installBlock(level, role)} onInstall={() => setInstalling(p)} />)}
        </div>
      )}

      <section className="mt-8 grid gap-4 lg:grid-cols-2">
        <div className="border border-line bg-surface p-4 text-sm">
          <p className="font-medium flex items-center gap-2"><Scale className="h-4 w-4 text-muted" aria-hidden />How a pack is admitted</p>
          <p className="text-muted mt-1">A pack ships only when it passes five gates: a dated hook (G-A), a named auditor (G-B), every write reversible or declared irreversible (G-C), evidence worth paying for on its own (G-D), and Elan1 Govern owning the write rather than copying it afterwards (G-E). Each gate is scored from the facts written for the pack; G-D stays provisional until the pilot’s day-85 answer. Candidates, admissions and the packs rejected by name are in the <Link to="/records/packs/portfolio" className="underline underline-offset-2 hover:text-fg">portfolio register</Link>.</p>
        </div>
        <div className="border border-line bg-surface p-4 text-sm">
          <p className="font-medium flex items-center gap-2"><FileCheck2 className="h-4 w-4 text-muted" aria-hidden />What it does not do</p>
          <p className="text-muted mt-1">A pack records that the governed write path ran under these rules at this time. It does not establish that a transaction is lawful or that a control works; your auditor and counsel decide that.</p>
        </div>
      </section>

      {installing && <InstallDialog pack={installing} open onClose={() => setInstalling(undefined)} />}
    </div>
  );
}

function PackCard({ pack, block, onInstall }: { pack: RegulatoryPack; block?: string; onInstall: () => void }) {
  const nav = useNavigate();
  const met = pack.gates.filter((g) => g.state !== 'not_met').length;
  const provisional = pack.gates.filter((g) => g.state === 'provisional').length;
  return (
    <article className="flex flex-col border border-line bg-surface">
      <div className="p-5 border-b border-line">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link to={`/records/packs/${pack.id}`} className="font-mono text-lg font-semibold hover:underline underline-offset-2">{pack.name}</Link>
            <p className="text-sm text-muted mt-0.5">{pack.regime}</p>
          </div>
          <InstalledChip pack={pack} />
        </div>
        <p className="mt-3 text-sm">{pack.summary}</p>
        <p className="mt-2 text-xs text-muted">For: {pack.buyer}</p>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-line">
        <div className="bg-surface p-3"><dt className="label">Price</dt><dd className="mt-1 text-sm font-medium num">{rupees(pack.price)} a year</dd></div>
        <div className="bg-surface p-3"><dt className="label">Admission gates</dt><dd className="mt-1 text-sm font-medium num">{met} of {pack.gates.length} pass{provisional ? ` · ${provisional} provisional` : ''}</dd></div>
        <div className="bg-surface p-3"><dt className="label">Verifier profile</dt><dd className="mt-1 text-xs font-mono break-all">{pack.profileId}</dd></div>
        <div className="bg-surface p-3"><dt className="label">Writes covered</dt><dd className="mt-1 text-sm num">{n(pack.coverage?.writes ?? 0)} · {plural(pack.coverage?.refusals ?? 0, 'refusal')}</dd></div>
      </dl>
      <ul className="px-5 py-3 border-t border-line space-y-1.5">
        {pack.gates.map((g) => (
          <li key={g.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="min-w-0 truncate"><span className="font-mono text-xs text-muted mr-2">{g.id}</span>{g.label}</span>
            <GateChip gate={g} />
          </li>
        ))}
      </ul>
      <div className="mt-auto px-5 py-4 border-t border-line flex flex-wrap items-center gap-2">
        {pack.installed ? (
          <span className="text-xs text-muted mr-auto">Installed {pack.installedAt ? date(pack.installedAt) : ''} by {userName(pack.installedBy)}{pack.coverage?.lastAt && <> · last write <When iso={pack.coverage.lastAt} /></>}</span>
        ) : !block ? (
          <Tooltip content={pack.dryRun ? `A dry run until L2; billed ${rupees(pack.price)} a year from then` : `Adds ${rupees(pack.price)} a year`}>
            <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={onInstall}>Install</Button>
          </Tooltip>
        ) : <span className="text-xs text-muted mr-auto">Not installed</span>}
        <Button size="sm" variant="secondary" className={pack.installed || block ? '' : 'ml-auto'} onClick={() => nav(`/records/packs/${pack.id}`)}>Open {pack.name}</Button>
      </div>
    </article>
  );
}
