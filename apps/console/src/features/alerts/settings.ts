import { useQuery } from '@/hooks/useQuery';
import { getAlertSettings, type AnyDetector, type Sensitivity } from '@/features/work/backend';

/**
 * Detector and auto-pause settings, stored for the organisation (shared by everyone in it and kept across reloads).
 * Every change writes an admin receipt; the live detectors and auto-pause read them.
 */
export type { Sensitivity };

export const SENSITIVITY_LABEL: Record<Sensitivity, string> = { fewer: 'Fewer alerts', default: 'Default', more: 'More alerts' };

export function useAlertSettings() {
  // the same store the Agents screens write (features/work/backend.ts, `autoPause` on the organisation's record),
  // re-read when an agent changes so Alerts and Agents always agree
  const q = useQuery((o) => getAlertSettings(o), [], { kinds: ['receipt', 'agent', 'alert'] });
  const s = q.data;
  return {
    loading: q.loading,
    error: q.error,
    refetch: q.refetch,
    detectorOn: (id: AnyDetector) => s?.detectors[id]?.on ?? true,
    sensitivity: (id: AnyDetector): Sensitivity => s?.detectors[id]?.sensitivity ?? 'default',
    /** Auto-pause is off by default; it is on only where a person switched it on (the seed records who did). */
    autoPause: (slug: string) => !!s?.autoPause[slug],
  };
}
