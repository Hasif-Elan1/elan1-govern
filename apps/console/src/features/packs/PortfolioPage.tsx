import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Plus, X } from 'lucide-react';
import type { AdmissionGate } from '@/types';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useRole, useUser } from '@/store/session';
import { date } from '@/lib/format';
import { evaluateGates, gatesPass, type GateFacts } from '@/lib/packs';
import { userName } from '@/mock/users';
import type { CandidateStatus, PackCandidate } from '@/mock/packsFactory';
import { Badge, Banner, Button, Checkbox, Dialog, EmptyState, Field, Input, LegalDraft, PageHeader, Panel, Select, Skeleton, Stat, StatusChip, Textarea, Tooltip, toast } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { cn } from '@/lib/cn';
import { GateChip } from './parts';
import { FormDialog } from './FormDialog';

const STATUS: Record<CandidateStatus, { label: string; tone: 'ok' | 'held' | 'bad' | 'neutral' | 'info' }> = {
  live: { label: 'Live', tone: 'ok' }, admitted: { label: 'Admitted — in the build queue', tone: 'info' }, awaiting_admission: { label: 'Waiting for a second person', tone: 'held' },
  candidate: { label: 'Failing a gate', tone: 'bad' }, rejected: { label: 'Rejected', tone: 'bad' }, returned: { label: 'Returned to the register', tone: 'bad' },
};

function GateStrip({ gates }: { gates: AdmissionGate[] }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Admission gates">
      {gates.map((g) => (
        <li key={g.id} title={`${g.id} ${g.label}: ${g.evidence}`} className={cn('border px-1.5 h-6 inline-flex items-center gap-1 text-[11px] font-mono', g.state === 'met' ? 'border-ok/40 text-ok-fg' : g.state === 'provisional' ? 'border-held/40 text-held-fg' : 'border-bad/40 text-bad-fg')}>
          {g.state === 'not_met' ? <X className="h-3 w-3" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}{g.id}<span className="sr-only">{g.state === 'met' ? ' met' : g.state === 'provisional' ? ' provisional' : ' not met'}</span>
        </li>
      ))}
    </ul>
  );
}

/** Records › Regulatory packs › Portfolio register — every candidate scored against G-A…G-E, admitted under dual control, or rejected by name. */
export default function PortfolioPage() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const q = useQuery((o) => api.packPortfolio(o), []);
  const members = useQuery((o) => api.members(o), [], { live: false });
  const [open, setOpen] = useState<string>();
  const [proposing, setProposing] = useState(false);
  const [admitting, setAdmitting] = useState<PackCandidate>();
  const [rejecting, setRejecting] = useState<PackCandidate>();
  const manager = role === 'owner' || role === 'admin';
  const rows = q.data;
  const groups = useMemo(() => ({
    live: rows?.filter((c) => c.status === 'live' || c.status === 'admitted') ?? [],
    open: rows?.filter((c) => c.status === 'awaiting_admission' || c.status === 'candidate') ?? [],
    rejected: rows?.filter((c) => c.status === 'rejected' || c.status === 'returned') ?? [],
  }), [rows]);

  const card = (c: PackCandidate) => (
    <li key={c.id} className="px-5 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button type="button" onClick={() => setOpen(open === c.id ? undefined : c.id)} className="font-mono font-semibold hover:underline underline-offset-2 text-left" aria-expanded={open === c.id}>{c.name}</button>
          <span className="ml-2"><StatusChip size="sm" tone={STATUS[c.status].tone}>{STATUS[c.status].label}</StatusChip></span>
          <p className="text-sm text-muted mt-1">{c.domain}</p>
          {c.sentence && <p className="text-sm mt-1"><span className="font-mono text-xs mr-1">{c.failedGates?.join(', ')}</span>“{c.sentence}”</p>}
          {c.revisit && <p className="text-xs text-muted mt-0.5">Revisit when: {c.revisit}</p>}
          <p className="text-xs text-muted mt-1">
            {c.proposedBy && <>Proposed by {userName(c.proposedBy)}{c.proposedAt && <> <When iso={c.proposedAt} /></>}{c.proposedSeq !== undefined && <> · <ReceiptLink seq={c.proposedSeq} /></>}. </>}
            {c.decidedBy && <>{c.status === 'rejected' ? 'Rejected' : 'Admitted'} by {userName(c.decidedBy)} <When iso={c.decidedAt} />{c.decidedSeq !== undefined && <> · <ReceiptLink seq={c.decidedSeq} /></>}. </>}
            {!c.decidedBy && c.decidedAt && c.source === 'portfolio' && <>Scored {date(c.decidedAt)} in the portfolio register. </>}
            {c.goLive && <>Plan go-live {c.goLive}. </>}{c.note}
          </p>
          {c.team && <p className="text-xs text-muted mt-0.5">Declaration owner {userName(c.team.declarationOwner)} · profile author {userName(c.team.profileAuthor)} · profile issuer {userName(c.team.profileCertifier)}</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
          <GateStrip gates={c.gates} />
          <div className="flex flex-wrap gap-2">
            {c.status === 'live' && ['ledger1', 'invoice1', 'collect1'].includes(c.id) && <Link to={`/records/packs/${c.id}`} className="inline-flex items-center gap-1 h-8 px-3 text-sm font-medium border border-line-strong/70 hover:border-fg">Open <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>}
            {/* owners and admins decide; the gate and the same-person rule keep their reasons on a disabled Admit */}
            {(c.status === 'awaiting_admission' || c.status === 'candidate') && manager && (
              <>
                <Tooltip content={c.status === 'candidate' ? 'A candidate failing a gate cannot be admitted. “Probably” is scored fail.' : c.proposedBy === user?.id ? 'Dual control: the proposer cannot admit their own candidate.' : 'Admit to the build queue: a governed write under dual control'}>
                  <Button size="sm" variant="primary" disabled={c.status === 'candidate' || c.proposedBy === user?.id} onClick={() => setAdmitting(c)}>Admit</Button>
                </Tooltip>
                <Tooltip content="Reject by name into the register, with the gate and the sentence">
                  <Button size="sm" variant="secondary" onClick={() => setRejecting(c)}>Reject</Button>
                </Tooltip>
              </>
            )}
          </div>
        </div>
      </div>
      {open === c.id && (
        <ul className="mt-3 border border-line divide-y divide-line">
          {c.gates.map((g) => (
            <li key={g.id} className="px-4 py-2.5 grid gap-x-4 gap-y-1 sm:grid-cols-[1fr_auto] items-start">
              <span className="min-w-0 text-sm"><span className="font-mono text-xs text-muted mr-2">{g.id}</span><span className="font-medium">{g.label}</span><span className="block text-muted mt-0.5">{g.evidence}</span></span>
              <GateChip gate={g} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Records · Regulatory packs"
        crumbs={[{ label: 'Records', to: '/records' }, { label: 'Regulatory packs', to: '/records/packs' }, { label: 'Portfolio register' }]}
        title="Portfolio register"
        description="Every candidate pack is scored against five gates before any build work. All five must pass; a gate scored “probably” is scored fail. Admission is a governed write under dual control; a rejected candidate stays here by name, with the gate it failed."
        meta={<LegalDraft />}
        actions={manager ? <Tooltip content="Write the candidate on one page; the gates are scored from it"><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setProposing(true)}>Propose a pack</Button></Tooltip> : undefined}
      />
      {q.error && <Banner tone="bad" className="mb-6" title="The register did not load" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>}

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 mb-6">
        {!rows ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[100px]" />) : (
          <>
            <Stat label="Live" value={String(rows.filter((c) => c.status === 'live').length)} sub="ledger1 · invoice1 · collect1" />
            <Stat label="Admitted" value={String(rows.filter((c) => c.status === 'admitted').length)} sub="In the build queue" />
            <Stat label="Open candidates" value={String(groups.open.length)} sub={`${rows.filter((c) => c.status === 'awaiting_admission').length} waiting for a second person`} />
            <Stat label="Rejected by name" value={String(groups.rejected.length)} sub="Kept with the gate each failed" />
          </>
        )}
      </div>

      {!rows ? <Skeleton className="h-96" /> : (
        <div className="space-y-6">
          <Panel title="Live and admitted" kicker={`${groups.live.length} packs`} flush>
            <ul className="divide-y divide-line">{groups.live.map(card)}</ul>
          </Panel>
          <Panel title="Candidates" kicker="Scored, not yet decided" flush>
            {groups.open.length ? <ul className="divide-y divide-line">{groups.open.map(card)}</ul> : <EmptyState compact title="No open candidates" disc="gate">Propose a pack to score it against the five gates.</EmptyState>}
          </Panel>
          <Panel title="Rejected by name" kicker="Not softened, parked or renamed" flush footer="G-E kills the most candidates and is the least negotiable: “we could integrate with their log” is refused on the spot.">
            <ul className="divide-y divide-line">{groups.rejected.map(card)}</ul>
          </Panel>
        </div>
      )}

      <ProposeDialog open={proposing} onClose={() => setProposing(false)} />
      {admitting && <AdmitDialog candidate={admitting} members={(members.data ?? []).filter((m) => m.status === 'active').map((m) => m.userId)} onClose={() => setAdmitting(undefined)} />}
      <FormDialog open={!!rejecting} onClose={() => setRejecting(undefined)} tone="danger" title={`Reject ${rejecting?.name ?? ''}`}
        description="It goes into the register by name with the gate it failed. The sentence is kept as written."
        intro={rejecting && <p className="text-muted">Failing: {rejecting.gates.filter((g) => g.state === 'not_met').map((g) => g.id).join(', ') || 'none — rejecting a candidate that passes every gate is recorded as such'}.</p>}
        fields={[
          { id: 'sentence', kind: 'text', label: 'The sentence', min: 12, placeholder: 'The write path belongs to the MES vendor.' },
          { id: 'revisit', kind: 'text', label: 'Revisit when (optional)', placeholder: 'A path exists for us to be in the write path rather than beside it.' },
        ]}
        submitLabel="Reject into the register"
        onSubmit={async (v) => {
          if (!user || !rejecting) return;
          const c = await api.rejectPackCandidate(orgId, rejecting.id, user.id, String(v.sentence), String(v.revisit ?? ''));
          toast.ok(`${c.name} rejected`, `Kept in the register with ${c.failedGates?.join(', ') || 'its sentence'}. Receipt #${c.decidedSeq}.`);
        }} />
    </div>
  );
}

const EMPTY: GateFacts = {
  hook: { instrument: '', issuer: '', date: '', kind: 'regulation' },
  auditor: { role: '', organisation: '', obliged: true, callable: true },
  writeTypes: [],
  evidence: { ownLine: 'provisional', budgetLine: '', note: '' },
  writePath: { kind: 'owns', note: '' },
};

/** Write the candidate on one page: domain, dated hook, the auditor, the write types, the evidence line and the write path. The gates score as you type. */
function ProposeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [facts, setFacts] = useState<GateFacts>(EMPTY);
  const [wt, setWt] = useState('');
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(''); setDomain(''); setFacts(EMPTY); setWt(''); setErr(undefined); } }, [open]);
  const writeTypes = wt.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [n, r] = l.split(':').map((x) => x.trim());
    return { name: n, reversibility: (r === 'irreversible' ? 'irreversible_declared' : r === 'reversible' ? 'reversible' : 'unclear') as GateFacts['writeTypes'][number]['reversibility'] };
  });
  const full: GateFacts = { ...facts, writeTypes };
  const gates = evaluateGates(full);
  const set = <K extends keyof GateFacts>(k: K, v: Partial<GateFacts[K]>) => setFacts((f) => ({ ...f, [k]: { ...(f[k] as object), ...v } }));
  const go = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const c = await api.proposePackCandidate(orgId, { name, domain, facts: full }, user.id);
      toast[c.status === 'awaiting_admission' ? 'ok' : 'held'](`${c.name} proposed`, c.status === 'awaiting_admission' ? 'Every gate passes. A different owner or admin admits it.' : `Failing ${c.gates.filter((g) => g.state === 'not_met').map((g) => g.id).join(', ')}: it can only be rejected into the register, by name.`);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Propose a pack" description="One page. Each gate is scored from what you write, with the sentence that decided it."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={go}>Propose {gatesPass(gates) ? 'for admission' : 'and score'}</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Not proposed">{err}</Banner>}
        <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
          <Field label="Pack id" htmlFor="pp-name" hint="Lowercase, ends in 1."><Input id="pp-name" mono value={name} placeholder="close1" onChange={(e) => setName(e.target.value.toLowerCase())} /></Field>
          <Field label="Domain, in one sentence a non-engineer can read" htmlFor="pp-domain"><Input id="pp-domain" value={domain} onChange={(e) => setDomain(e.target.value)} /></Field>
        </div>
        <fieldset className="border border-line p-4 space-y-3">
          <legend className="label px-1">G-A · the dated hook</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Regulation, standard or contract" htmlFor="pp-inst"><Input id="pp-inst" value={facts.hook.instrument} onChange={(e) => set('hook', { instrument: e.target.value })} /></Field>
            <Field label="Issuer" htmlFor="pp-iss"><Input id="pp-iss" value={facts.hook.issuer ?? ''} onChange={(e) => set('hook', { issuer: e.target.value })} /></Field>
            <Field label="In force from" htmlFor="pp-date"><Input id="pp-date" type="date" value={facts.hook.date ?? ''} onChange={(e) => set('hook', { date: e.target.value })} /></Field>
            <Field label="Kind" htmlFor="pp-kind"><Select id="pp-kind" value={facts.hook.kind} onChange={(e) => set('hook', { kind: e.target.value as GateFacts['hook']['kind'] })}><option value="regulation">Regulation</option><option value="standard">Standard</option><option value="contract">Contract</option><option value="principle">A principle or direction of travel</option></Select></Field>
          </div>
        </fieldset>
        <fieldset className="border border-line p-4 space-y-3">
          <legend className="label px-1">G-B · the auditor</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Auditor, by role" htmlFor="pp-aud"><Input id="pp-aud" value={facts.auditor.role} placeholder="Statutory auditor" onChange={(e) => set('auditor', { role: e.target.value })} /></Field>
            <Field label="Organisation (where possible)" htmlFor="pp-audorg"><Input id="pp-audorg" value={facts.auditor.organisation ?? ''} onChange={(e) => set('auditor', { organisation: e.target.value })} /></Field>
          </div>
          <Checkbox id="pp-obl" checked={facts.auditor.obliged} onChange={(v) => set('auditor', { obliged: v })} label="Their job obliges them to ask for the evidence" />
          <Checkbox id="pp-call" checked={facts.auditor.callable} onChange={(v) => set('auditor', { callable: v })} label="Somebody who could be telephoned — not a category" />
        </fieldset>
        <Field label="G-C · write types, one per line as name: reversible | irreversible" htmlFor="pp-wt" hint="Anything not marked either way is scored unclear, and fails G-C.">
          <Textarea id="pp-wt" rows={3} className="font-mono text-sm" value={wt} placeholder={'accrual.post: reversible\nperiod.lock: irreversible'} onChange={(e) => setWt(e.target.value)} />
        </Field>
        <fieldset className="border border-line p-4 space-y-3">
          <legend className="label px-1">G-D · evidence sold separately</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Would a buyer pay for it on its own line?" htmlFor="pp-own"><Select id="pp-own" value={facts.evidence.ownLine} onChange={(e) => set('evidence', { ownLine: e.target.value as GateFacts['evidence']['ownLine'] })}><option value="yes">Yes — a buyer has said so</option><option value="provisional">Provisionally — the pilot will ask</option><option value="probably">Probably</option><option value="no">No</option></Select></Field>
            <Field label="Budget line" htmlFor="pp-budget"><Input id="pp-budget" value={facts.evidence.budgetLine ?? ''} onChange={(e) => set('evidence', { budgetLine: e.target.value })} /></Field>
          </div>
          <Field label="The evidence, in a sentence" htmlFor="pp-evnote"><Input id="pp-evnote" value={facts.evidence.note} onChange={(e) => set('evidence', { note: e.target.value })} /></Field>
        </fieldset>
        <fieldset className="border border-line p-4 space-y-3">
          <legend className="label px-1">G-E · the write path</legend>
          <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
            <Field label="Where elan1 sits" htmlFor="pp-wp"><Select id="pp-wp" value={facts.writePath.kind} onChange={(e) => set('writePath', { kind: e.target.value as GateFacts['writePath']['kind'] })}><option value="owns">In the write path</option><option value="reads_log">Reading another system’s log</option><option value="beside">Beside the write</option></Select></Field>
            <Field label="How" htmlFor="pp-wpnote"><Input id="pp-wpnote" value={facts.writePath.note} onChange={(e) => set('writePath', { note: e.target.value })} /></Field>
          </div>
        </fieldset>
        <div className="border border-line">
          <p className="px-4 py-2 border-b border-line label">How it scores</p>
          <ul className="divide-y divide-line">
            {gates.map((g) => (
              <li key={g.id} className="px-4 py-2 grid gap-x-3 sm:grid-cols-[1fr_auto] items-start text-sm">
                <span className="min-w-0"><span className="font-mono text-xs text-muted mr-2">{g.id}</span>{g.evidence}</span>
                <GateChip gate={g} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Dialog>
  );
}

/** Admission: a second owner or admin, never the proposer, names the declaration owner, the profile author and a different profile issuer the same day. */
function AdmitDialog({ candidate, members, onClose }: { candidate: PackCandidate; members: string[]; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [owner, setOwner] = useState(members[0] ?? '');
  const [author, setAuthor] = useState(members[1] ?? members[0] ?? '');
  const [issuer, setIssuer] = useState(members[2] ?? members[0] ?? '');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const opts = members.map((m) => <option key={m} value={m}>{userName(m)}</option>);
  const go = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const c = await api.admitPackCandidate(orgId, candidate.id, user.id, { declarationOwner: owner, profileAuthor: author, profileCertifier: issuer }, note);
      toast.ok(`${c.name} admitted`, `In the build queue under dual control. Receipt #${c.decidedSeq}.`);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={`Admit ${candidate.name}`} description={`Proposed by ${userName(candidate.proposedBy)}. Admission is a governed write under dual control: the proposer cannot admit it.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={go}>Admit to the build queue</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Not admitted">{err}</Banner>}
        <GateStrip gates={candidate.gates} />
        <Field label="Declaration owner" htmlFor="ad-owner"><Select id="ad-owner" value={owner} onChange={(e) => setOwner(e.target.value)}>{opts}</Select></Field>
        <Field label="Profile author" htmlFor="ad-author"><Select id="ad-author" value={author} onChange={(e) => setAuthor(e.target.value)}>{opts}</Select></Field>
        <Field label="Profile issuer — never the author" htmlFor="ad-issuer" error={author && author === issuer ? 'The issuer must be a different person from the author.' : undefined}><Select id="ad-issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)}>{opts}</Select></Field>
        <Field label="Note (optional)" htmlFor="ad-note"><Input id="ad-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Badge tone="info">Names are recorded on the admission receipt</Badge>
      </div>
    </Dialog>
  );
}
