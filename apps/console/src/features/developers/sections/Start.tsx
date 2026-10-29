import { ArrowRight, Lock, ArrowRightLeft, KeyRound, FileCheck2, Wrench, ListChecks, Gauge, Scale, Play, BellRing } from 'lucide-react';
import { cn } from '@/lib/cn';
import { DocTitle, H2, H3, P, UL, OL, C, CodeTabs, Code, Note, DocLink, SimpleTable, MCP_URL, TEST_KEY, BASE } from '../docs';

/* ── Overview ─────────────────────────────────────────────── */

const STEPS = [
  { icon: KeyRound, name: 'Identify', text: 'Agent key checked. A paused agent is refused.', id: 'agent-paused' },
  { icon: FileCheck2, name: 'Load rulebook', text: 'Signature verified on every call.', id: 'no-rulebook · rulebook-invalid' },
  { icon: Wrench, name: 'Resolve tool', text: 'Built-in connectors and your MCP servers. Unknown or disabled is refused.', id: 'default · tool-disabled' },
  { icon: ListChecks, name: 'Validate arguments', text: 'Against the tool schema.', id: 'invalid-arguments' },
  { icon: Gauge, name: 'Count limits', text: 'Quotas per window: a count, or a sum of a field.' },
  { icon: Scale, name: 'Decide', text: 'Strictest matching rule wins. No match refuses.' },
  { icon: Play, name: 'Act', text: 'Allow runs or advises; ask holds for a person; refuse names the rule.' },
  { icon: BellRing, name: 'Notify', text: 'Receipt, approval links, webhooks, behaviour checks.' },
];

function PathDiagram() {
  return (
    <figure className="my-6" aria-label="The 8 steps of a governed call">
      <ol className="grid gap-px border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.name} className="relative bg-surface p-4">
            <div className="flex items-center gap-2">
              <span className={cn('inline-flex h-6 w-6 items-center justify-center border font-mono text-[11px] font-semibold', i === 5 ? 'border-fg bg-fg text-canvas' : 'border-line-strong/60 text-muted')}>{i + 1}</span>
              <s.icon className="h-4 w-4 text-muted" aria-hidden />
              <span className="text-sm font-semibold">{s.name}</span>
            </div>
            <p className="mt-2 text-sm text-muted leading-relaxed">{s.text}</p>
            {s.id && <p className="mt-2 font-mono text-[11px] text-bad-fg">refuses: {s.id}</p>}
            {i < STEPS.length - 1 && <ArrowRight className="absolute right-2 top-4 hidden h-3.5 w-3.5 text-subtle xl:block" aria-hidden />}
          </li>
        ))}
      </ol>
      <figcaption className="mt-2 text-xs text-muted">An unexpected error at any step before the call runs refuses with <C>gate-error</C>. Every outcome — allow, ask or refuse — writes one receipt, sealed in the organisation’s hash chain.</figcaption>
    </figure>
  );
}

export function Overview() {
  return (
    <>
      <DocTitle kicker="Developers" title="How a call is governed" lead="Before an agent's tool call runs, it asks Elan1 Govern. Your published rulebook answers Allow, Ask a person or Refuse — and anything no rule allows is refused; from L2 each rulebook version is also signed. Every decision becomes a receipt sealed in a hash chain, which an auditor can check offline; from L2 each receipt is also signed and timestamped." />
      <H2 id="the-path">The path of one call</H2>
      <P>Every call takes the same 8 steps, in the same order, whether it arrives over MCP or the REST API. The decision step is a pure function of the rulebook, the tool and its arguments, so the same call always gets the same answer.</P>
      <PathDiagram />

      <H2 id="two-ways">2 ways to connect</H2>
      <P>Choose per agent. The difference is who holds the tool's credentials, and so what a refusal can do.</P>
      <div className="my-5 grid gap-px border border-line bg-line md:grid-cols-2">
        <div className="bg-surface p-5">
          <p className="flex items-center gap-2 font-semibold"><Lock className="h-4 w-4" aria-hidden />Governed run · MCP</p>
          <p className="mt-2 text-sm text-fg/90 leading-relaxed">The agent connects to Elan1 Govern as its MCP server. Elan1 Govern holds the credentials for Gmail, Zoho Books and your own MCP servers, and runs the call only when it is allowed or approved. A refused call cannot run: the agent never had the credential.</p>
          <p className="mt-3 text-xs text-muted">Enforced. Use it for anything that moves money, deletes or changes access.</p>
        </div>
        <div className="bg-surface p-5">
          <p className="flex items-center gap-2 font-semibold"><ArrowRightLeft className="h-4 w-4" aria-hidden />Check and record · REST and SDKs</p>
          <p className="mt-2 text-sm text-fg/90 leading-relaxed">The agent keeps its own credentials. It calls <C>POST /v1/check</C> before a tool call and <C>POST /v1/record</C> after. Elan1 Govern advises and records; the agent runs the call. Your code decides whether to honour a refusal.</p>
          <p className="mt-3 text-xs text-muted">Advisory. Use it where the tool cannot be proxied, and wrap it so a refusal stops the call.</p>
        </div>
      </div>
      <Note tone="neutral" title="Wording we hold ourselves to">Only the governed run blocks a call. For check and record we say it advises and records; the agent runs the call.</Note>

      <H2 id="decisions">The 3 answers</H2>
      <SimpleTable caption="Decisions" head={['Decision', 'Governed run (MCP)', 'Check and record (REST)']} rows={[
        [<C>allow</C>, 'Elan1 Govern runs the tool, then writes the receipt.', 'You get allow and a receipt sequence number. Run the call, then record the outcome.'],
        [<C>ask</C>, 'Nothing runs. A person is asked; if they approve, the held call runs at once.', 'You get an approval id and a poll URL. Wait, then run only if approved.'],
        [<C>refuse</C>, 'Nothing runs. The tool result explains the rule.', 'You get refuse with the rule id and reason, as HTTP 200.'],
      ]} />

      <H2 id="next">Where to go next</H2>
      <UL>
        <li><DocLink to="/developers/quickstart">Quickstart</DocLink> — your first governed call in 5 minutes.</li>
        <li><DocLink to="/developers/rulebooks">Rulebook YAML</DocLink> — write the rules an agent works under.</li>
        <li><DocLink to="/developers/api">REST API</DocLink> — the five agent-facing paths, with a live Try it panel.</li>
        <li><DocLink to="/developers/receipts">Receipts and verification</DocLink> — what an auditor checks, and how.</li>
      </UL>
    </>
  );
}

/* ── Quickstart ───────────────────────────────────────────── */

export function Quickstart() {
  return (
    <>
      <DocTitle kicker="Get started" title="Your first governed call in 5 minutes" lead="Add an agent, connect Claude Code or Cursor to it over MCP, make one call and read its receipt. You need an Elan1 Govern organisation with an owner or admin role." />

      <H2 id="add-agent">1. Add an agent</H2>
      <P>In the console, open <strong>Agents → Add agent</strong>. Give it a name, an owner and a risk level, and choose a starter rulebook from your industry. The agent joins your AI inventory as you save it.</P>
      <Note tone="info">The starter rulebook is published for you; from L2 each version is also signed with your organisation's key. Anything it does not allow is refused, so a new agent starts narrow.</Note>

      <H2 id="copy-credentials">2. Copy the MCP address and key</H2>
      <P>The last step shows 2 values. The key is shown once — copy it now; afterwards only its prefix is kept.</P>
      <Code title="Values" code={`MCP address   ${MCP_URL}\nAgent key     ${TEST_KEY}   # sk_sbx_ for the sandbox, gk_ for production`} />

      <H2 id="configure">3. Connect your client</H2>
      <CodeTabs samples={[
        { key: 'claude-code', label: 'Claude Code', title: 'Terminal', code: `claude mcp add --transport http elan1-govern \\\n  ${MCP_URL} \\\n  --header "Authorization: Bearer ${TEST_KEY}"\n\nclaude mcp list   # elan1-govern: connected` },
        { key: 'cursor', label: 'Cursor', title: '.cursor/mcp.json', code: JSON.stringify({ mcpServers: { 'elan1-govern': { url: MCP_URL, headers: { Authorization: `Bearer ${TEST_KEY}` } } } }, null, 2) },
        { key: 'claude-desktop', label: 'Claude Desktop', title: 'claude_desktop_config.json', code: JSON.stringify({ mcpServers: { 'elan1-govern': { command: 'npx', args: ['-y', 'mcp-remote', MCP_URL, '--header', `Authorization: Bearer ${TEST_KEY}`] } } }, null, 2) },
      ]} />
      <P>Your client now lists only the tools this agent may call, from the built-in connectors and the MCP servers you have added.</P>

      <H2 id="make-call">4. Make a call</H2>
      <P>Ask the agent for something its rulebook covers. With the finance starter rulebook, try a payment both sides of the line:</P>
      <Code title="Prompt" code={`Record a payment of ₹42,000 to Northwind Traders against BILL-2026-0412.\nThen record ₹2,40,000 to Kalyani Metals against BILL-2026-0419.`} />
      <UL>
        <li>The first is allowed by <C>pay-small</C>: Elan1 Govern runs it in Zoho Books and returns the result.</li>
        <li>The second is held by <C>pay-large</C>: the tool result says it is waiting for the finance group, with an approval id. Nothing has run.</li>
      </UL>

      <H2 id="see-receipt">5. See the receipt</H2>
      <P>Open <strong>Activity</strong> in the console. Each call is one receipt: the agent, the tool, the rule that decided, the reason, and the hash that links it to the receipt before. Approve the held payment in <strong>Approvals</strong> and a second receipt records who approved it and through which channel.</P>
      <P>To check the chain yourself, export an auditor pack from <strong>Assurance → Proof</strong> and drop it on the <DocLink to="/verify">public verifier</DocLink>, or run <C>govern verify</C> offline.</P>
      <Note tone="ok" title="Using an agent framework instead?">See <DocLink to="/developers/examples">Examples</DocLink> for LangChain and the OpenAI Agents SDK over MCP, or the <DocLink to="/developers/sdks">SDKs</DocLink> for check and record.</Note>
    </>
  );
}

/* ── MCP ──────────────────────────────────────────────────── */

export function Mcp() {
  return (
    <>
      <DocTitle kicker="Connect" title="MCP" lead="Connect any MCP client to Elan1 Govern and every tool call takes the governed run: Elan1 Govern holds the credentials, decides, runs the allowed calls and blocks the rest." />
      <H2 id="endpoint">Endpoint</H2>
      <SimpleTable caption="MCP endpoint" head={['Item', 'Detail']} rows={[
        ['Address', <span className="font-mono text-[12.5px] break-all">POST {BASE}/mcp/&lt;org&gt;/&lt;agent&gt;</span>],
        ['Transport', 'Streamable HTTP, stateless. Every request carries the agent key; there is no session to resume.'],
        ['Authentication', <span><C>Authorization: Bearer gk_…</C> (production) or <C>sk_sbx_…</C> (sandbox)</span>],
        ['Rate limit', '300 requests a minute per key. Calls rejected for a bad key or the rate limit are not receipted.'],
      ]} />

      <H2 id="tools">Where the tools come from</H2>
      <UL>
        <li><strong>Built-in connectors</strong> — Gmail and Zoho Books, connected with your own OAuth app. Tools are named <C>gmail.send_email</C>, <C>zoho_books.record_payment</C>.</li>
        <li><strong>Your MCP servers</strong> — add an upstream server by URL and header; its tools appear as <C>&lt;server&gt;.&lt;tool&gt;</C>, off until you enable them and give them risk tags.</li>
        <li><strong><C>govern.approval_status</C></strong> — a tool Elan1 Govern adds, so the agent can ask about a held call. It long-polls for up to 30 seconds.</li>
      </UL>
      <P><C>tools/list</C> returns only the tools enabled for this agent. A tool that is not listed is refused if called anyway: with <C>tool-disabled</C> when it exists but is switched off on its connector, and with <C>default</C> when it is unknown or no rule allows it.</P>

      <H2 id="refusals">Refusals are tool results</H2>
      <P>A refused or held call is not a transport error. The agent receives a normal tool result with <C>isError: true</C> and text that names the rule, so the model can explain it and move on. The MCP session stays healthy.</P>
      <CodeTabs samples={[
        { key: 'refuse', label: 'Refused', title: 'tools/call → result', code: JSON.stringify({ jsonrpc: '2.0', id: 7, result: { isError: true, content: [{ type: 'text', text: 'Refused by rule no-deletes: Bills are cancelled by a person in Zoho Books, never deleted by an agent. Receipt #6,215.' }], structuredContent: { decision: 'refuse', rule_id: 'no-deletes', receipt: 6215 } } }, null, 2) },
        { key: 'ask', label: 'Held for a person', title: 'tools/call → result', code: JSON.stringify({ jsonrpc: '2.0', id: 8, result: { isError: true, content: [{ type: 'text', text: 'Waiting for a person (finance) under rule pay-large: Payments over ₹50,000 need the finance controller. Approval apr_9f2k1c expires in 24 h. Call govern.approval_status to check.' }], structuredContent: { decision: 'ask', rule_id: 'pay-large', approval_id: 'apr_9f2k1c', receipt: 6216 } } }, null, 2) },
        { key: 'allow', label: 'Allowed', title: 'tools/call → result', code: JSON.stringify({ jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: '{"payment_id":"pay_884120","status":"recorded"}' }], structuredContent: { decision: 'allow', rule_id: 'pay-small', receipt: 6217 } } }, null, 2) },
      ]} />

      <H3 id="held-calls">Held calls</H3>
      <P>When a person approves, the held call runs at once with the arguments it was held with — it is not re-decided against a newer rulebook. The agent learns the result through <C>govern.approval_status</C>. An approval expires 24 hours after the ask unless the rule says otherwise; an approver may extend it once, with a declared reason that is recorded. A rejected or expired approval is a refusal; the arguments are wiped on expiry.</P>
      <Note tone="held" title="Stops and failed writes">During an emergency stop, waiting approvals are held: nobody can decide them until the stop is lifted, and their expiry still runs (an expiry is a refusal). In a governed run an allowed call runs before its receipt is written. If that write fails, the receipt is written on retry with an error outcome and the call is reported as having run, not as refused.</Note>
      <OL>
        <li>Connect with the snippets in <DocLink to="/developers/examples">Examples</DocLink>.</li>
        <li>Write the rules in <DocLink to="/developers/rulebooks">Rulebook YAML</DocLink>.</li>
      </OL>
    </>
  );
}
