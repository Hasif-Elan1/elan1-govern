import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, X } from 'lucide-react';
import { api } from '@/api';
import type { LevelId } from '@/types';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { useQuery } from '@/hooks/useQuery';
import { cn } from '@/lib/cn';
import { IconButton, Meter, Skeleton } from '@/components/ui';

const keyFor = (orgId: string, level: LevelId) => `eg:today:checklist-dismissed:${orgId}:${level}`;

function readDismissed(orgId: string, level: LevelId) {
  try { return localStorage.getItem(keyFor(orgId, level)) === '1'; } catch { return false; }
}

export interface SetupStep { id: string; level: LevelId; label: string; hint: string; to: string; done: boolean }

/**
 * The set-up steps for the organisation's level, each read as done from its real records — never from clicks.
 * L1: connect, agent, rulebook, decision, approval, export. L2 adds KMS custody, two timestamp authorities, write-once
 * storage, a sealed record, a verifier profile run and dual control used. L3 adds a counterparty, a key ceremony in your
 * HSM and a first graduation to A3. Sovereign adds a verified deployment, a signed update applied and egress denied.
 */
export async function setupSteps(orgId: string, level: LevelId): Promise<SetupStep[]> {
  const [connectors, agents, rulebooks, decisions, approvals, evidence, org] = await Promise.all([
    api.connectors(orgId), api.agents(orgId), api.rulebooks(orgId), api.receipts(orgId, { kind: 'decision', limit: 1 }), api.approvals(orgId), api.evidence(orgId), Promise.resolve(api.org(orgId)),
  ]);
  const steps: SetupStep[] = [
    { id: 'connect', level: 'l1', label: 'Connect a system', hint: 'Gmail, Zoho Books or an MCP server', to: '/connectors', done: connectors.some((c) => c.status === 'connected' || c.status === 'demo') },
    { id: 'agent', level: 'l1', label: 'Add an agent', hint: 'Give it a key and a route', to: '/agents/new', done: agents.length > 0 },
    { id: 'rulebook', level: 'l1', label: 'Publish a rulebook', hint: atLeast(level, 'l2') ? 'Signed; anything not allowed is refused' : 'Anything not allowed is refused', to: '/rulebooks', done: rulebooks.some((rb) => rb.versions.some((v) => v.status === 'published')) },
    { id: 'decision', level: 'l1', label: 'First decision arrived', hint: 'An agent called a tool through Elan1 Govern', to: '/activity', done: decisions.total > 0 },
    { id: 'approval', level: 'l1', label: 'First approval decided', hint: 'A person approved or rejected a held call', to: '/approvals', done: approvals.some((a) => !!a.decidedBy) },
    { id: 'export', level: 'l1', label: 'First evidence exported', hint: atLeast(level, 'l2') ? 'The 8-member evidence bundle' : 'Receipts, checkpoints and public keys in one file', to: '/assurance/exports', done: evidence.exports.length > 0 },
  ];
  if (atLeast(level, 'l2')) {
    const head = evidence.head;
    const l2From = new Date(org.levelHistory?.find((h) => atLeast(h.level, 'l2'))?.from ?? 0).getTime();
    const [custody, anchors, deployment, seal, profiles, reviews] = await Promise.all([
      api.custody(orgId).catch(() => undefined),
      api.anchors(orgId, 2).catch(() => undefined),
      api.deployment(orgId).catch(() => undefined),
      head ? api.seal(orgId, head.seq).catch(() => undefined) : undefined,
      api.profiles(orgId).catch(() => []),
      api.reviews(orgId).catch(() => []),
    ]);
    steps.push(
      { id: 'kms', level: 'l2', label: level === 'l2' ? 'Signing key in AWS KMS' : 'Signing key in custody', hint: custody ? `${custody.provider} · ${custody.residencyDomain}` : 'Key custody in the residency domain', to: '/agents/keys', done: !!custody && custody.mode !== 'env_master' },
      { id: 'tsa', level: 'l2', label: 'Two timestamp authorities', hint: anchors?.authorities.map((a) => a.name.replace(/ \(.*\)$/, '')).join(' and ') || 'eMudhra and a global authority', to: '/assurance/anchors', done: !!anchors?.enabled && anchors.authorities.length >= 2 && anchors.batches.some((b) => b.tokens.length >= 2) },
      { id: 'worm', level: 'l2', label: 'Write-once storage', hint: deployment ? `${deployment.storage.backend}, ${deployment.storage.objectLock} mode` : 'Object lock in compliance mode', to: '/agents/deployment', done: deployment?.storage.objectLock === 'compliance' },
      { id: 'seal', level: 'l2', label: 'First sealed record', hint: 'Seal v6: 16 frozen fields, signed', to: '/activity/chain', done: !!seal && seal.sealed },
      { id: 'profile', level: 'l2', label: 'Verifier profile run', hint: 'MCA audit trail, GST, RBI, EU AI Act, DPDP or ISO 42001', to: '/assurance/profiles', done: profiles.some((p) => p.lastRun) },
      { id: 'dual', level: 'l2', label: 'Dual control used', hint: 'A rulebook reviewed by a second person', to: '/work/reviews', done: reviews.some((r) => r.status === 'approved' || r.status === 'published') || rulebooks.some((rb) => rb.versions.some((v) => v.status === 'published' && !!v.reviewedBy && v.reviewedBy !== v.signedBy && new Date(v.signedAt ?? 0).getTime() >= l2From)) },
    );
  }
  if (atLeast(level, 'l3')) {
    const [cps, custody, grants] = await Promise.all([
      api.counterparties(orgId).catch(() => undefined),
      api.custody(orgId).catch(() => undefined),
      api.grants(orgId).catch(() => undefined),
    ]);
    steps.push(
      { id: 'counterparty', level: 'l3', label: 'First counterparty registered', hint: 'Someone who verifies your receipts', to: '/assurance/counterparties', done: (cps?.counterparties.length ?? 0) > 0 },
      { id: 'ceremony', level: 'l3', label: 'Key ceremony in your HSM', hint: custody ? `${custody.provider}${custody.quorum ? ` · ${custody.quorum.required} of ${custody.quorum.of} holders` : ''}` : 'CloudHSM, Thales Luna or Entrust nShield', to: '/agents/keys', done: !!custody && custody.heldBy === 'customer' && custody.ceremonies.some((c) => c.outcome === 'completed') },
      { id: 'grant', level: 'l3', label: 'First graduation to A3', hint: 'One owner or admin proposes it on the record, a different one approves', to: '/agents/autonomy', done: !!grants?.rows.some((r) => r.graduated) },
    );
  }
  if (level === 'sovereign') {
    const dep = await api.deployment(orgId).catch(() => undefined);
    steps.push(
      { id: 'deployment', level: 'sovereign', label: 'Deployment verified', hint: dep ? `${dep.cluster.nodes.length} nodes · ${dep.database.engine}` : 'Your cluster, database and storage', to: '/agents/deployment', done: !!dep && dep.cluster.nodes.every((x) => x.status === 'ready') && dep.components.every((c) => c.status === 'running') },
      { id: 'update', level: 'sovereign', label: 'Signed update bundle applied', hint: 'Signature checked against the elan1 release key', to: '/agents/deployment', done: !!dep?.updates.some((u) => u.status === 'applied' && u.verified) },
      { id: 'egress', level: 'sovereign', label: 'Egress denied', hint: 'No telemetry leaves your network', to: '/agents/deployment', done: dep?.egress.policy === 'deny_all' },
    );
  }
  return steps;
}

/**
 * First-week checklist for the organisation's level. Every step reads as done from the organisation's real records.
 * Dismissal is remembered in this browser only, per level, so an upgrade brings the new steps back.
 */
export function OnboardingChecklist({ orgId, level, version }: { orgId: string; level: LevelId; version: unknown }) {
  const [dismissed, setDismissed] = useState(() => readDismissed(orgId, level));
  const q = useQuery((o) => setupSteps(o, level), [level, version], { kinds: ['level', 'rulebook', 'agent', 'key', 'autonomy'] });

  if (dismissed) return null;
  if (q.loading && !q.data) return <Skeleton className="h-[120px]" />;
  if (q.error && !q.data) return <p className="text-sm text-bad-fg">The set-up steps could not be read. {q.error.message}</p>;
  const steps = q.data ?? [];
  const doneCount = steps.filter((s) => s.done).length;
  const complete = doneCount === steps.length;
  const levelSteps = steps.filter((s) => s.level !== 'l1');
  // once the first-week steps are done, show only the level's own steps
  const shown = steps.filter((s) => s.level === 'l1').every((s) => s.done) && levelSteps.length ? levelSteps : steps;
  const shownDone = shown.filter((s) => s.done).length;

  const dismiss = () => {
    try { localStorage.setItem(keyFor(orgId, level), '1'); } catch { /* storage unavailable — hide for this session */ }
    setDismissed(true);
  };

  return (
    <section aria-label="Getting started" className="border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-line">
        <div className="min-w-0 flex-1">
          <p className="label mb-0.5">{shown === levelSteps ? `Set-up for ${LEVEL_INFO[level].label}` : 'Getting started'}</p>
          <h2 className="text-lg font-semibold">{complete ? 'Set-up complete' : `${shown.length} steps ${shown === levelSteps ? `to ${LEVEL_INFO[level].name}` : 'to a governed agent'}`}</h2>
        </div>
        <div className="hidden sm:flex items-center gap-3 w-48">
          <Meter value={shown.length ? shownDone / shown.length : 1} label="Set-up progress" />
          <span className="text-sm text-muted num whitespace-nowrap">{shownDone} of {shown.length}</span>
        </div>
        <IconButton label="Dismiss the checklist" size="sm" onClick={dismiss}><X className="h-4 w-4" /></IconButton>
      </div>
      <ol className={cn('grid sm:grid-cols-2 gap-px bg-line', shown.length >= 6 ? 'xl:grid-cols-6' : shown.length === 3 ? 'xl:grid-cols-3' : 'xl:grid-cols-4')}>
        {shown.map((s, i) => (
          <li key={s.id} className="bg-surface">
            <Link to={s.to} className="group flex h-full items-start gap-3 px-4 py-3.5 hover:bg-sunken/60">
              <span className={cn('mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center border text-[11px] font-semibold num', s.done ? 'bg-fg border-fg text-canvas' : 'border-line-strong text-muted')}>
                {s.done ? <Check className="h-3 w-3" strokeWidth={3} aria-hidden /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={cn('block text-sm font-medium', s.done && 'text-muted')}>
                  {s.label}
                  <span className="sr-only">{s.done ? ' — done' : ' — to do'}</span>
                </span>
                <span className="block text-xs text-muted mt-0.5">{s.hint}</span>
              </span>
              <ChevronRight className="ml-auto mt-0.5 h-4 w-4 shrink-0 text-subtle opacity-0 group-hover:opacity-100" aria-hidden />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
