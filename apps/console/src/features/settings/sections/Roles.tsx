import { Fragment } from 'react';
import { Check, Minus, ShieldCheck } from 'lucide-react';
import { useRole } from '@/store/session';
import { ROLE_INFO } from '@/lib/permissions';
import type { Role } from '@/types';
import { cn } from '@/lib/cn';
import { Badge, Banner, Panel } from '@/components/ui';
import { SectionHeader } from '../shared';
import { ALL_PERMISSIONS, LEVEL_PERMISSIONS, PORTAL_ROLES, permissionCount, roleHas } from '../permissions';

const ROLES: Role[] = ['owner', 'admin', 'approver', 'viewer', 'auditor'];
const GROUP_ORDER = ['Approvals', 'Records', 'Agents', 'Rulebooks', 'Connectors', 'Governance', 'Alerts and stop', 'Assurance', 'Organisation'];

export function RolesSection() {
  const mine = useRole();
  const groups = Array.from(new Set(ALL_PERMISSIONS.map((p) => p.group))).sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
  const isLevel = (id: string) => LEVEL_PERMISSIONS.some((p) => p.id === id);

  return (
    <div>
      <SectionHeader
        title="Roles and permissions"
        description={`5 roles inside the organisation and 2 portal roles outside it. Each person has one role per organisation; auditors hold read-only access across the client organisations they audit. ${ALL_PERMISSIONS.length} permissions in all.`}
      />

      <div className="grid gap-px bg-line border border-line sm:grid-cols-2 xl:grid-cols-5 mb-6">
        {ROLES.map((r) => (
          <div key={r} className={cn('bg-surface p-4', r === mine && 'shadow-[inset_0_3px_0_rgb(var(--fg))]')}>
            <div className="flex items-center justify-between gap-2">
              <p className="font-display text-md font-semibold">{ROLE_INFO[r].label}</p>
              {r === mine && <Badge tone="inverse">You</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted leading-relaxed">{ROLE_INFO[r].summary}</p>
            <p className="mt-2 text-xs num"><span className="font-semibold">{permissionCount(r)}</span> <span className="text-muted">of {ALL_PERMISSIONS.length} permissions</span></p>
          </div>
        ))}
      </div>

      {/* relative: the sr-only cell labels are absolutely positioned and must stay inside the scroll box */}
      <div className="relative overflow-x-auto border border-line bg-surface">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">Permissions held by each role. Read-only.</caption>
          <thead className="bg-sunken/95">
            <tr className="border-b border-line">
              <th scope="col" className="h-10 px-4 text-left label font-semibold">Permission</th>
              {ROLES.map((r) => (
                <th key={r} scope="col" className={cn('h-10 px-3 text-center label font-semibold w-[96px]', r === mine && 'text-fg bg-sunken')}>{ROLE_INFO[r].label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g}>
                <tr className="border-b border-line bg-sunken/40">
                  <th scope="rowgroup" colSpan={ROLES.length + 1} className="px-4 py-1.5 text-left label">{g}</th>
                </tr>
                {ALL_PERMISSIONS.filter((p) => p.group === g).map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-b-0 hover:bg-sunken/40">
                    <th scope="row" className="px-4 py-2.5 text-left font-normal">
                      <span className="block">{p.label}</span>
                      <span className="block font-mono text-[11.5px] text-subtle">{p.id}{isLevel(p.id) && <span className="font-sans"> · used by the level features</span>}</span>
                    </th>
                    {ROLES.map((r) => {
                      const has = roleHas(r, p.id);
                      return (
                        <td key={r} className={cn('relative px-3 text-center', r === mine && 'bg-sunken/50')}>
                          {has
                            ? <><Check className="inline h-4 w-4 text-fg" strokeWidth={2.5} aria-hidden /><span className="sr-only">{ROLE_INFO[r].label} can</span></>
                            : <><Minus className="inline h-4 w-4 text-subtle/70" aria-hidden /><span className="sr-only">{ROLE_INFO[r].label} cannot</span></>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-8 mb-3 text-lg font-semibold">Portal roles</h3>
      <p className="mb-4 max-w-[72ch] text-sm text-muted">People outside the organisation who see only what was shared with them, through a link. They never sign in to this console and hold none of the permissions above.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        {PORTAL_ROLES.map((r) => (
          <Panel key={r.id} title={r.label} actions={<Badge>{r.seat}</Badge>}>
            <div className="grid gap-4 sm:grid-cols-2 text-sm">
              <div><p className="label mb-1.5">Can</p><ul className="space-y-1">{r.can.map((x) => <li key={x} className="flex gap-2"><Check className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />{x}</li>)}</ul></div>
              <div><p className="label mb-1.5">Cannot</p><ul className="space-y-1 text-muted">{r.cannot.map((x) => <li key={x} className="flex gap-2"><Minus className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />{x}</li>)}</ul></div>
            </div>
          </Panel>
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Banner tone="neutral" title={<span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4" aria-hidden />Fresh sign-in for consequential actions</span>}>
          Approving or rejecting in the console, engaging the emergency stop, rotating the signing key and proposing or approving an autonomy graduation ask for your password again if your last sign-in is older than 10 minutes. The Approve and Reject buttons on a Slack or WhatsApp message do not: they decide only for the person the message was sent to, which is why they appear only on rules marked approvable in chat and never on a call that asks for the password again. Email links and Sovereign deployments, which have no chat, always ask you to sign in.
        </Banner>
        <Banner tone="neutral" title="Two people for the riskiest changes">
          From L2 a rulebook is published only after a different person reviews it. At every level an erasure needs two approvers who did not open it. At L3 an agent reaches A3 only by a graduation one person proposes and a different person approves — no one sets a level directly — while revoking takes one press by one person. Each receipt names the people involved.
        </Banner>
      </div>
    </div>
  );
}
