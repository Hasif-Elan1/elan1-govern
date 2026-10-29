import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Play, RotateCcw, Timer } from 'lucide-react';
import { db, api } from '@/api';
import { canonical, sha256Hex } from '@/lib/crypto';
import { cn } from '@/lib/cn';
import { seqLabel } from '@/lib/format';
import { toolByName } from '@/mock/catalog';
import type { Decision } from '@/types';
import { Badge, Button, CodeBlock, DecisionChip, Field, Input, JsonView, Select, Textarea, toast } from '@/components/ui';
import { useOrgId, useUser } from '@/store/session';
import { DEPRECATIONS, deprecationHeaders } from '@/mock/devpathData';
import { OPENAPI } from './openapi';
import { BASE, TEST_KEY } from './docs';

const ORG = 'org_demo';
const AGENT = 'invoice-bot';
/** A key with the prefix used before 28 Oct 2026: still accepted until its Sunset date, with deprecation headers. */
const LEGACY_KEY = 'eg_test_7Kq2mV9xR4tB1nP8'; // gitleaks:allow made-up sample key shown in the developer docs
const LEGACY = DEPRECATIONS.find((d) => d.id === 'eg-key-prefixes')!;

/**
 * Where "open this rulebook" goes for the person reading: the signed-in organisation's own rulebook for its
 * invoice agent (its slug differs per organisation), or the demo's when nobody is signed in.
 */
function useRulebookLink(): { to: string; label: string; signedIn: boolean } {
  const user = useUser();
  const orgId = useOrgId();
  if (!user || !orgId) return { to: `/rulebooks/${AGENT}`, label: 'open this rulebook', signedIn: false };
  try {
    const d = db.getDB(orgId);
    const agent = d.agents.find((a) => a.scenarioKey === AGENT);
    const slug = agent ? d.rulebooks.find((r) => r.id === agent.rulebookId)?.slug : undefined;
    return slug ? { to: `/rulebooks/${slug}`, label: `open your ${slug} rulebook`, signedIn: true } : { to: '/rulebooks', label: 'open your rulebooks', signedIn: true };
  } catch {
    return { to: '/rulebooks', label: 'open your rulebooks', signedIn: true };
  }
}

interface Res { status: number; text: string; headers: Record<string, string>; body: unknown; ms: number }

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
const latency = () => sleep(120 + Math.random() * 220);
const reqId = () => `req_${Math.random().toString(36).slice(2, 12)}`;

interface SandboxAsk { id: string; seq: number; group?: string; expires: string; status: 'pending' | 'approved' | 'rejected'; decidedAt?: string; resultSeq?: number }

/** Shared across the panels on this page so a check, a record, a decision and a poll tell one story. */
const session = {
  nextSeq: 0, recorded: new Set<number>(), allowed: [] as number[], asks: [] as SandboxAsk[], remaining: 300,
  /** the reader chose the legacy eg_test_ key: every response carries the deprecation headers */
  legacy: false,
  /** quota use per rule in this sandbox session: { count, sum, since } */
  quota: {} as Record<string, { count: number; sum: number; since: number }>,
};

/** Decide a sandbox approval as its approver group would. An approved ask becomes recordable. */
function decideSandbox(id: string, approve: boolean) {
  const a = session.asks.find((x) => x.id === id);
  if (!a || a.status !== 'pending') return a;
  a.status = approve ? 'approved' : 'rejected';
  a.decidedAt = new Date().toISOString();
  a.resultSeq = headSeq();
  if (approve) session.allowed.unshift(a.seq);
  return a;
}

/** Wait up to `seconds`, returning as soon as the sandbox approval is decided. Reports the real wait. */
async function waitForSandbox(id: string, seconds: number, onTick?: (left: number) => void) {
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const a = session.asks.find((x) => x.id === id);
    if (!a || a.status !== 'pending') break;
    onTick?.(Math.ceil(seconds - (Date.now() - t0) / 1000));
    await sleep(250);
  }
  return Math.round((Date.now() - t0) / 100) / 10;
}

const WINDOW_MS: Record<string, number> = { day: 864e5, '1h': 3.6e6, '30m': 18e5, '7d': 7 * 864e5 };

function headSeq() {
  const d = db.getDB(ORG);
  if (!session.nextSeq) session.nextSeq = d.receipts[d.receipts.length - 1].seq + 1;
  return session.nextSeq++;
}

function rateHeaders(): Record<string, string> {
  session.remaining = Math.max(0, session.remaining - 1);
  return { 'content-type': 'application/json', 'x-request-id': reqId(), 'ratelimit-limit': '300', 'ratelimit-remaining': String(session.remaining), ...(session.legacy ? deprecationHeaders(LEGACY) : {}) };
}

const keyInUse = () => (session.legacy ? LEGACY_KEY : TEST_KEY);

function TryShell({ title, curl, form, onSend, res, sending, onReset, footnote }: {
  title: string; curl: string; form?: ReactNode; onSend: () => void; res?: Res; sending: boolean; onReset?: () => void; footnote?: ReactNode;
}) {
  const ok = res && res.status < 300;
  return (
    <section aria-label={`Try ${title}`} className="my-6 border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-sunken/50 px-4 py-2.5">
        <p className="flex items-center gap-2 text-sm font-semibold"><Play className="h-3.5 w-3.5" aria-hidden />Try it <span className="font-normal text-muted">· {title}</span></p>
        <span className="text-xs text-muted">Sandbox · runs in your browser against the demo organisation</span>
      </div>
      <div className="space-y-4 p-4">
        {form}
        <CodeBlock code={curl} title="Request" />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" icon={<Play className="h-3.5 w-3.5" />} loading={sending} onClick={onSend}>Send request</Button>
          {res && onReset && <Button variant="ghost" size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onReset}>Clear</Button>}
        </div>
        {res && (
          <div className="border border-line" aria-live="polite">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-2 text-xs">
              <span className={cn('inline-flex h-6 items-center border px-2 font-mono font-semibold', ok ? 'border-ok/40 bg-ok-bg text-ok-fg' : res.status === 409 || res.status === 404 ? 'border-held/50 bg-held-bg text-held-fg' : 'border-bad/40 bg-bad-bg text-bad-fg')}>
                {res.status} {res.text}
              </span>
              <span className="inline-flex items-center gap-1 text-muted"><Timer className="h-3 w-3" aria-hidden />{res.ms} ms</span>
              <span className="hidden sm:flex flex-wrap gap-x-3 font-mono text-[11.5px] text-muted">
                {Object.entries(res.headers).filter(([k]) => k !== 'content-type').map(([k, v]) => <span key={k}>{k}: {v}</span>)}
              </span>
            </div>
            <JsonView value={res.body} className="border-0" maxHeight={420} />
          </div>
        )}
        {footnote && <p className="text-xs text-muted leading-relaxed">{footnote}</p>}
      </div>
    </section>
  );
}

/* ── POST /v1/check ───────────────────────────────────────── */

const PRESETS: { label: string; tool: string; args: Record<string, unknown> }[] = [
  { label: 'Pay an approved vendor ₹42,000', tool: 'zoho_books.record_payment', args: { vendor: 'Northwind Traders', amount: 42000, bill: 'BILL-2026-0412', mode: 'NEFT' } },
  { label: 'Pay ₹2,40,000 — over the line', tool: 'zoho_books.record_payment', args: { vendor: 'Kalyani Metals', amount: 240000, bill: 'BILL-2026-0419', mode: 'RTGS' } },
  { label: 'Email a vendor domain', tool: 'gmail.send_email', args: { to: 'accounts@northwind.in', subject: 'Remittance advice' } },
  { label: 'Email an unknown domain', tool: 'gmail.send_email', args: { to: 'billing@unknown-supplier.com', subject: 'Bank details' } },
  { label: 'Delete a bill', tool: 'zoho_books.delete_bill', args: { bill: 'BILL-2026-0398' } },
  { label: 'A tool this agent does not have', tool: 'bank.initiate_transfer', args: { to_account: 'ICICI-FD-1180', amount: 100000 } },
  { label: 'Amount that is not a number', tool: 'zoho_books.record_payment', args: { vendor: 'Northwind Traders', amount: 'forty thousand' } },
];

export function CheckTry() {
  const d = db.getDB(ORG);
  const agent = d.agents.find((a) => a.slug === AGENT);
  const rb = d.rulebooks.find((r) => r.slug === AGENT);
  const version = rb?.versions.find((v) => v.version === rb.currentVersion && v.status === 'published') ?? rb?.versions.filter((v) => v.status === 'published').slice(-1)[0];
  const tools = useMemo(() => Array.from(new Set([...(agent?.tools ?? []), 'zoho_books.delete_bill', 'bank.initiate_transfer'])), [agent]);
  const [tool, setTool] = useState(PRESETS[0].tool);
  const [args, setArgs] = useState(JSON.stringify(PRESETS[0].args, null, 2));
  const [res, setRes] = useState<Res>();
  const [trace, setTrace] = useState<{ id: string; decide: Decision; outcome: string }[]>();
  const [sending, setSending] = useState(false);
  const [argErr, setArgErr] = useState<string>();
  const [poll, setPoll] = useState<Res>();
  const [legacy, setLegacy] = useState(session.legacy);
  const rbLink = useRulebookLink();

  const body = (() => { try { return JSON.stringify({ tool, args: JSON.parse(args) }); } catch { return `{"tool": "${tool}", "args": ${args.replace(/\s+/g, ' ')}}`; } })();
  const curl = `curl -X POST ${BASE}/v1/check \\\n  -H "Authorization: Bearer ${legacy ? LEGACY_KEY : TEST_KEY}" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;

  const send = async () => {
    setSending(true); setPoll(undefined);
    const t0 = performance.now();
    await latency();
    let parsed: Record<string, unknown>;
    try {
      const v = JSON.parse(args);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('args must be an object');
      parsed = v;
      setArgErr(undefined);
    } catch {
      setArgErr('args is not a JSON object.');
      setRes({ status: 400, text: 'Bad Request', headers: rateHeaders(), body: { error: 'invalid_request', message: 'The body must be JSON with "tool" (string) and "args" (object). No receipt was written.' }, ms: Math.round(performance.now() - t0) });
      setTrace(undefined); setSending(false);
      return;
    }
    const seq = headSeq();
    const rulebook = version ? { version: version.version, hash: version.hash } : undefined;
    let decision: Decision; let ruleId: string; let reason: string;
    let tr: { id: string; decide: Decision; outcome: string }[] | undefined;
    const def = toolByName(tool);
    const needsAmount = def?.tags.includes('moves_money') || tool === 'zoho_books.create_bill';
    if (!agent || agent.status !== 'active') {
      decision = 'refuse'; ruleId = 'agent-paused'; reason = 'This agent is paused. Every call is refused until it is resumed.';
    } else if (!version) {
      decision = 'refuse'; ruleId = 'no-rulebook'; reason = 'This agent has no published rulebook.';
    } else if (!tools.includes(tool) || !agent.tools.includes(tool) && tool !== 'zoho_books.delete_bill') {
      decision = 'refuse'; ruleId = 'default'; reason = `${tool} is not a tool this agent may call. Anything not explicitly allowed is refused.`;
    } else if (needsAmount && (typeof parsed.amount !== 'number' || !Number.isFinite(parsed.amount))) {
      decision = 'refuse'; ruleId = 'invalid-arguments'; reason = 'amount must be a number. Arguments are checked against the tool schema before any rule.';
    } else {
      const e = api.tryAction(version.rules, tool, parsed);
      decision = e.decision; ruleId = e.ruleId; reason = e.reason;
      tr = e.matched.map((m) => ({ id: m.rule.id, decide: m.rule.decide, outcome: m.outcome }));
    }
    // Quotas are counted for this sandbox session: limits only tighten (allow → ask, or refuse without an approver group).
    let quotaOut: Record<string, unknown> | undefined;
    const qRule = version?.rules.find((r) => r.id === ruleId);
    if (decision === 'allow' && qRule?.quota) {
      const q = qRule.quota;
      const win = WINDOW_MS[q.window] ?? 864e5;
      const prev = session.quota[qRule.id];
      const u = prev && Date.now() - prev.since < win ? prev : { count: 0, sum: 0, since: Date.now() };
      const add = q.kind === 'max_sum' ? Number(parsed[q.field ?? 'amount']) || 0 : 1;
      const used = q.kind === 'max_count' ? u.count : u.sum;
      if (used + add > q.limit) {
        decision = qRule.approver ? 'ask' : 'refuse';
        reason = `${reason} Over the ${q.kind === 'max_count' ? `limit of ${q.limit} calls` : `limit of ${q.limit.toLocaleString('en-IN')} in ${q.field ?? 'amount'}`} per ${q.window} (${used.toLocaleString('en-IN')} used in this sandbox session).`;
        quotaOut = { rule: qRule.id, kind: q.kind, limit: q.limit, window: q.window, used, exceeded: true };
      } else {
        if (q.kind === 'max_count') u.count++; else u.sum += add;
        session.quota[qRule.id] = u;
        quotaOut = { rule: qRule.id, kind: q.kind, limit: q.limit, window: q.window, used: used + add, exceeded: false };
      }
    }
    const receiptBody = { seq, org: ORG, kind: 'decision', agent: AGENT, tool, rule_id: ruleId, decision, reason, rulebook, ts: new Date().toISOString() };
    const receipt = { seq, hash: sha256Hex(canonical(receiptBody)) };
    const out: Record<string, unknown> = { decision, rule_id: ruleId, reason, mode: 'check_and_record', receipt, rulebook, ...(quotaOut ? { quota: quotaOut } : {}) };
    if (decision === 'allow') {
      out.next = 'Run the call yourself, then POST /v1/record with the outcome.';
      session.allowed.unshift(seq);
    }
    if (decision === 'ask') {
      const rule = version?.rules.find((r) => r.id === ruleId);
      const id = `apr_${Math.random().toString(36).slice(2, 10)}`;
      const expires = new Date(Date.now() + 24 * 3.6e6).toISOString();
      out.approval = { id, status: 'pending', approver_group: rule?.approver ?? 'owners', expires_at: expires, poll_url: `/v1/approvals/${id}?wait=30` };
      out.next = 'Do not run the call. Poll the approval; run it only if it comes back approved, then record the outcome.';
      session.asks.unshift({ id, seq, group: rule?.approver ?? 'owners', expires, status: 'pending' });
    }
    if (decision === 'refuse') out.next = 'Do not run the call. Tell the user the reason; the refusal is recorded.';
    setRes({ status: 200, text: 'OK', headers: rateHeaders(), body: out, ms: Math.round(performance.now() - t0) });
    setTrace(tr);
    setSending(false);
    toast.info(`${decision === 'allow' ? 'Allowed' : decision === 'ask' ? 'Asked a person' : 'Refused'} · ${ruleId}`, `Receipt ${seqLabel(seq)} in the sandbox response. Nothing was written to the demo chain.`);
  };

  const [polling, setPolling] = useState<number>();
  const [, rerender] = useState(0);
  const askId = res ? (res.body as { approval?: { id: string } }).approval?.id : undefined;
  const ask = askId ? session.asks.find((x) => x.id === askId) : undefined;

  const pollNow = async () => {
    const a = res && (res.body as { approval?: { id: string; expires_at: string; approver_group: string } }).approval;
    if (!a) return;
    const t0 = performance.now();
    const WAIT = 10;
    setPolling(WAIT);
    const waited = await waitForSandbox(a.id, WAIT, (left) => setPolling(left));
    setPolling(undefined);
    const s = session.asks.find((x) => x.id === a.id);
    const decided = s && s.status !== 'pending';
    setPoll({
      status: 200, text: 'OK', headers: rateHeaders(), ms: Math.round(performance.now() - t0),
      body: {
        id: a.id, status: s?.status ?? 'pending', approver_group: a.approver_group, expires_at: a.expires_at, waited_s: waited, receipt_seq: (res!.body as { receipt: { seq: number } }).receipt.seq,
        ...(decided ? { decided_at: s!.decidedAt, channel: 'web', result_seq: s!.resultSeq, next: s!.status === 'approved' ? 'Run the call now, then POST /v1/record with this receipt_seq.' : 'Do not run the call. The rejection is recorded.' } : { note: `Still pending after waiting ${waited} s. Poll again, or listen for the approval.resolved webhook.` }),
      },
    });
  };

  const decideNow = (approve: boolean) => {
    if (!askId) return;
    decideSandbox(askId, approve);
    rerender((x) => x + 1);
    toast.info(approve ? 'Approved in the sandbox' : 'Rejected in the sandbox', approve ? 'A waiting poll returns at once; the decision is now recordable.' : 'A waiting poll returns at once with rejected.');
  };

  return (
    <TryShell
      title="POST /v1/check"
      curl={curl}
      res={res}
      sending={sending}
      onSend={send}
      onReset={() => { setRes(undefined); setTrace(undefined); setPoll(undefined); }}
      footnote={<>Decided by the published <span className="font-mono">{AGENT}</span> rulebook{version ? <> (version {version.version}, <span className="font-mono">{version.hash.slice(0, 12)}…</span>)</> : null} from the demo organisation, with the same decision function the service uses. Quotas are counted for this sandbox session — send the small payment a few times to cross the daily cap. {rbLink.signedIn ? <><Link to={rbLink.to} className="link">{rbLink.label[0].toUpperCase() + rbLink.label.slice(1)}</Link> in your organisation.</> : <>Sign in as the demo admin to <Link to={rbLink.to} className="link">{rbLink.label}</Link>.</>}{legacy && <> The legacy key is accepted until {LEGACY.sunset}; see the <Link to="/developers/changelog#deprecation" className="link">Deprecation and Sunset headers</Link>.</>}</>}
      form={
        <div className="space-y-4">
          <div>
            <p className="label mb-2">Examples</p>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button key={p.label} type="button" onClick={() => { setTool(p.tool); setArgs(JSON.stringify(p.args, null, 2)); setArgErr(undefined); }}
                  className={cn('h-7 border px-2 text-xs transition-colors', p.tool === tool && JSON.stringify(p.args, null, 2) === args ? 'border-fg bg-fg text-canvas' : 'border-line bg-surface text-muted hover:border-line-strong hover:text-fg')}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
            <Field label="Agent key" htmlFor="try-key" hint={legacy ? 'An eg_test_ key: deprecated, so the response carries Deprecation, Sunset and Link headers.' : 'A sandbox key for the demo invoice-bot.'}>
              <Select id="try-key" value={legacy ? 'legacy' : 'sandbox'} className="font-mono text-sm" onChange={(e) => { const v = e.target.value === 'legacy'; session.legacy = v; setLegacy(v); }}>
                <option value="sandbox">{TEST_KEY}</option>
                <option value="legacy">{LEGACY_KEY} (deprecated prefix)</option>
              </Select>
            </Field>
            <Field label="tool" htmlFor="try-tool">
              <Select id="try-tool" value={tool} onChange={(e) => setTool(e.target.value)} className="font-mono text-sm">
                {tools.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="args" htmlFor="try-args" error={argErr}>
            <Textarea id="try-args" value={args} onChange={(e) => setArgs(e.target.value)} rows={6} spellCheck={false} className="font-mono text-[12.5px]" invalid={!!argErr} />
          </Field>
          {res && trace && (
            <div className="border border-line">
              <p className="label border-b border-line bg-sunken/50 px-3 py-2">Why — every rule, in order (strictest match wins)</p>
              <ul className="divide-y divide-line">
                {trace.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className="w-36 shrink-0 font-mono text-[12.5px]">{t.id}</span>
                    <DecisionChip decision={t.decide} size="sm" short />
                    <span className={cn('text-xs', t.outcome === 'matched' ? 'font-semibold text-fg' : 'text-muted')}>
                      {t.outcome === 'matched' ? 'Matched' : t.outcome === 'conditions_failed' ? 'Conditions not met' : t.outcome === 'unknown_field' ? 'A field it checks is missing' : 'Does not apply to this tool'}
                    </span>
                    {(res.body as { rule_id?: string }).rule_id === t.id && <Badge tone="inverse">Decided</Badge>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {res && (res.body as { decision?: string }).decision === 'ask' && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" loading={polling !== undefined} icon={<Timer className="h-3.5 w-3.5" />} onClick={pollNow}>Poll GET /v1/approvals/{askId}?wait=10</Button>
                {polling !== undefined && <span className="text-xs text-muted num" aria-live="polite">Waiting… up to {polling} s more</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2 border border-dashed border-line-strong/70 bg-sunken/40 px-3 py-2">
                <span className="text-xs text-muted">Act as the <span className="font-mono">{ask?.group}</span> approver in the sandbox:</span>
                {ask?.status === 'pending' ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => decideNow(true)}>Approve</Button>
                    <Button size="sm" variant="ghost" onClick={() => decideNow(false)}>Reject</Button>
                  </>
                ) : <Badge tone={ask?.status === 'approved' ? 'ok' : 'bad'}>{ask?.status === 'approved' ? 'Approved' : 'Rejected'}</Badge>}
              </div>
              {poll && <JsonView value={poll.body} maxHeight={260} />}
            </div>
          )}
        </div>
      }
    />
  );
}

/* ── POST /v1/record ──────────────────────────────────────── */

export function RecordTry() {
  const [seq, setSeq] = useState(() => String(session.allowed[0] ?? ''));
  const [status, setStatus] = useState<'ok' | 'error'>('ok');
  const [ref, setRef] = useState('zoho:pay_884120');
  const [res, setRes] = useState<Res>();
  const [sending, setSending] = useState(false);
  const curl = `curl -X POST ${BASE}/v1/record \\\n  -H "Authorization: Bearer ${keyInUse()}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"receipt_seq": ${seq || '<seq from /v1/check>'}, "status": "${status}", "ref": "${ref}", "ms": 412}'`;
  const send = async () => {
    setSending(true);
    const t0 = performance.now();
    await latency();
    const s = Number(seq);
    const ms = () => Math.round(performance.now() - t0);
    if (!seq || !Number.isInteger(s)) {
      setRes({ status: 400, text: 'Bad Request', headers: rateHeaders(), ms: ms(), body: { error: 'invalid_request', message: 'receipt_seq must be the integer from the /v1/check response.' } });
    } else if (!session.allowed.includes(s)) {
      setRes({ status: 404, text: 'Not Found', headers: rateHeaders(), ms: ms(), body: { error: 'not_found', message: `No allowed or approved decision ${seqLabel(s)} for this agent in this sandbox session. Send an allowed /v1/check, or approve a held one, first.` } });
    } else if (session.recorded.has(s)) {
      setRes({ status: 409, text: 'Conflict', headers: rateHeaders(), ms: ms(), body: { error: 'duplicate', message: `An outcome for ${seqLabel(s)} was already recorded. Each decision has one outcome.` } });
    } else {
      session.recorded.add(s);
      const out = headSeq();
      setRes({ status: 201, text: 'Created', headers: rateHeaders(), ms: ms(), body: { recorded: true, seq: out, ref_seq: s, outcome: { status, ref, ms: 412 } } });
    }
    setSending(false);
  };
  return (
    <TryShell
      title="POST /v1/record"
      curl={curl}
      res={res}
      sending={sending}
      onSend={send}
      onReset={() => setRes(undefined)}
      footnote="Send an allowed check above, or approve a held one; its sequence number fills in here. Record a rejected or still-pending ask to see the 404, and the same record twice to see the 409."
      form={
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="receipt_seq" htmlFor="rec-seq" hint={session.allowed.length ? `Last allowed or approved: ${seqLabel(session.allowed[0])}` : 'From an allowed or approved /v1/check.'}>
            <Input id="rec-seq" mono value={seq} onChange={(e) => setSeq(e.target.value)} onFocus={() => { if (!seq && session.allowed[0]) setSeq(String(session.allowed[0])); }} />
          </Field>
          <Field label="status" htmlFor="rec-status">
            <Select id="rec-status" value={status} onChange={(e) => setStatus(e.target.value as 'ok' | 'error')}>
              <option value="ok">ok</option>
              <option value="error">error</option>
            </Select>
          </Field>
          <Field label="ref" htmlFor="rec-ref" hint="Your system's id for the result.">
            <Input id="rec-ref" mono value={ref} onChange={(e) => setRef(e.target.value)} />
          </Field>
        </div>
      }
    />
  );
}

/* ── GET /v1/approvals/{id} ───────────────────────────────── */

export function ApprovalTry() {
  const d = db.getDB(ORG);
  const known = useMemo(() => d.approvals.filter((a) => a.agentSlug === AGENT).slice(-8).reverse(), [d]);
  const [id, setId] = useState(() => session.asks[0]?.id ?? known[0]?.id ?? '');
  const [wait, setWait] = useState('10');
  const [res, setRes] = useState<Res>();
  const [sending, setSending] = useState(false);
  const idRef = useRef<HTMLInputElement>(null);
  const curl = `curl "${BASE}/v1/approvals/${id || '<id>'}?wait=${wait || 0}" \\\n  -H "Authorization: Bearer ${keyInUse()}"`;
  const send = async () => {
    setSending(true);
    const t0 = performance.now();
    const w = Math.min(30, Math.max(0, Number(wait) || 0));
    const mine = session.asks.find((a) => a.id === id.trim());
    const a = d.approvals.find((x) => x.id === id.trim());
    const waited = mine ? await waitForSandbox(mine.id, w) : (await sleep(200), 0);
    const ms = Math.round(performance.now() - t0);
    if (mine) {
      setRes({ status: 200, text: 'OK', headers: rateHeaders(), ms, body: { id: mine.id, status: mine.status, approver_group: mine.group, expires_at: mine.expires, receipt_seq: mine.seq, ...(mine.status === 'pending' ? { waited_s: waited, poll_url: `/v1/approvals/${mine.id}?wait=30` } : { decided_at: mine.decidedAt, channel: 'web', result_seq: mine.resultSeq, waited_s: waited }) } });
    } else if (a) {
      setRes({
        status: 200, text: 'OK', headers: rateHeaders(), ms,
        body: {
          id: a.id, status: a.status === 'approved_run_failed' ? 'approved' : a.status, approver_group: a.approverGroup, tool: a.tool, rule_id: a.ruleId,
          expires_at: a.expiresAt, decided_at: a.decidedAt, channel: a.channel, receipt_seq: a.seq, result_seq: a.resultSeq,
          ...(a.status === 'pending' ? { waited_s: w, poll_url: `/v1/approvals/${a.id}?wait=30` } : {}),
        },
      });
    } else {
      setRes({ status: 404, text: 'Not Found', headers: rateHeaders(), ms, body: { error: 'not_found', message: 'No approval with that id for this agent.' } });
    }
    setSending(false);
  };
  return (
    <TryShell
      title="GET /v1/approvals/{id}"
      curl={curl}
      res={res}
      sending={sending}
      onSend={send}
      onReset={() => setRes(undefined)}
      footnote="Ids below are real approvals from the demo organisation's invoice-bot, read without changing them. An approval you raised with Try it above can be approved or rejected there; a waiting request here returns as soon as you do, and reports how long it really waited."
      form={
        <div className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <Field label="id" htmlFor="apr-id">
              <Input id="apr-id" ref={idRef} mono value={id} onChange={(e) => setId(e.target.value)} />
            </Field>
            <Field label="wait (seconds, 0–30)" htmlFor="apr-wait">
              <Input id="apr-wait" mono inputMode="numeric" value={wait} onChange={(e) => setWait(e.target.value.replace(/\D/g, ''))} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[...session.asks.slice(0, 2).map((a) => ({ id: a.id, label: `${a.id} · yours` })), ...known.map((a) => ({ id: a.id, label: `${a.id} · ${a.status.replace(/_/g, ' ')}` }))].map((o) => (
              <button key={o.id} type="button" onClick={() => setId(o.id)} className={cn('h-7 border px-2 font-mono text-[11.5px]', o.id === id ? 'border-fg bg-fg text-canvas' : 'border-line text-muted hover:text-fg hover:border-line-strong')}>{o.label}</button>
            ))}
          </div>
        </div>
      }
    />
  );
}

/* ── GET /v1/openapi.json and /healthz ────────────────────── */

export function OpenApiTry() {
  const [res, setRes] = useState<Res>();
  const [sending, setSending] = useState(false);
  return (
    <TryShell title="GET /v1/openapi.json" curl={`curl ${BASE}/v1/openapi.json`} res={res} sending={sending} onReset={() => setRes(undefined)}
      onSend={async () => { setSending(true); const t0 = performance.now(); await latency(); setRes({ status: 200, text: 'OK', headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' }, body: OPENAPI, ms: Math.round(performance.now() - t0) }); setSending(false); }} />
  );
}

export function HealthTry() {
  const [res, setRes] = useState<Res>();
  const [sending, setSending] = useState(false);
  return (
    <TryShell title="GET /healthz" curl={`curl ${BASE}/healthz`} res={res} sending={sending} onReset={() => setRes(undefined)}
      onSend={async () => {
        setSending(true); const t0 = performance.now(); await latency();
        const d = db.getDB(ORG);
        setRes({ status: 200, text: 'OK', headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, ms: Math.round(performance.now() - t0), body: { status: 'ok', version: OPENAPI.info.version, receipts: 'writable', checkpoints: { last_sealed_at:d.checkpoints[d.checkpoints.length - 1]?.ts }, time: new Date().toISOString() } });
        setSending(false);
      }} />
  );
}
