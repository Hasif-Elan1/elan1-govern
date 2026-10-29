import { Badge } from '@/components/ui';
import { DEPRECATIONS, deprecationHeaders } from '@/mock/devpathData';
import { DocTitle, H2, H3, P, UL, C, Code, CodeTabs, Note, DocLink, SimpleTable, MCP_URL, TEST_KEY } from '../docs';

/* ── SDKs ─────────────────────────────────────────────────── */

const TS_SDK = `import { Govern, GovernRefused } from '@elan1/govern';

const govern = new Govern({ apiKey: process.env.ELAN1_GOVERN_KEY! }); // gk_… (production) or sk_sbx_… (sandbox)

export async function payBill(args: { vendor: string; amount: number; bill: string }) {
  const d = await govern.check('zoho_books.record_payment', args);

  if (d.decision === 'refuse') throw new GovernRefused(d); // rule_id and reason inside
  if (d.decision === 'ask') {
    const a = await govern.waitForApproval(d.approval!.id, { timeoutMs: 30 * 60_000 });
    if (a.status !== 'approved') throw new GovernRefused(d, a.status);
  }

  try {
    const result = await zoho.recordPayment(args);           // your credentials, your call
    await govern.record(d.receipt.seq, { status: 'ok', ref: result.id });
    return result;
  } catch (e) {
    await govern.record(d.receipt.seq, { status: 'error', error: String(e).slice(0, 200) });
    throw e;
  }
}`;

const PY_SDK = `from elan1_govern import Govern, guarded, GovernError, RecordError

govern = Govern(api_key=os.environ["ELAN1_GOVERN_KEY"])  # gk_… (production) or sk_sbx_… (sandbox)

@guarded(govern, tool="zoho_books.record_payment", wait_for_approval=30 * 60)
def pay_bill(vendor: str, amount: int, bill: str) -> dict:
    # Runs only when Elan1 Govern answers allow, or a person approves.
    # The outcome is recorded for you when the function returns or raises.
    return zoho.record_payment(vendor=vendor, amount=amount, bill=bill)

try:
    pay_bill("Kalyani Metals", 240000, "BILL-2026-0419")
except GovernError as e:          # refused, rejected, expired — or Elan1 Govern unreachable
    print(e.decision, e.rule_id, e.reason)
except RecordError:               # the call ran but its outcome could not be recorded
    alert_ops()`;

export function Sdks() {
  return (
    <>
      <DocTitle kicker="Connect" title="SDKs" lead="Thin clients for check and record in TypeScript (@elan1/govern) and Python (elan1-govern). They wrap the REST API, wait for approvals, verify webhook signatures and, from L2, fetch inclusion proofs and evidence bundles." />
      <Note tone="neutral" title="Check and record is advisory">Elan1 Govern advises and records; your code runs the call. The SDKs make honouring the answer the easy path — but only the MCP governed run blocks a call.</Note>
      <H2 id="install">Install</H2>
      <CodeTabs samples={[
        { key: 'ts', lang: 'typescript', label: 'TypeScript', title: 'npm', code: 'npm install @elan1/govern' },
        { key: 'py', lang: 'python', label: 'Python', title: 'pip', code: 'pip install elan1-govern' },
      ]} />

      <H2 id="typescript">TypeScript · @elan1/govern</H2>
      <SimpleTable caption="TypeScript SDK methods" head={['Method', 'Does']} rows={[
        [<C>check(tool, args)</C>, <>POST /v1/check. Resolves with the decision; a refusal resolves, it does not throw.</>],
        [<C>record(seq, outcome)</C>, <>POST /v1/record. Throws on 409 if already recorded.</>],
        [<C>waitForApproval(id, opts)</C>, <>Polls GET /v1/approvals/&#123;id&#125;?wait=30 until decided or the timeout.</>],
        [<C>verifyWebhook(body, header, secret)</C>, <>Checks <C>X-Elan1-Signature</C>; returns the parsed event or throws.</>],
        [<C>proof(seq)</C>, <>L2+: GET /v1/receipts/&#123;seq&#125;/proof — the Merkle path and both timestamp tokens.</>],
        [<C>verifyBundle(file, opts)</C>, <>Runs the six-code verifier locally on a bundle; the same code as <C>govern verify</C>.</>],
      ]} />
      <Code title="pay-bill.ts" code={TS_SDK} />

      <H2 id="python">Python · elan1_govern</H2>
      <P>The <C>guarded</C> decorator checks before the function runs and records after. It <strong>fails closed</strong>: if Elan1 Govern cannot be reached, it raises <C>GovernError</C> and your function does not run. If the call ran but its outcome could not be recorded, it raises <C>RecordError</C> so you can reconcile.</P>
      <Code title="pay_bill.py" code={PY_SDK} />
      <H3 id="sdk-config">Configuration</H3>
      <UL>
        <li><C>ELAN1_GOVERN_KEY</C> — the agent key. Keep production <C>gk_</C> keys in your secret store; never commit them.</li>
        <li><C>ELAN1_GOVERN_URL</C> — defaults to <C>https://govern.elan1.ai</C>.</li>
        <li>Timeouts default to 5 seconds per request. A timeout is a refusal in <C>guarded</C>.</li>
      </UL>
    </>
  );
}

/* ── Examples ─────────────────────────────────────────────── */

export function Examples() {
  const server = 'elan1-govern';
  return (
    <>
      <DocTitle kicker="Connect" title="Examples" lead="Connect the agent frameworks people use most. Every MCP example takes the governed run: Elan1 Govern holds the credentials and runs the allowed calls." />
      <H2 id="claude">Claude</H2>
      <CodeTabs samples={[
        { key: 'cc', label: 'Claude Code', title: 'Terminal', code: `claude mcp add --transport http ${server} \\\n  ${MCP_URL} \\\n  --header "Authorization: Bearer ${TEST_KEY}"` },
        { key: 'cd', label: 'Claude Desktop', title: 'claude_desktop_config.json', code: JSON.stringify({ mcpServers: { [server]: { command: 'npx', args: ['-y', 'mcp-remote', MCP_URL, '--header', `Authorization: Bearer ${TEST_KEY}`] } } }, null, 2) },
      ]} />
      <H2 id="cursor">Cursor</H2>
      <Code title=".cursor/mcp.json" code={JSON.stringify({ mcpServers: { [server]: { url: MCP_URL, headers: { Authorization: `Bearer ${TEST_KEY}` } } } }, null, 2)} />
      <P>Save it in the project, or in <C>~/.cursor/mcp.json</C> for every project, then enable the server in Cursor's settings.</P>
      <H2 id="langchain">LangChain</H2>
      <Code title="Python · langchain-mcp-adapters" code={`from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent

client = MultiServerMCPClient({
    "${server}": {
        "transport": "streamable_http",
        "url": "${MCP_URL}",
        "headers": {"Authorization": "Bearer ${TEST_KEY}"},
    }
})
tools = await client.get_tools()          # only the tools this agent may call
agent = create_react_agent("anthropic:claude-sonnet-4-5", tools)
await agent.ainvoke({"messages": "Pay the Northwind invoice in the AP inbox"})`} />
      <H2 id="openai-agents">OpenAI Agents SDK</H2>
      <Code title="Python · openai-agents" code={`from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

async with MCPServerStreamableHttp(
    name="${server}",
    params={"url": "${MCP_URL}", "headers": {"Authorization": "Bearer ${TEST_KEY}"}},
) as govern:
    agent = Agent(name="Invoice bot", mcp_servers=[govern])
    result = await Runner.run(agent, "List today's unread invoices")
    # A refused call comes back as an error tool result; it did not run.`} />
      <H2 id="plain">Plain Python, check and record</H2>
      <P>For a tool that cannot go through MCP, wrap it with the <DocLink to="/developers/sdks">Python SDK</DocLink>. Elan1 Govern advises and records; your code runs the call.</P>
    </>
  );
}

/* ── Errors ───────────────────────────────────────────────── */

export function Errors() {
  return (
    <>
      <DocTitle kicker="Reference" title="Errors and refusal ids" lead="A refusal is an answer, not an error: it comes back as HTTP 200 with decision refuse, a rule id and a reason. HTTP errors are reserved for calls that never reached a decision." />
      <H2 id="http">HTTP status codes</H2>
      <SimpleTable caption="HTTP errors" head={['Status', 'Meaning', 'Receipt', 'What to do']} rows={[
        ['200', <>A decision. <C>refuse</C> is a 200.</>, 'Yes', 'Read decision.'],
        ['400', 'The body is not JSON, or required fields are missing.', 'No', 'Fix the request.'],
        ['401', 'The key is missing, unknown or revoked.', 'No', 'Check the key; issue a new one in the console.'],
        ['404', 'No such approval or decision for this agent.', 'No', 'Check the id.'],
        ['409', 'An outcome was already recorded for this decision.', 'No', 'Do not retry the record.'],
        ['429', 'More than 300 requests a minute for this key.', 'No', <>Wait for <C>Retry-After</C> seconds, then retry.</>],
        ['503', 'Receipts cannot be written right now.', 'No', 'Treat as a refusal; retry with backoff.'],
      ]} />
      <Code title="Error body" code={JSON.stringify({ error: 'rate_limited', message: 'More than 300 requests in a minute for this key.', retry_after: 12 }, null, 2)} />
      <Code title="429 headers" code={`HTTP/1.1 429 Too Many Requests\nRetry-After: 12\nRateLimit-Limit: 300\nRateLimit-Remaining: 0`} />

      <H2 id="refusal-ids">System refusal ids</H2>
      <P>Your own rules use their own ids. 17 ids are reserved for refusals Elan1 Govern makes itself, at the step of the <DocLink to="/developers/overview">decision path</DocLink> where they happen:</P>
      <SimpleTable caption="System refusal ids" head={['rule_id', 'Step', 'Means']} rows={[
        [<C>POLICY.TENANT_STOPPED</C>, 'Before 1 · the pilot’s hard stop', <>The organisation’s pilot has reached its hard stop. This is the one refusal that writes no receipt; the stop itself is recorded once. Code <DocLink to="/developers/refusals/POLICY.TENANT_STOPPED">POLICY.TENANT_STOPPED</DocLink>.</>],
        [<C>RECEIPT_WRITE_FAILED</C>, 'Before 1', 'The receipt writer has failed, and the guard runs nothing it cannot record. The refusals are counted and written to the chain once receipts can be written again.'],
        [<C>agent-paused</C>, '1 Identify', 'The agent is paused by its owner, by auto-pause, or by an emergency stop.'],
        [<C>sandbox-limit</C>, '1 Identify · sandbox keys only', <>A sandbox key (<C>sk_sbx_</C>) is over 10 calls a minute, 2 at once or 5,000 a month. The refusal is recorded on a sandbox receipt and never billed. Code <DocLink to="/developers/refusals/GATE.SANDBOX_LIMIT_REACHED">GATE.SANDBOX_LIMIT_REACHED</DocLink>.</>],
        [<C>no-rulebook</C>, '2 Load rulebook', 'The agent has no published rulebook.'],
        [<C>rulebook-invalid</C>, '2 Load rulebook', 'The published rulebook\'s signature does not verify against the organisation\'s key.'],
        [<C>default</C>, '3 Resolve · 6 Decide', 'The tool is unknown, or no rule allows the call. Anything not explicitly allowed is refused.'],
        [<C>tool-disabled</C>, '3 Resolve', <>The tool exists but is switched off on its connector, so it is refused whatever the rulebook allows. New tools from your own MCP servers start switched off. Code <DocLink to="/developers/refusals/GATE.TOOL_DISABLED">GATE.TOOL_DISABLED</DocLink>.</>],
        [<C>invalid-arguments</C>, '4 Validate', 'The arguments do not match the tool\'s schema.'],
        [<C>G1_NO_CONSENT</C>, '6 Decide · consent check (L1+)', <>A call that writes to a person (email, SMS, WhatsApp or a phone call) has no consent on record for the organisation’s contact purpose. The consent check runs once the organisation keeps a consent ledger; it does not run on sandbox calls. Code <DocLink to="/developers/refusals/GATE.CONSENT_MISSING">GATE.CONSENT_MISSING</DocLink>.</>],
        [<C>G1_CHANNEL</C>, '6 Decide · consent check (L1+)', <>Consent is on record, but for other channels, not the one this call uses. Code <DocLink to="/developers/refusals/GATE.CONSENT_MISSING">GATE.CONSENT_MISSING</DocLink>.</>],
        [<C>G1_WITHDRAWN</C>, '6 Decide · consent check (L1+)', <>The person withdrew their consent. Calls before the withdrawal stay as they were recorded. Code <DocLink to="/developers/refusals/GATE.CONSENT_EXPIRED">GATE.CONSENT_EXPIRED</DocLink>.</>],
        [<C>G1_EXPIRED</C>, '6 Decide · consent check (L1+)', <>The consent has expired. Ask the person again before writing to them. Code <DocLink to="/developers/refusals/GATE.CONSENT_EXPIRED">GATE.CONSENT_EXPIRED</DocLink>.</>],
        [<C>pack-gate</C>, '6 Decide · pack checks (L2+)', <>An installed regulatory pack, admitted for this agent, does not admit this write type (for example a delete). At L1 the pack is a dry run: nothing is refused, and the receipt says what would have been. See <DocLink to="/developers/packs">Regulatory packs</DocLink>.</>],
        [<C>pack-declaration</C>, '6 Decide · pack checks (L2+)', 'The write breaks a condition of the pack’s declaration (collect1: outside the contact window, no approved template, or over the daily contact cap). The pack’s own rule is named on the receipt. Where the declaration only needs a named person to decide (above its threshold, or for a write type it always holds), the call is held for a person under this id instead of refused; a hold by your own rulebook already meets it. A dry run at L1.'],
        [<C>autonomy-a0</C>, '6 Decide · autonomy (L3+)', <>The agent holds A0 Observe for this tool, or no person has granted it autonomy for the tool, and the call is not read-only. See <DocLink to="/developers/autonomy">Earned autonomy</DocLink>.</>],
        [<C>gate-error</C>, 'Any', 'Something unexpected failed before the call ran. The call is refused rather than let through. A failure after an allowed call has run is not a refusal: it is recorded as an error outcome.'],
      ]} />
      <Note tone="info">Over MCP, the same refusals arrive as a tool result with <C>isError: true</C>, never as a transport error — see <DocLink to="/developers/mcp">MCP</DocLink>.</Note>
      <P>Each system id maps to a permanent code in the <DocLink to="/developers/refusal-codes">refusal-code register</DocLink> (47 codes in three families — policy, pre-write checks and platform, with the wire prefixes <C>POLICY.*</C>, <C>GATE.*</C> and <C>PLATFORM.*</C>), where every code has its own page with what to do and whether it is billed.</P>
    </>
  );
}

/* ── Versioning and changelog ─────────────────────────────── */

const CHANGES_RAW: { date: string; tag: 'added' | 'changed' | 'deprecated'; text: string }[] = [
  { date: '2026-10-28', tag: 'added', text: 'The developer path to production: a self-serve sandbox tenant (sk_sbx_, metered at 0), the conformance suite C1–C14 with a result file, production keys by request and human review within 2 working days, and promotion from check and record to a governed run after 30 days with a bypass proof.' },
  { date: '2026-10-28', tag: 'added', text: 'The refusal-code register: 47 codes in three families — policy, pre-write checks and platform (wire prefixes POLICY.*, GATE.* and PLATFORM.*) — each with its own page; 5 more at L3. The built-in MCP tool catalogue: 18 read, 10 stage and 6 act tools.' },
  { date: '2026-10-28', tag: 'added', text: 'Control tokens (gctl_) for the control plane and read-only operations tokens (gops_) for verify and scope, issued and revoked by owners and admins; from L2 a control token needs a second owner or admin. The secret is shown once, and every step is a receipt (token.requested, token.approved, token.declined, token.request_withdrawn, token.issued, token.revoked). See REST API › Tokens.' },
  { date: '2026-10-28', tag: 'added', text: 'Approve and Reject buttons on Slack and WhatsApp messages, for rules marked approvable in chat. They decide for the person the message was sent to, and the receipt records the channel. They are never shown for deletes, access or production changes, personal data or calls that need a password step-up, and nothing is approved in chat at Sovereign.' },
  { date: '2026-10-28', tag: 'added', text: 'Evidence bundles carry an optional ninth member, lexicon.json, listed in the signed manifest: the rule and refusal vocabulary the receipts use. Bundles made before it still verify.' },
  { date: '2026-10-28', tag: 'changed', text: 'Regulatory pack checks now decide live calls from L2: a write the declaration does not admit is refused with pack-gate or pack-declaration, and a write that needs a named person is held for one, with the pack’s rule named on the receipt. At L1 they stay a dry run: the receipt notes what would have been refused or held. The consent check (G1_NO_CONSENT, G1_CHANNEL, G1_WITHDRAWN, G1_EXPIRED) runs from L1, and the Errors page now lists all 17 system refusal ids.' },
  { date: '2026-10-28', tag: 'changed', text: 'An L2+ evidence bundle can be exported only once a completed integrity run covers its range. govern verify names its nine report sections: Verdict, Claim, Scope, Integrity, Clause results, First failure, Notes, Limits and Reproduction. Scope lists the write types in range: each tool a decision names, with how many decisions name it.' },
  { date: '2026-10-28', tag: 'added', text: 'A public 404 page: a signed-out visitor to an unknown address sees the ways in (sign in, /verify, /developers) instead of being sent to sign-in.' },
  { date: '2026-10-28', tag: 'deprecated', text: 'Agent keys that start eg_live_ or eg_test_. They keep working until 28 October 2027; responses to them carry Deprecation, Sunset and Link headers.' },
  { date: '2026-10-27', tag: 'added', text: 'Sovereign: air-gapped signed update bundles (verify, stage, apply — each a receipt), local timestamp authorities and deny-all egress.' },
  { date: '2026-10-27', tag: 'added', text: 'L3 Proven: Action Receipts between organisations, selective disclosure packages and the counterparty, regulator and partner portals. POST /v1/receipts/{seq}/issue, GET /v1/disclosures/{token}, POST /v1/verify/action-receipt, /.well-known/action-receipt-keys.' },
  { date: '2026-10-28', tag: 'changed', text: 'Agent keys now start gk_ (production) and sk_sbx_ (sandbox). Approvals can be extended once, with a declared reason. A batch timestamped by only one authority is reported as degraded, not failed. Regulatory packs install from L1 as a dry run; DPDP erasure is available from L1.' },
  { date: '2026-10-27', tag: 'added', text: 'L3 Proven: earned autonomy per agent and tool; decisions carry autonomy { level, grant_id }. No API sets a level: A3 is reached only by a two-person graduation (POST /v1/autonomy/graduations, then /approve by a second person) and a 30-day supervised period. Revoking is one call by one person. A4 and A5 are not yet available.' },
  { date: '2026-10-27', tag: 'added', text: 'L2 Attested: Seal v6 records, Merkle batches with RFC 3161 timestamps from two authorities, GET /v1/receipts/{seq}/proof, and the 8-member evidence bundle from POST /v1/exports.' },
  { date: '2026-10-27', tag: 'changed', text: 'govern verify answers with six result codes (exit 0–5) and a nine-section report; new options --fingerprint, --profile and --report. Exit 2 now means FAIL_PROFILE (it meant “cannot verify”, which is now INCOMPLETE, exit 3).' },
  { date: '2026-10-27', tag: 'added', text: 'Regulatory packs ledger1, invoice1 and collect1 with their verifier profiles (each profile billed as its own line); DPDP erasure by salt destruction; webhook events approval.escalated, timestamp.anchored, counterparty.receipt, erasure.requested, erasure.executed, stop.engaged, stop.lifted and chain.integrity.' },
  { date: '2026-10-27', tag: 'added', text: 'SAML 2.0 sign-in and SCIM 2.0 provisioning (/scim/v2/{org}/Users, /Groups); GET /v1/status.' },
  { date: '2026-10-01', tag: 'added', text: 'GET /v1/approvals/{id} accepts wait up to 30 seconds.' },
  { date: '2026-09-12', tag: 'added', text: 'alert.created webhook event.' },
  { date: '2026-08-20', tag: 'changed', text: 'Webhook deliveries retry up to 8 attempts (was 5).' },
  { date: '2026-07-30', tag: 'added', text: 'MCP tool govern.approval_status long-polls up to 30 seconds.' },
  { date: '2026-06-02', tag: 'added', text: 'First public version of the agent API: /v1/check, /v1/record, /v1/approvals, /v1/openapi.json, /healthz.' },
];

/** Newest first; entries on the same day keep the order they were written in. */
const CHANGES = CHANGES_RAW.map((c, i) => ({ c, i })).sort((a, b) => b.c.date.localeCompare(a.c.date) || a.i - b.i).map(({ c }) => c);

export function Changelog() {
  return (
    <>
      <DocTitle kicker="Reference" title="Versioning and changelog" lead="The agent API is versioned in its path. Additive changes ship without notice; breaking changes get 12 months' notice." />
      <H2 id="policy">Policy</H2>
      <UL>
        <li><strong>Additive</strong> — new fields in responses, new optional request fields, new events, new endpoints. Ship any time. Ignore fields you do not know.</li>
        <li><strong>Breaking</strong> — removing or renaming a field, changing a type or meaning, removing an endpoint. Announced here and by email to every organisation owner at least <strong>12 months</strong> before it takes effect, with the old behaviour kept until then.</li>
        <li><strong>Receipts</strong> — the receipt format and hashing rules are versioned separately; a pack exported today stays verifiable with today's <C>govern verify</C>.</li>
        <li><strong>Refusal codes</strong> — a new code is announced 60 days before it can be raised. Codes are never renumbered or reused.</li>
      </UL>
      <H2 id="deprecation">Deprecation and Sunset headers</H2>
      <P>While a deprecated behaviour still works, every response to a request that uses it carries three headers, so your client can log and alert on them without reading this page:</P>
      <SimpleTable caption="Deprecation headers" head={['Header', 'Standard', 'Means']} rows={[
        [<C key="d">Deprecation</C>, 'RFC 9745', <>When the behaviour was deprecated, as <C>@</C> and a Unix time.</>],
        [<C key="s">Sunset</C>, 'RFC 8594', 'When it stops working, as an HTTP date. At least 12 months after the Deprecation date for anything breaking.'],
        [<C key="l">Link</C>, 'RFC 8288', <>Where to read about it, with <C>rel="deprecation"</C>.</>],
      ]} />
      {DEPRECATIONS.map((d) => {
        const h = deprecationHeaders(d);
        return (
          <div key={d.id}>
            <H3 id={`dep-${d.id}`}>{d.what}</H3>
            <P>Deprecated on {d.deprecatedOn}; stops on {d.sunset}. Use instead: {d.replacement}. Affects: {d.affects}. Try it with the legacy key in the <DocLink to="/developers/api#post-check">POST /v1/check</DocLink> panel.</P>
            <Code title="Response headers" code={`HTTP/1.1 200 OK\nDeprecation: ${h.deprecation}\nSunset: ${h.sunset}\nLink: ${h.link}`} />
          </div>
        );
      })}
      <P>We also email every organisation owner when a behaviour is deprecated, and again 90 and 30 days before its Sunset date, naming the agents and keys that still use it.</P>
      <H2 id="changelog">Changelog</H2>
      <ol className="my-5 border-l border-line">
        {CHANGES.map((c) => (
          <li key={c.date + c.text} className="relative pl-5 pb-5 last:pb-0">
            <span className="absolute -left-[5px] top-1.5 h-[9px] w-[9px] bg-line-strong" aria-hidden />
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[12.5px] text-muted">{c.date}</span>
              <Badge tone={c.tag === 'added' ? 'ok' : c.tag === 'changed' ? 'info' : 'held'}>{c.tag === 'added' ? 'Added' : c.tag === 'changed' ? 'Changed' : 'Deprecated'}</Badge>
            </div>
            <p className="mt-1 text-md text-fg/90">{c.text}</p>
          </li>
        ))}
      </ol>
      <P>Two breaking changes are above. The meaning of <C>govern verify</C> exit code 2 changed in the verifier only; scripts that treated any non-zero exit as a failure are unaffected. In the agent API, keys that start <C>eg_live_</C> or <C>eg_test_</C> stop working on 28 October 2027 — 12 months after they were deprecated, as the policy requires. Until then every response to them carries the Deprecation, Sunset and Link headers shown above. Issue a <C>gk_</C> or <C>sk_sbx_</C> key and rotate before that date. No other breaking change to the agent API is scheduled.</P>
    </>
  );
}
