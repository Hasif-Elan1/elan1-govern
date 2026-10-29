import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { CheckCircle2, ChevronDown, ChevronUp, Clock3, Eraser, Hourglass, Plus, ShieldCheck, UserCheck, XCircle } from 'lucide-react';
import type { ErasureRequest, LevelId } from '@/types';
import { api } from '@/api';
import { useNow, useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { sha256Hex, verifyChain } from '@/lib/crypto';
import { verifySeal } from '@/lib/seal';
import { countdown, dateTime, n, plural } from '@/lib/format';
import { userName } from '@/mock/users';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, Dialog, EmptyState, Field, Input, LegalDraft, PageHeader, Panel, Skeleton, Stat, StatusChip, Textarea, Tooltip, toast } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { doorState } from '@/features/records/ext';
import type { ErasurePlan } from '@/mock/records';
import { ErasurePlanView, PlanOutcome, RefusalsPanel } from './plan';
import { useCanSee } from '@/shell/access';

const H = 3_600_000;

/** Records › Erasure — DPDP erasure by salt destruction: request, two approvers, a 72-hour clock, then the salt is destroyed. */
export default function ErasurePage() {
  const level = useOrgLevel();
  const role = useRole();
  const user = useUser();
  const now = useNow(15_000);
  const l2 = atLeast(level, 'l2');
  const q = useQuery(async (o) => {
    const [er, members, lv, inv, refusals] = await Promise.all([api.erasures(o), api.members(o), api.level(o), api.inventory(o), api.records.erasureRefusals(o)]);
    const extra = doorState(o).aiExtra;
    return { ...er, refusals, members, level: lv, systems: inv.filter((s) => extra[s.id]?.personalData || s.dataCategories.some((d) => /contact|personal|health|cv|employee|bank|identifier/i.test(d))).map((s) => ({ ...s, extra: extra[s.id] })) };
  }, [level]);
  const [openNew, setOpenNew] = useState(false);
  const manager = role === 'owner' || role === 'admin';
  const canSeeReviews = useCanSee('/work/reviews');

  // a request is focused by #<id> (record pages) or ?id=<id> (DPDP framework page, Work › Reviews)
  const loc = useLocation();
  const [sp] = useSearchParams();
  const focusId = sp.get('id') || sp.get('request') || (loc.hash ? decodeURIComponent(loc.hash.slice(1)) : '') || undefined;
  const loaded = !!q.data;
  useEffect(() => {
    if (!loaded || !focusId) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById(focusId);
      if (!el) return;
      el.scrollIntoView({ block: 'start' });
      el.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(t);
  }, [loaded, focusId]);

  const reqs = q.data?.requests ?? [];
  const stats = useMemo(() => ({
    waiting: reqs.filter((e) => e.status === 'awaiting_approval').length,
    ready: reqs.filter((e) => e.status === 'approved').length,
    executed: reqs.filter((e) => e.status === 'executed').length,
    overdue: reqs.filter((e) => e.status !== 'executed' && e.status !== 'rejected' && new Date(e.dueAt).getTime() < now).length,
  }), [reqs, now]);

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Records"
        title="Erasure (DPDP)"
        description="A data principal asks for their personal data to be erased. Two different people approve within 72 hours; then the values the rules inspected are removed from each receipt and the salt behind its payload hash is destroyed, so nothing left can be linked to the person — and the chain still verifies."
        meta={<LegalDraft />}
        actions={manager ? (
          <Tooltip content="Open a request: the identifier is hashed at once and never stored">
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpenNew(true)}>New erasure request</Button>
          </Tooltip>
        ) : undefined}
      />

      {/* erasure is available from L1 (decision 6c): every record is salted from the first L1 record */}
      {!l2 && (
        <Banner tone="info" className="mb-6" title="Erasure works from L1">
          Every record is salted from the first L1 record. At L1 erasure removes the values the rules inspected from each matching receipt, destroys its salt and has the organisation seal what is left, so the chain still verifies. From L2 each Seal v6 record also marks its payload hash unbound.
        </Banner>
      )}

      {q.error && <Banner tone="bad" title="Erasure requests did not load" className="mb-6" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>}

      {(
        <div className="grid gap-4 grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-4 mb-6">
          {!q.data ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px]" />) : (
            <>
              <Stat label="Waiting for approval" value={n(stats.waiting)} sub={stats.waiting ? 'Two different people approve' : 'Nothing waiting'} to={canSeeReviews ? '/work/reviews' : undefined} />
              <Stat label="Ready to execute" value={n(stats.ready)} sub="Approved by two people" />
              <Stat label="Overdue" value={<span className={cn(stats.overdue && 'text-bad-fg')}>{n(stats.overdue)}</span>} sub="Past the 72-hour clock" />
              <Stat label="Salts destroyed" value={n(q.data.destroyedSalts)} sub={`${plural(stats.executed, 'request')} executed`} />
            </>
          )}
        </div>
      )}

      {(
        <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
          <div className="lg:col-span-8 space-y-4">
            <h2 className="text-xl font-semibold">Requests</h2>
            {q.loading && !q.data ? <Skeleton className="h-64" /> : reqs.length === 0 ? (
              <div className="border border-line bg-surface">
                <EmptyState title="No erasure requests" disc="registration" action={manager ? <Button variant="primary" onClick={() => setOpenNew(true)}>New erasure request</Button> : undefined}>
                  When a data principal asks for their personal data to be erased, open a request here or from the record that holds it.
                </EmptyState>
              </div>
            ) : (
              <>
                {focusId && !reqs.some((e) => e.id === focusId) && (
                  <Banner tone="neutral" title="That erasure request is not in this organisation">All requests are listed below.</Banner>
                )}
                {reqs.map((e) => <RequestCard key={e.id} e={e} now={now} members={q.data!.members} userId={user?.id} manager={manager} level={level} focused={e.id === focusId} />)}
              </>
            )}
          </div>
          <div className="lg:col-span-4 space-y-6">
            <Panel title="Who can approve" kicker="Owners and admins, not the requester" flush>
              <ul className="divide-y divide-line">
                {(q.data?.members ?? []).filter((m) => (m.role === 'owner' || m.role === 'admin') && m.user).map((m) => (
                  <li key={m.userId} className="px-5 py-2.5 flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0"><span className="font-medium">{m.user!.name}</span><span className="block text-xs text-muted truncate">{m.user!.title}</span></span>
                    <Badge>{m.role}</Badge>
                  </li>
                ))}
              </ul>
              <p className="px-5 py-3 border-t border-line text-xs text-muted">Waiting requests also appear in Work › Reviews for each person who can approve them.</p>
            </Panel>
            <RefusalsPanel refusals={q.data?.refusals} />
            <Panel title="Where personal data is processed" kicker="From the AI inventory" flush>
              {!q.data ? <Skeleton className="h-24 m-5" /> : q.data.systems.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">No AI system in the inventory is marked as processing personal data. Mark it when you register or edit a system.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {q.data.systems.map((s) => (
                    <li key={s.id} className="px-5 py-2.5 text-sm">
                      <Link to={`/inventory/${s.id}`} className="font-medium hover:underline underline-offset-2">{s.name}</Link>
                      <span className="block text-xs text-muted">{s.extra?.principals?.length ? s.extra.principals.join(', ') : s.affectedPeople.join(', ') || 'Data principals not listed'} · {s.extra?.residency ?? q.data!.level.residency}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="What erasure does not do" tone="sunken">
              <ul className="space-y-2 text-sm text-muted">
                <li>Receipts are never deleted or rewritten: their hashes and {l2 ? 'signatures' : 'seals'} keep verifying, and the fields each receipt recorded stay as they were.</li>
                <li>{l2 ? 'Records from before the L2 boundary have no Seal v6 record: their values are removed and the redaction sealed, with no Seal v6 record to mark.' : 'L1 records have no Seal v6 record: their values are removed and the organisation seals what is left. From L2 each seal also marks its payload unbound.'}</li>
                <li>Copies held outside Elan1 Govern (the source system, backups you run) are erased there, by you.</li>
              </ul>
            </Panel>
          </div>
        </div>
      )}

      {manager && openNew && <NewRequestDialog open onClose={() => setOpenNew(false)} />}
    </div>
  );
}

/* ── One request ──────────────────────────────────────────── */

type Member = Awaited<ReturnType<typeof api.members>>[number];

function RequestCard({ e, now, members, userId, manager, level, focused }: { e: ErasureRequest; now: number; members: Member[]; userId?: string; manager: boolean; level: LevelId; focused?: boolean }) {
  const orgId = useOrgId();
  const [busy, setBusy] = useState<'approve' | 'execute'>();
  const [open, setOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const planQ = useQuery((o) => (planOpen ? api.records.requestPlan(o, e) : Promise.resolve(undefined)), [planOpen, e.id, e.status], { live: false });
  const due = new Date(e.dueAt).getTime();
  const left = due - now;
  // a rejected request is closed: no clock runs and it is never overdue
  const overdue = e.status !== 'executed' && e.status !== 'rejected' && left < 0;
  const elapsed = Math.min(1, Math.max(0, (now - new Date(e.requestedAt).getTime()) / (72 * H)));
  const managers = members.filter((m) => m.role === 'owner' || m.role === 'admin');
  const eligible = managers.filter((m) => m.userId !== e.requestedBy && !e.approvals.some((a) => a.userId === m.userId));
  // only owners and admins see Approve; the same-person and second-approval rules keep their reasons
  const whyNotApprove = userId === e.requestedBy ? 'You opened this request. Two other people approve it.' : e.approvals.some((a) => a.userId === userId) ? 'You have approved. A different person gives the second approval.' : undefined;

  const approve = async () => {
    if (!userId) return;
    setBusy('approve');
    try {
      const r = await api.approveErasure(orgId, e.id, userId);
      toast.ok(r.status === 'approved' ? 'Second approval given — ready to execute' : 'Approved', `${r.approvals.length} of ${r.required} approvals.`);
    } catch (err) { toast.bad('Could not approve', (err as Error).message); } finally { setBusy(undefined); }
  };
  const execute = async () => {
    if (!userId) return;
    setBusy('execute');
    try {
      const r = await api.executeErasure(orgId, e.id, userId);
      toast.ok('Salts destroyed', `${plural(r.affected, 'payload hash', 'payload hashes')} unlinkable. The chain ${r.chainStillVerifies ? 'still verifies' : 'needs a check'}.`);
      setOpen(true);
    } catch (err) { toast.bad('Could not execute', (err as Error).message); } finally { setBusy(undefined); }
  };

  const chip = e.status === 'executed' ? <StatusChip tone="ok" icon={<CheckCircle2 className="h-3.5 w-3.5" />}>Executed — salt destroyed</StatusChip>
    : e.status === 'approved' ? <StatusChip tone="info" icon={<UserCheck className="h-3.5 w-3.5" />}>Approved — ready to execute</StatusChip>
    : e.status === 'rejected' ? <StatusChip tone="bad" icon={<XCircle className="h-3.5 w-3.5" />}>Rejected</StatusChip>
    : <StatusChip tone="held" icon={<Hourglass className="h-3.5 w-3.5" />}>Waiting for approval</StatusChip>;

  return (
    <article id={e.id} tabIndex={-1} aria-current={focused ? 'true' : undefined} className={cn('border border-line bg-surface scroll-mt-24 focus:outline-none', overdue && 'border-l-[3px] border-l-bad', focused && 'ring-2 ring-fg ring-offset-2 ring-offset-canvas')}>
      <header className="px-5 py-4 flex flex-wrap items-start justify-between gap-3 border-b border-line">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold">{e.subjectRef}</p>
          <p className="text-sm mt-0.5">{e.reason}</p>
          <p className="text-xs text-muted mt-1">Opened by {userName(e.requestedBy)} <When iso={e.requestedAt} />{e.seq !== undefined && <> · <ReceiptLink seq={e.seq} /></>} · subject hash <span className="font-mono">{e.subjectHash.slice(0, 16)}…</span></p>
        </div>
        {chip}
      </header>

      <div className="px-5 py-4 grid gap-4 sm:grid-cols-3">
        <div>
          <p className="label">72-hour clock</p>
          {e.status === 'executed' ? (
            <p className="mt-1 text-sm">Executed {e.executedAt ? dateTime(e.executedAt) : ''} by {userName(e.executedBy)}</p>
          ) : e.status === 'rejected' ? (
            <p className="mt-1 text-sm inline-flex items-center gap-1.5"><XCircle className="h-3.5 w-3.5 text-bad-fg" aria-hidden />Sent back — not erased. The clock stopped.</p>
          ) : (
            <>
              <p className={cn('mt-1 text-sm font-medium num inline-flex items-center gap-1.5', overdue ? 'text-bad-fg' : left < 12 * H ? 'text-held-fg' : '')} aria-live="polite">
                <Clock3 className="h-3.5 w-3.5" aria-hidden />
                {overdue ? `Overdue by ${countdown(new Date(now + (now - due)).toISOString(), now)}` : `${countdown(e.dueAt, now)} left`}
              </p>
              <div className="mt-2 h-1.5 bg-line" aria-hidden><div className={cn('h-full', overdue ? 'bg-bad' : 'bg-held')} style={{ width: `${elapsed * 100}%` }} /></div>
              <p className="mt-1 text-xs text-muted">Due {dateTime(e.dueAt)}</p>
            </>
          )}
        </div>
        <div>
          <p className="label">Approvals</p>
          <p className="mt-1 text-sm num font-medium">{e.approvals.length} of {e.required}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-muted">
            {e.approvals.map((a) => <li key={a.userId} className="inline-flex items-center gap-1 mr-2"><ShieldCheck className="h-3 w-3 text-ok" aria-hidden />{userName(a.userId)} · <When iso={a.at} /></li>)}
            {e.status === 'awaiting_approval' && <li>Can still approve: {eligible.map((m) => m.user?.name ?? userName(m.userId)).join(', ') || 'no one else — add an admin under People and roles'}</li>}
          </ul>
        </div>
        <div>
          <p className="label">Scope</p>
          <p className="mt-1 text-sm"><span className="num font-medium">{plural(e.affected, 'receipt')}</span> match the identifier</p>
          <p className="text-xs text-muted">Every record is salted from the first L1 record; erasure works at every level.</p>
        </div>
      </div>

      {e.status === 'executed' && (
        <div className={cn('mx-5 mb-4')}>
          <Banner tone={e.chainStillVerifies ? 'ok' : 'held'} title={e.chainStillVerifies ? 'The chain still verifies after the salts were destroyed' : 'The chain was not re-checked'}>
            {atLeast(level, 'l2')
              ? 'Every receipt hash, signature and seal over the affected range was re-checked when the salts were destroyed. The payload hashes below can no longer be linked to the person. The values the rules inspected were removed from each receipt (in this chain and in every export); the organisation signed what is left, so no remaining field can be changed. Each receipt keeps its original hash and signature.'
              : 'Every receipt hash and seal over the affected range was re-checked when the salts were destroyed. The payload hashes below can no longer be linked to the person. The values the rules inspected were removed from each receipt (in this chain and in every export); the organisation sealed what is left, so no remaining field can be changed. Each receipt keeps its original hash and seal.'}
          </Banner>
        </div>
      )}

      <footer className="px-5 py-3 border-t border-line flex flex-wrap items-center gap-2">
        {e.status === 'awaiting_approval' && manager && (
          <Tooltip content={whyNotApprove ?? 'Approve this erasure. A second, different person is needed too.'}>
            <Button size="sm" variant="primary" icon={<UserCheck className="h-3.5 w-3.5" />} loading={busy === 'approve'} disabled={!!whyNotApprove} onClick={approve}>Approve</Button>
          </Tooltip>
        )}
        {e.status === 'approved' && manager && (
          <Tooltip content="Destroy the salts now. This cannot be undone.">
            <Button size="sm" variant="danger" icon={<Eraser className="h-3.5 w-3.5" />} loading={busy === 'execute'} onClick={execute}>Destroy the salts</Button>
          </Tooltip>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" iconRight={planOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} aria-expanded={planOpen} onClick={() => setPlanOpen((o) => !o)}>
          Erasure plan
        </Button>
        <Button size="sm" variant="ghost" iconRight={open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {e.status === 'executed' ? 'Unlinkable payload hashes and chain check' : `Affected receipts (${n(e.affected)})`}
        </Button>
      </footer>
      {planOpen && (
        <div className="border-t border-line px-5 py-4">
          {planQ.error ? <p className="text-sm text-bad-fg">{planQ.error.message}</p> : !planQ.data ? <Skeleton className="h-28" /> : <ErasurePlanView plan={planQ.data} />}
        </div>
      )}
      {open && <AffectedDetail e={e} level={level} />}
    </article>
  );
}

/** The affected receipts: for executed requests, each F14 payload hash that is now unlinkable, and a re-check of the chain. */
function AffectedDetail({ e, level }: { e: ErasureRequest; level: LevelId }) {
  const orgId = useOrgId();
  const [shown, setShown] = useState(12);
  const seqs = e.affectedSeqs.slice(0, shown);
  const sealsQ = useQuery(async (o) => Promise.all(seqs.map((s) => api.seal(o, s).catch(() => undefined))), [e.id, shown, e.status], { live: false });
  const [check, setCheck] = useState<{ chain: string; seals: string; ok: boolean; ms: number }>();
  const [checking, setChecking] = useState(false);

  const recheck = async () => {
    setChecking(true);
    const t0 = performance.now();
    try {
      const lo = Math.min(...e.affectedSeqs);
      const hi = Math.max(...e.affectedSeqs);
      const slice = api.chainSlice(orgId, lo, Math.min(hi, lo + 800));
      const rep = verifyChain(slice.receipts, slice.publicKeys, []);
      const sample = e.affectedSeqs.slice(0, 40);
      const seals = await Promise.all(sample.map((s) => api.seal(orgId, s).catch(() => undefined)));
      let ok = 0, unbound = 0, total = 0;
      for (let i = 0; i < seals.length; i++) {
        const sv = seals[i];
        if (!sv || !sv.sealed) continue;
        total++;
        const c = verifySeal(sv.seal, slice.publicKeys[sv.seal.kid], sv.receipt);
        if (c.structure && c.digest && c.signature && c.binding) ok++;
        if (sv.payloadUnbound) unbound++;
      }
      const chainOk = rep.result === 'verified';
      setCheck({
        chain: chainOk ? `${plural(rep.receipts, 'receipt')} from #${n(rep.firstSeq ?? lo)} to #${n(rep.lastSeq ?? hi)} verify: every hash, link and ${atLeast(level, 'l2') ? 'signature' : 'seal'}.` : `The chain check reports ${rep.result}${rep.brokenAt ? ` at #${n(rep.brokenAt)}` : ''}: ${rep.brokenReason ?? ''}`,
        seals: `${ok} of ${total} seals recompute and verify; ${unbound} carry the destroyed-salt mark.`,
        ok: chainOk && ok === total,
        ms: Math.round(performance.now() - t0),
      });
    } catch (err) {
      setCheck({ chain: (err as Error).message, seals: '', ok: false, ms: 0 });
    } finally {
      setChecking(false);
    }
  };

  if (!e.affectedSeqs.length) return <p className="px-5 py-4 border-t border-line text-sm text-muted">No receipt matches this identifier, so there is no salt to destroy. The request is still recorded.</p>;
  return (
    <div className="border-t border-line">
      {e.status === 'executed' && (
        <div className="px-5 py-3 flex flex-wrap items-center gap-3 border-b border-line">
          <Button size="sm" variant="secondary" icon={<ShieldCheck className="h-3.5 w-3.5" />} loading={checking} onClick={recheck}>Re-check the chain now</Button>
          {check && <span className={cn('text-sm', check.ok ? 'text-ok-fg' : 'text-bad-fg')} aria-live="polite">{check.ok ? 'Still verifies.' : 'Check failed.'} {check.chain} {check.seals} <span className="text-muted num">({n(check.ms)} ms, in this browser)</span></span>}
        </div>
      )}
      {sealsQ.error && <div className="p-4"><Banner tone="bad" title="Seals did not load">{sealsQ.error.message}</Banner></div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Affected receipts and their payload hashes</caption>
          <thead className="bg-sunken/60"><tr className="border-b border-line"><th scope="col" className="label text-left px-5 h-8">Receipt</th><th scope="col" className="label text-left px-3 h-8">F14 payload hash</th><th scope="col" className="label text-right px-5 h-8">State</th></tr></thead>
          <tbody>
            {seqs.map((s, i) => {
              const sv = sealsQ.data?.[i];
              const f14 = sv && sv.sealed ? sv.seal.fields.find((f) => f.id === 'F14')?.value : undefined;
              return (
                <tr key={s} className="border-b border-line last:border-b-0 h-10">
                  <td className="px-5"><ReceiptLink seq={s} /></td>
                  <td className="px-3 font-mono text-[12px] text-muted break-all">{sealsQ.loading && !sealsQ.data ? <Skeleton className="h-4 w-48" /> : f14 ? `${f14.slice(0, 32)}…` : e.status === 'executed' ? 'No seal (L1 record) — values removed, redaction sealed' : 'No seal (L1 record)'}</td>
                  <td className="px-5 text-right whitespace-nowrap">{sv && sv.sealed && sv.payloadUnbound ? <StatusChip size="sm" tone="ok" icon={<Eraser className="h-3 w-3" />}>Unlinkable</StatusChip> : e.status === 'executed' ? <StatusChip size="sm" tone="ok" icon={<Eraser className="h-3 w-3" />}>Values removed</StatusChip> : <StatusChip size="sm" tone="held" icon={<Hourglass className="h-3 w-3" />}>Salt held</StatusChip>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {e.affectedSeqs.length > shown && (
        <div className="px-5 py-3 border-t border-line flex items-center justify-between gap-2 text-sm text-muted">
          <span className="num">Showing {n(shown)} of {n(e.affectedSeqs.length)}</span>
          <Button size="sm" onClick={() => setShown((x) => x + 24)}>Show more</Button>
        </div>
      )}
      <p className="px-5 py-3 border-t border-line text-xs text-muted">{level === 'l1' ? '' : 'F14 is the salted payload hash in each Seal v6 record. Each salt came from a random secret that is never exported, and that secret was deleted, so nobody — Elan1 Govern included — can test a guess of the payload against it.'}</p>
    </div>
  );
}

/* ── New request ──────────────────────────────────────────── */

function NewRequestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [ref, setRef] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [plan, setPlan] = useState<{ needle: string; plan: ErasurePlan }>();
  const [planning, setPlanning] = useState(false);
  const [refused, setRefused] = useState<{ subjectRef: string; seq?: number }>();
  const needle = identifier.trim().toLowerCase();
  // the plan is shown before anything is opened, and must be for the identifier as typed now
  const current = plan && plan.needle === needle ? plan.plan : undefined;
  const reasonErr = reason.trim().length < 8 ? 'Say why, in a sentence.' : undefined;
  const idErr = needle.length < 3 ? 'Enter the identifier to search for: an email domain, a customer name or a record id.' : undefined;
  const preview = async () => {
    setTried(true);
    if (idErr) return;
    setPlanning(true); setErr(undefined);
    try { setPlan({ needle, plan: await api.records.erasurePlan(orgId, needle) }); } catch (x) { setErr((x as Error).message); } finally { setPlanning(false); }
  };
  const submit = async () => {
    setTried(true);
    if (reasonErr || idErr || !user || !current) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await api.records.openErasure(orgId, { subjectRef: ref, identifier, reason }, user.id);
      if (r.outcome === 'refused') {
        setRefused({ subjectRef: r.refusal.subjectRef, seq: r.refusal.seq });
        setPlan({ needle, plan: r.plan });
        toast.info('Erasure refused and recorded', `Every matching record is under statutory retention (${r.refusal.bases.join(', ')}).`);
        return;
      }
      toast.ok(`${r.request.subjectRef} opened`, `${plural(r.request.affected, 'receipt')} in scope${r.plan.held.length ? `, ${r.plan.held.length} held by statutory retention` : ''}. Two other people approve within 72 hours.`);
      onClose();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} size="xl" title="New erasure request" description="See the plan first: the fields, systems and exports it touches, and what the law requires you to keep. The identifier is hashed at once and never stored. Two different people approve, neither of them you."
      footer={refused ? <Button variant="primary" onClick={onClose}>Close</Button> : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" loading={planning} onClick={preview}>{current ? 'Refresh the plan' : 'Show the plan'}</Button>
          <Tooltip content={current ? (current.outcome === 'refused' ? 'Records the refusal: nothing is erased' : 'Opens the request with this plan') : 'Show the plan first'}>
            <Button variant={current?.outcome === 'refused' ? 'danger' : 'primary'} loading={busy} disabled={!current} onClick={submit}>{current?.outcome === 'refused' ? 'Record the refusal' : 'Open the request'}</Button>
          </Tooltip>
        </>
      )}>
      <div className="space-y-5">
        {err && <Banner tone="bad" title="Could not open the request">{err}</Banner>}
        {refused && <Banner tone="bad" title={`${refused.subjectRef} refused — nothing erased`}>The refusal is recorded{refused.seq !== undefined ? <> as <ReceiptLink seq={refused.seq} /></> : ''} with the plan below. Tell the person which law applies and until when.</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Subject reference" htmlFor="ne-ref" hint="Your case number. Left blank, one is made."><Input id="ne-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="DP-2026-…" data-autofocus disabled={!!refused} /></Field>
          <Field label="Scope — identifier to erase" required htmlFor="ne-id" error={tried ? idErr : undefined} hint="Matched against every receipt, from L1. Try a customer domain, or a vendor name to see retention."><Input id="ne-id" mono value={identifier} onChange={(e) => setIdentifier(e.target.value)} invalid={tried && !!idErr} placeholder="prakashretail.in" disabled={!!refused} /></Field>
        </div>
        <Field label="Reason" required htmlFor="ne-reason" error={tried ? reasonErr : undefined}><Textarea id="ne-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} invalid={tried && !!reasonErr} placeholder="The data principal asked for erasure under Section 12 of the DPDP Act." disabled={!!refused} /></Field>
        <div className="border border-line bg-sunken/30 p-4" aria-live="polite">
          {current ? <ErasurePlanView plan={current} /> : (
            <p className="text-sm text-muted">{plan && plan.needle !== needle ? 'The identifier changed. Show the plan again before opening the request.' : <>Show the plan to see what this erasure would touch. Subject hash {needle.length >= 3 ? <span className="font-mono">{sha256Hex(needle).slice(0, 16)}…</span> : 'appears once you type 3 characters'}.</>}</p>
          )}
        </div>
        {current && !refused && <p className="text-xs text-muted flex flex-wrap items-center gap-2"><PlanOutcome plan={current} /> The plan and its digest are recorded with the request.</p>}
      </div>
    </Dialog>
  );
}
