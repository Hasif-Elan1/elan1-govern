import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, Check, Ellipsis, Lock, LockOpen, Mail, MailPlus, Minus, PauseCircle, PlayCircle, RotateCw, ShieldAlert, Trash2, UserPlus, UserX, Users } from 'lucide-react';
import { signInLock, subscribeRegistry, unlockSignIn } from '@/features/auth/registry';
import { api } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useOrgId, useUser } from '@/store/session';
import { roleHas, useMemberRole } from '../permissions';
import { userName } from '@/mock/users';
import { ROLE_INFO } from '@/lib/permissions';
import { plural } from '@/lib/format';
import type { Member, Role, User } from '@/types';
import { Avatar, Badge, Banner, Button, CopyButton, DataTable, Dialog, EmptyState, Field, IconButton, Menu, Panel, RadioCards, SearchInput, Segmented, Select, StatusChip, Textarea, toast, type Column } from '@/components/ui';
import { Person, When } from '@/components/domain';
import { emailProblem } from '@/features/auth/password';
import { ReadOnlyNote, RoleBadge, SectionHeader, errText, receiptNote } from '../shared';
import { effectiveGroups, orgApi } from '../orgApi';
import { LIVE } from '@/api/mode';
import { post } from '@/api/http';
import { resync } from '@/api/live/sync';

type Row = Member & { user?: User };
const ROLES: Role[] = ['owner', 'admin', 'approver', 'viewer', 'auditor'];

/**
 * Live builds: the server issues invitations (POST /api/invites/send): the link goes by email and only its hash is
 * kept, here as on the server; the pending entry and its receipt land in the organisation's document, fetched again.
 */
async function sendLiveInvites(orgId: string, emails: string[], role: Role) {
  const r = await post<{ invites: { email: string; added: boolean }[]; seq: number | null }>('/api/invites/send', { orgId, emails, role });
  await resync(orgId).catch(() => undefined);
  return r;
}

/** `focus` is a member's user id (from ?member= on People and roles): that row is highlighted and scrolled to. */
export function MembersSection({ focus, onClearFocus }: { focus?: string; onClearFocus?: () => void } = {}) {
  const orgId = useOrgId();
  const me = useUser();
  // the role recorded in this organisation's member list, so a change made here applies at once
  const role = useMemberRole();
  const nav = useNavigate();
  const canManage = roleHas(role, 'members.manage');
  const { data, loading, error, refetch } = useQuery((o) => api.members(o), [], { kinds: ['member', 'approval', 'settings'] });

  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'all'>('all');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [change, setChange] = useState<{ m: Row; to: Role }>();
  const [remove, setRemove] = useState<Row>();
  const [suspend, setSuspend] = useState<Row>();
  const [reason, setReason] = useState('');
  const changeRole = useMutation(orgApi.changeRole);
  const removeMember = useMutation(orgApi.removeMember);
  const setSuspended = useMutation(orgApi.setSuspended);

  // sign-in locks live with the sign-in registry: re-render when one is set or cleared
  useSyncExternalStore(subscribeRegistry, () => JSON.stringify((data ?? []).map((m) => signInLock(m.userId).failures)));
  const lockOf = (m: Row) => (m.user ? signInLock(m.userId) : undefined);
  const unlock = (m: Row) => {
    if (!me) return;
    try {
      const r = unlockSignIn(orgId, m.userId, me.id);
      toast.ok(`${nameOf(m)} can sign in again`, `${r.wasLocked ? 'The lock and the failed attempts were cleared.' : 'The failed attempts were cleared.'} ${receiptNote(r.seq)}`);
    } catch (e) { toast.bad('Not unlocked', errText(e)); }
  };

  const emailOf = (m: Row) => orgApi.emailOf(orgId, m);
  const nameOf = (m: Row) => m.user?.name ?? emailOf(m);
  const active = useMemo(() => (data ?? []).filter((m) => m.status !== 'invited'), [data]);
  const invited = useMemo(() => (data ?? []).filter((m) => m.status === 'invited'), [data]);
  const owners = active.filter((m) => m.role === 'owner' && m.status === 'active').length;
  const groups = useMemo(() => effectiveGroups(orgId), [orgId, data]);
  const groupsOf = (id: string) => groups.filter((g) => g.members.includes(id));

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return active.filter((m) => (roleFilter === 'all' || m.role === roleFilter) && (!needle || `${nameOf(m)} ${emailOf(m)} ${m.user?.title ?? ''}`.toLowerCase().includes(needle)));
  }, [active, q, roleFilter]);

  const editable = (m: Row): string | undefined => {
    if (!canManage) return 'Owners and admins change roles.';
    if (m.userId === me?.id) return 'You cannot change your own role.';
    if (m.role === 'owner' && role !== 'owner') return 'Only an owner can change another owner.';
    if (m.status === 'suspended') return 'Reinstate this person before changing their role.';
    return undefined;
  };

  const applyRole = async () => {
    if (!change || !me) return;
    try {
      const r = await changeRole.mutate(orgId, change.m.userId, change.to, me.id);
      toast.ok(`${nameOf(change.m)} is now ${/^[aeiou]/i.test(change.to) ? 'an' : 'a'} ${ROLE_INFO[change.to].label.toLowerCase()}`, receiptNote(r.seq));
      setChange(undefined);
    } catch { /* shown in the dialog */ }
  };

  const applyRemove = async () => {
    if (!remove || !me) return;
    try {
      const r = await removeMember.mutate(orgId, remove.userId, me.id);
      toast.ok(remove.status === 'invited' ? 'Invitation revoked' : `${nameOf(remove)} removed`, `${r.groups.length ? `Left ${r.groups.join(', ')}. ` : ''}${r.rerouted ? `${plural(r.rerouted, 'pending approval')} re-routed to a backup group. ` : ''}${receiptNote(r.seq)}`);
      setRemove(undefined);
    } catch { /* shown in the dialog */ }
  };

  const applySuspend = async () => {
    if (!suspend || !me) return;
    const to = suspend.status !== 'suspended';
    try {
      const r = await setSuspended.mutate(orgId, suspend.userId, to, me.id, reason);
      toast.ok(to ? `${nameOf(suspend)} suspended` : `${nameOf(suspend)} reinstated`, `${to ? `${plural(r.ended, 'session')} ended. ` : ''}${receiptNote(r.seq)}`);
      setSuspend(undefined);
      setReason('');
    } catch { /* shown in the dialog */ }
  };

  const resend = async (m: Row) => {
    if (!me) return;
    try {
      if (LIVE) {
        // the server issues the new link (the old one stops working) and emails it
        const r = await sendLiveInvites(orgId, [emailOf(m)], m.role);
        toast.ok(`New invitation sent to ${emailOf(m)}`, `The previous link stops working. ${r.seq ? receiptNote(r.seq) : ''}`);
        return;
      }
      const r = await orgApi.resendInvite(orgId, m.userId, me.id);
      toast.ok(`New invitation sent to ${emailOf(m)}`, `The previous link stops working. ${receiptNote(r.seq)}`, { label: 'Open the invitation page', onClick: () => nav(`/invite/${r.invite.token}`) });
    } catch (e) { toast.bad('Not sent', errText(e)); }
  };

  const focused = focus ? (data ?? []).find((m) => m.userId === focus) : undefined;
  const focusHidden = !!focused && focused.status !== 'invited' && !rows.some((m) => m.userId === focus);
  useEffect(() => {
    if (!focus || !data) return;
    const t = window.setTimeout(() => document.getElementById(`member-${focus}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
    return () => window.clearTimeout(t);
  }, [focus, data, q, roleFilter]);

  const counts = Object.fromEntries(ROLES.map((r) => [r, active.filter((m) => m.role === r).length])) as Record<Role, number>;
  const without2step = active.filter((m) => m.status === 'active' && !orgApi.mfaOn(orgId, m.userId)).length;

  const columns: Column<Row>[] = [
    {
      key: 'person', header: 'Person', sort: (m) => nameOf(m),
      cell: (m) => (
        <span id={`member-${m.userId}`} className="flex items-center gap-2.5 min-w-0 py-1.5 scroll-mt-24">
          {m.user ? <Avatar initials={m.user.initials} size={28} /> : <span className="h-7 w-7 inline-flex items-center justify-center border border-line bg-sunken"><Mail className="h-3.5 w-3.5 text-muted" /></span>}
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5"><span className="block text-sm font-medium truncate">{nameOf(m)}</span>{m.userId === me?.id && <Badge>You</Badge>}{m.status === 'suspended' && <StatusChip tone="neutral" size="sm" icon={<UserX className="h-3 w-3" />}>Suspended</StatusChip>}{lockOf(m)?.lockedUntil && <StatusChip tone="held" size="sm" icon={<Lock className="h-3 w-3" />}>Sign-in locked</StatusChip>}</span>
            <span className="block text-xs text-muted truncate max-w-[260px]" title={m.user?.email}>{m.user ? m.user.title : 'Invitation pending'}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'role', header: 'Role', sort: (m) => ROLES.indexOf(m.role), width: 170,
      cell: (m) => {
        const why = editable(m);
        if (why) return <span title={why}><RoleBadge role={m.role} /></span>;
        return (
          <Select size_="sm" className="min-w-[132px]" aria-label={`Role for ${nameOf(m)}`} value={m.role} onClick={(e) => e.stopPropagation()} onChange={(e) => setChange({ m, to: e.target.value as Role })}>
            {ROLES.filter((r) => r !== 'owner' || role === 'owner').map((r) => <option key={r} value={r}>{ROLE_INFO[r].label}</option>)}
          </Select>
        );
      },
    },
    { key: 'groups', header: 'Approver groups', hideBelow: 'lg', cell: (m) => { const gs = groupsOf(m.userId); return gs.length ? <span className="text-xs">{gs.map((g) => g.name).join(', ')}</span> : <span className="text-xs text-subtle">None</span>; } },
    { key: 'mfa', header: '2-step', hideBelow: 'md', cell: (m) => orgApi.mfaOn(orgId, m.userId) ? <span className="inline-flex items-center gap-1 text-sm"><Check className="h-3.5 w-3.5 text-ok-fg" aria-hidden />On</span> : <span className="inline-flex items-center gap-1 text-sm text-held-fg"><ShieldAlert className="h-3.5 w-3.5" aria-hidden />Off</span> },
    { key: 'last', header: 'Last active', sort: (m) => m.lastActiveAt ?? '', hideBelow: 'sm', cell: (m) => <When iso={m.lastActiveAt} className="text-sm text-muted" /> },
    {
      key: 'channels', header: 'Chat channels', hideBelow: 'lg',
      cell: (m) => (
        <span className="flex flex-col gap-0.5 text-xs whitespace-nowrap">
          <span className={m.slackLinked ? 'text-fg' : 'text-subtle'}>{m.slackLinked ? <Check className="h-3 w-3 inline mr-1 text-ok-fg" aria-hidden /> : <Minus className="h-3 w-3 inline mr-1" aria-hidden />}Slack {m.slackLinked ? 'linked' : 'not linked'}</span>
          <span className={m.whatsappVerified ? 'text-fg' : 'text-subtle'}>{m.whatsappVerified ? <Check className="h-3 w-3 inline mr-1 text-ok-fg" aria-hidden /> : <Minus className="h-3 w-3 inline mr-1" aria-hidden />}WhatsApp {m.whatsappVerified ? 'verified' : 'not verified'}</span>
        </span>
      ),
    },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', width: 56,
      cell: (m) => {
        const why = !canManage ? 'Owners and admins remove members.' : m.userId === me?.id ? 'You cannot remove yourself.' : m.role === 'owner' && role !== 'owner' ? 'Only an owner can remove an owner.' : m.role === 'owner' && owners <= 1 ? 'The last owner cannot be removed.' : undefined;
        const suspendWhy = !canManage ? 'Owners and admins suspend members.' : m.userId === me?.id ? 'You cannot suspend yourself.' : m.role === 'owner' && role !== 'owner' ? 'Only an owner can suspend an owner.' : m.status === 'active' && m.role === 'owner' && owners <= 1 ? 'The last active owner cannot be suspended.' : undefined;
        return (
          <Menu width={250} trigger={({ toggle }) => <IconButton label={`Actions for ${nameOf(m)}`} size="sm" onClick={(e) => { e.stopPropagation(); toggle(); }}><Ellipsis className="h-4 w-4" /></IconButton>} items={[
            { label: 'Approver groups', icon: <Users className="h-4 w-4" />, onSelect: () => nav('/agents/people?tab=groups') },
            { label: 'Activity by this person', icon: <RotateCw className="h-4 w-4" />, onSelect: () => nav(`/activity?range=all&q=${encodeURIComponent(m.userId)}`) },
            'sep',
            (() => {
              const lk = lockOf(m);
              const unlockWhy = !canManage ? 'Owners and admins unlock sign-in.' : !lk?.failures ? 'No failed sign-in attempts' : undefined;
              return { label: unlockWhy ?? (lk?.lockedUntil ? 'Unlock sign-in' : `Clear ${plural(lk!.failures, 'failed attempt')}`), icon: <LockOpen className="h-4 w-4" />, disabled: !!unlockWhy, onSelect: () => unlock(m) };
            })(),
            m.status === 'suspended'
              ? { label: suspendWhy ?? 'Reinstate', icon: <PlayCircle className="h-4 w-4" />, disabled: !!suspendWhy, onSelect: () => { setReason(''); setSuspend(m); } }
              : { label: suspendWhy ?? 'Suspend', icon: <PauseCircle className="h-4 w-4" />, disabled: !!suspendWhy, onSelect: () => { setReason(''); setSuspend(m); } },
            { label: why ?? 'Remove from organisation', icon: <Trash2 className="h-4 w-4" />, danger: !why, disabled: !!why, onSelect: () => setRemove(m) },
          ]} />
        );
      },
    },
  ];

  const soleGroups = remove ? groupsOf(remove.userId).filter((g) => g.members.length === 1) : [];

  return (
    <div>
      <SectionHeader
        title="Members"
        description="Everyone who can sign in to this organisation, their role, their approver groups and the channels they approve from. Every change is recorded as a receipt on the chain (control EG-20: access is role-based, and every change to it is recorded)."
        actions={<Button variant="primary" icon={<UserPlus className="h-4 w-4" />} disabled={!canManage} title={!canManage ? 'Owners and admins invite members.' : undefined} onClick={() => setInviteOpen(true)}>Invite people</Button>}
      />
      {!canManage && <ReadOnlyNote role={role} who="Owners and admins" />}
      {error && <Banner tone="bad" className="mb-6" title="Members could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      {focus && data && (
        focused ? (
          <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span>Showing <span className="font-medium">{nameOf(focused)}</span>{focused.status === 'invited' ? ' (invitation pending, listed under Pending invitations)' : ''}.</span>
            {focusHidden && <button type="button" className="link" onClick={() => { setQ(''); setRoleFilter('all'); }}>Clear the filters to see them</button>}
            {onClearFocus && <button type="button" className="link" onClick={onClearFocus}>Clear</button>}
          </p>
        ) : (
          <Banner tone="neutral" className="mb-6" title="Not a member of this organisation" actions={onClearFocus && <Button size="sm" onClick={onClearFocus}>Show everyone</Button>}>
            {userName(focus)} is not in this organisation’s member list. They may have been removed; their past receipts stay on the chain.
          </Banner>
        )
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SearchInput placeholder="Search by name, title or email" value={q} onChange={(e) => setQ(e.target.value)} className="w-full sm:w-72" aria-label="Search members" />
        <div className="overflow-x-auto max-w-full">
          <Segmented label="Filter by role" size="sm" value={roleFilter} onChange={setRoleFilter} options={[{ value: 'all', label: 'All', count: active.length }, ...ROLES.map((r) => ({ value: r, label: ROLE_INFO[r].label, count: counts[r] }))]} />
        </div>
      </div>

      <DataTable
        caption="Members of the organisation"
        columns={columns}
        rows={data ? rows : undefined}
        loading={loading}
        rowKey={(m) => m.userId}
        selectedKey={focus}
        initialSort={{ key: 'role', dir: 'asc' }}
        empty={<EmptyState compact title="No members match" disc="aperture" action={<Button size="sm" onClick={() => { setQ(''); setRoleFilter('all'); }}>Clear filters</Button>}>Change the search or the role filter.</EmptyState>}
      />
      <p className="mt-2 text-xs text-muted">{plural(active.length, 'member')} · {plural(without2step, 'person', 'people')} without two-step sign-in · <Link to="/agents/organisation?tab=sessions" className="link">Sign-in policy</Link></p>

      <div className="mt-8 grid gap-6 xl:grid-cols-2">
        <Panel title="Pending invitations" actions={<Badge>{invited.length}</Badge>} flush>
          {invited.length === 0 ? (
            <EmptyState compact title="No pending invitations" disc="trail">Invitations are single-use links that expire after 7 days.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {invited.map((m) => {
                const t = orgApi.inviteFor(orgId, m.userId);
                const expired = t && new Date(t.expiresAt).getTime() < Date.now();
                return (
                  <li key={m.userId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <Mail className="h-4 w-4 text-muted shrink-0" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{emailOf(m)}</p>
                      <p className="text-xs text-muted">{ROLE_INFO[m.role].label} · sent <When iso={m.invitedAt} /> · {expired ? <span className="text-held-fg">expired — resend</span> : <>expires <When iso={t?.expiresAt} /></>}</p>
                    </div>
                    {t?.token && <CopyButton text={`${location.origin}/invite/${t.token}`} label="Copy link" />}
                    <Button size="sm" variant="ghost" icon={<MailPlus className="h-3.5 w-3.5" />} disabled={!canManage} title={!canManage ? 'Owners and admins resend invitations.' : undefined} onClick={() => resend(m)}>Resend</Button>
                    <Button size="sm" variant="quiet-danger" disabled={!canManage} title={!canManage ? 'Owners and admins revoke invitations.' : undefined} onClick={() => setRemove(m)}>Revoke</Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Approver groups" actions={<Link to="/agents/people?tab=groups" className="text-sm inline-flex items-center gap-1 link">Edit groups<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>} flush>
          <ul className="divide-y divide-line">
            {groups.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 w-28">
                  <p className="text-sm font-medium">{g.name}</p>
                  <p className="text-xs text-muted font-mono">{g.id}</p>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 flex-1 min-w-0">
                  {g.members.map((id) => <Person key={id} id={id} size={22} />)}
                </div>
                {g.members.length < 2 && <Link to="/agents/people?tab=groups" className="inline-flex"><Badge tone="held" title="If this person is away, held actions go to the backup group after the escalation time.">One member — check the backup</Badge></Link>}
              </li>
            ))}
          </ul>
          <p className="px-5 py-3 border-t border-line text-xs text-muted">Rules name a group; members of that group decide its held actions. Each group has a backup group and an escalation time, set under Approver groups.</p>
        </Panel>
      </div>

      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} canOwner={role === 'owner'} existing={(data ?? []).map(emailOf)} groupsText={groups.map((g) => `${g.name} (${g.members.map((m) => userName(m).split(' ')[0]).join(', ')})`).join(' · ')}
        onInvite={async (emails, r) => {
          if (!me) return;
          if (LIVE) {
            const sent = await sendLiveInvites(orgId, emails, r);
            const added = sent.invites.filter((i) => i.added).length;
            toast.ok(emails.length === 1 ? (added ? `${emails[0]} added` : `Invitation sent to ${emails[0]}`) : `${emails.length} invitations sent`, `${added ? `${plural(added, 'person', 'people')} already on Elan1 Govern joined at once. ` : ''}Single-use links by email, valid 7 days. ${sent.seq ? receiptNote(sent.seq) : ''}`);
            setInviteOpen(false);
            return;
          }
          const res = await orgApi.inviteMembers(orgId, emails, r, me.id);
          const first = res.invites[0];
          toast.ok(emails.length === 1 ? `Invitation sent to ${emails[0]}` : `${emails.length} invitations sent`, `Single-use ${emails.length === 1 ? 'link' : 'links'}, valid 7 days. ${receiptNote(res.seq)}`, first ? { label: 'Open the invitation page', onClick: () => nav(`/invite/${first.token}`) } : undefined);
          setInviteOpen(false);
        }} />

      <Dialog open={!!change} onClose={() => setChange(undefined)} size="sm" title="Change role"
        description={change ? `${nameOf(change.m)}: ${ROLE_INFO[change.m.role].label} → ${ROLE_INFO[change.to].label}` : undefined}
        footer={<><Button variant="ghost" onClick={() => setChange(undefined)}>Cancel</Button><Button variant="primary" loading={changeRole.pending} onClick={applyRole} data-autofocus>Change role</Button></>}>
        {change && (
          <div className="space-y-3 text-sm">
            <p><span className="font-medium">{ROLE_INFO[change.to].label}:</span> {ROLE_INFO[change.to].summary}</p>
            <p className="text-muted">Their permissions change at once: the console and every check behind it read the role recorded here, so their next action is allowed or refused under the new role. Decisions they already made stay on the chain unchanged. The change is written to the chain as a receipt naming you.</p>
            {(change.to === 'viewer' || change.to === 'auditor') && groupsOf(change.m.userId).length > 0 && <Banner tone="held">They are in {groupsOf(change.m.userId).map((g) => g.name).join(', ')}. Viewers and auditors cannot approve; remove them from those groups under Approver groups.</Banner>}
            {changeRole.error && <Banner tone="bad">{changeRole.error.message}</Banner>}
          </div>
        )}
      </Dialog>

      <Dialog open={!!suspend} onClose={() => setSuspend(undefined)} size="sm" tone={suspend?.status === 'suspended' ? undefined : 'danger'} title={suspend?.status === 'suspended' ? `Reinstate ${suspend ? nameOf(suspend) : ''}` : `Suspend ${suspend ? nameOf(suspend) : ''}`}
        footer={<><Button variant="ghost" onClick={() => setSuspend(undefined)}>Cancel</Button><Button variant={suspend?.status === 'suspended' ? 'primary' : 'danger'} loading={setSuspended.pending} onClick={applySuspend}>{suspend?.status === 'suspended' ? 'Reinstate' : 'Suspend'}</Button></>}>
        {suspend && (
          <div className="space-y-3 text-sm">
            {suspend.status === 'suspended'
              ? <p>{nameOf(suspend)} can sign in again with the same role and groups.</p>
              : <>
                  <p>Their sessions end at once, sign-in is refused, and any action from a page they still have open is refused. The account, role, groups and every receipt stay; reinstating restores access.</p>
                  {groupsOf(suspend.userId).length > 0 && <p className="text-muted">Held actions for {groupsOf(suspend.userId).map((g) => g.name).join(', ')} go to the other members, then to the backup group after the escalation time.</p>}
                  <Field label="Why (recorded)" htmlFor="susp-why"><Textarea id="susp-why" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus /></Field>
                </>}
            {setSuspended.error && <Banner tone="bad">{setSuspended.error.message}</Banner>}
          </div>
        )}
      </Dialog>

      <Dialog open={!!remove} onClose={() => setRemove(undefined)} size="sm" tone="danger" title={remove?.status === 'invited' ? 'Revoke invitation' : `Remove ${remove ? nameOf(remove) : ''}`}
        footer={<><Button variant="ghost" onClick={() => setRemove(undefined)}>Cancel</Button><Button variant="danger" loading={removeMember.pending} onClick={applyRemove}>{remove?.status === 'invited' ? 'Revoke invitation' : 'Remove member'}</Button></>}>
        {remove && (remove.status === 'invited'
          ? <p className="text-sm">The link sent to <span className="font-medium">{emailOf(remove)}</span> stops working at once.</p>
          : (
            <div className="space-y-3 text-sm">
              <p>{nameOf(remove)} loses access at once: their sessions end and any action they try here is refused.</p>
              <ul className="list-[square] pl-5 text-muted space-y-1">
                <li>Their past decisions and receipts stay on the chain, unchanged.</li>
                <li>{groupsOf(remove.userId).length ? <>They leave {groupsOf(remove.userId).map((g) => g.name).join(', ')}.</> : 'They are in no approver group.'}{soleGroups.length > 0 && <> They are the only member of {soleGroups.map((g) => g.name).join(', ')}: pending approvals there are re-routed to the backup group.</>}</li>
                <li>Agents they own keep running; reassign them on the Agents page.</li>
              </ul>
              {removeMember.error && <Banner tone="bad">{removeMember.error.message}</Banner>}
            </div>
          ))}
      </Dialog>
    </div>
  );
}

function InviteDialog({ open, onClose, canOwner, existing, groupsText, onInvite }: { open: boolean; onClose: () => void; canOwner: boolean; existing: string[]; groupsText: string; onInvite: (emails: string[], role: Role) => Promise<void> }) {
  const [text, setText] = useState('');
  const [r, setR] = useState<Role>('approver');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const emails = text.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  const bad = emails.find((e) => emailProblem(e));
  const dup = emails.find((e) => existing.map((x) => x.toLowerCase()).includes(e.toLowerCase()));
  const err = !emails.length ? 'Enter at least one email address.' : bad ? `${bad} is not a valid email address.` : dup ? `${dup} is already a member or invited.` : undefined;
  const roles: Role[] = canOwner ? ['admin', 'approver', 'viewer', 'auditor', 'owner'] : ['admin', 'approver', 'viewer', 'auditor'];

  const close = () => { setText(''); setTried(false); setR('approver'); setFailed(undefined); onClose(); };
  const send = async () => {
    setTried(true);
    if (err) return;
    setBusy(true);
    try { await onInvite(emails, r); setText(''); setTried(false); setFailed(undefined); } catch (e) { setFailed(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={close} size="lg" title="Invite people" description="Each person gets a single-use link that expires after 7 days. They set a password, or sign in with SSO if your organisation uses it."
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" icon={<MailPlus className="h-4 w-4" />} loading={busy} onClick={send}>Send {emails.length > 1 ? `${emails.length} invitations` : 'invitation'}</Button></>}>
      <div className="space-y-5">
        <Field label="Email addresses" htmlFor="inv-emails" hint="Separate several with commas or new lines." error={tried ? err : undefined}>
          <Textarea id="inv-emails" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="name@company.com, other@company.com" invalid={tried && !!err} data-autofocus />
        </Field>
        <fieldset>
          <legend className="text-sm font-medium mb-2">Role</legend>
          <RadioCards name="invite-role" value={r} onChange={setR} cols={2} options={roles.map((x) => ({ value: x, label: ROLE_INFO[x].label, description: ROLE_INFO[x].summary }))} />
        </fieldset>
        {r === 'owner' && <Banner tone="held">Owners can engage the emergency stop, rotate the signing key, change the assurance level and close the organisation.</Banner>}
        {r === 'approver' && <p className="text-xs text-muted">After they accept, add them to an approver group so held actions reach them. Current groups: {groupsText}.</p>}
        {failed && <Banner tone="bad">{failed}</Banner>}
      </div>
    </Dialog>
  );
}
