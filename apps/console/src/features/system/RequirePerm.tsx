import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Role } from '@/types';
import { useRole } from '@/store/session';
import { roleHas, type AnyPermission } from '@/features/settings/permissions';

/**
 * A permission gate on a route: a person whose role lacks the permission (or is not one of `roles`) is sent to /403,
 * which names what was asked for, what their role can do and who can help.
 */
export function RequirePerm({ perm, roles, what, children }: { perm?: AnyPermission; roles?: Role[]; what?: string; children: ReactNode }) {
  const role = useRole();
  const loc = useLocation();
  // the role is read from the member record; until it is known the page decides for itself
  if (!role) return <>{children}</>;
  const ok = (!perm || roleHas(role, perm)) && (!roles || roles.includes(role));
  if (ok) return <>{children}</>;
  const q = new URLSearchParams();
  if (perm) q.set('perm', perm);
  if (roles) q.set('roles', roles.join(','));
  if (what) q.set('what', what);
  q.set('from', loc.pathname + loc.search);
  return <Navigate to={`/403?${q.toString()}`} replace />;
}
