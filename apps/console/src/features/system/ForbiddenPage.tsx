import { useNavigate, useSearchParams } from 'react-router-dom';
import { SmartLink, useScreenAccess } from '@/shell/access';
import { ArrowLeft, Check, Lock, Minus } from 'lucide-react';
import { useOrgId, useRole, useUser } from '@/store/session';
import { db } from '@/api';
import { userById } from '@/mock/users';
import { PERMISSIONS, ROLE_INFO, ROLE_PERMISSIONS, type Permission } from '@/lib/permissions';
import { ALL_PERMISSIONS, roleHas, type AnyPermission } from '@/features/settings/permissions';
import type { Role } from '@/types';
import { Badge, Button, Disc } from '@/components/ui';
import { Person } from '@/components/domain';
import { PORTAL_INFO } from '@/features/auth/registry';

const ROLES: Role[] = ['owner', 'admin', 'approver', 'viewer', 'auditor'];

/** 403 inside the shell: says what the role can do, what was asked for, and who can help. */
export default function ForbiddenPage() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const role = useRole();
  const user = useUser();
  const orgId = useOrgId();
  const access = useScreenAccess();
  // the gate sends ?perm= (any permission, base or level), ?roles= (the roles a screen is for) and ?what=
  const perm = ALL_PERMISSIONS.find((p) => p.id === sp.get('perm')) ?? PERMISSIONS.find((p) => p.id === sp.get('perm'));
  const roleList = (sp.get('roles') ?? '').split(',').filter((r): r is Role => (ROLES as string[]).includes(r));
  const what = sp.get('what');
  const from = sp.get('from');
  const holders = perm ? ROLES.filter((r) => roleHas(r, perm.id as AnyPermission) && (!roleList.length || roleList.includes(r))) : roleList.length ? roleList : ['owner', 'admin'] as Role[];
  const people = db.getDB(orgId).members.filter((m) => m.status === 'active' && holders.includes(m.role) && m.role !== 'auditor' && m.userId !== user?.id).slice(0, 4);
  const mine = role ? PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role].includes(p.id as Permission)) : [];

  return (
    <div className="min-h-[60vh] grid place-items-center py-10">
      <div className="w-full max-w-[720px]">
        <Disc kind="gate" size={64} title="Access limited" />
        <p className="label mt-8">403 · Not allowed for your role</p>
        <h1 className="mt-2 text-4xl font-bold tracking-tighter2">Your role cannot open this</h1>
        <p className="mt-3 text-md text-muted leading-relaxed max-w-[62ch]">
          {what && <><span className="text-fg font-medium">{what}</span>. </>}
          {perm ? <>This needs the permission <span className="text-fg font-medium">“{perm.label}”</span>, which {holders.map((h) => ROLE_INFO[h].label).join(', ')} hold.</> : roleList.length ? <>This page is for {holders.map((h) => ROLE_INFO[h].label).join(' and ')} only.</> : <>This page is limited to roles that can change the organisation’s set-up.</>}
          {' '}You are signed in as <span className="text-fg font-medium">{role ? ROLE_INFO[role].label : 'a guest'}</span>{role && <> — {ROLE_INFO[role].summary.charAt(0).toLowerCase() + ROLE_INFO[role].summary.slice(1)}</>}
        </p>
        {from && <p className="mt-2 text-sm text-muted">Requested: <span className="font-mono text-fg">{from}</span></p>}

        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="primary" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => nav(-1)}>Go back</Button>
          {access.canSee('/agents/people') && <Button variant="secondary" onClick={() => nav('/agents/people?tab=roles')}>See every role’s permissions</Button>}
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <section className="border border-line bg-surface" aria-labelledby="can-h">
            <div className="px-5 py-3 border-b border-line flex items-center justify-between gap-2">
              <h2 id="can-h" className="text-md font-semibold">What your role can do</h2>
              {role && <Badge tone="inverse">{ROLE_INFO[role].label}</Badge>}
            </div>
            <ul className="divide-y divide-line">
              {mine.length ? mine.slice(0, 8).map((p) => (
                <li key={p.id} className="px-5 py-2 flex items-center gap-2 text-sm"><Check className="h-3.5 w-3.5 text-ok-fg shrink-0" aria-hidden />{p.label}</li>
              )) : <li className="px-5 py-3 text-sm text-muted inline-flex items-center gap-2"><Minus className="h-3.5 w-3.5" />Nothing yet</li>}
              {mine.length > 8 && <li className="px-5 py-2 text-xs text-muted">and {mine.length - 8} more</li>}
            </ul>
          </section>
          <section className="border border-line bg-surface" aria-labelledby="ask-h">
            <div className="px-5 py-3 border-b border-line"><h2 id="ask-h" className="text-md font-semibold">Who can help</h2></div>
            <ul className="divide-y divide-line">
              {people.length ? people.map((m) => (
                <li key={m.userId} className="px-5 py-2.5 flex items-center justify-between gap-2">
                  <Person id={m.userId} showTitle size={28} />
                  <a className="text-xs link shrink-0" href={`mailto:${userById(m.userId)?.email}`}>Email</a>
                </li>
              )) : <li className="px-5 py-3 text-sm text-muted">Ask an owner of the organisation.</li>}
            </ul>
            <p className="px-5 py-3 border-t border-line text-xs text-muted"><Lock className="inline h-3.5 w-3.5 mr-1.5 align-[-2px]" aria-hidden />Role changes are made in the Agents door, under <SmartLink to="/agents/people" className="link">People and roles</SmartLink>, and recorded as receipts on the organisation’s chain.</p>
          </section>
        </div>

        <section className="mt-4 border border-line bg-surface" aria-labelledby="portal-h">
          <div className="px-5 py-3 border-b border-line flex flex-wrap items-center justify-between gap-2">
            <h2 id="portal-h" className="text-md font-semibold">People outside the console (L3)</h2>
            <Badge>Verification seat · ₹45,000 a year</Badge>
          </div>
          <ul className="divide-y divide-line">
            {(Object.keys(PORTAL_INFO) as (keyof typeof PORTAL_INFO)[]).map((k) => (
              <li key={k} className="px-5 py-2.5 text-sm"><span className="font-medium">{PORTAL_INFO[k].label}.</span> <span className="text-muted">{PORTAL_INFO[k].summary}</span></li>
            ))}
          </ul>
          <p className="px-5 py-3 border-t border-line text-xs text-muted">They sign in to the counterparty portal, never to these doors. Seats are added in the Assurance door, under <SmartLink to="/assurance/counterparties" className="link">Counterparties</SmartLink>.</p>
        </section>
      </div>
    </div>
  );
}
