import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, CircleDashed, Download, Fingerprint, Minus, Printer, ShieldCheck, ShieldQuestion, ShieldX, X } from 'lucide-react';
import { api } from '@/api';
import type { VerifyCode, VerifySection } from '@/types';
import { CODE_LABELS, EXIT_CODES, reportSections, type BundleManifest } from '@/lib/verify6';
import { LEVEL_INFO, levelRank } from '@/lib/levels';
import { LEGAL_ENTITY } from '@/lib/company';
import { cn } from '@/lib/cn';
import { dateTime, n, seqLabel } from '@/lib/format';
import { useOrgId, useOrgLevel } from '@/store/session';
import { useQuery } from '@/hooks/useQuery';
import { Badge, Banner, Button, CopyButton, Field, Input, Meter, Segmented, Select, Spinner, StatusChip, type Tone } from '@/components/ui';
import { verifyChainProgressive, type ChainVerification, type CheckLine, type LineState, type Verdict } from './verify';
import { buildWorkingBundle, runSixCode, type SixCodeResult } from './bundle';
import { CLAIM_L1, claimFor, claimForChain, segmentPhrase, slugify } from './assurance';
import { downloadText } from './shared';
import { UpgradeHint } from './UpgradeHint';

export { claimFor, claimForChain, CLAIM_L1 };

export const VERDICT_META: Record<Verdict, { label: string; tone: string; edge: string; icon: typeof ShieldCheck; exit: 0 | 1 | 2 }> = {
  verified: { label: 'Verified', tone: 'text-ok-fg', edge: 'border-l-ok', icon: ShieldCheck, exit: 0 },
  failed: { label: 'Failed', tone: 'text-bad-fg', edge: 'border-l-bad', icon: ShieldX, exit: 1 },
  cannot_verify: { label: 'Cannot verify', tone: 'text-held-fg', edge: 'border-l-held', icon: ShieldQuestion, exit: 2 },
};

export function CheckIcon({ state }: { state: LineState }) {
  if (state === 'pass') return <span className="inline-flex h-5 w-5 items-center justify-center bg-ok-bg border border-ok/40 text-ok-fg shrink-0"><Check className="h-3 w-3" aria-hidden /><span className="sr-only">Passed</span></span>;
  if (state === 'fail') return <span className="inline-flex h-5 w-5 items-center justify-center bg-bad-bg border border-bad/40 text-bad-fg shrink-0"><X className="h-3 w-3" aria-hidden /><span className="sr-only">Failed</span></span>;
  if (state === 'warn') return <span className="inline-flex h-5 w-5 items-center justify-center bg-held-bg border border-held/50 text-held-fg shrink-0"><AlertTriangle className="h-3 w-3" aria-hidden /><span className="sr-only">Passed with a caveat</span></span>;
  return <span className="inline-flex h-5 w-5 items-center justify-center bg-sunken border border-line text-muted shrink-0"><Minus className="h-3 w-3" aria-hidden /><span className="sr-only">Not checked</span></span>;
}

const STATE_WORD: Record<LineState, string> = { pass: 'passed', fail: 'failed', warn: 'holds, with a caveat', skip: 'not checked' };

export function CheckList({ checks, inverse, grouped }: { checks: CheckLine[]; inverse?: boolean; grouped?: boolean }) {
  const groups = grouped && checks.some((c) => c.level === 'l2')
    ? [{ title: 'Sealed in a hash chain (L1)', items: checks.filter((c) => c.level !== 'l2') }, { title: 'Sealed and timestamped (L2 and above)', items: checks.filter((c) => c.level === 'l2') }]
    : [{ title: '', items: checks }];
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.title || 'all'}>
          {g.title && <p className="label mb-1.5">{g.title}</p>}
          <ul className={cn('divide-y border', inverse ? 'divide-ink-700 border-ink-700' : 'divide-line border-line')}>
            {g.items.map((c) => (
              <li key={c.label} className="flex items-start gap-3 px-3 py-2.5">
                <CheckIcon state={c.state} />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{c.label} <span className={cn('ml-1 text-xs font-normal', inverse ? 'text-ink-300' : 'text-muted')}>{STATE_WORD[c.state]}</span></p>
                  <p className={cn('text-xs leading-relaxed mt-0.5 break-words', inverse ? 'text-ink-300' : 'text-muted')}>{c.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function VerdictLine({ verdict, children, className }: { verdict: Verdict; children?: ReactNode; className?: string }) {
  const m = VERDICT_META[verdict];
  const Icon = m.icon;
  return (
    <div role="status" className={cn('flex items-start gap-3 border border-line border-l-[3px] bg-surface px-4 py-3', m.edge, className)}>
      <Icon className={cn('h-5 w-5 shrink-0 mt-0.5', m.tone)} aria-hidden />
      <div className="min-w-0">
        <p className={cn('font-display text-lg font-semibold', m.tone)}>{m.label} <span className="ml-2 font-mono text-xs font-normal text-muted">exit {m.exit}</span></p>
        {children && <div className="mt-0.5 text-sm text-muted">{children}</div>}
      </div>
    </div>
  );
}

/* ── Six result codes and the nine-section report ─────────── */

export const CODE_ORDER: VerifyCode[] = ['PASS', 'PASS_UNANCHORED_TAIL', 'PASS_KEY_FROM_BUNDLE', 'FAIL_INTEGRITY', 'FAIL_PROFILE', 'INCOMPLETE', 'UNSUPPORTED', 'USAGE'];

const CODE_MEANING: Record<VerifyCode, string> = {
  PASS: 'Everything checks, the key fingerprint was supplied and matches, nothing is unanchored.',
  PASS_UNANCHORED_TAIL: 'Passes; the newest sealed records are not yet in a timestamped batch.',
  PASS_KEY_FROM_BUNDLE: 'Passes, but the key came from the bundle itself. Supply the fingerprint you obtained directly.',
  PASS_L1_INTERNAL: 'Passes. L1 records only: internal evidence, sealed in a hash chain and not externally timestamped.',
  PASS_PAYLOAD_UNBOUND: 'Passes. An erasure destroyed a salt, so some payload hashes cannot be recomputed.',
  FAIL_INTEGRITY: 'A hash, link, signature, seal, Merkle root or timestamp does not verify.',
  FAIL_PROFILE: 'Integrity holds, but a rule of the verifier profile fails.',
  INCOMPLETE: 'Something needed to check is missing: a member, a seal or a key.',
  UNSUPPORTED: 'A format or profile this verifier does not know.',
  USAGE: 'The input is not a bundle, or an option is wrong.',
};

export function codeTone(code: VerifyCode): Tone {
  return code.startsWith('PASS') ? 'ok' : code === 'FAIL_INTEGRITY' ? 'bad' : code === 'FAIL_PROFILE' ? 'bad' : 'held';
}

export function CodeChip({ code, size = 'sm' }: { code: VerifyCode; size?: 'sm' | 'md' }) {
  const tone = codeTone(code);
  const Icon = code.startsWith('PASS') ? ShieldCheck : code.startsWith('FAIL') ? ShieldX : ShieldQuestion;
  return <StatusChip tone={tone} size={size} icon={<Icon className="h-3.5 w-3.5" aria-hidden />}><span className="font-mono">{code}</span><span className="text-muted font-normal">exit {EXIT_CODES[code]}</span></StatusChip>;
}

const SECTION_META: Record<VerifySection['state'], { tone: Tone; label: string; icon: ReactNode }> = {
  pass: { tone: 'ok', label: 'Pass', icon: <Check className="h-3 w-3" aria-hidden /> },
  fail: { tone: 'bad', label: 'Fail', icon: <X className="h-3 w-3" aria-hidden /> },
  warn: { tone: 'held', label: 'Pass with a caveat', icon: <AlertTriangle className="h-3 w-3" aria-hidden /> },
  not_applicable: { tone: 'neutral', label: 'Not applicable', icon: <Minus className="h-3 w-3" aria-hidden /> },
  incomplete: { tone: 'held', label: 'Incomplete', icon: <CircleDashed className="h-3 w-3" aria-hidden /> },
};

export function SectionChip({ state }: { state: VerifySection['state'] }) {
  const m = SECTION_META[state];
  return <StatusChip tone={m.tone} size="sm" icon={m.icon}>{m.label}</StatusChip>;
}

/** The report a person can download: the result as JSON. */
export function reportJson(result: SixCodeResult, meta: { orgName: string; source: string; profileName?: string }) {
  return JSON.stringify({ report: 'elan1.verify.report.v1', organisation: meta.orgName, source: meta.source, profile: meta.profileName ?? null, generated_at: new Date().toISOString(), ...result, chain: result.chain ? { ...result.chain, checks: undefined } : undefined }, null, 2);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** A print-ready page of the nine-section report; the browser's print dialog saves it as PDF. */
export function printReport(result: SixCodeResult, meta: { orgName: string; source: string; profileName?: string; manifest?: BundleManifest; profileChecked?: string }) {
  const w = window.open('', '_blank', 'noopener=no,width=900,height=1000');
  if (!w) return false;
  // the specification's nine sections, with each section's lines (the verifier's checks under Integrity)
  const rows = reportSections(result, meta.manifest, { profileChecked: meta.profileChecked }).map((s) => `<tr><td class="n">${s.n}</td><td><b>${esc(s.title)}</b><div class="d">${esc(s.text)}</div>${s.lines.length ? `<div class="d">${s.lines.map((l) => `${esc(l.label)}: ${esc(l.value)}`).join('<br>')}</div>` : ''}</td><td class="s">${s.state === 'info' ? '' : esc(SECTION_META[s.state].label)}</td></tr>`).join('');
  w.document.write(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Verification report — ${esc(meta.orgName)}</title>
<style>*{border-radius:0}body{font-family:'IBM Plex Sans',Arial,sans-serif;color:#141820;margin:32px;font-size:12px;line-height:1.5}h1{font-family:'Schibsted Grotesk',Arial,sans-serif;font-size:22px;margin:0 0 4px}
.k{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#5b6170}.code{font-family:'IBM Plex Mono',monospace;font-size:16px;font-weight:600;border:1px solid #141820;border-left:4px solid #141820;padding:8px 12px;margin:16px 0}
table{width:100%;border-collapse:collapse;margin-top:12px}td{border-top:1px solid #d9dbe0;padding:8px 6px;vertical-align:top}.n{width:24px;font-family:monospace}.s{width:130px;text-align:right;font-weight:600}.d{color:#3b4150;margin-top:2px}.f{color:#a3261c;margin-top:4px;font-family:monospace;font-size:11px}
.mono{font-family:'IBM Plex Mono',monospace}footer{margin-top:24px;border-top:1px solid #d9dbe0;padding-top:8px;color:#5b6170;font-size:10px}</style></head><body>
<p class="k">Elan1 Govern · verification report</p><h1>${esc(meta.orgName)}</h1><p>${esc(meta.source)}${meta.profileName ? ` · profile ${esc(meta.profileName)}` : ''} · ${esc(dateTime(new Date().toISOString()))}</p>
<div class="code">${result.code} · exit ${result.exitCode} — ${esc(result.label)}</div><p>${esc(result.headline)}</p>
<p class="k">Levels in this bundle</p><p>${result.levels.map((l) => `${LEVEL_INFO[l.level].label}: #${l.firstSeq}–#${l.lastSeq} (${l.count})`).map(esc).join('<br>')}</p>
<table>${rows}</table>
<footer>${esc(LEGAL_ENTITY)} · Draft — needs legal review</footer><script>window.onload=function(){window.print()}</script></body></html>`);
  w.document.close();
  return true;
}

/** The six-code result with its nine sections. */
export function SixCodeReport({ result, orgName, source, profileName, actions, manifest, profileChecked }: {
  result: SixCodeResult; orgName: string; source: string; profileName?: string; actions?: ReactNode;
  /** the bundle's manifest, so Claim shows the profile it claims (as on /verify) */
  manifest?: BundleManifest;
  /** the profile chosen to check ('none' for integrity only), shown as "Profile checked" (as on /verify) */
  profileChecked?: string;
}) {
  const [open, setOpen] = useState<number | null>(() => result.sections.find((s) => s.state === 'fail' || s.state === 'incomplete')?.number ?? null);
  // the specification's nine sections; the verifier's own checks are listed under Integrity, the profile's rules under Clause results
  const [spec, setSpec] = useState<Record<string, boolean>>(() => ({ verdict: false, integrity: result.sections.some((s) => s.id !== 'profile' && (s.state === 'fail' || s.state === 'incomplete')), clauses: result.code === 'FAIL_PROFILE', 'first-failure': result.exitCode !== 0 }));
  const integrityChecks = result.sections.filter((s) => s.id !== 'profile');
  const meta = { orgName, source, profileName, manifest, profileChecked };
  const tone = codeTone(result.code);
  return (
    <div className="space-y-4">
      <div role="status" className={cn('border border-line border-l-[4px] bg-surface px-4 py-3', tone === 'ok' ? 'border-l-ok' : tone === 'bad' ? 'border-l-bad' : 'border-l-held')}>
        <div className="flex flex-wrap items-center gap-2">
          <CodeChip code={result.code} size="md" />
          <span className="font-display text-lg font-semibold">{result.label}</span>
        </div>
        <p className="mt-1.5 text-sm">{result.headline}</p>
        {result.variants.length > 1 && <p className="mt-1 text-xs text-muted">Pass variants that also apply: {result.variants.map((v) => <span key={v} className="font-mono mr-2">{v}</span>)}</p>}
      </div>

      {result.levels.length > 0 && (
        <div className="grid gap-px bg-line border border-line sm:grid-cols-2">
          {result.levels.map((l) => (
            <div key={`${l.level}-${l.firstSeq}`} className="bg-surface p-3">
              <p className="label">{LEVEL_INFO[l.level].label}</p>
              <p className="mt-1 text-sm"><span className="font-display text-xl font-semibold num">{n(l.count)}</span> records <span className="font-mono text-xs text-muted">{seqLabel(l.firstSeq)}–{seqLabel(l.lastSeq)}</span></p>
              <p className="text-xs text-muted">{segmentPhrase({ level: l.level, count: l.count, firstSeq: l.firstSeq, lastSeq: l.lastSeq })}</p>
            </div>
          ))}
        </div>
      )}

      <ol className="border border-line divide-y divide-line" aria-label="Nine-section report">
        {reportSections(result, manifest, { profileChecked }).map((rs) => {
          const on = spec[rs.id] ?? false;
          const isIntegrity = rs.id === 'integrity';
          return (
            <li key={rs.id}>
              <button type="button" onClick={() => setSpec((o) => ({ ...o, [rs.id]: !on }))} aria-expanded={on} className="w-full grid grid-cols-[28px_1fr_auto] items-start gap-3 px-3 py-2.5 text-left hover:bg-sunken/50">
                <span className="font-mono text-xs text-muted pt-1">{rs.n}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{rs.title}</span>
                  <span className={cn('block text-xs text-muted mt-0.5', !on && 'line-clamp-1')}>{rs.text}</span>
                </span>
                {rs.state === 'info' ? <span className="text-xs text-muted pt-1">{(isIntegrity ? integrityChecks.length : rs.lines.length) ? (on ? 'Hide' : 'Show') : ''}</span> : <SectionChip state={rs.state} />}
              </button>
              {on && isIntegrity && (
                <ol className="mx-3 mb-3 ml-[52px] border border-line divide-y divide-line" aria-label="The verifier’s checks">
                  {integrityChecks.map((s) => {
                    const expanded = open === s.number;
                    return (
            <li key={s.id}>
              <button type="button" onClick={() => setOpen(expanded ? null : s.number)} aria-expanded={expanded} className="w-full grid grid-cols-[28px_1fr_auto] items-start gap-3 px-3 py-2.5 text-left hover:bg-sunken/50">
                <span className="font-mono text-xs text-muted pt-1">{s.number}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{s.title}</span>
                  <span className={cn('block text-xs text-muted mt-0.5', !expanded && 'line-clamp-1')}>{s.detail}</span>
                </span>
                <SectionChip state={s.state} />
              </button>
              {expanded && (s.facts?.length || s.firstFailure) && (
                <div className="px-3 pb-3 pl-[52px] space-y-2">
                  {s.facts && s.facts.length > 0 && (
                    <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2 text-xs">
                      {s.facts.map((f) => <div key={f.label} className="flex justify-between gap-3 border-b border-line py-1 min-w-0"><dt className="text-muted shrink-0">{f.label}</dt><dd className="font-mono text-right break-all">{f.value}</dd></div>)}
                    </dl>
                  )}
                  {s.firstFailure && (
                    <p className="text-xs border border-bad/40 bg-bad-bg px-2.5 py-2 text-fg">
                      <span className="font-semibold text-bad-fg">First failure{s.firstFailure.seq ? ` at ${seqLabel(s.firstFailure.seq)}` : ''}:</span> <span className="font-mono">{s.firstFailure.field}</span> — expected <span className="font-mono">{s.firstFailure.expected}</span>, found <span className="font-mono">{s.firstFailure.found}</span>
                    </p>
                  )}
                </div>
              )}
            </li>
                    );
                  })}
                </ol>
              )}
              {on && !isIntegrity && rs.lines.length > 0 && (
                <dl className="mx-3 mb-3 ml-[52px] border border-line divide-y divide-line text-xs">
                  {rs.lines.map((l, i) => (
                    <div key={i} className="grid gap-1 px-3 py-1.5 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)] sm:gap-4">
                      <dt className="text-muted">{l.label}</dt>
                      <dd className={cn('min-w-0 break-words', /digest|command/i.test(l.label) && 'font-mono break-all')}>{l.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ol>

      <div className="grid gap-px bg-line border border-line sm:grid-cols-4 text-sm">
        <div className="bg-surface p-3"><p className="label">Records</p><p className="mt-1 font-display text-xl font-semibold num">{n(result.counts.receipts)}</p></div>
        <div className="bg-surface p-3"><p className="label">Sealed</p><p className="mt-1 font-display text-xl font-semibold num">{n(result.counts.seals)}</p></div>
        <div className="bg-surface p-3"><p className="label">Timestamp tokens</p><p className="mt-1 font-display text-xl font-semibold num">{n(result.counts.tokens)}</p><p className="text-xs text-muted">{n(result.counts.batches)} batches</p></div>
        <div className="bg-surface p-3"><p className="label">Time taken</p><p className="mt-1 font-display text-xl font-semibold num">{(result.ms / 1000).toFixed(1)}<span className="text-sm text-muted font-normal"> s</span></p></div>
      </div>

      <div className="border border-line bg-sunken/40 px-3 py-2.5">
        <p className="label mb-1">Reproduce offline</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-[12.5px] break-all">{result.reproduction.command}</code>
          <CopyButton text={result.reproduction.command} compact label="Copy command" />
        </div>
        <p className="mt-1 text-xs text-muted">{result.reproduction.verifierVersion}{result.fingerprint && <> · head key <span className="font-mono">{result.fingerprint}</span> ({result.keySource === 'supplied' ? 'fingerprint supplied' : 'key from the bundle'})</>}</p>
      </div>

      <p className="text-xs text-muted leading-relaxed">{result.limits}</p>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadText(`verification-report-${slugify(orgName)}-${new Date().toISOString().slice(0, 10)}.json`, reportJson(result, meta))}>Download report (JSON)</Button>
        <Button size="sm" variant="ghost" icon={<Printer className="h-3.5 w-3.5" />} onClick={() => printReport(result, meta)}>Print or save as PDF</Button>
        {actions}
      </div>
    </div>
  );
}

/** All six codes with their exit codes; the current one is marked. */
export function CodeLegend({ current }: { current?: VerifyCode }) {
  return (
    <ul className="border border-line divide-y divide-line text-xs">
      {CODE_ORDER.map((c) => (
        <li key={c} className={cn('grid grid-cols-[minmax(0,180px)_44px_1fr] gap-2 px-3 py-1.5 items-baseline', c === current && 'bg-sunken shadow-[inset_3px_0_0_rgb(var(--fg))]')}>
          <span className="font-mono font-medium truncate" title={CODE_LABELS[c]}>{c}</span>
          <span className="font-mono text-muted">exit {EXIT_CODES[c]}</span>
          <span className="text-muted">{CODE_MEANING[c]}</span>
        </li>
      ))}
    </ul>
  );
}

/* ── Whole-chain verifier ─────────────────────────────────── */

/**
 * Verifies this browser's copy of the organisation's chain. L1: the three-valued check (verified, failed,
 * cannot verify; exit 0/1/2). L2 and above: the six-code verifier with a profile and the nine-section report,
 * plus the quick three-valued check.
 */
export function ChainVerifier({ compact }: { compact?: boolean }) {
  const orgId = useOrgId();
  const level = useOrgLevel();
  const l2 = levelRank(level) >= 1;
  const [mode, setMode] = useState<'six' | 'quick'>(l2 ? 'six' : 'quick');
  useEffect(() => setMode(l2 ? 'six' : 'quick'), [l2, orgId]);
  return (
    <div className="space-y-4">
      {l2 && (
        <div className="max-w-full overflow-x-auto">
          <Segmented<'six' | 'quick'> label="Verifier" value={mode} onChange={setMode} options={[{ value: 'six', label: 'Six result codes · nine sections' }, { value: 'quick', label: 'Quick chain check' }]} />
        </div>
      )}
      {mode === 'six' && l2 ? <SixCodeRunner key={orgId} orgId={orgId} /> : <QuickChainCheck key={orgId} orgId={orgId} compact={compact} />}
      {!l2 && !compact && (
        <UpgradeHint to="l2" title="Six result codes, a nine-section report and verifier profiles start at L2 Attested."
          preview={<CodeLegend />}>
          From L2 every record is sealed and timestamped by two authorities, and the verifier reports one of six codes (PASS with three variants, FAIL_INTEGRITY, FAIL_PROFILE, INCOMPLETE, UNSUPPORTED, USAGE) against a profile such as the MCA audit trail or the EU AI Act. Records written at L1 keep verifying exactly as they do here.
        </UpgradeHint>
      )}
    </div>
  );
}

function QuickChainCheck({ orgId, compact }: { orgId: string; compact?: boolean }) {
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const signedLevel = levelRank(useOrgLevel()) >= 1;
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [at, setAt] = useState<number>();
  const [report, setReport] = useState<ChainVerification>();
  const [claim, setClaim] = useState<string>(CLAIM_L1);
  const [err, setErr] = useState<string>();
  const signal = useRef({ cancelled: false });

  const run = async () => {
    signal.current = { cancelled: false };
    setRunning(true); setReport(undefined); setProgress(0); setErr(undefined);
    try {
      const [ev, state] = await Promise.all([api.evidence(orgId), api.level(orgId)]);
      const slice = api.chainSlice(orgId);
      const rep = await verifyChainProgressive(slice.receipts, { ...slice.publicKeys }, slice.checkpoints, ev.signingKeys, (f, s) => { setProgress(f); if (s) setAt(s); }, signal.current, { history: state.history, current: state.level });
      setClaim(claimForChain(state));
      setReport(rep);
    } catch (e) {
      if ((e as Error).message !== 'cancelled') setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={<ShieldCheck className="h-4 w-4" />} onClick={run} loading={running} disabled={running}>
          {report ? 'Verify again' : 'Verify the whole chain in this browser'}
        </Button>
        {running && <Button variant="ghost" onClick={() => { signal.current.cancelled = true; }}>Cancel</Button>}
        {!compact && !running && !report && <span className="text-sm text-muted">Recomputes every hash and {signedLevel ? 'signature' : 'Ed25519 seal'} here. Nothing is sent to Elan1 Govern.</span>}
      </div>
      {err && <Banner tone="bad" title="The chain could not be checked">{err}</Banner>}
      {running && (
        <div aria-live="polite" className="space-y-1.5">
          <Meter value={progress} label="Verification progress" />
          <p className="text-xs text-muted num">{Math.round(progress * 100)}% · checking {at ? seqLabel(at) : 'receipts'}</p>
        </div>
      )}
      {report && (
        <div className="space-y-3">
          <VerdictLine verdict={report.verdict}>
            {report.verdict === 'verified' && <>Chain intact: {n(report.receipts)} receipts, {seqLabel(report.firstSeq ?? 0)}–{seqLabel(report.lastSeq ?? 0)}, {n(report.checkpoints.valid)} {signedLevel ? 'signed' : 'sealed'} checkpoints. {claim}</>}
            {report.verdict === 'failed' && <>{report.brokenAt !== undefined ? <>First broken receipt: <span className="font-mono">{seqLabel(report.brokenAt)}</span>. {report.brokenReason}</> : 'A checkpoint does not verify or does not match the chain.'}</>}
            {report.verdict === 'cannot_verify' && <>{report.receipts ? `Keys missing from the key set: ${report.missingKeys.join(', ')}.` : 'There are no receipts to check.'}</>}
          </VerdictLine>
          {report.segments.length > 1 && (
            <div className="border border-line bg-surface p-3 text-sm">
              <p className="label mb-1.5">Split at the level boundary</p>
              <ul className="space-y-1">
                {report.segments.map((s, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2"><span className="font-display font-semibold num">{n(s.count)}</span><span>receipts {i === 0 ? 'before the boundary' : 'after the boundary'}</span><span className="font-mono text-xs text-muted">{seqLabel(s.firstSeq)}–{seqLabel(s.lastSeq)}</span><span className="text-muted">({segmentPhrase(s)})</span></li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-muted">This quick check covers what every level shares: the Ed25519 check, hashes, links and checkpoints. Use the six-code verifier for seals and timestamps.</p>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-line border border-line">
            <div className="bg-surface p-3"><p className="label">Receipts checked</p><p className="mt-1 font-display text-2xl font-semibold num">{n(report.receipts)}</p></div>
            <div className="bg-surface p-3"><p className="label">Checkpoints</p><p className="mt-1 font-display text-2xl font-semibold num">{n(report.checkpoints.valid)}<span className="text-sm text-muted font-normal"> / {n(report.checkpoints.total)}</span></p></div>
            <div className="bg-surface p-3"><p className="label">Range</p><p className="mt-1 font-mono text-sm">{seqLabel(report.firstSeq ?? 0)}–{seqLabel(report.lastSeq ?? 0)}</p></div>
            <div className="bg-surface p-3"><p className="label">Time taken</p><p className="mt-1 font-display text-2xl font-semibold num">{(report.ms / 1000).toFixed(1)}<span className="text-sm text-muted font-normal"> s</span></p></div>
          </div>
          <CheckList checks={report.summary} />
        </div>
      )}
    </div>
  );
}

/** The six-code verifier over the organisation's records, with a verifier profile and an optional fingerprint. */
export function SixCodeRunner({ orgId, from, to, onResult, compactIntro }: { orgId: string; from?: number; to?: number; onResult?: (r: SixCodeResult, profileId: string) => void; compactIntro?: boolean }) {
  const profiles = useQuery((o) => api.profiles(o), [], { live: false });
  const custody = useQuery((o) => api.custody(o), [], { kinds: ['key'] });
  const enabled = useMemo(() => (profiles.data ?? []).filter((p) => p.enabled), [profiles.data]);
  const [profileId, setProfileId] = useState<string>('');
  useEffect(() => {
    if (profileId || !enabled.length) return;
    setProfileId(enabled.find((p) => p.viaPack)?.id ?? 'none');
  }, [enabled, profileId]);
  const [fp, setFp] = useState('');
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<{ f: number; label: string }>({ f: 0, label: '' });
  const [result, setResult] = useState<{ res: SixCodeResult; orgName: string; profileName?: string; range: string; manifest?: BundleManifest; profileChecked: string }>();
  const [err, setErr] = useState<string>();
  const signal = useRef({ cancelled: false });
  const fpInvalid = fp.trim() !== '' && !/^[0-9a-f]{16}$/i.test(fp.trim());

  const run = async () => {
    signal.current = { cancelled: false };
    setRunning(true); setErr(undefined); setResult(undefined); setStage({ f: 0, label: 'Starting' });
    try {
      const w = await buildWorkingBundle(orgId, { from, to, signal: signal.current, onProgress: (f, label) => setStage({ f, label }) });
      setStage({ f: 0.8, label: `Checking nine sections over ${n(w.range.count)} records — about ${Math.max(1, Math.round(w.range.count / 180))} s` });
      await new Promise((res) => window.setTimeout(res, 30));
      const res = await runSixCode(w, { profileId, expectedFingerprint: fp });
      setStage({ f: 1, label: 'Done' });
      const p = enabled.find((x) => x.id === profileId);
      setResult({ res, orgName: w.orgName, profileName: p ? `${p.name} v${p.version}` : undefined, range: `${seqLabel(w.range.first)}–${seqLabel(w.range.last)}`, manifest: w.bundle.manifest, profileChecked: profileId || 'none' });
      onResult?.(res, profileId);
    } catch (e) {
      if ((e as Error).message !== 'cancelled') setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      {!compactIntro && <p className="text-sm text-muted">Assembles an evidence bundle from this organisation’s records — receipts, Seal v6 records, Merkle batches with both timestamp tokens, checkpoints and keys — and runs the same verifier as <span className="font-mono">govern verify</span>. Nothing is recorded or sent.</p>}
      <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Verifier profile" htmlFor={`vp-${orgId}`} hint={profiles.error ? profiles.error.message : 'The regime the records are checked against, as well as integrity.'}>
          <Select id={`vp-${orgId}`} value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={running || profiles.loading}>
            <option value="none">No profile — integrity only</option>
            {enabled.map((p) => <option key={p.id} value={p.id}>{p.name} v{p.version}{p.viaPack ? ' (pack installed)' : ''}</option>)}
          </Select>
        </Field>
        <Field label="Key fingerprint obtained directly" htmlFor={`fp-${orgId}`} error={fpInvalid ? 'Enter 16 hexadecimal characters.' : undefined}
          hint={!fpInvalid ? 'Without it the best result is PASS_KEY_FROM_BUNDLE.' : undefined}
          aside={custody.data && <button type="button" className="text-xs text-muted hover:text-fg underline underline-offset-2" onClick={() => setFp(custody.data!.fingerprint)}>Use the one on record</button>}>
          <Input id={`fp-${orgId}`} mono value={fp} onChange={(e) => setFp(e.target.value)} placeholder="16 hex characters" leading={<Fingerprint className="h-4 w-4" aria-hidden />} invalid={fpInvalid} disabled={running} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={<ShieldCheck className="h-4 w-4" />} onClick={run} loading={running} disabled={running || fpInvalid}>{result ? 'Run again' : `Verify ${from || to ? 'this range' : 'the whole chain'}`}</Button>
        {running && <Button variant="ghost" onClick={() => { signal.current.cancelled = true; }}>Cancel</Button>}
      </div>
      {running && (
        <div aria-live="polite" className="space-y-1.5">
          <Meter value={stage.f} label="Verification progress" />
          <p className="flex items-center gap-2 text-xs text-muted num">{stage.f >= 0.8 && stage.f < 1 && <Spinner className="h-3.5 w-3.5" />}{Math.round(stage.f * 100)}% · {stage.label}</p>
        </div>
      )}
      {err && <Banner tone="bad" title="The bundle could not be verified">{err}</Banner>}
      {result && (
        <SixCodeReport result={result.res} orgName={result.orgName} source={`Working copy ${result.range}, assembled in the console`} profileName={result.profileName} manifest={result.manifest} profileChecked={result.profileChecked}
          actions={<Badge tone="neutral">Not recorded on the chain</Badge>} />
      )}
    </div>
  );
}
