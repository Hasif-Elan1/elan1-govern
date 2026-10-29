import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Plus, Timer, Trash2, Users } from 'lucide-react';
import { api } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useOrgId, useRole, useUser } from '@/store/session';
import { userName } from '@/mock/users';
import { ROLE_INFO } from '@/lib/permissions';
import { dateTime, plural, relative } from '@/lib/format';
import { Badge, Banner, Button, EmptyState, IconButton, Panel, Select, Skeleton, StatusChip, Switch, toast } from '@/components/ui';
import { Person, ReceiptLink, When } from '@/components/domain';
import { ReadOnlyNote, SectionHeader, errText, receiptNote } from '../shared';
import { effectiveGroups, orgApi } from '../orgApi';
import { useCanDo } from '../permissions';

const AFTER = [15, 30, 60, 120, 240, 480, 1440];
const afterLabel = (m: number) => (m < 60 ? `${m} minutes` : m < 1440 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m / 1440} day${m === 1440 ? '' : 's'}`);

/** Approver groups: who decides each group's held actions, its backup group and when a held action escalates. */
export function ApproverGroupsSection() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const canEdit = useCanDo('approvers.manage');
  const { data: esc, loading, error, refetch } = useQuery((o) => api.escalation(o), [], { kinds: ['approval', 'receipt'] });
  const { data: members } = useQuery((o) => api.members(o), [], { kinds: ['member'] });
  const { data: approvals } = useQuery((o) => api.approvals(o), [], { kinds: ['approval'] });
  const setEsc = useMutation(api.setEscalation);
  const [adding, setAdding] = useState<Record<string, string>>({});
  const groups = useMemo(() => effectiveGroups(orgId), [orgId, esc, members]);
  const eligible = (members ?? []).filter((m) => m.status === 'active' && ['owner', 'admin', 'approver'].includes(m.role));

  const escRun = async (groupId: string, patch: { afterMinutes?: number; backupGroupId?: string; enabled?: boolean }, ok: string) => {
    if (!user) return;
    try { await setEsc.mutate(orgId, groupId, patch, user.id); toast.ok(ok, 'Recorded as an escalation.updated receipt.'); } catch (e) { toast.bad('Not changed', errText(e)); }
  };
  const add = async (groupId: string) => {
    const id = adding[groupId];
    if (!user || !id) return;
    try { const r = await orgApi.addGroupMember(orgId, groupId, id, user.id); setAdding({ ...adding, [groupId]: '' }); toast.ok(`${userName(id)} added`, receiptNote(r.seq)); } catch (e) { toast.bad('Not added', errText(e)); }
  };
  const remove = async (groupId: string, id: string) => {
    if (!user) return;
    try { const r = await orgApi.removeGroupMember(orgId, groupId, id, user.id); toast.ok(`${userName(id)} removed`, receiptNote(r.seq)); } catch (e) { toast.bad('Not removed', errText(e)); }
  };

  if (error) return <Banner tone="bad" title="Approver groups could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;

  return (
    <div>
      <SectionHeader
        title="Approver groups"
        description="A rule that asks a person names a group. Members of that group decide its held actions; if nobody does within the group’s time, the action is re-routed once to the backup group. Every change here is a receipt."
      />
      {!canEdit && <ReadOnlyNote role={role} who="Owners and admins" />}

      {loading && !esc ? <Skeleton className="h-96" /> : esc && (
        <div className="grid gap-6 xl:grid-cols-2">
          {groups.map((g) => {
            const pol = esc.policies.find((p) => p.groupId === g.id);
            const pending = (approvals ?? []).filter((a) => a.status === 'pending' && (a.approverGroup === g.name || a.approverGroup === g.id)).length;
            const candidates = eligible.filter((m) => !g.members.includes(m.userId));
            return (
              <Panel key={g.id} title={<span className="inline-flex items-center gap-2"><Users className="h-4 w-4" aria-hidden />{g.name}</span>}
                actions={<span className="flex items-center gap-2">{pending > 0 && <Link to="/approvals" className="inline-flex"><Badge tone="held">{plural(pending, 'held action')}</Badge></Link>}<span className="font-mono text-xs text-muted">{g.id}</span></span>}>
                <p className="label mb-2">Members</p>
                <ul className="divide-y divide-line border border-line">
                  {g.members.map((id) => {
                    const m = members?.find((x) => x.userId === id);
                    return (
                      <li key={id} className="flex items-center gap-3 px-3 py-2">
                        <Person id={id} size={24} showTitle className="flex-1 min-w-0" />
                        {m && <Badge>{ROLE_INFO[m.role].label}</Badge>}
                        {g.added.includes(id) && <Badge tone="info" title="Added here">Added</Badge>}
                        <IconButton label={`Remove ${userName(id)} from ${g.name}`} size="sm" disabled={!canEdit || g.members.length <= 1} title={g.members.length <= 1 ? 'The only member — add someone else first' : `Remove ${userName(id)}`} onClick={() => remove(g.id, id)}><Trash2 className="h-4 w-4" /></IconButton>
                      </li>
                    );
                  })}
                  {g.members.length === 0 && <li className="px-3 py-2 text-sm text-held-fg">No active member — held actions go to the backup group.</li>}
                </ul>
                {canEdit && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Select size_="sm" aria-label={`Add a member to ${g.name}`} className="flex-1 min-w-[180px]" value={adding[g.id] ?? ''} onChange={(e) => setAdding({ ...adding, [g.id]: e.target.value })}>
                      <option value="">{candidates.length ? 'Add an owner, admin or approver…' : 'Everyone eligible is already in'}</option>
                      {candidates.map((m) => <option key={m.userId} value={m.userId}>{m.user?.name ?? m.userId} · {ROLE_INFO[m.role].label}</option>)}
                    </Select>
                    <Button size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" />} disabled={!adding[g.id]} onClick={() => add(g.id)}>Add</Button>
                  </div>
                )}
                {g.members.length === 1 && <p className="mt-2 text-xs text-held-fg">One member: if they are away, held actions wait until the escalation time, then go to the backup group.</p>}

                {pol && (
                  <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <div>
                      <p className="label mb-1 inline-flex items-center gap-1"><Timer className="h-3 w-3" aria-hidden />Escalate after</p>
                      <Select size_="sm" aria-label={`Escalate ${g.name} after`} value={String(pol.afterMinutes)} disabled={!canEdit || setEsc.pending} onChange={(e) => escRun(g.id, { afterMinutes: Number(e.target.value) }, `${g.name} escalates after ${afterLabel(Number(e.target.value))}`)}>
                        {Array.from(new Set([...AFTER, pol.afterMinutes])).sort((a, b) => a - b).map((m) => <option key={m} value={m}>{afterLabel(m)}</option>)}
                      </Select>
                    </div>
                    <div>
                      <p className="label mb-1">Backup group</p>
                      <Select size_="sm" aria-label={`Backup group for ${g.name}`} value={pol.backupGroupId} disabled={!canEdit || setEsc.pending} onChange={(e) => escRun(g.id, { backupGroupId: e.target.value }, `${g.name} now escalates to ${groups.find((x) => x.id === e.target.value)?.name}`)}>
                        {groups.filter((x) => x.id !== g.id).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.members.length})</option>)}
                      </Select>
                    </div>
                    <Switch label={`Escalation for ${g.name}`} checked={pol.enabled} disabled={!canEdit || setEsc.pending} onChange={(v) => escRun(g.id, { enabled: v }, `Escalation for ${g.name} ${v ? 'on' : 'off'}`)} />
                  </div>
                )}
                {pol && <p className="mt-2 text-xs text-muted">{pol.enabled ? <>Re-routed {plural(pol.triggered, 'time')}{pol.lastTriggeredAt && <>, last {relative(pol.lastTriggeredAt)}</>}.</> : 'Escalation off: held actions wait for this group until they expire.'}</p>}
              </Panel>
            );
          })}
        </div>
      )}

      <Panel className="mt-6" title="Recent escalations" flush footer={<>Members of the first group can still decide after a re-route. An owner may decide outside any group; that is recorded on the receipt. <Link to="/work/channels" className="link">Who is notified</Link>.</>}>
        {!esc ? <div className="p-5"><Skeleton className="h-24" /></div> : esc.recent.length === 0 ? (
          <EmptyState compact title="No escalations yet" disc="trail">When a held action waits longer than its group’s time, its re-route appears here with the receipt.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {esc.recent.map((e) => (
              <li key={`${e.approvalId}${e.at}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
                <span className="font-medium">{e.from}</span><ArrowRight className="h-3.5 w-3.5 text-muted" aria-label="to" /><span className="font-medium">{e.to}</span>
                <span className="text-xs text-muted min-w-0 flex-1 truncate">{e.headline}</span>
                <StatusChip tone={e.status === 'pending' ? 'held' : 'neutral'} size="sm">{e.status === 'pending' ? 'Waiting' : e.status}</StatusChip>
                <span className="text-xs text-muted" title={dateTime(e.at)}>{e.by === 'system' ? `after ${afterLabel(e.afterMinutes ?? 0)}` : `by ${userName(e.by)}`} · <When iso={e.at} /></span>
                {e.seq && <ReceiptLink seq={e.seq} className="text-xs" />}
                <Link to={`/approvals/${e.approvalId}`} className="text-xs link inline-flex items-center gap-0.5">Open<ArrowUpRight className="h-3 w-3" aria-hidden /></Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
