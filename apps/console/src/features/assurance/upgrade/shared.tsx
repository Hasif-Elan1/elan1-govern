import { CheckCircle2, Clock3, XCircle } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { StatusChip } from '@/components/ui';
import type { CheckState } from '@/mock/upgrade';

/** The close-out of the newest L1 → L2 upgrade, live (reloads on every new receipt). */
export function useCloseout() {
  return useQuery((o) => api.upgradeCloseout(o), []);
}

/** A 16-hex fingerprint in groups of four, the way it is read aloud and compared. */
export const groupFp = (fp?: string) => (fp ? fp.replace(/(.{4})(?=.)/g, '$1 ') : '—');

const CHECK_META: Record<CheckState, { tone: 'ok' | 'bad' | 'held'; label: string; Icon: typeof CheckCircle2 }> = {
  pass: { tone: 'ok', label: 'Passes', Icon: CheckCircle2 },
  fail: { tone: 'bad', label: 'Fails', Icon: XCircle },
  waiting: { tone: 'held', label: 'Waiting', Icon: Clock3 },
};

export function CheckChip({ state, size = 'sm' }: { state: CheckState; size?: 'sm' | 'md' }) {
  const m = CHECK_META[state];
  return <StatusChip size={size} tone={m.tone} icon={<m.Icon className="h-3 w-3" aria-hidden />}>{m.label}</StatusChip>;
}

/** A pass or fail mark that never relies on colour alone. */
export function Mark({ ok, label }: { ok: boolean; label: string }) {
  return ok
    ? <span className="inline-flex items-center gap-1 text-ok-fg"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">{label}: </span>Yes</span>
    : <span className="inline-flex items-center gap-1 text-bad-fg"><XCircle className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">{label}: </span>No</span>;
}

export const toDateInput = (t: number) => new Date(t + 5.5 * 3_600_000).toISOString().slice(0, 10);
