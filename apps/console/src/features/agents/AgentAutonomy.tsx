import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Eye, GraduationCap, Info, ShieldOff, SlidersHorizontal, Undo2, X } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { markReauth, needsReauth, useOrgLevel, useSession, useUser } from '@/store/session';
import { useCanDo, useMemberRole } from '@/features/settings/permissions';
import type { Agent, AutonomyGrant, AutonomyLevel, GraduationProposal } from '@/types';
import { DEMO_ACCOUNTS, userName } from '@/mock/users';
import { AUTONOMY_LEVELS, COOLDOWN_DAYS, GRADUATION, NO_GRANT_LABEL, isReadOnly, precedentScore, type GraduationCheck } from '@/lib/autonomy';
import { atLeast } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { date, dateTime, n, plural } from '@/lib/format';
import { Badge, Banner, Button, DataTable, Dialog, EmptyState, Field, Panel, Skeleton, StatusChip, Textarea, Timeline, Tooltip, toast, type Column } from '@/components/ui';
import { ReceiptLink, TagList } from '@/components/domain';
import { PasswordInput } from '@/features/auth/password';
import { isRetired, type AgentExt } from './backend';
import { UpgradePreview } from './levelPreview';
import { BreachesPanel } from '@/features/agentsdoor/AutonomyBreaches';

/*
 * Autonomy is graduation only (see lib/autonomy.ts). Nothing on these screens sets or raises a level: each write
 * type starts at A2 Propose, one owner or admin proposes a graduation to A3 when the record meets the thresholds,
 * a different owner or admin approves it, and any owner or admin revokes it in one press. The pieces below are
 * shared with Agents › Autonomy (agentsdoor/AutonomyPage).
 */

type Row = Awaited<ReturnType<typeof api.grants>>['rows'][number];
export type Candidate = Awaited<ReturnType<typeof api.graduationCandidates>>[number];
export type Supervision = Awaited<ReturnType<typeof api.supervision>>[number];
type SampledCall = Supervision['sampled'][number];

const levelName = (l: AutonomyLevel) => AUTONOMY_LEVELS.find((x) => x.id === l)!.label;
const currentOrg = () => useSession.getState().orgId;
const shortDate = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function AutonomyChip({ level, hasGrant = true, supervised, size = 'sm' }: { level: AutonomyLevel; hasGrant?: boolean; supervised?: boolean; size?: 'sm' | 'md' }) {
  if (!hasGrant) return <StatusChip tone="neutral" size={size} icon={<ShieldOff className="h-3 w-3" aria-hidden />}>{NO_GRANT_LABEL}</StatusChip>;
  return <StatusChip tone={level === GRADUATION.to ? 'info' : 'neutral'} size={size} icon={<SlidersHorizontal className="h-3 w-3" aria-hidden />}>{levelName(level)}{supervised ? ' · supervised' : ''}</StatusChip>;
}

/** The highest level in force across an agent's write types (for headers and the registry), and how many graduated. */
export function highestGrant(rows: Row[] | undefined, slug: string): { level: AutonomyLevel; hasGrant: boolean; tools: number; graduated: number; supervised: number } | undefined {
  if (!rows) return undefined;
  const mine = rows.filter((r) => r.agentSlug === slug && !isReadOnly(r.tags));
  const top = mine.filter((r) => r.grant).reduce<AutonomyLevel | undefined>((m, r) => (!m || Number(r.level.slice(1)) > Number(m.slice(1)) ? r.level : m), undefined);
  return { level: top ?? 'A0', hasGrant: !!top, tools: mine.length, graduated: mine.filter((r) => r.graduated).length, supervised: mine.filter((r) => r.supervised).length };
}

/**
 * The three graduation thresholds as numbers: value, the threshold, met or not met. With `record`, the precedent
 * score sits beside them as information only (it is not a threshold and changes nothing).
 */
export function RecordChecks({ checks, className, record }: { checks: GraduationCheck[]; className?: string; record?: { approvals: number; rejections: number; reversals: number } }) {
  const ps = record ? precedentScore(record) : undefined;
  return (
    <dl className={cn('grid gap-2 text-xs', ps ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3', className)}>
      {checks.map((c) => (
        <div key={c.id} className={cn('border px-2 py-1.5 min-w-0', c.met ? 'border-line' : 'border-line-strong/60 bg-sunken/50')}>
          <dt className="text-muted truncate">{c.label}</dt>
          <dd className="mt-0.5"><span className="font-semibold num">{n(c.value)}</span> <span className="text-muted num">/ {n(c.need)}</span></dd>
          <dd className={cn('mt-0.5 inline-flex items-center gap-1', c.met ? 'text-ok-fg' : 'text-muted')}>{c.met ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}{c.met ? 'Met' : 'Not met'}</dd>
        </div>
      ))}
      {ps && (
        <Tooltip content={`${ps.version}: approved share of ${n(ps.decided)} decided (${Math.round(ps.approvedShare * 100)}%), less 5 points per reversal (−${ps.reversalPenalty}). Information only — not a threshold and not a recommendation; graduation is decided on the three checks.`}>
          <div className="border border-dashed border-line-strong/60 px-2 py-1.5 min-w-0" tabIndex={0}>
            <dt className="text-muted truncate">Precedent score</dt>
            <dd className="mt-0.5"><span className="font-semibold num">{ps.score}</span> <span className="text-muted num">/ 100</span></dd>
            <dd className="mt-0.5 inline-flex items-center gap-1 text-muted"><Info className="h-3 w-3" aria-hidden />Information</dd>
          </div>
        </Tooltip>
      )}
    </dl>
  );
}

/** A fresh sign-in is asked for when the last one is older than 10 minutes (proposing or approving a graduation). */
function useReauth() {
  const user = useUser();
  const [password, setPassword] = useState('');
  const reauth = needsReauth();
  const check = (): string | undefined => {
    if (!reauth) return undefined;
    const acct = DEMO_ACCOUNTS.find((a) => a.userId === user?.id);
    if (!password || (acct && acct.password !== password)) return 'Your password is not right. A graduation asks for a fresh sign-in.';
    markReauth();
    return undefined;
  };
  const field = reauth ? <Field label="Your password" htmlFor="grad-pw" hint="Your last sign-in is older than 10 minutes."><PasswordInput id="grad-pw" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field> : null;
  return { check, field };
}

/* ── Actions shared with Agents › Autonomy ────────────────── */

/** Revoke a graduation: one press by one owner or admin, at once. The write type falls back to A2 Propose. */
export function RevokeButton({ grant, disabled, label = 'Revoke' }: { grant: AutonomyGrant; disabled?: boolean; label?: string }) {
  const user = useUser();
  const [busy, setBusy] = useState(false);
  const go = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    setBusy(true);
    try {
      const r = await api.revokeGrant(currentOrg(), grant.id, user.id);
      toast.ok(`A3 revoked for ${grant.tool}`, `${grant.agentSlug} is back to ${r.fallsBackTo === 'A0' ? NO_GRANT_LABEL : levelName(r.fallsBackTo)} for it, from the next call. It can be proposed again after ${COOLDOWN_DAYS} days. Receipt #${r.seq}.`);
    } catch (err) {
      toast.bad('Not revoked', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <Button size="sm" variant="quiet-danger" icon={<Undo2 className="h-3.5 w-3.5" />} loading={busy} disabled={disabled} onClick={go}>{label}</Button>;
}

/** Propose graduating one write type to A3. The justification is the proposer's own words; nothing is pre-filled. */
export function ProposeDialog({ candidate, onClose }: { candidate?: Candidate; onClose: () => void }) {
  const user = useUser();
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const re = useReauth();
  const key = candidate ? `${candidate.agentSlug}|${candidate.tool}` : undefined;
  if (key && open !== key) { setOpen(key); setWhy(''); setError(undefined); }
  if (!key && open) setOpen(undefined);
  const go = async () => {
    if (!user || !candidate) return;
    setError(undefined);
    const bad = re.check();
    if (bad) { setError(bad); return; }
    setBusy(true);
    try {
      const p = await api.proposeGraduation(currentOrg(), { agentSlug: candidate.agentSlug, tool: candidate.tool, justification: why }, user.id);
      toast.held('Graduation proposed', `A different owner or admin approves A3 for ${candidate.agentSlug} on ${candidate.tool}. Receipt #${p.seq}.`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!candidate} onClose={onClose} size="lg" title={candidate ? 'Propose a graduation to A3' : ''}
      description={candidate ? <><span className="font-mono">{candidate.agentSlug}</span> on <span className="font-mono">{candidate.tool}</span> · now {levelName(candidate.level)}</> : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<GraduationCap className="h-4 w-4" />} loading={busy} disabled={why.trim().length < 10 || !candidate?.eligible} onClick={go}>Propose</Button></>}>
      {candidate && (
        <div className="space-y-4">
          {error && <Banner tone="bad" title="Not proposed">{error}</Banner>}
          <div>
            <p className="label mb-2">The record for this write type</p>
            <RecordChecks checks={candidate.checks} record={candidate.precedent} />
            <p className="mt-2 text-xs text-muted num">Rejected {n(candidate.precedent.rejections)} · reversed {n(candidate.precedent.reversals)} · since {date(candidate.precedent.since)}. Numbers only, never a recommendation; the precedent score is information beside them.</p>
          </div>
          <Field label="Your justification" required htmlFor="grad-why" hint="Recorded on the receipt. Say what you checked; it is not pre-filled.">
            <Textarea id="grad-why" rows={3} value={why} onChange={(e) => setWhy(e.target.value)} data-autofocus />
          </Field>
          {re.field}
          <p className="text-xs text-muted">A different owner or admin approves it. On approval {candidate.agentSlug} acts at A3 on {candidate.tool} — the rulebook decides unchanged — and the first {GRADUATION.supervisedDays} days are supervised: 1 in {GRADUATION.sampleEvery} calls is sampled for a person to review. Revoking is one press.</p>
        </div>
      )}
    </Dialog>
  );
}

/** The second person decides (approve or decline with a note); the proposer can only withdraw. */
export function DecideGraduationDialog({ prop, onClose }: { prop?: GraduationProposal; onClose: () => void }) {
  const user = useUser();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'yes' | 'no'>();
  const [error, setError] = useState<string>();
  const re = useReauth();
  const proposer = prop ? prop.proposedBy ?? prop.decisions[0]?.userId : undefined;
  const mine = !!prop && proposer === user?.id;
  const go = async (approve: boolean) => {
    if (!user || !prop) return;
    setError(undefined);
    if (!approve && !mine && note.trim().length < 4) { setError('Say why you decline — the note is recorded.'); return; }
    if (approve) { const bad = re.check(); if (bad) { setError(bad); return; } }
    setBusy(approve ? 'yes' : 'no');
    try {
      const r = await api.decideGraduation(currentOrg(), prop.id, approve, user.id, note.trim());
      if (r.status === 'granted') toast.ok(`${prop.agentSlug} graduated to A3 on ${prop.tool}`, `Supervised for ${GRADUATION.supervisedDays} days: 1 in ${GRADUATION.sampleEvery} calls is sampled for a person. Receipt #${r.seq}.`);
      else toast.ok(r.status === 'withdrawn' ? 'Proposal withdrawn' : 'Graduation declined', `Recorded${r.seq ? ` as receipt #${r.seq}` : ''}.`);
      setNote('');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Dialog open={!!prop} onClose={onClose} size="lg" title={prop ? `Graduate ${prop.agentSlug} to A3?` : ''}
      description={prop ? <><span className="font-mono">{prop.tool}</span> · {prop.from} → {prop.to} · proposed by {userName(proposer)} on {date(prop.createdAt)}</> : undefined}
      footer={mine ? <><Button variant="ghost" onClick={onClose}>Keep it</Button><Button variant="quiet-danger" loading={busy === 'no'} onClick={() => go(false)}>Withdraw proposal</Button></> : (
        <><Button variant="quiet-danger" loading={busy === 'no'} disabled={!!busy} onClick={() => go(false)}>Decline</Button><Button variant="primary" icon={<Check className="h-4 w-4" />} loading={busy === 'yes'} disabled={!!busy} onClick={() => go(true)}>Approve graduation</Button></>
      )}>
      {prop && (
        <div className="space-y-4">
          {error && <Banner tone="bad" title="Not recorded">{error}</Banner>}
          <div>
            <p className="label mb-2">The record when it was proposed</p>
            <RecordChecks checks={[
              { id: 'days', label: 'Days of operation', value: prop.evidence.days, need: GRADUATION.minDays, met: prop.evidence.days >= GRADUATION.minDays },
              { id: 'records', label: 'Records', value: prop.evidence.records, need: GRADUATION.minRecords, met: prop.evidence.records >= GRADUATION.minRecords },
              { id: 'approvals', label: 'Approvals', value: prop.evidence.approvals, need: GRADUATION.minApprovals, met: prop.evidence.approvals >= GRADUATION.minApprovals },
            ]} record={prop.evidence} />
            <p className="mt-2 text-xs text-muted num">Rejected {n(prop.evidence.rejections)} · reversed {n(prop.evidence.reversals)}. Numbers only, never a recommendation; the record is checked again when you approve. A graduation revoked later, by a person or on a breach, cannot be proposed again for {COOLDOWN_DAYS} days.</p>
          </div>
          {prop.decisions[0] && <p className="text-sm"><span className="text-muted">{userName(proposer)}’s justification:</span> “{prop.decisions[0].note}”</p>}
          {mine ? <p className="text-sm text-muted">You proposed this graduation, so a different owner or admin approves it. You can withdraw it.</p> : (
            <>
              <Field label="Note for the record" htmlFor="grad-note" hint="Required to decline."><Textarea id="grad-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked" /></Field>
              {re.field}
              <p className="text-xs text-muted">Approving writes the A3 grant (autonomy.graduated, naming both people) and starts a {GRADUATION.supervisedDays}-day supervised period sampling 1 in {GRADUATION.sampleEvery} calls. Any owner or admin can revoke it in one press.</p>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** The supervised period of each graduation: calls so far, the 1-in-10 sample, and a review per sampled call. */
export function SupervisionPanel({ rows, canReview, className, showAgent }: { rows: Supervision[]; canReview: boolean; className?: string; showAgent?: boolean }) {
  const active = rows.filter((r) => r.active);
  const ended = rows.filter((r) => !r.active).slice(0, 3);
  const [reviewing, setReviewing] = useState<{ row: Supervision; call: SampledCall }>();
  return (
    <Panel className={className} title={<span className="inline-flex items-center gap-2"><Eye className="h-4 w-4" aria-hidden />Supervised period</span>} actions={<Badge tone={active.length ? 'held' : 'neutral'}>{active.length} running</Badge>} flush
      footer={`The first ${GRADUATION.supervisedDays} days after a graduation: 1 in ${GRADUATION.sampleEvery} calls (the 1st, 11th, 21st …) is sampled for an owner, admin or approver to review. After that it is a normal A3 grant.`}>
      {rows.length === 0 ? <p className="p-5 text-sm text-muted">No graduation yet, so nothing is supervised.</p> : (
        <ul className="divide-y divide-line">
          {[...active, ...ended].map((r) => {
            const open = r.sampled.filter((s) => !s.review);
            return (
              <li key={r.grant.id} className="px-5 py-3.5 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p>{showAgent && <><span className="font-mono">{r.grant.agentSlug}</span> · </>}<span className="font-mono text-[12.5px] break-all">{r.grant.tool}</span></p>
                    <p className="mt-0.5 text-xs text-muted num">
                      {r.active ? `Supervised until ${shortDate(r.endsAt)}` : r.grant.revokedAt ? `Revoked ${shortDate(r.grant.revokedAt)}` : `Ended ${shortDate(r.endsAt)}; a normal A3 grant`} · {plural(r.calls, 'call')} · {n(r.sampled.length)} sampled · {n(r.reviewed)} reviewed{r.concerns ? ` · ${plural(r.concerns, 'concern')}` : ''}
                    </p>
                  </div>
                  {r.active ? <StatusChip size="sm" tone="held">Supervised</StatusChip> : <StatusChip size="sm" tone="neutral">{r.grant.revokedAt ? 'Revoked' : 'Ended'}</StatusChip>}
                </div>
                {r.sampled.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {r.sampled.slice(-4).map((s) => (
                      <li key={s.seq} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <ReceiptLink seq={s.seq} />
                        <span className="text-muted">{dateTime(s.ts)} · {s.decision ?? '—'}</span>
                        {s.review
                          ? <span className={cn('inline-flex items-center gap-1', s.review.ok ? 'text-ok-fg' : 'text-held-fg')}>{s.review.ok ? <Check className="h-3 w-3" aria-hidden /> : <X className="h-3 w-3" aria-hidden />}{s.review.ok ? 'Reviewed' : 'Concern'} by {userName(s.review.by)}</span>
                          : canReview && r.active ? <Button size="sm" variant="secondary" onClick={() => setReviewing({ row: r, call: s })}>Review</Button> : <span className="text-muted">Not reviewed</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {r.active && open.length > 0 && !canReview && <p className="mt-1.5 text-xs text-muted">{plural(open.length, 'sampled call')} waiting for an owner, admin or approver.</p>}
              </li>
            );
          })}
        </ul>
      )}
      <ReviewSampleDialog target={reviewing} onClose={() => setReviewing(undefined)} />
    </Panel>
  );
}

function ReviewSampleDialog({ target, onClose }: { target?: { row: Supervision; call: SampledCall }; onClose: () => void }) {
  const user = useUser();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'ok' | 'concern'>();
  const [error, setError] = useState<string>();
  const go = async (ok: boolean) => {
    if (!user || !target) return;
    setError(undefined);
    setBusy(ok ? 'ok' : 'concern');
    try {
      const r = await api.reviewSample(currentOrg(), { grantId: target.row.grant.id, seq: target.call.seq, ok, note }, user.id);
      toast.ok(ok ? 'Sampled call reviewed' : 'Concern recorded', ok ? `Receipt #${r.reviewSeq}.` : `Receipt #${r.reviewSeq}. Revoking the graduation is a separate press.`);
      setNote('');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const t = target;
  return (
    <Dialog open={!!t} onClose={onClose} title={t ? `Review sampled call #${t.call.seq}` : ''}
      description={t ? <><span className="font-mono">{t.row.grant.agentSlug}</span> on <span className="font-mono">{t.row.grant.tool}</span> · A3, supervised until {shortDate(t.row.endsAt)}</> : undefined}
      footer={<><Button variant="quiet-danger" loading={busy === 'concern'} disabled={!!busy} onClick={() => go(false)}>Record a concern</Button><Button variant="primary" icon={<Check className="h-4 w-4" />} loading={busy === 'ok'} disabled={!!busy} onClick={() => go(true)}>Right for A3</Button></>}>
      {t && (
        <div className="space-y-4">
          {error && <Banner tone="bad" title="Not recorded">{error}</Banner>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted">Receipt</dt><dd><ReceiptLink seq={t.call.seq} /> · {dateTime(t.call.ts)}</dd>
            <dt className="text-muted">Decision</dt><dd>{t.call.decision ?? '—'}{t.call.ruleId && <span className="font-mono text-xs text-muted"> · {t.call.ruleId}</span>}</dd>
            {t.call.summary && <><dt className="text-muted">Call</dt><dd className="break-words">{t.call.summary}</dd></>}
          </dl>
          <Field label="Note" htmlFor="sample-note" hint="Required for a concern. A concern does not revoke on its own."><Textarea id="sample-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
      )}
    </Dialog>
  );
}

/* ── The agent's Autonomy tab ─────────────────────────────── */

export function AgentAutonomy({ agent }: { agent: Agent }) {
  const level = useOrgLevel();
  const enforced = atLeast(level, 'l3');
  const user = useUser();
  const role = useMemberRole();
  // owners and admins propose, approve and revoke (the autonomy.grant permission); approvers also review samples
  const canGrant = useCanDo('autonomy.grant');
  const canReview = role === 'owner' || role === 'admin' || role === 'approver';
  const retired = isRetired(agent as AgentExt);
  const kinds = { kinds: ['autonomy', 'receipt', 'level', 'approval'] };
  const gQ = useQuery((o) => api.grants(o), [], kinds);
  const cQ = useQuery((o) => api.graduationCandidates(o), [], kinds);
  const pQ = useQuery((o) => api.graduationProposals(o), [], kinds);
  const sQ = useQuery((o) => api.supervision(o), [], kinds);
  const [proposing, setProposing] = useState<Candidate>();
  const [deciding, setDeciding] = useState<GraduationProposal>();

  const rows = useMemo(() => (gQ.data?.rows ?? []).filter((r) => r.agentSlug === agent.slug), [gQ.data, agent.slug]);
  const candidates = useMemo(() => new Map((cQ.data ?? []).filter((c) => c.agentSlug === agent.slug).map((c) => [c.tool, c])), [cQ.data, agent.slug]);
  const proposals = (pQ.data ?? []).filter((p) => p.agentSlug === agent.slug);
  const open = proposals.filter((p) => p.status === 'open');
  const supervision = (sQ.data ?? []).filter((r) => r.grant.agentSlug === agent.slug);
  const history = useMemo(() => rows.flatMap((r) => r.history).sort((a, b) => b.grantedAt.localeCompare(a.grantedAt)), [rows]);

  if (!enforced) {
    return (
      <UpgradePreview to="l3" title="Earned autonomy"
        what={<>From L3 Proven each of {agent.slug}'s write types starts at A2 Propose — a person approves every write — and the guard applies it after the rulebook. No one sets a level directly: a write type reaches A3 Act reversible only by a graduation one owner or admin proposes and a different one approves, once its record shows at least {GRADUATION.minDays} days, {GRADUATION.minRecords} records and {GRADUATION.minApprovals} approvals. The first {GRADUATION.supervisedDays} days at A3 are supervised (1 in {GRADUATION.sampleEvery} calls sampled for a person). Revoking is one press. A4 and A5 are not yet available.</>}>
        <ul className="divide-y divide-line border border-line bg-surface">
          {agent.tools.slice(0, 6).map((t) => (
            <li key={t} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="font-mono text-[12.5px]">{t}</span>
              <span className="text-xs text-muted">Starts at A2 Propose at the upgrade; A3 by graduation</span>
            </li>
          ))}
        </ul>
      </UpgradePreview>
    );
  }

  const error = gQ.error ?? cQ.error ?? pQ.error ?? sQ.error;
  const cols: Column<Row>[] = [
    { key: 'tool', header: 'Tool (write type)', sort: (r) => r.tool, cell: (r) => <div className="py-1.5 min-w-0"><p className="font-mono text-[12.5px]">{r.tool}</p><div className="mt-1"><TagList tags={r.tags} /></div></div> },
    { key: 'level', header: 'Level', sort: (r) => (r.grant ? Number(r.level.slice(1)) : -1), cell: (r) => <AutonomyChip level={r.level} hasGrant={!!r.grant} supervised={r.supervised} /> },
    {
      key: 'record', header: 'Record for graduation', hideBelow: 'md',
      cell: (r) => {
        const c = candidates.get(r.tool);
        if (!c) return <span className="text-xs text-muted">{isReadOnly(r.tags) ? 'Reads run at every level, A0 included.' : 'Not counted.'}</span>;
        if (r.graduated && r.grant) return (
          <div className="text-xs text-muted leading-relaxed py-1">
            <p>Graduated {date(r.grant.grantedAt)}: approved by <span className="text-fg">{userName(r.grant.grantedBy)}</span>{r.grant.seq ? <> · <ReceiptLink seq={r.grant.seq} /></> : null}</p>
            {r.supervised && r.grant.supervisedUntil && <p>Supervised until {date(r.grant.supervisedUntil)}: 1 in {r.grant.sampleEvery ?? GRADUATION.sampleEvery} calls sampled</p>}
          </div>
        );
        return (
          <div className="py-1 min-w-[260px]">
            <RecordChecks checks={c.checks} record={c.precedent} />
            {c.whyNot && (!c.met || c.cooldownUntil) && <p className={cn('mt-1 text-[11px]', c.cooldownUntil ? 'text-held-fg' : 'text-muted')}>{c.whyNot}</p>}
            {c.openProposalId && <p className="mt-1 text-[11px] text-held-fg">A proposal is waiting for a second person.</p>}
          </div>
        );
      },
    },
    // propose and revoke belong to owners and admins (autonomy.grant); other roles read the table without them
    ...(!canGrant ? [] : [{
      key: 'act', header: <span className="sr-only">Actions</span>, align: 'right' as const,
      cell: (r: Row) => {
        const c = candidates.get(r.tool);
        if (r.graduated && r.grant) return (
          <Tooltip content="Revoke now: one press, effective at the next call. The write type falls back to A2 Propose.">
            <RevokeButton grant={r.grant} />
          </Tooltip>
        );
        if (!c) return null;
        return (
          <Tooltip content={retired ? 'This agent is retired.' : c.eligible ? 'Propose A3; a different owner or admin approves it' : c.whyNot ?? ''}>
            <Button size="sm" variant="secondary" icon={<GraduationCap className="h-3.5 w-3.5" />} disabled={retired || !c.eligible} onClick={(e) => { e.stopPropagation(); setProposing(c); }}>Propose A3</Button>
          </Tooltip>
        );
      },
    }]),
  ];

  return (
    <div className="space-y-6">
      {error && <Banner tone="bad" title="Autonomy did not load" actions={<Button size="sm" onClick={() => { gQ.refetch(); cQ.refetch(); pQ.refetch(); sQ.refetch(); }}>Try again</Button>}>{error.message}</Banner>}
      <Banner tone="info" title="Autonomy is earned by graduation; no one sets a level">
        Each write type starts at A2 Propose: a person approves every write. It reaches A3 only when one owner or admin proposes a graduation and a different one approves it, with at least {GRADUATION.minDays} days, {GRADUATION.minRecords} records and {GRADUATION.minApprovals} approvals for that write type. The first {GRADUATION.supervisedDays} days are supervised: 1 in {GRADUATION.sampleEvery} calls is sampled for a person. Revoking is one press by one owner or admin, at once. A4 and A5 are not yet available.
        {' '}<Link to={`/agents/autonomy?agent=${agent.slug}`} className="underline underline-offset-2">Autonomy across all agents</Link>
      </Banner>

      {open.length > 0 && (
        <Panel title={`${plural(open.length, 'graduation')} waiting for a second person`} flush>
          <ul className="divide-y divide-line">
            {open.map((p) => {
              const proposer = p.proposedBy ?? p.decisions[0]?.userId;
              const mine = proposer === user?.id;
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0 text-sm">
                    <p><span className="font-mono text-[12.5px]">{p.tool}</span> · {levelName(p.from)} → <span className="font-medium">{levelName(p.to)}</span></p>
                    <p className="text-xs text-muted num">Proposed by {userName(proposer)} · {n(p.evidence.days)} days · {n(p.evidence.records)} records · {n(p.evidence.approvals)} approvals{p.seq ? <> · <ReceiptLink seq={p.seq} /></> : null}</p>
                  </div>
                  {canGrant ? (
                    <Tooltip content={mine ? 'You proposed it; a different owner or admin approves. You can withdraw it.' : 'Approve or decline, with a note'}>
                      <Button size="sm" variant="secondary" onClick={() => setDeciding(p)}>{mine ? 'Withdraw' : 'Decide'}</Button>
                    </Tooltip>
                  ) : <span className="text-xs text-muted">Waiting for an owner or admin</span>}
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      <DataTable caption={`Autonomy per tool for ${agent.slug}`} columns={cols} rows={gQ.data ? rows : undefined} loading={gQ.loading} rowKey={(r) => r.tool}
        empty={<EmptyState compact title="No tools" disc="gate">This agent has no tools, so there is nothing to graduate.</EmptyState>} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 [&>*]:min-w-0">
        <div className="lg:col-span-7 space-y-6">
          <SupervisionPanel rows={supervision} canReview={canReview} />
          <BreachesPanel agentSlug={agent.slug} graduated={rows.filter((r) => r.graduated && r.grant).map((r) => r.grant!)} />
        </div>

        <Panel className="lg:col-span-5" title="Autonomy history">
          {gQ.loading ? <Skeleton className="h-32" /> : history.length === 0 ? <p className="text-sm text-muted">Nothing yet. Write types start at A2 Propose when they are first governed at L3.</p> : (
            <Timeline items={history.slice(0, 12).map((g) => ({
              title: <span><span className="font-mono text-[12px]">{g.tool}</span> · {levelName(g.level)}{g.origin === 'start' ? <span className="text-muted font-normal"> · starting level</span> : g.origin === 'graduation' ? <span className="text-muted font-normal"> · graduated</span> : ''}{g.revokedAt ? <span className="text-muted font-normal"> · revoked</span> : ''}</span>,
              time: dateTime(g.grantedAt),
              body: <>{g.origin === 'start' ? 'Set by the platform at L3' : userName(g.grantedBy)}: “{g.reason}”{g.seq ? <> · <ReceiptLink seq={g.seq} /></> : null}{g.revokedAt ? <> · revoked {date(g.revokedAt)}{g.revokedBy === 'system' ? ' automatically, on an autonomy breach' : g.revokedBy ? ` by ${userName(g.revokedBy)}` : ''}</> : null}</>,
              tone: g.revokedAt ? 'neutral' : g.origin === 'graduation' ? 'ok' : 'info',
            }))} />
          )}
        </Panel>
      </div>

      <ProposeDialog candidate={proposing} onClose={() => setProposing(undefined)} />
      <DecideGraduationDialog prop={deciding} onClose={() => setDeciding(undefined)} />
    </div>
  );
}
