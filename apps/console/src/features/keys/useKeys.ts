import { useQuery } from '@/hooks/useQuery';
import { keysApi } from '@/mock/keys';

/** Keys state for the current organisation: contact, open compromise, bound key, windows, gate, publications. */
export function useKeysState() {
  return useQuery((o) => keysApi.state(o), [], { kinds: ['key', 'incident', 'level', 'open'] });
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
