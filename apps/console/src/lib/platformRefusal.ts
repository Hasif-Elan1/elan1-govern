/**
 * PLATFORM refusals are ours: the guard failed (the receipt could not be appended, or something unexpected failed
 * before the call ran), so the call was refused rather than let through. They are recorded like any refusal but
 * never billed — the meter counts them at 0, unlike a POLICY or pre-write-check refusal (40% of the per-action rate).
 *
 * On the chain they carry the system rule id `gate-error` (PLATFORM.LOG_APPEND_FAILED, PLATFORM.INTERNAL_ERROR),
 * or a `PLATFORM.*` wire code in `rule_id` / `details.code`.
 */
export const PLATFORM_RULE_IDS: readonly string[] = ['gate-error'];

export function isPlatformRefusal(r: { decision?: string; rule_id?: string; details?: Record<string, unknown> }): boolean {
  if (r.decision !== 'refuse') return false;
  const rule = r.rule_id ?? '';
  if (PLATFORM_RULE_IDS.includes(rule) || rule.startsWith('PLATFORM.')) return true;
  const code = r.details?.code;
  return typeof code === 'string' && code.startsWith('PLATFORM.');
}
