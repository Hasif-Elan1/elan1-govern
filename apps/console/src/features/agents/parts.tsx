/**
 * Shared pieces for the agents area: decision-mix maths over the chain, the mini stacked bar,
 * the risk-level mark and day buckets in IST. Auto-pause lives on the organisation's record (see backend.ts).
 */
import type { Decision, Receipt, RiskLevel, RiskTag, Rule } from '@/types';
import { db } from '@/api';
import { cn } from '@/lib/cn';
import { n, pct, HIGH_IMPACT_TAGS } from '@/lib/format';

export const DAY = 864e5;
export const HOUR = 36e5;
const IST = 5.5 * HOUR;

/* ── Decision mix ─────────────────────────────────────────── */

export interface Mix { allow: number; ask: number; refuse: number; total: number; last?: string }

export const emptyMix = (): Mix => ({ allow: 0, ask: 0, refuse: 0, total: 0 });

export function addDecision(m: Mix, d?: Decision, ts?: string) {
  if (!d) return;
  m[d]++;
  m.total++;
  if (ts && (!m.last || ts > m.last)) m.last = ts;
}

/** Decision receipts in the last `days` days, newest first. Reads the organisation's chain directly (read only). */
export function decisionsSince(orgId: string, days: number, agent?: string): Receipt[] {
  const from = Date.now() - days * DAY;
  const rs = db.getDB(orgId).receipts;
  const out: Receipt[] = [];
  for (let i = rs.length - 1; i >= 0; i--) {
    const r = rs[i];
    if (new Date(r.ts).getTime() < from) break;
    if (r.kind === 'decision' && (!agent || r.agent === agent)) out.push(r);
  }
  return out;
}

export function mixByAgent(rs: Receipt[]): Map<string, Mix> {
  const m = new Map<string, Mix>();
  for (const r of rs) {
    if (!r.agent) continue;
    if (!m.has(r.agent)) m.set(r.agent, emptyMix());
    addDecision(m.get(r.agent)!, r.decision, r.ts);
  }
  return m;
}

export function mixOf(rs: Receipt[]): Mix {
  const m = emptyMix();
  for (const r of rs) addDecision(m, r.decision, r.ts);
  return m;
}

export function mixText(m: Mix) {
  if (!m.total) return 'No calls';
  return `${n(m.allow)} allowed, ${n(m.ask)} asked a person, ${n(m.refuse)} refused`;
}

/** Mini stacked bar: allowed · asked · refused. Always carries a text label for screen readers and on hover. */
export function MixBar({ mix, className, height = 6 }: { mix: Mix; className?: string; height?: number }) {
  const t = mix.total || 1;
  const label = mixText(mix);
  return (
    <div role="img" aria-label={label} title={label} className={cn('flex w-full bg-sunken overflow-hidden', className)} style={{ height }}>
      {mix.total > 0 && (
        <>
          <span className="bg-ok h-full" style={{ width: `${(mix.allow / t) * 100}%` }} />
          <span className="bg-held h-full" style={{ width: `${(mix.ask / t) * 100}%` }} />
          <span className="bg-bad h-full" style={{ width: `${(mix.refuse / t) * 100}%` }} />
        </>
      )}
    </div>
  );
}

export function MixNumbers({ mix }: { mix: Mix }) {
  if (!mix.total) return <span className="text-xs text-subtle">No calls in 7 days</span>;
  return (
    <span className="inline-flex flex-wrap gap-x-2 text-xs text-muted num">
      <span title="Allowed"><span className="inline-block h-2 w-2 bg-ok mr-1" aria-hidden />{n(mix.allow)}</span>
      <span title="Asked a person"><span className="inline-block h-2 w-2 bg-held mr-1" aria-hidden />{n(mix.ask)}</span>
      <span title="Refused"><span className="inline-block h-2 w-2 bg-bad mr-1" aria-hidden />{n(mix.refuse)}</span>
      <span className="sr-only">{mixText(mix)}</span>
    </span>
  );
}

/* ── Risk level ───────────────────────────────────────────── */

const RISK_LABEL: Record<RiskLevel, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** Risk level is set by the owner; shown as a three-step mark plus a word, never colour alone. */
export function RiskLevelMark({ level, className }: { level: RiskLevel; className?: string }) {
  const k = { low: 1, medium: 2, high: 3 }[level];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm whitespace-nowrap', className)} title={`${RISK_LABEL[level]} risk level`}>
      <span className="inline-flex items-end gap-[2px]" aria-hidden>
        {[1, 2, 3].map((i) => <span key={i} className={cn('w-[5px]', i <= k ? 'bg-fg' : 'bg-line-strong/50')} style={{ height: 4 + i * 3 }} />)}
      </span>
      {RISK_LABEL[level]}
    </span>
  );
}

/* ── Days in IST ──────────────────────────────────────────── */

export const istDay = (t: number) => new Date(t + IST).toISOString().slice(0, 10);
export const istHour = (t: number) => new Date(t + IST).getUTCHours();
export const dayLabel = (d: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

export function byDay(rs: Receipt[], days: number) {
  const out: { day: string; allow: number; ask: number; refuse: number }[] = [];
  for (let i = days - 1; i >= 0; i--) out.push({ day: istDay(Date.now() - i * DAY), allow: 0, ask: 0, refuse: 0 });
  const idx = new Map(out.map((o, i) => [o.day, i]));
  for (const r of rs) {
    const i = idx.get(istDay(new Date(r.ts).getTime()));
    if (i !== undefined && r.decision) out[i][r.decision]++;
  }
  return out;
}

/* ── Starter rules (mirrors the add-agent wizard on the server) ── */

export const isHighImpact = (tags: RiskTag[]) => tags.some((t) => HIGH_IMPACT_TAGS.includes(t));

export function starterRules(tools: { name: string; tags: RiskTag[] }[], starter: 'strict' | 'balanced'): Rule[] {
  return tools.map((t) => {
    const high = isHighImpact(t.tags);
    const decide: Decision = high ? (starter === 'strict' ? 'refuse' : 'ask') : t.tags.includes('reads_data') || starter === 'balanced' ? 'allow' : 'ask';
    return { id: t.name.replace(/\./g, '-'), match: { tool: t.name }, decide, approver: high ? 'owners' : undefined, reason: high ? 'High-impact tool held for a person.' : 'Starter rule.' } as Rule;
  });
}

/* ── Counterparties ───────────────────────────────────────── */

const CP_FIELDS = ['vendor', 'to_domain', 'counterparty', 'customer', 'to_account', 'payee', 'candidate'];

export function counterpartyOf(r: Receipt): string | undefined {
  const a = r.args_summary;
  if (!a) return undefined;
  for (const f of CP_FIELDS) if (a[f] !== undefined && a[f] !== '') return String(a[f]);
  return undefined;
}

export const share = (part: number, total: number) => (total ? pct(part / total) : '0%');

export function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

export const BUSINESS_UNITS = ['Finance', 'Treasury', 'Accounts payable', 'Collections', 'Customer support', 'Sales', 'Human resources', 'Engineering', 'Operations', 'Risk and compliance', 'Clinical operations', 'Information technology'];
