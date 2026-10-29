import { useCallback, useEffect, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * The selected tab lives in the URL (?tab=…) so the retired Settings redirects —
 * /settings/sso → /agents/organisation?tab=sso — land on the right tab, and a tab can be linked to.
 * The first tab is the default and is kept out of the URL.
 */
export function useTabParam<T extends string>(allowed: readonly T[]): [T, (t: T) => void] {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab') ?? '';
  const fallback = allowed[0];
  const tab = (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const setTab = useCallback(
    (t: T) => setSp((p) => {
      const next = new URLSearchParams(p);
      if (t === fallback) next.delete('tab');
      else next.set('tab', t);
      return next;
    }, { replace: true }),
    [setSp, fallback],
  );
  return [tab, setTab];
}

/** The word alone, singular or plural, for when the number is set separately (format.plural includes it). */
export function word(count: number, one: string, many = one + 's') {
  return count === 1 ? one : many;
}

export function usePageTitle(title: string) {
  useEffect(() => { document.title = `${title} · Elan1 Govern`; }, [title]);
}

/** The region under a set of tabs. */
export function TabPanel({ label, children }: { label: string; children: ReactNode }) {
  return <section role="tabpanel" aria-label={label} className="pt-6 min-w-0">{children}</section>;
}
