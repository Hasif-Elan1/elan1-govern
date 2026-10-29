import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Clock3, Link2, Lock, LockOpen, LogOut, MapPin, Monitor, ShieldAlert, Smartphone } from 'lucide-react';
import { userById } from '@/mock/users';
import { api } from '@/api';
import { useMutation, useNow, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useRole, useSession, useUser } from '@/store/session';
import { countdown, dateTime, plural } from '@/lib/format';
import { Badge, Banner, Button, Dialog, Panel, Select, Skeleton, StatusChip, Switch, toast } from '@/components/ui';
import { Person, ReceiptLink, When } from '@/components/domain';
import { SectionHeader, SettingRow, errText, receiptNote } from '../shared';
import { orgApi, type Lifetime, type SessionRecord } from '../orgApi';
import { BreakGlassPanel } from '@/features/work/BreakGlassPanel';
import { MAX_FAILURES, signInLock, subscribeRegistry, unlockSignIn } from '@/features/auth/registry';
import type { Member } from '@/types';

/**
 * Members whose sign-in is locked (5 failed attempts lock it for 1 minute, doubling to 1 hour) or who have
 * failed attempts counted. Owners and admins unlock them here; each unlock is a receipt.
 */
function LockedSignIns({ orgId, members, canUnlock }: { orgId: string; members?: Member[]; canUnlock: boolean }) {
  const me = useUser();
  const now = useNow(1000);
  useSyncExternalStore(subscribeRegistry, () => JSON.stringify((members ?? []).map((m) => signInLock(m.userId, now).failures)));
  const rows = (members ?? []).map((m) => ({ m, lock: signInLock(m.userId, now) })).filter((x) => x.lock.failures > 0);
  const unlock = (memberId: string, name: string) => {
    if (!me) return;
    try {
      const r = unlockSignIn(orgId, memberId, me.id);
      toast.ok(`${name} can sign in again`, `${r.wasLocked ? 'The lock and the failed attempts were cleared.' : 'The failed attempts were cleared.'} ${receiptNote(r.seq)}`);
    } catch (e) { toast.bad('Not unlocked', errText(e)); }
  };
  return (
    <Panel className="mt-6" title="Locked sign-ins" actions={!canUnlock ? <Badge>Owners and admins unlock</Badge> : <Badge>{rows.length}</Badge>} flush>
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted">Nobody in this organisation has failed sign-in attempts. After {MAX_FAILURES} in a row an account locks for 1 minute, doubling each time up to 1 hour.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map(({ m, lock }) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-4 px-5 py-3">
              <Lock className={`h-4 w-4 ${lock.lockedUntil ? 'text-held-fg' : 'text-muted'}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <Person id={m.userId} size={22} />
                <p className="mt-0.5 text-xs text-muted">{plural(lock.failures, 'failed attempt')}{lock.lockedUntil ? ` · locked until ${dateTime(new Date(lock.lockedUntil).toISOString())}` : ` · ${lock.left} left before a lock`}</p>
              </div>
              <Button size="sm" variant="secondary" icon={<LockOpen className="h-3.5 w-3.5" aria-hidden />} disabled={!canUnlock} title={!canUnlock ? 'Owners and admins unlock sign-in.' : undefined} onClick={() => unlock(m.userId, userById(m.userId)?.name ?? m.userId)}>
                {lock.lockedUntil ? 'Unlock' : 'Clear attempts'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const LIFETIME_TEXT: Record<string, string> = { '8h': '8 hours', '12h': '12 hours', '24h': '24 hours', '7d': '7 days' };

export function SessionsSection() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const nav = useNavigate();
  const now = useNow(30_000);
  const signedInAt = useSession((s) => s.signedInAt);
  const signOut = useSession((s) => s.signOut);
  const canPolicy = useCan('settings.security');
  const [confirm, setConfirm] = useState(false);
  const currentId = user && signedInAt ? `ses_${user.id}_${signedInAt}` : '';

  useEffect(() => {
    if (user) orgApi.registerSession(orgId, user.id, signedInAt, typeof navigator !== 'undefined' ? navigator.userAgent : '', orgApi.mfaOn(orgId, user.id));
  }, [orgId, user, signedInAt]);

  const { data, loading, error, refetch } = useQuery((o) => orgApi.sessions(o, user?.id ?? ''), [user?.id], { kinds: ['session', 'approval', 'member'] });
  const { data: members } = useQuery((o) => api.members(o), [], { kinds: ['member'] });
  const policy = useMutation(orgApi.setSessionPolicy);
  const endOthers = useMutation(orgApi.endOtherSessions);

  const current = data?.sessions.find((s) => s.id === currentId);
  const live = useMemo(() => (data?.sessions ?? []).filter((s) => s.id !== currentId && !s.endedAt), [data, currentId]);
  const past = useMemo(() => (data?.sessions ?? []).filter((s) => s.id !== currentId && s.endedAt).slice(0, 8), [data, currentId]);
  const expiresAt = current && data ? new Date(new Date(current.startedAt).getTime() + data.lifetimeMs).toISOString() : undefined;
  const expired = !!expiresAt && new Date(expiresAt).getTime() < now;
  const without2step = (members ?? []).filter((m) => m.status === 'active' && m.user && !orgApi.mfaOn(orgId, m.userId));

  const setPolicy = async (patch: { lifetime?: Lifetime; require2step?: boolean }) => {
    if (!user) return;
    try {
      const r = await policy.mutate(orgId, patch, user.id);
      toast.ok(patch.lifetime ? `Sessions now last ${r.policy.lifetime}` : r.policy.require2step ? 'Two-step sign-in required' : 'Two-step sign-in optional', receiptNote(r.seq));
    } catch (e) { toast.bad('Not changed', errText(e)); }
  };
  const signOutOthers = async () => {
    if (!user) return;
    try { const r = await endOthers.mutate(orgId, user.id, currentId); setConfirm(false); toast.ok(`Signed out of ${plural(r.count, 'other session')}`, `Those devices must sign in again. ${receiptNote(r.seq)}`); } catch (e) { toast.bad('Not signed out', errText(e)); }
  };
  const signOutOne = async (s: SessionRecord) => {
    if (!user) return;
    try { const r = await orgApi.endSession(orgId, user.id, s.id); toast.ok(`Signed out of ${s.device}`, receiptNote(r.seq)); } catch (e) { toast.bad('Not signed out', errText(e)); }
  };
  const icon = (k: SessionRecord['kind']) => (k === 'phone' ? <Smartphone className="h-5 w-5" aria-hidden /> : <Monitor className="h-5 w-5" aria-hidden />);

  return (
    <div>
      <SectionHeader
        title="Sessions"
        description="Where you are signed in, and the organisation’s sign-in policy. Sign out anything you do not recognise — and change your password if you did not start it."
        actions={<Button variant="quiet-danger" icon={<LogOut className="h-4 w-4" />} disabled={live.length === 0} title={live.length === 0 ? 'No other open sessions.' : undefined} onClick={() => setConfirm(true)}>Sign out other sessions</Button>}
      />
      {error && <Banner tone="bad" className="mb-6" title="Sessions could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}
      {expired && (
        <Banner tone="held" className="mb-6" title="This session is past the organisation’s lifetime" actions={<Button size="sm" variant="primary" onClick={() => { signOut(); nav('/login', { replace: true }); }}>Sign in again</Button>}>
          Sessions last {data?.policy.lifetime}. Yours started {current && dateTime(current.startedAt)}.
        </Banner>
      )}

      <Panel title="Your sessions" flush>
        {loading && !data ? <div className="p-5"><Skeleton className="h-24" /></div> : (
          <ul className="divide-y divide-line">
            <li className="flex flex-wrap items-center gap-4 px-5 py-4 bg-sunken/40">
              <span className="h-10 w-10 inline-flex items-center justify-center border border-line bg-surface">{icon(current?.kind ?? 'desktop')}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium flex flex-wrap items-center gap-2">{current?.device ?? 'This browser'} <StatusChip tone="ok" size="sm">This browser</StatusChip></p>
                <p className="text-xs text-muted mt-0.5 inline-flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" aria-hidden />Location unknown</span>
                  <span>Signed in {signedInAt ? dateTime(new Date(signedInAt).toISOString()) : '—'}</span>
                  <span>{current?.method ?? (user && orgApi.mfaOn(orgId, user.id) ? 'Password and 2-step code' : 'Password')}</span>
                  {expiresAt && !expired && <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" aria-hidden />Ends in {countdown(expiresAt)}</span>}
                </p>
              </div>
              <Button size="sm" variant="ghost" icon={<LogOut className="h-3.5 w-3.5" />} onClick={() => { signOut(); nav('/login', { replace: true }); }}>Sign out</Button>
            </li>
            {live.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <span className="h-10 w-10 inline-flex items-center justify-center border border-line bg-surface text-muted">{icon(s.kind)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{s.device}</p>
                  <p className="text-xs text-muted mt-0.5 inline-flex flex-wrap items-center gap-x-3 gap-y-0.5"><span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" aria-hidden />Location unknown</span><span>Signed in {dateTime(s.startedAt)}</span><span>Active <When iso={s.lastActiveAt} /></span><span>{s.method}</span></p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => signOutOne(s)}>Sign out</Button>
              </li>
            ))}
            {live.length === 0 && <li className="px-5 py-4 text-sm text-muted">No other open sessions. Only this browser is signed in.</li>}
          </ul>
        )}
      </Panel>

      {/* break-glass: emergency access, two people, time-boxed (src/features/work/BreakGlassPanel.tsx) */}
      <BreakGlassPanel className="mt-6" />

      {past.length > 0 && (
        <Panel className="mt-6" title="Ended" flush>
          <ul className="divide-y divide-line">
            {past.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm">
                {s.via === 'approval_link' ? <Link2 className="h-4 w-4 text-muted" aria-hidden /> : <Monitor className="h-4 w-4 text-muted" aria-hidden />}
                <span className="font-medium">{s.device}</span>
                <span className="text-xs text-muted">{dateTime(s.startedAt)} · {s.endReason}</span>
                {s.seq && <ReceiptLink seq={s.seq} className="text-xs" />}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel className="mt-6" title="Sign-in policy" actions={!canPolicy ? <Badge>Owners change this</Badge> : undefined}>
        <SettingRow label="Session lifetime" htmlFor="sess-life" help="After this, people sign in again. Keeping someone signed in never skips the fresh sign-in below.">
          {/* owners set the policy (settings.security); other roles read it as text */}
          {canPolicy ? (
            <Select id="sess-life" value={data?.policy.lifetime ?? '12h'} disabled={policy.pending || !data} onChange={(e) => setPolicy({ lifetime: e.target.value as Lifetime })}>
              <option value="8h">8 hours</option>
              <option value="12h">12 hours</option>
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
            </Select>
          ) : <p className="text-sm font-medium">{data ? LIFETIME_TEXT[data.policy.lifetime] ?? data.policy.lifetime : '…'}</p>}
          {data?.policy.updatedAt && <p className="mt-2 text-xs text-muted">Changed {dateTime(data.policy.updatedAt)}.</p>}
        </SettingRow>
        <SettingRow label="Fresh sign-in" help="Built rule, not configurable: approvals in the console, the emergency stop and key rotation ask for the password again when the last sign-in is older than 10 minutes.">
          <p className="text-sm font-medium">10 minutes</p>
        </SettingRow>
        <SettingRow label="Lockout" help="Built rule: after 5 failed attempts sign-in locks for 1 minute, doubling each time, up to 1 hour.">
          <p className="text-sm font-medium">5 attempts · 1 min doubling · 1 h cap</p>
        </SettingRow>
        <SettingRow label="Require two-step sign-in" help="Everyone signing in with a password must enrol an authenticator app (6-digit codes, 30 seconds). Until they do, their own page asks them to enrol. People on SSO use their provider’s second factor.">
          {canPolicy
            ? <Switch label="Require two-step sign-in for everyone" checked={!!data?.policy.require2step} disabled={policy.pending || !data} onChange={(v) => setPolicy({ require2step: v })} />
            : <p className="text-sm font-medium">{data ? (data.policy.require2step ? 'Required for everyone' : 'Optional') : '…'}</p>}
          {without2step.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-held-fg inline-flex items-center gap-1.5"><ShieldAlert className="h-3.5 w-3.5" aria-hidden />{plural(without2step.length, 'member')} without two-step sign-in{data?.policy.require2step ? ' — asked to enrol on their own page' : ''}:</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">{without2step.map((m) => <Person key={m.userId} id={m.userId} size={22} />)}</div>
            </div>
          )}
          {user && !orgApi.mfaOn(orgId, user.id) && <Link to="/you" className="mt-3 inline-block text-sm link">Set up two-step sign-in for yourself</Link>}
        </SettingRow>
      </Panel>

      <LockedSignIns orgId={orgId} members={members} canUnlock={role === 'owner' || role === 'admin'} />

      {role === 'auditor' && <Banner tone="neutral" className="mt-6">Auditor sessions are read-only in every client organisation and do not start live traffic.</Banner>}

      <Dialog open={confirm} onClose={() => setConfirm(false)} size="sm" title="Sign out other sessions"
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" loading={endOthers.pending} onClick={signOutOthers}>Sign out {plural(live.length, 'session')}</Button></>}>
        <p className="text-sm">Every session except this browser is signed out at once. Approvals already decided stay decided.</p>
      </Dialog>
    </div>
  );
}
