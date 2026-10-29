import { useCallback, useMemo } from 'react';
import { useQuery } from '@/hooks/useQuery';
import { useUser } from '@/store/session';
import { explainRefusals, listExplanations } from './backend';

/**
 * Which Not done items have been explained, shared by everyone in the organisation. Marking writes one
 * refusal.explained admin receipt with the operator's note; putting items back writes
 * refusal.explanation_withdrawn. The refusal receipts themselves never change.
 */
export function useExplained(_orgId: string) {
  const user = useUser();
  const q = useQuery((o) => listExplanations(o), [], { kinds: ['explained', 'receipt'] });
  const explained = useMemo(() => new Set(Object.keys(q.data ?? {})), [q.data]);

  const mark = useCallback(async (orgId: string, keys: string[], on: boolean, note = '') => {
    if (!user) throw new Error('Sign in to explain refusals.');
    const r = await explainRefusals(orgId, keys, note, user.id, on);
    q.refetch();
    return r;
  }, [user, q]);

  return { explained, notes: q.data ?? {}, mark, loading: q.loading, error: q.error };
}
