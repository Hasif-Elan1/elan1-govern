import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '@/api';
import { useOrgId } from '@/store/session';

export interface QueryState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean; // first load only
  refreshing: boolean;
  refetch: () => void;
}

/**
 * Loads data through the API and reloads it whenever the organisation's records change
 * (a new receipt, an approval decided, a stop engaged). `live: false` loads once.
 */
export function useQuery<T>(fn: (orgId: string) => Promise<T>, deps: unknown[] = [], opts: { live?: boolean; kinds?: string[] } = {}): QueryState<T> {
  const orgId = useOrgId();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback((initial: boolean) => {
    const id = ++seq.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    fnRef.current(orgId)
      .then((d) => { if (id === seq.current) { setData(d); setError(undefined); } })
      .catch((e: Error) => { if (id === seq.current) setError(e); })
      .finally(() => { if (id === seq.current) { setLoading(false); setRefreshing(false); } });
  }, [orgId]);

  useEffect(() => {
    run(true);
  }, [orgId, ...deps]);

  useEffect(() => {
    if (opts.live === false) return;
    let t: number | undefined;
    const off = db.subscribe((o, kind) => {
      if (o !== orgId) return;
      if (opts.kinds && !opts.kinds.includes(kind)) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => run(false), 250);
    });
    return () => { off(); window.clearTimeout(t); };
  }, [orgId, opts.live, run]);

  return { data, error, loading, refreshing, refetch: () => run(false) };
}

/** Run a mutation with pending and error state. */
export function useMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error>();
  const mutate = useCallback(async (...args: A) => {
    setPending(true);
    setError(undefined);
    try {
      return await fn(...args);
    } catch (e) {
      setError(e as Error);
      throw e;
    } finally {
      setPending(false);
    }
  }, []);
  return { mutate, pending, error };
}

/** Re-render every `ms` so countdowns and relative times stay current. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
