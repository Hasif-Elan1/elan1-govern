import { DocTitle, H2, H3, P, C, CodeTabs, Note, DocLink, FieldsTable, SimpleTable, Endpoint, BASE, TEST_KEY } from '../docs';
import { CheckTry, RecordTry, ApprovalTry, OpenApiTry, HealthTry } from '../TryIt';

const j = (x: unknown) => JSON.stringify(x, null, 2);

export function ApiReference() {
  return (
    <>
      <DocTitle kicker="Connect" title="REST API" lead="Agent-facing paths for check and record, and evidence paths for receipts, proofs and exports. Elan1 Govern advises and records; your agent holds its own credentials and runs the call. Base URL https://govern.elan1.ai." />
      <SimpleTable caption="Paths" head={['Path', 'Use']} rows={[
        [<a href="#post-check" className="font-mono text-[12.5px] hover:underline">POST /v1/check</a>, 'Ask for a decision before a tool call.'],
        [<a href="#post-record" className="font-mono text-[12.5px] hover:underline">POST /v1/record</a>, 'Record the outcome after you ran an allowed call.'],
        [<a href="#get-approval" className="font-mono text-[12.5px] hover:underline">GET /v1/approvals/&#123;id&#125;</a>, 'Read or wait for a person\'s decision.'],
        [<a href="#evidence-paths" className="font-mono text-[12.5px] hover:underline">GET /v1/receipts/&#123;seq&#125;[/proof]</a>, 'A receipt with its seal, and its inclusion proof with both timestamps (L2+).'],
        [<a href="#evidence-paths" className="font-mono text-[12.5px] hover:underline">POST /v1/exports</a>, 'The auditor pack, or the 8-member evidence bundle from L2.'],
        [<a href="#get-openapi" className="font-mono text-[12.5px] hover:underline">GET /v1/openapi.json</a>, 'The OpenAPI 3.1 document for every public path, including counterparties, autonomy and SCIM.'],
        [<a href="#get-healthz" className="font-mono text-[12.5px] hover:underline">GET /healthz</a>, 'Liveness, and whether receipts can be written.'],
      ]} />
      <P>Authenticate every call with the agent key: <C>Authorization: Bearer gk_…</C> in production, <C>sk_sbx_…</C> in the sandbox. Bodies are JSON. 300 requests a minute per key; see <DocLink to="/developers/errors">Errors</DocLink>.</P>

      {/* token classes */}
      <H2 id="tokens">Tokens: agent keys, control and operations</H2>
      <P>There are 3 token classes, and no fourth. Each one says what it is by its prefix, so a leaked token is easy to recognise.</P>
      <SimpleTable caption="Token classes" head={['Class', 'Prefix', 'Can call', 'Cannot call']} rows={[
        ['Agent key (tenant token)', <C key="p">gk_ · sk_sbx_</C>, 'Check and record, approvals, receipts and proofs for its own organisation. One organisation, one agent, one autonomy level.', 'The control plane. It is the only class that reaches the write endpoints.'],
        ['Control token', <C key="p">gctl_</C>, 'The control plane: define, which registers a write type at a declaration version. Each registration is a governed write under dual control.', 'Any record store or write endpoint, including check and record.'],
        ['Read-only operations token', <C key="p">gops_</C>, 'Verify and scope, for monitoring and operations.', 'Anything that changes state. It sees no organisation data.'],
      ]} />
      <H3 id="tokens-issue">Who issues them</H3>
      <P>Agents never use a control or operations token; an agent calls with its agent key. Owners and admins issue, list and revoke control and operations tokens in the console, under Agents › Keys › Platform tokens. Each token has a label saying where it is used, and an expiry of 30 days, 90 days, 1 year or none.</P>
      <P>From L2, a control token needs a second person. One owner or admin asks for it, a different owner or admin approves or declines it, and then it is collected once. The person who asked cannot approve their own request, and can withdraw it while it waits for a second person. Once it is approved, it can only be collected and then revoked. At L1, and for an operations token at every level, one owner or admin issues the token straight away. A Sovereign deployment issues and checks these tokens inside its own network under the same rules.</P>
      <H3 id="tokens-secret">The secret is shown once</H3>
      <P>The full token is shown once, when it is issued or collected. Elan1 Govern keeps only a hash and the prefix. Store it in your secret manager; if you lose it, revoke it and issue a new one.</P>
      <H3 id="tokens-revoke">Revoking</H3>
      <P>One owner or admin can revoke an active token at once, with an optional reason. Calls with it are refused from the next call. A revocation cannot be undone; issue a new token instead. An expired token is refused in the same way.</P>
      <H3 id="tokens-receipts">Receipts</H3>
      <P>Every step writes a receipt to the organisation’s chain, naming the person, the class and the label, never the secret:</P>
      <SimpleTable caption="Token receipts" head={['Receipt', 'Written when']} rows={[
        [<C key="r">token.requested</C>, 'A control token is asked for from L2 (dual control).'],
        [<C key="r">token.approved</C>, 'A second owner or admin approves the request.'],
        [<C key="r">token.declined</C>, 'A second owner or admin declines it, with the reason.'],
        [<C key="r">token.request_withdrawn</C>, 'The requester withdraws the request before a second person decides on it.'],
        [<C key="r">token.issued</C>, 'The secret is generated: issued straight away, or collected after approval. It records the prefix, the class, the label, the expiry and, under dual control, who asked and who approved.'],
        [<C key="r">token.revoked</C>, 'An active token is revoked, with the reason if one was given.'],
      ]} />

      {/* /v1/check */}
      <H2 id="post-check">POST /v1/check</H2>
      <Endpoint method="POST" path="/v1/check" note="Writes one decision receipt" />
      <P>Send the tool name and its arguments before you call the tool. The answer is always HTTP 200 with a decision — a refusal is a decision, not an error.</P>
      <H3 id="check-request">Request</H3>
      <FieldsTable caption="Check request fields" rows={[
        { name: 'tool', type: 'string', required: true, desc: <>The tool name as the rulebook knows it, such as <C>zoho_books.record_payment</C>.</> },
        { name: 'args', type: 'object', required: true, desc: 'The arguments you are about to send. Rules read fields from here. Only the values a rule inspects, and display identifiers, are kept in the receipt.' },
        { name: 'context.run_id', type: 'string', desc: 'Your id for the agent run, echoed into the receipt details.' },
      ]} />
      <CodeTabs samples={[
        { key: 'curl', lang: 'curl', label: 'curl', code: `curl -X POST ${BASE}/v1/check \\\n  -H "Authorization: Bearer ${TEST_KEY}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"tool": "zoho_books.record_payment", "args": {"vendor": "Kalyani Metals", "amount": 240000, "bill": "BILL-2026-0419"}}'` },
        { key: 'ts', lang: 'typescript', label: 'TypeScript', code: `import { Govern } from '@elan1/govern';\n\nconst govern = new Govern({ apiKey: process.env.ELAN1_GOVERN_KEY! });\n\nconst d = await govern.check('zoho_books.record_payment', {\n  vendor: 'Kalyani Metals', amount: 240000, bill: 'BILL-2026-0419',\n});\nif (d.decision !== 'allow') throw new Error(\`\${d.decision}: \${d.reason}\`);` },
        { key: 'py', lang: 'python', label: 'Python', code: `from elan1_govern import Govern\n\ngovern = Govern(api_key=os.environ["ELAN1_GOVERN_KEY"])\n\nd = govern.check("zoho_books.record_payment",\n                 {"vendor": "Kalyani Metals", "amount": 240000, "bill": "BILL-2026-0419"})\nif d.decision != "allow":\n    raise RuntimeError(f"{d.decision}: {d.reason}")` },
      ]} />
      <H3 id="check-response">Response</H3>
      <FieldsTable caption="Check response fields" rows={[
        { name: 'decision', type: '"allow" | "ask" | "refuse"', desc: 'Run only on allow.' },
        { name: 'rule_id', type: 'string', desc: <>The rule that decided, or a system refusal id such as <C>default</C>.</> },
        { name: 'reason', type: 'string', desc: 'The rule\'s own words. Safe to show to the person using the agent.' },
        { name: 'receipt.seq', type: 'integer', desc: <>The decision receipt. Pass it to <C>/v1/record</C>.</> },
        { name: 'receipt.hash', type: 'string', desc: 'SHA-256 of the receipt in canonical JSON.' },
        { name: 'rulebook', type: '{ version, hash }', desc: 'The published rulebook version that decided (from L2 that version is also signed).' },
        { name: 'approval', type: 'object', desc: <>On ask: <C>id</C>, <C>status</C>, <C>approver_group</C>, <C>expires_at</C> and <C>poll_url</C>.</> },
        { name: 'receipt.seal', type: 'object', desc: <>L2+: the Seal v6 digest and key (<C>elan1.seal.v6</C>). See <DocLink to="/developers/seal">Seal v6</DocLink>.</> },
        { name: 'receipt.anchor', type: 'object', desc: <>L2+: <C>pending</C> until the 15-minute batch closes, then <C>anchored</C> with its batch id.</> },
        { name: 'autonomy', type: 'object', desc: <>L3+: the autonomy level in force, reached by graduation, applied after the rulebook decided — <C>level</C>, <C>grant_id</C>, <C>changed_decision</C>, and <C>supervised: true</C> during the 30-day supervised period. See <DocLink to="/developers/autonomy">Earned autonomy</DocLink>.</> },
      ]} />
      <CodeTabs samples={[
        { key: 'allow', label: 'allow', title: '200 OK', code: j({ decision: 'allow', rule_id: 'pay-small', reason: 'Small payments to approved vendors run within the daily cap.', mode: 'check_and_record', receipt: { seq: 6217, hash: '9c1e…' }, rulebook: { version: 7, hash: 'a41f…' } }) },
        { key: 'ask', label: 'ask', title: '200 OK', code: j({ decision: 'ask', rule_id: 'pay-large', reason: 'Payments over ₹50,000 need the finance controller.', mode: 'check_and_record', receipt: { seq: 6218, hash: '0be3…' }, approval: { id: 'apr_9f2k1c', status: 'pending', approver_group: 'finance', expires_at: '2026-10-28T09:14:03Z', poll_url: '/v1/approvals/apr_9f2k1c?wait=30' } }) },
        { key: 'refuse', label: 'refuse', title: '200 OK', code: j({ decision: 'refuse', rule_id: 'no-deletes', reason: 'Bills are cancelled by a person in Zoho Books, never deleted by an agent.', mode: 'check_and_record', receipt: { seq: 6219, hash: '5d70…' } }) },
      ]} />
      <H3 id="check-errors">Errors</H3>
      <SimpleTable caption="Check errors" head={['Status', 'When', 'Receipt']} rows={[
        ['400', 'The body is not JSON, or tool / args are missing.', 'None'],
        ['401', 'The key is missing, unknown or revoked.', 'None'],
        ['429', 'More than 300 requests in a minute. Read Retry-After.', 'None'],
        ['200 refuse', <>Arguments fail the tool schema: <C>invalid-arguments</C>. Any other refusal also arrives as 200.</>, 'Yes'],
      ]} />
      <CheckTry />

      {/* /v1/record */}
      <H2 id="post-record">POST /v1/record</H2>
      <Endpoint method="POST" path="/v1/record" note="Writes one outcome receipt" />
      <P>After you run an allowed — or approved — call, record what happened. The outcome receipt points back to the decision with <C>ref_seq</C>, so the chain shows both the advice and what the agent did with it.</P>
      <FieldsTable caption="Record request fields" rows={[
        { name: 'receipt_seq', type: 'integer', required: true, desc: <>The <C>receipt.seq</C> from <C>/v1/check</C>.</> },
        { name: 'status', type: '"ok" | "error"', required: true, desc: 'Whether the call succeeded.' },
        { name: 'ref', type: 'string', desc: 'Your system\'s id for the result, such as a payment id.' },
        { name: 'ms', type: 'integer', desc: 'How long the call took.' },
        { name: 'error', type: 'string', desc: 'A short error message when status is error. Do not send personal data.' },
      ]} />
      <CodeTabs samples={[
        { key: 'curl', lang: 'curl', label: 'curl', code: `curl -X POST ${BASE}/v1/record \\\n  -H "Authorization: Bearer ${TEST_KEY}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"receipt_seq": 6217, "status": "ok", "ref": "zoho:pay_884120", "ms": 412}'` },
        { key: 'ts', lang: 'typescript', label: 'TypeScript', code: `await govern.record(d.receipt.seq, { status: 'ok', ref: 'zoho:pay_884120', ms: 412 });` },
        { key: 'py', lang: 'python', label: 'Python', code: `govern.record(d.receipt.seq, status="ok", ref="zoho:pay_884120", ms=412)` },
      ]} />
      <SimpleTable caption="Record responses" head={['Status', 'Meaning']} rows={[
        ['201', <>Recorded. Body: <C>{'{ "recorded": true, "seq": 6220, "ref_seq": 6217 }'}</C></>],
        ['404', 'No decision with that sequence number for this agent.'],
        ['409', 'An outcome for that decision was already recorded. Each decision has one outcome.'],
      ]} />
      <RecordTry />

      {/* approvals */}
      <H2 id="get-approval">GET /v1/approvals/&#123;id&#125;</H2>
      <Endpoint method="GET" path="/v1/approvals/{id}?wait=30" />
      <P>Read an approval raised by an ask. With <C>wait</C> (0–30 seconds) the request is held open while it is pending and returns as soon as a person decides. Expiry is a refusal: an approval nobody decides in time comes back <C>expired</C>, and you must not run the call. An approver may extend a pending approval once, with a declared reason; the extension is recorded and moves <C>expires_at</C>.</P>
      <FieldsTable caption="Approval fields" rows={[
        { name: 'status', type: '"pending" | "approved" | "rejected" | "expired"', desc: 'Run the held call only on approved, then record the outcome.' },
        { name: 'approver_group', type: 'string', desc: 'The group the rule names, such as finance.' },
        { name: 'expires_at', type: 'date-time', desc: 'Default 24 hours after the ask; at most 30 days. Moves once if an approver declares an extension.' },
        { name: 'extended', type: '{ by, reason, at } | null', desc: 'The one declared extension, if any. A second extension is refused.' },
        { name: 'decided_at · channel', type: 'date-time · string', desc: 'When and where a person decided: web, email, slack or whatsapp.' },
        { name: 'receipt_seq · result_seq', type: 'integer', desc: 'The ask\'s decision receipt, and the approval receipt that resolved it.' },
      ]} />
      <CodeTabs samples={[
        { key: 'curl', lang: 'curl', label: 'curl', code: `curl "${BASE}/v1/approvals/apr_9f2k1c?wait=30" \\\n  -H "Authorization: Bearer ${TEST_KEY}"` },
        { key: 'ts', lang: 'typescript', label: 'TypeScript', code: `const a = await govern.waitForApproval(d.approval!.id, { timeoutMs: 15 * 60_000 });\nif (a.status === 'approved') {\n  const r = await pay(args);\n  await govern.record(d.receipt.seq, { status: 'ok', ref: r.id });\n}` },
        { key: 'py', lang: 'python', label: 'Python', code: `a = govern.wait_for_approval(d.approval.id, timeout=15 * 60)\nif a.status == "approved":\n    r = pay(args)\n    govern.record(d.receipt.seq, status="ok", ref=r.id)` },
      ]} />
      <ApprovalTry />

      {/* evidence paths */}
      <H2 id="evidence-paths">Receipts, proofs and exports</H2>
      <Endpoint method="GET" path="/v1/receipts/{seq}" note="Agent or organisation key" />
      <P>The receipt as written to the chain, its assurance level and — from L2 — its signed Seal v6 record and anchor state. Records from before the L2 boundary come back with <C>level: l1</C> and no seal: sealed in a hash chain, not externally timestamped. That is what they are, not a failure.</P>
      <Endpoint method="GET" path="/v1/receipts/{seq}/proof" note="L2+" />
      <P>The Merkle path from the receipt’s leaf to its batch root and both RFC 3161 tokens. A receipt still in the open window answers 409 with <C>unanchored_tail</C>; ask again after the batch closes (at most 15 minutes).</P>
      <CodeTabs samples={[
        { key: 'curl', lang: 'curl', label: 'curl', code: `curl ${BASE}/v1/receipts/1638/proof \\\n  -H "Authorization: Bearer ${TEST_KEY}"` },
        { key: 'ts', lang: 'typescript', label: 'TypeScript', code: `const p = await govern.proof(1638);\nconsole.log(p.root, p.tokens.map((t) => t.tsaName)); // two authorities` },
        { key: 'py', lang: 'python', label: 'Python', code: `p = govern.proof(1638)\nprint(p.root, [t.tsa_name for t in p.tokens])` },
      ]} />
      <Endpoint method="POST" path="/v1/exports" note="Organisation key · owner, admin or auditor" />
      <P>Exports the range you ask for: the L1 auditor pack, or from L2 the 8-member evidence bundle as a ZIP, optionally claiming a verifier profile. The export writes <C>evidence.exported</C>. The L1 auditor pack is free; each L2+ evidence bundle is billed at ₹2,500. Check it with <DocLink to="/developers/verifier">govern verify</DocLink> or the <DocLink to="/verify">public verifier</DocLink>.</P>
      <Note tone="neutral">Paths for counterparties (<C>/v1/receipts/&#123;seq&#125;/issue</C>, <C>/v1/verify/action-receipt</C>, <C>/v1/disclosures/&#123;token&#125;</C>), autonomy graduations and SCIM are in the OpenAPI document and on their own pages: <DocLink to="/developers/cross-org">Action Receipts</DocLink>, <DocLink to="/developers/autonomy">Earned autonomy</DocLink>, <DocLink to="/developers/identity">SCIM</DocLink>.</Note>

      {/* openapi */}
      <H2 id="get-openapi">GET /v1/openapi.json</H2>
      <Endpoint method="GET" path="/v1/openapi.json" note="No key needed" />
      <P>The OpenAPI 3.1 document for every public path: check and record, approvals, receipts and proofs, exports, counterparties and disclosures, autonomy graduations, status and SCIM. Generate a client from it, or load it into your API tool. Console paths are not part of it and are not a public API.</P>
      <OpenApiTry />

      {/* healthz */}
      <H2 id="get-healthz">GET /healthz</H2>
      <Endpoint method="GET" path="/healthz" note="No key needed" />
      <P>Returns 200 while Elan1 Govern can decide and write receipts. If receipts cannot be written it returns 503, and every check is refused with <C>gate-error</C> until it clears — a decision that cannot be recorded is not given.</P>
      <HealthTry />
      <Note tone="neutral">The Try it panels run in your browser against the demo organisation. They do not write to its chain or contact any server.</Note>
    </>
  );
}
