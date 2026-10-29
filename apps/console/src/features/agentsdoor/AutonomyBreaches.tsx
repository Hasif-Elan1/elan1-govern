import { useState } from 'react';
import { SmartLink, useCanSee } from '@/shell/access';
import { Hourglass, ShieldAlert } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useUser } from '@/store/session';
import { useMemberRole } from '@/features/settings/permissions';
import type { AutonomyGrant } from '@/types';
import { COOLDOWN_DAYS } from '@/lib/autonomy';
import { date, dateTime, plural } from '@/lib/format';
import { userName } from '@/mock/users';
import { Badge, Banner, Button, Dialog, Field, Input, Panel, Select, Skeleton, StatusChip, Textarea, toast } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';

/**
 * Autonomy breaches and cooldowns (L3). An autonomy_breach incident revokes the agent's graduated grants at once,
 * by the platform; after any revocation the write type cannot be proposed again for 30 days. A person (owner, admin
 * or approver) reports a breach here; incidents opened elsewhere (declared by hand, or by the assurance checks) do
 * the same. Revoking a graduation is for owners and admins (autonomy.grant): an approver's report opens the
 * incident and waits for an owner or admin to confirm the revoke.
 */
export function BreachesPanel({ agentSlug, graduated, className }: { agentSlug?: string; graduated: AutonomyGrant[]; className?: string }) {
  const role = useMemberRole();
  const canReport = role === 'owner' || role === 'admin' || role === 'approver';
  const canRevoke = role === 'owner' || role === 'admin';
  const seeIncidents = useCanSee('/incidents');
  const orgId = useOrgId();
  const user = useUser();
  const [confirming, setConfirming] = useState<string>();
  const confirm = async (incidentId: string) => {
    if (!user) return;
    setConfirming(incidentId);
    try {
      const r = await api.confirmBreachRevoke(orgId, incidentId, user.id);
      toast.bad('Graduation revoked', `${plural(r.revoked.length, 'A3 grant')} revoked; no re-proposal for ${COOLDOWN_DAYS} days. Receipt #${r.seq}.`);
    } catch (e) { toast.bad('Not revoked', (e as Error).message); } finally { setConfirming(undefined); }
  };
  const q = useQuery((o) => api.autonomyBreaches(o), [], { kinds: ['autonomy', 'incident', 'receipt'] });
  const [open, setOpen] = useState(false);
  const breaches = (q.data?.breaches ?? []).filter((b) => !agentSlug || b.agentSlug === agentSlug);
  const cooldowns = (q.data?.cooldowns ?? []).filter((c) => !agentSlug || c.agentSlug === agentSlug);
  const active = graduated.filter((g) => !g.revokedAt && (!agentSlug || g.agentSlug === agentSlug));
  return (
    <Panel className={className} flush title={<span className="inline-flex items-center gap-2"><ShieldAlert className="h-4 w-4" aria-hidden />Breaches and cooldowns</span>}
      actions={canReport ? <Button size="sm" variant="quiet-danger" disabled={!active.length} onClick={() => setOpen(true)}>Report a breach</Button> : undefined}
      footer={`A breach opens an incident. Reported by an owner or admin, the graduation is revoked at once; reported by an approver, an owner or admin confirms the revoke. After any revocation the write type cannot be proposed again for ${COOLDOWN_DAYS} days.`}>
      {q.loading && !q.data ? <div className="p-5"><Skeleton className="h-20" /></div> : q.error ? <div className="p-5"><Banner tone="bad">{q.error.message}</Banner></div> : (
        <div className="divide-y divide-line">
          {cooldowns.length > 0 && (
            <div className="px-5 py-3.5">
              <p className="label mb-2">Cooldowns running</p>
              <ul className="space-y-2 text-sm">
                {cooldowns.map((c) => (
                  <li key={`${c.agentSlug}|${c.tool}`} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0"><span className="font-mono">{c.agentSlug}</span> · <span className="font-mono text-[12.5px] break-all">{c.tool}</span></span>
                    <StatusChip size="sm" tone="held" icon={<Hourglass className="h-3 w-3" aria-hidden />}>Until {date(c.until)}</StatusChip>
                    <span className="w-full text-xs text-muted">Revoked {dateTime(c.revokedAt)}{c.automatic ? ' automatically, on a breach' : c.revokedBy ? ` by ${userName(c.revokedBy)}` : ''}{c.incidentId && seeIncidents ? <> · <SmartLink to={`/incidents/${c.incidentId}`} className="link">incident</SmartLink></> : null}. Back at A2 Propose; it can be proposed again from {date(c.until)}.</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {breaches.length > 0 ? (
            <ul>
              {breaches.slice(0, 6).map((b) => (
                <li key={b.incidentId} className="px-5 py-3.5 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <SmartLink to={`/incidents/${b.incidentId}`} className="min-w-0 font-medium hover:underline underline-offset-2" plainClassName="min-w-0 font-medium">{b.title}</SmartLink>
                    <StatusChip size="sm" tone={b.status === 'active' ? 'bad' : 'neutral'}>{b.status === 'active' ? 'Open' : 'Resolved'}</StatusChip>
                  </div>
                  <p className="mt-1 text-xs text-muted">{dateTime(b.startedAt)} · reported by {userName(b.startedBy)}{b.callSeq !== undefined ? <> · call <ReceiptLink seq={b.callSeq} /></> : null}</p>
                  <p className="mt-1 text-xs">“{b.reason}”</p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                    {b.awaitingRevoke ? (
                      <>
                        <Badge tone="held">Waiting for an owner or admin to confirm the revoke</Badge>
                        {canRevoke
                          ? <Button size="sm" variant="danger" loading={confirming === b.incidentId} disabled={!!confirming} onClick={() => confirm(b.incidentId)}>Confirm and revoke</Button>
                          : <span className="text-muted">Until then the graduation stays in force.</span>}
                      </>
                    ) : b.revoked.length ? b.revoked.map((r) => <Badge key={r.grantId} tone="neutral">A3 on {r.tool} revoked{b.revokeConfirmedBy ? `, confirmed by ${userName(b.revokeConfirmedBy)}` : ' automatically'}{r.seq ? ` · #${r.seq}` : ''}</Badge>) : <span className="text-muted">No graduation to revoke.</span>}
                  </p>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 py-4 text-sm text-muted">No autonomy breach{agentSlug ? ` for ${agentSlug}` : ''}.</p>}
        </div>
      )}
      {open && <ReportDialog grants={active} canRevoke={canRevoke} onClose={() => setOpen(false)} />}
    </Panel>
  );
}

function ReportDialog({ grants, canRevoke, onClose }: { grants: AutonomyGrant[]; canRevoke: boolean; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [grantId, setGrantId] = useState(grants[0]?.id ?? '');
  const [seq, setSeq] = useState('');
  const [what, setWhat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const g = grants.find((x) => x.id === grantId);
  const go = async () => {
    if (!user) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.reportAutonomyBreach(orgId, { grantId, seq: seq ? Number(seq) : undefined, what }, user.id);
      if (r.awaitingRevoke) toast.held('Breach reported', `${r.incident.title}. An owner or admin is asked to confirm the revoke; until then the graduation stays in force.`);
      else toast.bad('Breach reported; graduation revoked', `${r.incident.title}. ${plural(r.revoked.length, 'A3 grant')} revoked automatically; no re-proposal for ${COOLDOWN_DAYS} days.`);
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} tone="danger" size="lg" title="Report an autonomy breach"
      description={canRevoke
        ? 'An agent acted beyond its graduated autonomy. This opens an incident, and the graduation is revoked at once by the platform.'
        : 'An agent acted beyond its graduated autonomy. This opens an incident and asks an owner or admin to confirm the revoke; only they can revoke a graduation.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={!g} onClick={go}>{canRevoke ? 'Report and revoke' : 'Report the breach'}</Button></>}>
      <div className="space-y-4">
        <Field label="Graduation" htmlFor="breach-grant">
          <Select id="breach-grant" value={grantId} onChange={(e) => setGrantId(e.target.value)}>
            {grants.map((x) => <option key={x.id} value={x.id}>{x.agentSlug} · {x.tool} · A3 since {date(x.grantedAt)}</option>)}
          </Select>
        </Field>
        <Field label="The call (optional)" htmlFor="breach-seq" hint="The receipt number of the call that went beyond the grant.">
          <Input id="breach-seq" inputMode="numeric" value={seq} onChange={(e) => setSeq(e.target.value.replace(/[^0-9]/g, ''))} className="w-36 num" mono />
        </Field>
        <Field label="What the agent did" htmlFor="breach-what" required><Textarea id="breach-what" rows={3} value={what} onChange={(e) => setWhat(e.target.value)} data-autofocus /></Field>
        <p className="text-xs text-muted">{g ? <>{g.agentSlug} goes back to A2 Propose on {g.tool} {canRevoke ? 'from the next call' : 'once an owner or admin confirms'}: a person approves every write. </> : null}It cannot be proposed again for {COOLDOWN_DAYS} days. Resolving the incident does not restore the grant.</p>
        {error && <Banner tone="bad" title="Not reported">{error}</Banner>}
      </div>
    </Dialog>
  );
}
