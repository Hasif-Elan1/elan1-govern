import { forwardRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDownToLine, Ban, Check, CircleSlash, Download, EyeOff, FileText, FileWarning, Minus, OctagonX, ShieldCheck, ShieldQuestion, X } from 'lucide-react';
import type { CheckState } from '@/lib/crypto';
import type { SectionState, VerifyCode, VerifySection } from '@/types';
import { EXIT_CODES } from '@/lib/verify6';
import { FIELD_LABELS, type DisclosableField } from '@/lib/disclosure';
import { cn } from '@/lib/cn';
import { Badge, Button, CopyButton, Panel } from '@/components/ui';
import { downloadBlob, downloadJson, reportText, type Result6 } from './bundle';

/** Square state mark with icon and a label for assistive tech. Colour is never the only signal. */
export function StateMark({ state, label, size = 'md' }: { state: CheckState | SectionState | 'info' | undefined; label?: string; size?: 'sm' | 'md' }) {
  const s = state ?? 'skip';
  const box = size === 'sm' ? 'h-5 w-5' : 'h-6 w-6';
  const ic = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  const text = s === 'pass' ? 'Passed' : s === 'fail' ? 'Failed' : s === 'warn' ? 'Passed with a warning' : s === 'incomplete' ? 'Incomplete' : s === 'info' ? 'Information' : 'Not checked';
  return (
    <span className={cn('inline-flex items-center justify-center border shrink-0', box,
      s === 'pass' && 'border-ok/40 bg-ok-bg text-ok-fg', s === 'fail' && 'border-bad/50 bg-bad-bg text-bad-fg', (s === 'warn' || s === 'incomplete') && 'border-held/50 bg-held-bg text-held-fg',
      (s === 'skip' || s === 'not_applicable' || s === 'info') && 'border-line bg-sunken text-subtle')}
      title={label ? `${label}: ${text}` : text}>
      {s === 'pass' ? <Check className={ic} strokeWidth={3} aria-hidden /> : s === 'fail' ? <X className={ic} strokeWidth={3} aria-hidden /> : s === 'warn' || s === 'incomplete' ? <AlertTriangle className={ic} aria-hidden /> : <Minus className={ic} aria-hidden />}
      <span className="sr-only">{label ? `${label}: ` : ''}{text}</span>
    </span>
  );
}

const CODE_META: Record<VerifyCode, { edge: string; tint: string; fg: string; icon: typeof ShieldCheck; tone: 'ok' | 'bad' | 'held' | 'neutral' }> = {
  PASS: { edge: 'border-l-ok', tint: 'bg-ok-bg/50', fg: 'text-ok-fg', icon: ShieldCheck, tone: 'ok' },
  PASS_UNANCHORED_TAIL: { edge: 'border-l-ok', tint: 'bg-ok-bg/50', fg: 'text-ok-fg', icon: ShieldCheck, tone: 'ok' },
  PASS_KEY_FROM_BUNDLE: { edge: 'border-l-ok', tint: 'bg-ok-bg/40', fg: 'text-ok-fg', icon: ShieldCheck, tone: 'ok' },
  PASS_L1_INTERNAL: { edge: 'border-l-ok', tint: 'bg-ok-bg/40', fg: 'text-ok-fg', icon: ShieldCheck, tone: 'ok' },
  PASS_PAYLOAD_UNBOUND: { edge: 'border-l-ok', tint: 'bg-ok-bg/40', fg: 'text-ok-fg', icon: ShieldCheck, tone: 'ok' },
  FAIL_INTEGRITY: { edge: 'border-l-bad', tint: 'bg-bad-bg/50', fg: 'text-bad-fg', icon: OctagonX, tone: 'bad' },
  FAIL_PROFILE: { edge: 'border-l-bad', tint: 'bg-bad-bg/40', fg: 'text-bad-fg', icon: FileWarning, tone: 'bad' },
  INCOMPLETE: { edge: 'border-l-held', tint: 'bg-held-bg/50', fg: 'text-held-fg', icon: ShieldQuestion, tone: 'held' },
  UNSUPPORTED: { edge: 'border-l-line-strong', tint: 'bg-sunken/60', fg: 'text-muted', icon: Ban, tone: 'neutral' },
  USAGE: { edge: 'border-l-line-strong', tint: 'bg-sunken/60', fg: 'text-muted', icon: CircleSlash, tone: 'neutral' },
};

export function CodeBadge({ code }: { code: VerifyCode }) {
  return <Badge tone={CODE_META[code].tone} className="font-mono">{code}</Badge>;
}

export const ResultHero = forwardRef<HTMLHeadingElement, { r: Result6; label: string; brokenAt?: number; onJump?: (seq: number) => void; expect?: VerifyCode }>(function ResultHero({ r, label, brokenAt, onJump, expect }, ref) {
  const m = CODE_META[r.code];
  const Icon = m.icon;
  const line = `${r.code} (exit ${r.exitCode}) · ${r.headline}${r.fingerprint ? ` · key ${r.fingerprint} (${r.keySource === 'supplied' ? 'matched to yours' : 'from the file'})` : ''}`;
  return (
    <section aria-labelledby="verdict" className={cn('border border-line border-l-[6px] bg-surface', m.edge)}>
      <div className={cn('flex flex-col gap-5 p-5 sm:p-7 md:flex-row md:items-start', m.tint)}>
        <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center border border-line-strong/60 bg-surface"><Icon className={cn('h-7 w-7', m.fg)} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <p className="label">Result · exit code {r.exitCode}{r.org ? ` · ${r.org}` : ''}</p>
          <h2 id="verdict" ref={ref} tabIndex={-1} className={cn('mt-1 font-mono text-3xl sm:text-4xl font-semibold tracking-tight leading-none break-all focus:outline-none', m.fg)}>{r.code}</h2>
          <p className="mt-2 text-md font-medium">{r.label}</p>
          <p className="mt-2 max-w-[72ch] text-md text-fg">{r.headline}</p>
          {r.variants.length > 0 && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-muted">Pass variants that apply: {r.variants.map((v) => <CodeBadge key={v} code={v} />)}</p>
          )}
          {expect && expect !== r.code && <p className="mt-2 text-sm text-held-fg">This sample usually gives {expect}; your options (fingerprint or profile) changed the outcome.</p>}
          <div className="mt-5 flex flex-wrap gap-2">
            {brokenAt !== undefined && onJump && <Button size="sm" variant="primary" icon={<ArrowDownToLine className="h-4 w-4" />} onClick={() => onJump(brokenAt)}>Show #{brokenAt} in the table</Button>}
            <Button size="sm" icon={<FileText className="h-4 w-4" />} onClick={() => downloadBlob(`verify-report-${r.code.toLowerCase()}.txt`, new Blob([reportText(r, label)], { type: 'text/plain' }))}>Download report</Button>
            <Button size="sm" variant="ghost" icon={<Download className="h-4 w-4" />} onClick={() => downloadJson(`verify-report-${r.code.toLowerCase()}.json`, { verifier: r.report.find((s) => s.id === 'reproduction')?.lines.find((l) => l.label === 'Verifier')?.value, input: label, checked_at: new Date().toISOString(), code: r.code, exit_code: r.exitCode, sections: r.report })}>JSON</Button>
            <CopyButton text={line} label="Copy result line" className="h-8 px-3" />
          </div>
        </div>
      </div>
    </section>
  );
});

/** The verifier's own checks (nine for a bundle; the steps for a package or counterparty receipt). */
export function ChecksPanel({ checks, title }: { checks: VerifySection[]; title: string }) {
  return (
    <Panel title={title} kicker="What was checked" flush>
      <ol className="divide-y divide-line">
        {checks.map((s) => (
          <li key={`${s.id}-${s.number}`} className="flex items-start gap-3 px-5 py-3.5">
            <span className="mt-0.5 w-4 text-xs text-subtle num">{s.number}</span>
            <StateMark state={s.state} label={s.title} />
            <div className="min-w-0">
              <p className="text-sm font-semibold">{s.title} <span className={cn('ml-1 text-xs font-medium', s.state === 'pass' ? 'text-ok-fg' : s.state === 'fail' ? 'text-bad-fg' : s.state === 'warn' || s.state === 'incomplete' ? 'text-held-fg' : 'text-muted')}>{stateLabel(s.state)}</span></p>
              <p className="mt-0.5 text-sm text-muted leading-relaxed">{s.detail}</p>
              {s.facts && s.facts.length > 0 && (
                <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">{s.facts.slice(0, 6).map((f) => <span key={f.label}>{f.label}: <span className="text-fg font-mono">{f.value}</span></span>)}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

const stateLabel = (s: SectionState) => (s === 'pass' ? 'Passed' : s === 'fail' ? 'Failed' : s === 'warn' ? 'Passed with a warning' : s === 'incomplete' ? 'Incomplete' : 'Not applicable');

/** The nine-section report: Verdict, Claim, Scope, Integrity, Clause results, First failure, Notes, Limits, Reproduction. */
export function ReportPanel({ r }: { r: Result6 }) {
  const [open, setOpen] = useState<Record<string, boolean>>({ verdict: true, claim: true, 'first-failure': true, clauses: r.code === 'FAIL_PROFILE' });
  return (
    <Panel title="The report" kicker="Nine sections, the same as govern verify writes" flush>
      <ol className="divide-y divide-line">
        {r.report.map((s) => {
          const on = open[s.id] ?? false;
          return (
            <li key={s.id}>
              <button type="button" aria-expanded={on} onClick={() => setOpen((o) => ({ ...o, [s.id]: !on }))} className="w-full flex items-start gap-3 px-5 py-3 text-left hover:bg-sunken/50">
                <span className="mt-0.5 w-4 text-xs text-subtle num">{s.n}</span>
                <StateMark state={s.state} label={s.title} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{s.title}</span>
                  <span className="block text-sm text-muted leading-relaxed">{s.text}</span>
                </span>
                {s.lines.length > 0 && <span className="text-xs text-muted shrink-0">{on ? 'Hide' : `${s.lines.length} line${s.lines.length === 1 ? '' : 's'}`}</span>}
              </button>
              {on && s.lines.length > 0 && (
                <dl className="mx-5 mb-4 ml-12 border border-line divide-y divide-line">
                  {s.lines.map((l, i) => (
                    <div key={i} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)] sm:gap-4">
                      <dt className="text-muted">{l.label}</dt>
                      <dd className={cn('min-w-0 break-words', /digest|hash|command|fingerprint/i.test(l.label) && 'font-mono text-[12.5px] break-all')}>{l.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

/** What a disclosure package reveals, and how many fields stay hidden but bound. */
export function RevealedPanel({ r }: { r: Result6 }) {
  if (!r.revealed) return null;
  const hidden = (r.committed ?? 0) - r.revealed.length;
  return (
    <Panel title={`You are seeing ${r.revealed.length} of ${r.committed} committed fields`} kicker="Selective disclosure (SD-JWT style)" flush>
      <ul className="divide-y divide-line">
        {r.revealed.map((f) => (
          <li key={f.name} className="grid gap-1 px-5 py-2.5 text-sm sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
            <span className="text-muted">{FIELD_LABELS[f.name as DisclosableField] ?? f.name}</span>
            <span className="min-w-0 break-words font-medium">{f.value || '—'}<span className="block font-mono text-[11px] text-subtle break-all">salt {f.salt}</span></span>
          </li>
        ))}
        {hidden > 0 && <li className="px-5 py-3 text-sm text-muted inline-flex items-center gap-2"><EyeOff className="h-4 w-4" aria-hidden />{hidden} other fields stay hidden. Their salted digests are in the signed list, so none can be swapped without the signature failing.</li>}
      </ul>
    </Panel>
  );
}

export function ExitTable() {
  const rows: [VerifyCode, ReactNode][] = [
    ['PASS', 'Everything checks, the key matches the fingerprint you supplied, and every sealed record is in a timestamped batch.'],
    ['PASS_UNANCHORED_TAIL', 'Passes; the newest sealed records are not yet in a timestamped batch.'],
    ['PASS_KEY_FROM_BUNDLE', 'Passes, but the key came from the file itself. Supply the fingerprint you obtained from the organisation.'],
    ['PASS_L1_INTERNAL', 'Passes. L1 records only: internal evidence, sealed in a hash chain by Elan1 Govern and not externally timestamped.'],
    ['PASS_PAYLOAD_UNBOUND', 'Passes. An erasure destroyed a salt, so some payload hashes can no longer be recomputed; links, seals and signatures still verify.'],
    ['FAIL_INTEGRITY', 'A hash, link, signature, seal, Merkle root or timestamp does not verify. Names the first failure.'],
    ['FAIL_PROFILE', 'Integrity holds, but a rule of the claimed verifier profile fails. Names the rule and the records.'],
    ['INCOMPLETE', 'Something needed is missing — a member, a seal, a key. Neither a pass nor a fail.'],
    ['UNSUPPORTED', 'A format or profile this verifier does not know. It refuses to guess.'],
    ['USAGE', 'The input is not a bundle, or an option is wrong.'],
  ];
  return (
    <div className="overflow-x-auto border border-line">
      <table className="w-full text-sm">
        <caption className="sr-only">Result codes and exit codes</caption>
        <thead className="bg-sunken/80"><tr className="border-b border-line"><th scope="col" className="h-8 px-3 text-left label w-14">Exit</th><th scope="col" className="h-8 px-3 text-left label">Code</th><th scope="col" className="h-8 px-3 text-left label">Meaning</th></tr></thead>
        <tbody>
          {rows.map(([c, t]) => (
            <tr key={c} className="border-b border-line last:border-b-0 align-top">
              <td className="px-3 py-2 num">{EXIT_CODES[c]}</td>
              <td className="px-3 py-2"><CodeBadge code={c} /></td>
              <td className="px-3 py-2 text-fg/90">{t}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 border-t border-line text-xs text-muted">Precedence when several apply: FAIL_INTEGRITY, then INCOMPLETE, then FAIL_PROFILE. A failure of integrity is never reported as a profile failure. A batch timestamped by only one of its two authorities is degraded — a warning, not a failure.</p>
    </div>
  );
}
