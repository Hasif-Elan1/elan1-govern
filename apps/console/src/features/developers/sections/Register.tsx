import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge, EmptyState, Input, Segmented } from '@/components/ui';
import {
  CORE_CODES, FAMILY_INFO, GLOSSARY, billingOf, MCP_SCOPES, MCP_TOOLS, REFUSAL_CODES, RUNGS, SEVERITIES, SUPPORT_TIERS, refusalByWire,
  type McpScope, type RefusalFamily,
} from '@/mock/devpathData';
import type { LevelId } from '@/types';
import { DocTitle, H2, H3, P, UL, C, Code, CodeTabs, Note, DocLink, SimpleTable } from '../docs';

const j = (x: unknown) => JSON.stringify(x, null, 2);
const LEVEL_TAG: Record<LevelId, string> = { l1: 'L1', l2: 'L2', l3: 'L3', sovereign: 'SOV' };

function LevelTag({ level }: { level: LevelId }) {
  return <span className="inline-flex h-5 items-center border border-line-strong/70 px-1 font-mono text-[10.5px] text-muted" title={`Active from ${LEVEL_TAG[level]}`}>{LEVEL_TAG[level]}</span>;
}

function FamilyBadge({ family }: { family: RefusalFamily }) {
  return <Badge tone={family === 'PLATFORM' ? 'bad' : family === 'GATE' ? 'held' : 'neutral'}>{FAMILY_INFO[family].label}</Badge>;
}

/* ── Refusal codes: the register ──────────────────────────── */

export function RefusalCodes() {
  const [q, setQ] = useState('');
  const [fam, setFam] = useState<'all' | RefusalFamily>('all');
  const [lvl, setLvl] = useState<'all' | 'l1' | 'l2' | 'l3'>('all');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return REFUSAL_CODES.filter((c) => (fam === 'all' || c.family === fam) && (lvl === 'all' || c.activeFrom === lvl)
      && (!needle || `${c.wire} ${c.ref} ${c.title} ${c.means} ${c.builtId ?? ''}`.toLowerCase().includes(needle)));
  }, [q, fam, lvl]);
  const count = (f: RefusalFamily) => CORE_CODES.filter((c) => c.family === f).length;
  const l1 = CORE_CODES.filter((c) => c.activeFrom === 'l1').length;
  return (
    <>
      <DocTitle kicker="Reference" title="Refusal codes" lead={<>A closed register of {CORE_CODES.length} codes — {count('POLICY')} policy codes, {count('GATE')} pre-write checks and {count('PLATFORM')} platform failures — with {l1} active from L1 and the other {CORE_CODES.length - l1} from L2. L3 Proven adds {REFUSAL_CODES.length - CORE_CODES.length} more for receipts between organisations. Every code has a permanent number and a page of its own.</>} />
      <Note tone="info" title="A refusal is an answer">It comes back as HTTP 200 (or an MCP tool result with <C>isError: true</C>) with a code, a rule id and a reason. The call did not run, and the refusal is a receipt like any other — with one exception: once the pilot’s hard stop is reached, refused calls write no receipt (<DocLink to="/developers/refusals/POLICY.TENANT_STOPPED">POLICY.TENANT_STOPPED</DocLink>). A refused action costs 40% of the per-action rate. A platform refusal is our failure and is never billed, and a sandbox call is metered at 0 — the meter and the invoice count both at 0.</Note>
      <H2 id="families">3 families</H2>
      <SimpleTable caption="Refusal families" head={['Family', 'Wire prefix', 'Means', 'Billed', 'Retry', 'Pages on-call']} rows={(['POLICY', 'GATE', 'PLATFORM'] as RefusalFamily[]).map((f) => [
        <span key={f} className="font-medium">{FAMILY_INFO[f].label}</span>, <span key="w" className="font-mono text-[12.5px]">{f}.*</span>, FAMILY_INFO[f].blurb, FAMILY_INFO[f].billed, FAMILY_INFO[f].retry, FAMILY_INFO[f].pages,
      ])} />
      <P>Two codes are billed differently from their family: <DocLink to="/developers/refusals/GATE.SANDBOX_LIMIT_REACHED">GATE.SANDBOX_LIMIT_REACHED</DocLink> is never billed, because sandbox calls are metered at 0, and <DocLink to="/developers/refusals/POLICY.TENANT_STOPPED">POLICY.TENANT_STOPPED</DocLink> is not billed when it comes from the pilot’s hard stop, which writes no receipt. The three codes raised at define — <DocLink to="/developers/refusals/POLICY.DECLARATION_INVALID">POLICY.DECLARATION_INVALID</DocLink>, <DocLink to="/developers/refusals/POLICY.VERSION_NOT_SEQUENTIAL">POLICY.VERSION_NOT_SEQUENTIAL</DocLink> and <DocLink to="/developers/refusals/POLICY.NOT_CERTIFIED">POLICY.NOT_CERTIFIED</DocLink> — come back when a rulebook or declaration version is checked before publishing, not on an agent’s call, so they are never billed.</P>
      <P>Today the console and the API also show a short system rule id (for example <C>default</C> or <C>agent-paused</C>) — see <DocLink to="/developers/errors">Errors and refusal ids</DocLink>. Each code page says which system id it maps to, where one does.</P>

      <H2 id="register">The register</H2>
      <div className="my-4 grid gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-center">
        <div>
          <label htmlFor="rc-q" className="sr-only">Search the register</label>
          <Input id="rc-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search codes, numbers or words" leading={<Search className="h-4 w-4" aria-hidden />} />
        </div>
        <Segmented<'all' | RefusalFamily> label="Family" size="sm" value={fam} onChange={setFam} options={[{ value: 'all', label: 'All' }, { value: 'POLICY', label: 'Policy' }, { value: 'GATE', label: 'Checks' }, { value: 'PLATFORM', label: 'Platform' }]} />
        <Segmented<'all' | 'l1' | 'l2' | 'l3'> label="Active from" size="sm" value={lvl} onChange={setLvl} options={[{ value: 'all', label: 'Any level' }, { value: 'l1', label: 'L1' }, { value: 'l2', label: 'L2' }, { value: 'l3', label: 'L3' }]} />
      </div>
      <p className="mb-2 text-sm text-muted" aria-live="polite">{rows.length} of {REFUSAL_CODES.length} codes</p>
      {rows.length ? (
        <div className="overflow-x-auto border border-line">
          <table className="w-full text-sm">
            <caption className="sr-only">Refusal codes</caption>
            <thead className="bg-sunken/80">
              <tr className="border-b border-line">
                {['No.', 'Code', 'Means', 'Step', 'From'].map((h) => <th key={h} scope="col" className="h-9 px-3 text-left label whitespace-nowrap">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.ref} className="border-b border-line last:border-b-0 align-top hover:bg-sunken/40">
                  <td className="px-3 py-2.5 font-mono text-[12px] text-muted whitespace-nowrap">{c.ref}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap"><Link to={`/developers/refusals/${c.wire}`} className="font-mono text-[12.5px] font-medium link">{c.wire}</Link></td>
                  <td className="px-3 py-2.5 min-w-[240px] leading-relaxed">{c.title}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-muted"><span className="font-mono text-[12px]">{RUNGS[c.rung].n}</span> {RUNGS[c.rung].name}</td>
                  <td className="px-3 py-2.5"><LevelTag level={c.activeFrom} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState compact title="No code matches" disc="aperture">Clear the search or choose another family.</EmptyState>}

      <H2 id="register-file">The register as data</H2>
      <P>Each entry carries a permanent number, the wire spelling, the family, the step, the level it is active from, whether it is billed, whether it pages us, and what the operator does. New codes are announced here 60 days before they can be raised.</P>
      <Code title="refusal-codes.yaml (one entry)" code={`- ref: REF-25\n  wire: GATE.PRECONDITION_FAILED\n  family: pre_write_checks\n  step: 3\n  active_from: L1\n  billed: 40% of the per-action rate\n  recorded: true\n  pages: false\n  consumer_raisable: true\n  operator_action: Fix the record's state, then send the call again.\n  fixtures: [precondition_credit_limit_exceeded]`} />
    </>
  );
}

/* ── One refusal code ─────────────────────────────────────── */

export function RefusalCodePage({ code }: { code: string }) {
  const c = refusalByWire(decodeURIComponent(code));
  if (!c) {
    return (
      <EmptyState title="That code is not in the register" disc="aperture" action={<Link to="/developers/refusal-codes" className="link">See every code</Link>}>
        There is no refusal code called “{code}”. Codes are spelt like <span className="font-mono">GATE.PRECONDITION_FAILED</span>, or by number like <span className="font-mono">REF-25</span>.
      </EmptyState>
    );
  }
  const idx = REFUSAL_CODES.indexOf(c);
  const prev = REFUSAL_CODES[idx - 1];
  const next = REFUSAL_CODES[idx + 1];
  const fam = FAMILY_INFO[c.family];
  const bill = billingOf(c);
  const related = REFUSAL_CODES.filter((x) => x.rung === c.rung && x.wire !== c.wire);
  const rest = { decision: 'refuse', code: c.wire, ref: c.ref, rule_id: c.builtId && c.builtId !== 'rejected' && c.builtId !== 'expired' ? c.builtId : c.family === 'POLICY' && c.wire.endsWith('DENIED_BY_RULE') ? 'no-delete' : c.wire.toLowerCase().replace(/^[a-z]+\./, '').replace(/_/g, '-'), reason: c.example, receipt: { seq: 6241, hash: 'sha256:9c1e…' }, billed: bill.billed, retry: c.family === 'PLATFORM' ? 'same_intent' : 'never' };
  const mcp = { jsonrpc: '2.0', id: 12, result: { isError: true, content: [{ type: 'text', text: `Refused (${c.wire}): ${c.example}` }], structuredContent: { decision: 'refuse', code: c.wire, rule_id: rest.rule_id, receipt: 6241 } } };
  // define codes are raised when a version is put forward for publishing, not on an agent's call: no decision receipt
  const publish = { result: 'not_published', code: c.wire, ref: c.ref, version_put_forward: c.wire === 'POLICY.VERSION_NOT_SEQUENTIAL' ? 9 : 8, version_in_force: 7, reason: c.example, in_force_unchanged: true };
  // L3 receipt codes are raised when a receipt another organisation sent you is checked: the receipt is not added to your
  // chain and cannot be accepted; the check itself is recorded as counterparty.receipt.verified (mock/platform.ts verifyReceived)
  const failedStep: Record<string, string> = { 'POLICY.RECEIPT_AUDIENCE_MISMATCH': 'audience', 'POLICY.RECEIPT_EXPIRED': 'expiry', 'POLICY.TRUST_ANCHOR_UNKNOWN': 'issuer key', 'POLICY.RECEIPT_UNVERIFIED': 'signature', 'GATE.RECEIPT_REPLAYED': 'nonce' };
  const order = ['audience', 'expiry', 'nonce', 'issuer key', 'hash', 'signature', 'timestamp'];
  const stop = failedStep[c.wire] ?? 'signature';
  const received = {
    state: c.wire === 'POLICY.RECEIPT_EXPIRED' ? 'expired' : 'failed', code: c.wire, ref: c.ref, issuer: 'ar-org:northbank.co.in', seq: 4097,
    steps: order.slice(0, order.indexOf(stop) + 1).map((s) => ({ step: s, state: s === stop ? 'fail' : 'pass', ...(s === stop ? { detail: c.example } : {}) })),
    added_to_chain: false,
    can_accept: false,
    recorded_as: { action: 'counterparty.receipt.verified', seq: 6242, result: c.wire === 'POLICY.RECEIPT_EXPIRED' ? 'expired' : 'failed' },
  };
  const samples = c.rung === 'define'
    ? [{ key: 'publish', label: 'Publishing', title: 'Put a version forward for publishing → refused', code: j(publish) }]
    : c.rung === 'receipt'
      ? [{ key: 'received', label: 'Receiving', title: 'POST /v1/verify/action-receipt → 200 OK', code: j(received) }]
      : [
        { key: 'rest', label: 'REST', title: 'POST /v1/check → 200 OK', code: j(rest) },
        { key: 'mcp', label: 'MCP', title: 'tools/call → result', code: j(mcp) },
      ];
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm"><Link to="/developers/refusal-codes" className="link inline-flex items-center gap-1"><ArrowLeft className="h-3.5 w-3.5" aria-hidden />Refusal codes</Link></nav>
      <DocTitle kicker={`${c.ref} · ${fam.label}`} title={c.wire} lead={c.title + '. ' + c.means} />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <FamilyBadge family={c.family} />
        <LevelTag level={c.activeFrom} />
        <Badge>Step {RUNGS[c.rung].n} · {RUNGS[c.rung].name}</Badge>
        {!c.core && <Badge tone="info">L3 receipt code</Badge>}
      </div>
      <SimpleTable caption={`Facts about ${c.wire}`} head={['', '']} rows={[
        ['Number', <span key="n" className="font-mono">{c.ref}</span>],
        ['Wire spelling', <span key="w" className="font-mono">{c.wire}</span>],
        ['Raised at', <>{RUNGS[c.rung].n} {RUNGS[c.rung].name} — {RUNGS[c.rung].what}</>],
        ['Active from', c.activeFrom === 'l1' ? 'L1 Guarded (every organisation)' : c.activeFrom === 'l2' ? 'L2 Attested' : 'L3 Proven'],
        ['Billed', bill.text],
        ['Recorded', bill.recorded],
        ['Pages on-call', fam.pages],
        ['Shown today as', c.builtId ? <span key="b"><C>{c.builtId}</C>{c.builtId === 'rejected' || c.builtId === 'expired' ? ' (the approval status on the receipt)' : ' (system rule id)'}</span> : 'Its code only'],
      ]} />
      <H2 id="what-to-do">What to do</H2>
      <P>{c.action}</P>
      <Note tone={c.family === 'PLATFORM' ? 'bad' : 'held'} title={c.family === 'PLATFORM' ? 'Retry the same intent' : 'Do not retry the same intent'}>{fam.retry}</Note>
      <H2 id="example">What it looks like</H2>
      {c.rung === 'define' && <P>This code is raised when a rulebook or declaration version is put forward for publishing, not on an agent’s call. The version is not put in force; the version already in force keeps deciding.</P>}
      {c.rung === 'receipt' && <P>This code is raised when you check an Action Receipt another organisation sent you. No refusal receipt is written, and the receipt you were sent is not added to your chain: it stays in your counterparty register marked failed (or expired) and cannot be accepted, so do not act on it. Your chain records the check instead — <C>counterparty.receipt.received</C> (verified: false) when it arrives, and <C>counterparty.receipt.verified</C> with the result each time it is verified and recorded again.</P>}
      <CodeTabs samples={samples} />
      {related.length > 0 && (
        <>
          <H2 id="related">Raised at the same step</H2>
          <UL>{related.map((r) => <li key={r.wire}><Link to={`/developers/refusals/${r.wire}`} className="font-mono text-[13px] link">{r.wire}</Link> — {r.title}</li>)}</UL>
        </>
      )}
      <nav aria-label="Previous and next code" className="mt-10 grid gap-3 sm:grid-cols-2">
        {prev ? <Link to={`/developers/refusals/${prev.wire}`} className="border border-line bg-surface p-3 hover:border-line-strong"><span className="label inline-flex items-center gap-1"><ArrowLeft className="h-3 w-3" aria-hidden />{prev.ref}</span><span className="mt-1 block font-mono text-[12.5px]">{prev.wire}</span></Link> : <span />}
        {next && <Link to={`/developers/refusals/${next.wire}`} className="border border-line bg-surface p-3 text-right hover:border-line-strong"><span className="label inline-flex items-center gap-1">{next.ref}<ArrowRight className="h-3 w-3" aria-hidden /></span><span className="mt-1 block font-mono text-[12.5px]">{next.wire}</span></Link>}
      </nav>
    </>
  );
}

/* ── Glossary ─────────────────────────────────────────────── */

export function Glossary() {
  const [q, setQ] = useState('');
  const terms = useMemo(() => {
    const n = q.trim().toLowerCase();
    return [...GLOSSARY].sort((a, b) => a.term.localeCompare(b.term)).filter((t) => !n || (t.term + ' ' + t.def).toLowerCase().includes(n));
  }, [q]);
  const letters = Array.from(new Set(terms.map((t) => t.term[0].toUpperCase())));
  return (
    <>
      <DocTitle kicker="Reference" title="Glossary" lead={`${GLOSSARY.length} terms the console, the API and the receipts use, in plain words. Where the specification uses another name, it is given too.`} />
      <div className="mb-4 max-w-md">
        <label htmlFor="gl-q" className="sr-only">Filter the glossary</label>
        <Input id="gl-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter terms" leading={<Search className="h-4 w-4" aria-hidden />} />
      </div>
      {!terms.length && <EmptyState compact title="No term matches" disc="aperture">Try a shorter word.</EmptyState>}
      {letters.map((l) => (
        <section key={l} aria-labelledby={`gl-${l}`}>
          <H3 id={`gl-${l}`}>{l}</H3>
          <dl className="mb-4 divide-y divide-line border-y border-line">
            {terms.filter((t) => t.term[0].toUpperCase() === l).map((t) => (
              <div key={t.term} id={`term-${t.term.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`} className="grid gap-1 py-3 sm:grid-cols-[220px_1fr] sm:gap-6">
                <dt className="font-semibold">{t.term}</dt>
                <dd className="text-md leading-7 text-fg/90">
                  {t.def}
                  {t.see && <> <Link to={t.see} className="link whitespace-nowrap">Read more</Link></>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </>
  );
}

/* ── Built-in MCP tool catalogue ──────────────────────────── */

export function McpTools() {
  const [scope, setScope] = useState<'all' | McpScope>('all');
  const tools = MCP_TOOLS.filter((t) => scope === 'all' || t.scope === scope);
  return (
    <>
      <DocTitle kicker="Connect" title="Built-in MCP tools" lead={<>Besides your own tools, every MCP address offers {MCP_TOOLS.length} built-in tools in 3 scopes: {MCP_SCOPES['govern:read'].count} read, {MCP_SCOPES['govern:stage'].count} stage and {MCP_SCOPES['govern:act'].count} act. A key carries the scopes it was issued with; <C>tools/list</C> shows only the tools its scopes allow.</>} />
      <H2 id="scopes">Scopes</H2>
      <SimpleTable caption="MCP scopes" head={['Scope', 'Tools', 'What it can do']} rows={(Object.keys(MCP_SCOPES) as McpScope[]).map((s) => [<C key={s}>{s}</C>, String(MCP_SCOPES[s].count), MCP_SCOPES[s].what])} />
      <Note tone="neutral" title="Stage, then act">An agent prepares a write with <C>stage.write</C>, which runs every pre-write check and returns what would be decided, without applying anything. Only <C>act.write</C> commits it, and it takes the full decision path again on the same bytes. An agent issued only <C>govern:read</C> and <C>govern:stage</C> can never change anything.</Note>
      <H2 id="catalogue">The catalogue</H2>
      <div className="my-3"><Segmented<'all' | McpScope> label="Scope" size="sm" value={scope} onChange={setScope} options={[{ value: 'all', label: `All ${MCP_TOOLS.length}` }, { value: 'govern:read', label: 'Read' }, { value: 'govern:stage', label: 'Stage' }, { value: 'govern:act', label: 'Act' }]} /></div>
      <SimpleTable caption="Built-in MCP tools" head={['Tool', 'Scope', 'Does', 'Arguments', 'Metered']} rows={tools.map((t) => [
        <span key={t.name} className="font-mono text-[12.5px] font-medium">{t.name}{t.level && <span className="ml-1.5"><LevelTag level={t.level} /></span>}</span>,
        <span key="s" className="font-mono text-[12px] text-muted whitespace-nowrap">{t.scope}</span>, t.does, <span key="a" className="font-mono text-[12px]">{t.args}</span>, t.billed,
      ])} />
      <H2 id="example">Stage and commit</H2>
      <CodeTabs samples={[
        { key: 'stage', label: 'stage.write', title: 'tools/call', code: j({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stage.write', arguments: { write_type: 'zoho_books.record_payment', intent_id: 'int_7f2c91', args: { vendor: 'Kalyani Metals', amount: 240000, bill: 'BILL-2026-0419' } } } }) },
        { key: 'staged', label: 'Result', title: 'result', code: j({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'Staged st_4k2m. Would be held for finance under pay-large (over ₹50,000). Nothing was applied.' }], structuredContent: { staged_id: 'st_4k2m', would_decide: 'ask', rule_id: 'pay-large', checks: { residency: 'pass', budget: 'pass', precondition: 'pass' } } } }) },
        { key: 'act', label: 'act.write', title: 'tools/call', code: j({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'act.write', arguments: { staged_id: 'st_4k2m' } } }) },
      ]} />
      <P>A refusal from any act tool is a tool result with <C>isError: true</C> and a <DocLink to="/developers/refusal-codes">refusal code</DocLink>. The status tool <C>govern.approval_status</C> described on the <DocLink to="/developers/mcp">MCP</DocLink> page is the same tool as <C>read.approval_status</C>.</P>
    </>
  );
}

/* ── Support ──────────────────────────────────────────────── */

export function Support() {
  return (
    <>
      <DocTitle kicker="Operate" title="Support" lead="Five tiers, one for each way of running Elan1 Govern. Response times are for the first answer from a person, measured from when the case is opened." />
      <H2 id="tiers">Tiers</H2>
      <div className="my-5 overflow-x-auto border border-line">
        <table className="w-full text-sm">
          <caption className="sr-only">Support tiers and first-response targets</caption>
          <thead className="bg-sunken/80">
            <tr className="border-b border-line">
              {['Tier', 'For', 'Hours', 'S1', 'S2', 'S3', 'S4', 'Named contact'].map((h) => <th key={h} scope="col" className="h-9 px-3 text-left label whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {SUPPORT_TIERS.map((t) => (
              <tr key={t.id} className="border-b border-line last:border-b-0 align-top">
                <th scope="row" className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">{t.name}{t.level && <span className="ml-1.5"><LevelTag level={t.level} /></span>}</th>
                <td className="px-3 py-2.5 min-w-[150px]">{t.who}</td>
                <td className="px-3 py-2.5 min-w-[170px] text-muted">{t.hours}</td>
                {[t.s1, t.s2, t.s3, t.s4].map((v, i) => <td key={i} className={cn('px-3 py-2.5 whitespace-nowrap num', v === '—' && 'text-subtle')}>{v}</td>)}
                <td className="px-3 py-2.5 min-w-[160px] text-muted">{t.named}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <P>Channels: {SUPPORT_TIERS.map((t) => `${t.name} — ${t.channels.toLowerCase()}`).join('; ')}.</P>
      <H2 id="severity">Severity</H2>
      <SimpleTable caption="Severity levels" head={['Severity', 'Means']} rows={SEVERITIES.map((s) => [<span key={s.id}><strong>{s.id}</strong> {s.name}</span>, s.means])} />
      <P>You set the severity when you open a case; we may change it, and we say why on the case. An S1 is worked until it is resolved or has a workaround.</P>
      <H2 id="security">Security and incidents</H2>
      <UL>
        <li>If we suspect a key we hold for you is compromised, we tell your named contact within <strong>24 hours</strong>.</li>
        <li>An emergency security change to the service is notified within <strong>30 minutes</strong>, with what changed and why.</li>
        <li>Incidents that affect calls or the chain are posted on the <Link to="/status" className="link">status page</Link>, with the chain integrity component.</li>
        <li>Report a vulnerability or a defect in the Action Receipt standard without an account; we acknowledge within <strong>5 working days</strong> — see <DocLink to="/developers/standard#defects">the standard</DocLink>.</li>
      </UL>
      <H2 id="what-we-need">What to send us</H2>
      <UL>
        <li>The receipt number (<C>#6241</C>) or the <C>x-request-id</C> from the response headers.</li>
        <li>The refusal code, if there was one. Never the key itself: the prefix is enough.</li>
        <li>For a verification problem, the <C>govern verify --report</C> output.</li>
      </UL>
    </>
  );
}
