import { tagLabel, HIGH_IMPACT_TAGS } from '@/lib/format';
import { Badge } from '@/components/ui';
import { DocTitle, H2, H3, P, UL, C, Code, Note, DocLink, FieldsTable, SimpleTable } from '../docs';

const EXAMPLE = `# Rulebook for invoice-bot — published, then verified on every call (from L2 also signed on publish).
# Anything no rule allows is refused.
version: 7
agent: invoice-bot
owner: rahul.menon@demotraders.in
default: refuse
approvers:
  finance: [venkat.iyer@demotraders.in, tom.whitfield@demotraders.eu]
lists:
  approved_vendors: [northwind, kalyanimetals, suryapack]
rules:
  - id: read-ledger
    tag: reads_data
    decide: allow
    reason: Reading invoices and the AP inbox is routine.

  - id: pay-small
    tag: moves_money
    when:
      amount: { lte: 50000 }
      vendor: { in: [approved_vendors] }
    decide: allow
    quota: { max_sum: 300000, field: amount, per: day }
    reason: Small payments to approved vendors run within the daily cap.

  - id: pay-large
    tag: moves_money
    when: { amount: { gt: 50000 } }
    decide: ask
    approver: finance
    expires_in: 24h
    approve_in_chat: false
    reason: Payments over ₹50,000 need the finance controller.

  - id: no-deletes
    tag: deletes
    decide: refuse
    reason: Bills are cancelled by a person in Zoho Books, never deleted by an agent.`;

export function Rulebooks() {
  return (
    <>
      <DocTitle kicker="Rules" title="Rulebook YAML" lead="One rulebook per agent, written in YAML, published and verified on every call; from L2 each published version is also signed. The default is always refuse: an agent can do only what a rule allows." />
      <Code title="invoice-bot.yaml" code={EXAMPLE} maxHeight={520} />

      <H2 id="top-level">Top-level fields</H2>
      <FieldsTable caption="Rulebook fields" rows={[
        { name: 'version', type: 'integer', required: true, desc: 'Increases with every publish. Every version is kept and can be compared.' },
        { name: 'agent', type: 'string', required: true, desc: 'The agent slug this rulebook governs.' },
        { name: 'owner', type: 'email', required: true, desc: 'The person accountable for the rules.' },
        { name: 'default', type: '"refuse"', required: true, desc: 'Always refuse. It cannot be changed.' },
        { name: 'approvers', type: 'map', desc: 'Named groups of people, by email. Ask rules name a group.' },
        { name: 'lists', type: 'map', desc: 'Named lists — known counterparties, domains, accounts — that conditions can refer to by name.' },
        { name: 'rules', type: 'list', required: true, desc: 'The rules, below. Order matters only to break ties.' },
        { name: 'declaration', type: 'object', desc: <>Added by a <DocLink to="/developers/packs">regulatory pack</DocLink> (from L1 as a dry run, live from L2): <C>id</C>, <C>version</C>, <C>write_types</C>, <C>fields</C> and <C>dual_control_above</C>. From L2 sealed into F06 and F07 of every record.</> },
        { name: 'signature', type: 'object', desc: 'Added on publish: the version’s hash and, from L2, the key id and Ed25519 signature. You do not write it.' },
      ]} />

      <H2 id="rule-fields">Rule fields</H2>
      <FieldsTable caption="Rule fields" rows={[
        { name: 'id', type: 'string', required: true, desc: 'Shown in every receipt it decides. Keep it short and stable.' },
        { name: 'tool | tag', type: 'string', required: true, desc: <>Match one tool by name, or every tool carrying a <DocLink to="/developers/risk-tags">risk tag</DocLink>. Exactly one of the two.</> },
        { name: 'when', type: 'map', desc: 'Conditions on the arguments. All must hold. A rule whose field is missing does not match.' },
        { name: 'unless', type: 'map', desc: 'Ask rules only. The ask stands aside when every exception holds; a missing value never holds.' },
        { name: 'decide', type: '"allow" | "ask" | "refuse"', required: true, desc: 'The answer when the rule matches.' },
        { name: 'approver', type: 'string', desc: 'For ask: the approver group.' },
        { name: 'expires_in', type: 'duration', desc: 'For ask: how long a person has. Default 24h, at most 30d. An approver may extend it once, with a declared reason that is recorded. Expiry is a refusal.' },
        { name: 'approve_in_chat', type: 'boolean', desc: 'For ask: put Approve and Reject buttons on the Slack or WhatsApp message about the held call, so the person it was sent to can decide there. Default false. Never at Sovereign (deny-all egress), on calls tagged deletes, changes_access, changes_production or personal_data, or where approving asks for the password again; those messages carry a link to open the call in Elan1 Govern instead. Limits below.' },
        { name: 'quota', type: 'object', desc: 'A count or a sum per window. See quotas.' },
        { name: 'reason', type: 'string', required: true, desc: 'Plain words, shown to the agent, the approver and the auditor.' },
      ]} />

      <H2 id="operators">The 8 condition operators</H2>
      <SimpleTable caption="Condition operators" head={['Operator', 'Holds when', 'Example']} rows={[
        [<C>eq</C>, 'The value equals (text compared without case).', <C>{'template: { eq: final_notice }'}</C>],
        [<C>lt</C>, 'Less than.', <C>{'amount: { lt: 10000 }'}</C>],
        [<C>lte</C>, 'Less than or equal.', <C>{'amount: { lte: 50000 }'}</C>],
        [<C>gt</C>, 'Greater than.', <C>{'amount: { gt: 50000 }'}</C>],
        [<C>gte</C>, 'Greater than or equal.', <C>{'approvals: { gte: 1 }'}</C>],
        [<C>in</C>, 'The value is in a list, or a named list.', <C>{'vendor: { in: [approved_vendors] }'}</C>],
        [<C>to_domain_in</C>, 'An email address\'s domain is in the list.', <C>{'to: { to_domain_in: [northwind.in] }'}</C>],
        [<C>fields_include</C>, 'Every named field is present in the arguments.', <C>{'fields_include: [bank_account, ifsc]'}</C>],
      ]} />

      <H2 id="quotas">Quotas</H2>
      <P>A quota counts calls, or sums a field, per window. The window is a calendar day at the organisation's midnight, or a rolling period such as <C>30m</C>, <C>1h</C> or <C>7d</C>.</P>
      <Code title="Quotas" code={`quota: { max_count: 120, per: day }                 # 120 reminders a day\nquota: { max_sum: 500000, field: amount, per: day }  # ₹5 lakh a day\nquota: { max_count: 50, per: 1h }                   # 50 emails an hour`} />
      <P>Limits only tighten. A call over its quota turns an allow into an ask — or into a refuse when the rule has no approver group. A limit never loosens a decision.</P>

      <H2 id="evaluation">How the decision is made</H2>
      <UL>
        <li>Every rule whose tool or tag matches, and whose conditions hold, is a candidate.</li>
        <li><strong>Strictest wins:</strong> refuse beats ask, ask beats allow. Between equals, the first rule in the file decides.</li>
        <li><strong>Default refuse:</strong> if no rule matches, the call is refused with rule id <C>default</C>.</li>
        <li>The decision is a pure function — the same rulebook, tool and arguments always give the same answer. That is what makes <em>Test on past actions</em> exact.</li>
      </UL>

      <H3 id="approve-in-chat">approve_in_chat limits</H3>
      <P>Chat buttons are a doorbell, not a replacement for the console. Publishing refuses <C>approve_in_chat: true</C> on a rule that can reach a tool tagged <C>deletes</C>, <C>changes_access</C>, <C>changes_production</C> or <C>personal_data</C>, and on money-moving tools unless the rule sets an upper amount. It never applies when a quota caused the ask.</P>
      <P>Where it applies, Slack and WhatsApp messages alike carry Approve and Reject buttons. They decide only for the person the message was sent to (their confirmed Slack email, or the WhatsApp number they verified with a code), so they are left off at Sovereign (deny-all egress, where nothing goes to Slack or WhatsApp), on calls tagged with any of those 4 tags, and where approving asks for the password again. Those messages carry a link to open the call in Elan1 Govern instead. Email always carries a single-use link.</P>

      <H3 id="publish-checks">Checks on publish</H3>
      <UL>
        <li>Tool names must exist in the agent's registry.</li>
        <li>A high-risk agent must have an ask rule covering its high-impact tags.</li>
        <li>Publishing needs an owner or admin, and the publish is itself a receipt; from L2 the version is also signed with the organisation's key.</li>
        <li><strong>Dual control.</strong> From L2 Attested a version is published only after a <em>different</em> person approves its review (Work › Reviews); the reviewer cannot also publish, and a draft that changes after review needs a fresh one. At L1 the reviewer is recorded on the publish receipt but not required.</li>
        <li>A rulebook carrying a regulatory pack’s declaration must keep every write type the declaration lists covered by a rule.</li>
      </UL>
      <H3 id="autonomy">Autonomy is earned, not written</H3>
      <P>The autonomy level is not a rulebook field, and no API or setting sets it directly. From L3 every move up is a graduation that one person proposes and a different person approves. A3, for one action class, needs at least 90 days, 200 records and 100 approvals for that class, and is followed by a 30-day supervised period that samples 1 in 10 calls. Revoking is one press by one person. The guard applies the level after the rulebook decides: A0 refuses writes, A1 and A2 hold allowed writes for a person, A3 leaves the rulebook’s answer alone. A refusal is never relaxed. A4 and A5 are not yet available. See <DocLink to="/developers/autonomy">Earned autonomy</DocLink>.</P>
      <Note tone="info">Draft, try one call, test on 7 or 30 days of past actions, compare versions, request a review, then publish — all in the console; from L2 publishing also signs the version. A test never publishes or signs anything.</Note>
    </>
  );
}

const TAG_TEXT: Record<string, string> = {
  reads_data: 'Reads records, messages or files. No change anywhere.',
  writes_data: 'Creates or changes records in a system you own.',
  moves_money: 'Pays, transfers, refunds or changes where money goes.',
  sends_external: 'Sends something outside the organisation: email, message, post.',
  personal_data: 'Touches data about a person — CVs, contacts, health, bank details.',
  deletes: 'Removes something that cannot be restored from the tool itself.',
  changes_access: 'Grants or removes someone\'s access or permissions.',
  changes_production: 'Deploys, merges to main or changes a live system.',
};

export function RiskTags() {
  const tags = Object.keys(tagLabel);
  return (
    <>
      <DocTitle kicker="Rules" title="Risk tags" lead="Every tool carries one or more of 8 risk tags. A rule can match a tag instead of naming tools, so a new tool is governed the moment it is tagged." />
      <SimpleTable caption="Risk tags" head={['Tag', 'Meaning', 'Impact']} rows={tags.map((t) => [
        <span className="font-mono text-[12.5px]">{t}</span>,
        <span><strong className="font-medium">{tagLabel[t]}.</strong> {TAG_TEXT[t]}</span>,
        HIGH_IMPACT_TAGS.includes(t) ? <Badge tone="accent">High impact</Badge> : <span className="text-muted text-xs">Standard</span>,
      ])} />
      <H2 id="high-impact">High-impact tags</H2>
      <P>4 tags are high impact: <C>moves_money</C>, <C>deletes</C>, <C>changes_access</C> and <C>changes_production</C>. A high-risk agent cannot publish a rulebook unless an ask rule covers them, and chat approval is limited for them.</P>
      <H2 id="tagging">Tagging tools</H2>
      <UL>
        <li>Built-in tools come tagged. <C>zoho_books.record_payment</C> is <C>moves_money</C> and <C>writes_data</C>.</li>
        <li>Tools from your MCP servers arrive switched off with suggested tags. A person confirms the tags and enables each tool.</li>
        <li>Match by tag for breadth (<C>tag: moves_money</C>), by tool for precision (<C>tool: gmail.send_email</C>). The strictest matching rule still wins.</li>
      </UL>
    </>
  );
}
