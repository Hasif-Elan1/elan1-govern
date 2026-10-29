/** Formatting in the house style: British English, Indian digit grouping, IST, numerals for all quantities. */

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('en-IN');

export const TZ = 'Asia/Kolkata';

/** ₹1,80,000 — whole rupees. */
export function rupees(n: number, opts: { paise?: boolean } = {}): string {
  return '₹' + (opts.paise ? inr2.format(n) : inr.format(Math.round(n)));
}

/** ₹1.2 crore · ₹6 lakh — for large headline figures. */
export function rupeesShort(n: number): string {
  if (n >= 1e7) return `₹${trim(n / 1e7)} crore`;
  if (n >= 1e5) return `₹${trim(n / 1e5)} lakh`;
  return rupees(n);
}

export function usd(n: number): string {
  return '$' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
}

export const INR_PER_USD = 90;

function trim(n: number) {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

export function n(value: number): string {
  return num.format(value);
}

export function pct(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function compact(value: number): string {
  if (value >= 1e7) return `${trim(value / 1e7)} cr`;
  if (value >= 1e5) return `${trim(value / 1e5)} L`;
  if (value >= 1e3) return `${trim(value / 1e3)}k`;
  return String(value);
}

const dt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
const dtt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
const tm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: TZ });
const tmShort = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });

export const date = (iso: string) => dt.format(new Date(iso));
export const dateTime = (iso: string) => dtt.format(new Date(iso)) + ' IST';
export const time = (iso: string) => tm.format(new Date(iso));
export const timeShort = (iso: string) => tmShort.format(new Date(iso));

export function relative(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const s = Math.round(abs / 1000);
  const m = Math.round(s / 60);
  const h = Math.round(m / 60);
  const d = Math.round(h / 24);
  const fmt = (v: number, u: string) => (diff < 0 ? `${v} ${u}${v === 1 ? '' : 's'} ago` : `in ${v} ${u}${v === 1 ? '' : 's'}`);
  if (s < 45) return diff < 0 ? 'just now' : 'in a moment';
  if (m < 60) return fmt(m, 'minute');
  if (h < 24) return fmt(h, 'hour');
  if (d < 30) return fmt(d, 'day');
  return date(iso);
}

/** "3 h 12 m" countdown for approval expiry. */
export function countdown(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d} d ${h % 24} h`;
  if (h > 0) return `${h} h ${m % 60} m`;
  return `${m} m`;
}

export function shortHash(h: string, len = 10): string {
  return h.length > len ? h.slice(0, len) : h;
}

export function seqLabel(seq: number) {
  return `#${num.format(seq)}`;
}

export function plural(count: number, one: string, many = one + 's') {
  return `${num.format(count)} ${count === 1 ? one : many}`;
}

export const tagLabel: Record<string, string> = {
  reads_data: 'Reads data',
  writes_data: 'Writes data',
  moves_money: 'Moves money',
  sends_external: 'Sends external',
  personal_data: 'Personal data',
  deletes: 'Deletes',
  changes_access: 'Changes access',
  changes_production: 'Changes production',
};

export const HIGH_IMPACT_TAGS = ['moves_money', 'deletes', 'changes_access', 'changes_production'];

export const decisionLabel = { allow: 'Allowed', ask: 'Asked a person', refuse: 'Refused' } as const;

export const channelLabel: Record<string, string> = {
  web: 'Console',
  email: 'Email link',
  phone_link: 'Phone link',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
};
