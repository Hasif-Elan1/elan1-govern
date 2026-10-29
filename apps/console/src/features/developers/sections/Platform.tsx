import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { SEAL_FIELDS } from '@/lib/seal';
import { BUNDLE_MEMBERS, CODE_LABELS, EXIT_CODES, LEXICON_MEMBER } from '@/lib/verify6';
import { PROFILES } from '@/lib/profiles';
import { PACKS } from '@/lib/packs';
import { AUTONOMY_LEVELS } from '@/lib/autonomy';
import { DISCLOSABLE_FIELDS, FIELD_LABELS } from '@/lib/disclosure';
import { PLANS } from '@/lib/pricing';
import { LEGAL_ENTITY } from '@/lib/company';
import { rupees, rupeesShort } from '@/lib/format';
import type { VerifyCode } from '@/types';
import { Badge, LegalDraft } from '@/components/ui';
import { DocTitle, H2, H3, P, UL, OL, C, Code, Note, DocLink, FieldsTable, SimpleTable, Endpoint } from '../docs';

const j = (x: unknown) => JSON.stringify(x, null, 2);

/* ── Seal v6 and the evidence bundle ──────────────────────── */

const SEAL_EXAMPLE = {
  format: 'elan1.seal.v6', seq: 1638, receiptHash: '4f0c…e91a', level: 'l2',
  fields: [
    { id: 'F01', name: 'tenant_id', value: 'org_northbank' }, { id: 'F02', name: 'seq', value: '1638' }, { id: 'F03', name: 'prev_digest', value: '9b1d…07c2' },
    { id: 'F04', name: 'write_id', value: 'w_4f0ce91a…' }, { id: 'F05', name: 'write_type', value: 'zoho_books.record_payment' }, { id: 'F06', name: 'declaration_id', value: 'decl.ledger1' },
    { id: 'F07', name: 'declaration_version', value: '1' }, { id: 'F08', name: 'policy_version', value: '12' }, { id: 'F09', name: 'actor_id', value: 'ap-agent' },
    { id: 'F10', name: 'actor_kind', value: 'agent' }, { id: 'F11', name: 'autonomy_level', value: 'A3' }, { id: 'F12', name: 'record_id', value: 'BILL-2026-0419' },
    { id: 'F13', name: 'record_version', value: '1' }, { id: 'F14', name: 'payload_hash', value: 'salted:6d2a…' }, { id: 'F15', name: 'lexicon_hash', value: 'c31e…' }, { id: 'F16', name: 'recorded_at', value: '2026-10-27T09:14:03.412Z' },
  ],
  preimageBytes: 812, digest: 'b7e2…44f0', kid: 'k_northbank_kms_2', sig: '3a90…',
};

export function Seal() {
  return (
    <>
      <DocTitle kicker="Events and evidence · L2" title="Seal v6 and the evidence bundle" lead="From L2 Attested every receipt is also sealed: 16 frozen fields, hashed over a length-prefixed preimage and signed with Ed25519 by a key in AWS KMS. Two independent implementations agree on every byte." />
      <H2 id="fields">The 16 frozen fields</H2>
      <FieldsTable caption="Seal v6 fields" nameHeader="Field" rows={SEAL_FIELDS.map((f) => ({ name: `${f.id} ${f.name}`, type: f.id === 'F02' || f.id === 'F07' || f.id === 'F13' ? 'integer as text' : 'text', desc: f.description }))} />
      <H2 id="preimage">The preimage and the digest</H2>
      <OL>
        <li>Take the 16 values in order F01 to F16, each as UTF-8 text.</li>
        <li>Prefix each with its length as a 4-byte big-endian unsigned integer, and concatenate. No separators, no escaping: a value can never be read as part of its neighbour.</li>
        <li><C>digest</C> = SHA-256 over those bytes, lower-case hex.</li>
        <li><C>sig</C> = Ed25519 over the digest, by the key in <C>kid</C>. <C>F03 prev_digest</C> is the digest of the seal before, so seals chain just as receipts do.</li>
        <li><C>F14 payload_hash</C> is salted: SHA-256 over a per-subject salt and the payload. Destroying the salt (a DPDP erasure) makes the payload unlinkable while the seal and the chain still verify.</li>
      </OL>
      <Code title="A seal (seals.jsonl, one per line)" code={j(SEAL_EXAMPLE)} maxHeight={420} />
      <H2 id="two-implementations">Two implementations, 64 test vectors</H2>
      <P>The sealing code exists twice — TypeScript in the service and the browser verifier, and an independent Python implementation — and both run the same 64 published test vectors: 12 structure, 12 chain, 12 Merkle and anchor, and 28 negative vectors that must be rejected. A release ships only when both agree byte for byte.</P>
      <Code title="Terminal" code={`govern vectors run --impl ts        # 64 of 64 pass\npython -m elan1_seal.vectors          # 64 of 64 pass\ngovern vectors diff ts.json py.json   # 0 differences`} />
      <H2 id="bundle">The evidence bundle: 8 members and the lexicon</H2>
      <P>From L2 an export is an evidence bundle (<C>elan1.evidence.bundle.v1</C>), a superset of the L1 auditor pack. It is a ZIP with 8 required members and, in bundles made from 28 October 2026, a ninth optional member, <C>{LEXICON_MEMBER}</C>; the manifest lists each member’s SHA-256 and is itself signed. Each evidence bundle is billed at {rupees(2500)}; the L1 auditor pack is free.</P>
      <SimpleTable caption="Evidence bundle members" head={['Member', 'Holds']} rows={[...BUNDLE_MEMBERS, LEXICON_MEMBER].map((m) => [<C>{m}{m === LEXICON_MEMBER ? ' (optional)' : ''}</C>, ({
        'manifest.json': 'Format, organisation, range, record and refusal counts, assurance levels by range, key fingerprints, member digests, the profile claimed, and the manifest signature.',
        'receipts.jsonl': 'Every receipt in the range, one per line — the same receipts an L1 pack carries.',
        'seals.jsonl': 'A Seal v6 record for every receipt made at L2 or above.',
        'checkpoints.json': 'Signed checkpoints whose head is in the range.',
        'anchors.json': 'The timestamp authorities, and every Merkle batch with its leaves, root and two RFC 3161 tokens.',
        'keys.json': 'Every public key that signed something in the range.',
        'declarations.json': 'The rulebook versions used, and the declarations of any regulatory pack.',
        'profile/ (profile.json + VERIFY.txt)': 'The verifier profile claimed (if any) and plain instructions for the person checking it.',
        'lexicon.json': 'The rule and refusal vocabulary the receipts use: what each decision means, every rule id with its rule, and the refusal codes they stand for. Optional, and added beside the 8 members, never in place of one. When the signed manifest lists it, its digest is checked like any other member’s. A bundle without it still verifies; the report says so in a note.',
      } as Record<string, string>)[m] ?? ''])} />
      <H3 id="boundary">The L1 → L2 boundary</H3>
      <P>Records keep the level they were made at. A bundle that spans the move lists both ranges in <C>assurance_levels</C>: the L1 receipts verify as sealed in a hash chain by Elan1 Govern, the L2 ones also as signed, Seal v6 sealed and timestamped. The verifier reports “not applicable — assurance level 1” for seals and anchors on the L1 part; that is not a failure.</P>
      <Note tone="info" title="Redaction">Fields are committed as salted digests, so a field can be withheld from a counterparty while the rest still verifies — see <DocLink to="/developers/cross-org">selective disclosure</DocLink>. A bundle’s receipt hashes cover the whole receipt, so bundles carry <C>redaction_profile: none</C>; redaction happens in disclosure packages.</Note>
    </>
  );
}

/* ── Anchors and timestamps ───────────────────────────────── */

export function Anchors() {
  return (
    <>
      <DocTitle kicker="Events and evidence · L2" title="Anchors and timestamps" lead="Every 15 minutes the sealed receipts of that window are put in a Merkle tree (RFC 6962), and its root is timestamped by two independent authorities (RFC 3161): eMudhra in India and one global authority. That fixes when the records existed, outside Elan1 Govern." />
      <H2 id="batches">Merkle batches</H2>
      <UL>
        <li>Leaves are receipt hashes in sequence order. Leaf hash = SHA-256(0x00 ‖ leaf); node hash = SHA-256(0x01 ‖ left ‖ right), as in RFC 6962.</li>
        <li>A batch closes at the end of its 15-minute window. Records in the window still open are the <strong>unanchored tail</strong>: signed and chained, waiting for their timestamp. The verifier reports <C>PASS_UNANCHORED_TAIL</C> for them.</li>
        <li>Each receipt has an inclusion proof: its leaf index, the sibling hashes up to the root, and the batch’s tokens.</li>
      </UL>
      <Code title="GET /v1/receipts/1638/proof" code={j({ seq: 1638, leafIndex: 7, treeSize: 12, batchId: 'mb_northbank_1972214', root: 'e4c1…9f20', path: [{ hash: '51ab…', side: 'right' }, { hash: '08de…', side: 'left' }, { hash: 'c9f3…', side: 'left' }, { hash: '7712…', side: 'right' }], tokens: [{ tsaName: 'eMudhra TSA (India)', genTime: '2026-10-27T09:30:41Z', serial: '5c1f…', policyOid: '1.3.6.1.4.1.37442.1.1', status: 'granted' }, { tsaName: 'DigiCert Timestamp Authority (global)', genTime: '2026-10-27T09:30:48Z', serial: 'a07b…', policyOid: '2.16.840.1.114412.7.1', status: 'granted' }], verified: true })} />
      <H2 id="tsa">Two authorities within 15 minutes</H2>
      <P>Both tokens sign the same message imprint — the batch root. If one authority is slow or unreachable the other still holds the time; the late one is added when it answers, marked <C>granted_late</C>, and the batch shows as late on the status page. A batch that carries a valid token from only one authority is reported by the verifier as <strong>degraded</strong>, not failed: the time rests on one authority instead of two. Sovereign deployments use two timestamp authorities inside the customer’s network.</P>
      <SimpleTable caption="Timestamp authorities" head={['Deployment', 'India', 'Second']} rows={[
        ['Hosted (L2, L3)', 'eMudhra TSA', 'DigiCert, GlobalSign or Sectigo'],
        ['Sovereign', 'Your TSA 1 (primary data centre)', 'Your TSA 2 (disaster-recovery site)'],
      ]} />
      <P>Only the 32-byte root leaves the residency domain; no receipt content is sent to an authority. Status of both authorities and the lag on each organisation’s last batch are on the <DocLink to="/status">status page</DocLink>.</P>
    </>
  );
}

/* ── The verifier: six codes, nine sections, profiles ─────── */

const CODE_ORDER: VerifyCode[] = ['PASS', 'PASS_UNANCHORED_TAIL', 'PASS_KEY_FROM_BUNDLE', 'FAIL_INTEGRITY', 'FAIL_PROFILE', 'INCOMPLETE', 'UNSUPPORTED', 'USAGE'];

export function Verifier() {
  return (
    <>
      <DocTitle kicker="Events and evidence" title="The verifier: six result codes" lead="govern verify and the public verifier answer with one of six result codes — PASS has three variants — and write a nine-section report. The same code runs offline, in a browser and in CI." />
      <H2 id="codes">Result codes and exit codes</H2>
      <SimpleTable caption="Result codes" head={['Exit', 'Code', 'Meaning']} rows={CODE_ORDER.map((c) => [<span className="num">{EXIT_CODES[c]}</span>, <C>{c}</C>, CODE_LABELS[c]])} />
      <UL>
        <li><strong>Precedence 1 › 3 › 2:</strong> an integrity failure is always reported, then a missing piece, then a profile failure. <C>FAIL_INTEGRITY</C> and <C>FAIL_PROFILE</C> are never collapsed, and <C>INCOMPLETE</C> is never reported as either.</li>
        <li><C>PASS_KEY_FROM_BUNDLE</C> means the key came from the file itself. Supply <C>--fingerprint</C> with one you obtained from the organisation directly to get <C>PASS</C>.</li>
        <li>L1 auditor packs verify with the same tool: the claim reads “sealed in a hash chain by Elan1 Govern · not yet externally timestamped”, and anchors and seals read “not applicable”.</li>
        <li>A batch with a valid timestamp from only one of its two authorities is <strong>degraded</strong>: section 6 warns and names the batch, and the result is not a failure. A token that does not verify is still <C>FAIL_INTEGRITY</C>.</li>
      </UL>
      <H2 id="report">The nine-section report</H2>
      <OL>
        <li><strong>Verdict</strong> — the code, the exit code and one sentence.</li>
        <li><strong>Claim</strong> — what the issuer claims, per assurance level, and the profile claimed.</li>
        <li><strong>Scope</strong> — records, range, write types (each tool a decision names, with how many decisions name it), checkpoints, sealed records, Merkle batches, timestamp tokens and the refusals among them.</li>
        <li><strong>Integrity</strong> — manifest, keys, signatures, hash chain, checkpoints, anchors, seals, disclosures.</li>
        <li><strong>Clause results</strong> — each rule of the profile: pass, fail or not applicable, with the failing records.</li>
        <li><strong>First failure</strong> — the record, field, expected and found values.</li>
        <li><strong>Notes</strong> — the unanchored tail, unbound payloads after erasure, a key from the bundle.</li>
        <li><strong>Limits</strong> — what a pass does not show. Draft — needs legal review.</li>
        <li><strong>Reproduction</strong> — the exact command, verifier version, bundle digest and profile digest.</li>
      </OL>
      <Code title="Terminal" code={`govern verify northbank-bundle.zip --fingerprint 4b0e9a17c2d35f68 --profile in-mca-audit-trail\n\n1. VERDICT         PASS_UNANCHORED_TAIL (exit 0)\n2. CLAIM           L1 #1201–#1544 sealed in a hash chain; L2 #1545–#1611 sealed, KMS, two timestamps\n3. SCOPE           411 records · #1201–#1611 · write types (3): zoho_books.record_payment (164), zoho_books.create_bill (97), gmail.send_email (58) · 52 checkpoints · 67 sealed records · 9 batches · 18 tokens · 12 refusals\n4. INTEGRITY       all 9 checks pass (anchors: 2 newest records not yet timestamped)\n5. CLAUSE RESULTS  MCA audit trail v1.0: 6 pass, 0 fail, 0 not applicable\n6. FIRST FAILURE   none\n7. NOTES           2 newest records are in the open batch\n8. LIMITS          a pass does not show the transactions occurred …\n9. REPRODUCTION    elan1-verify 2.0.0 · bundle 8c41…`} />
      <H2 id="profiles">Verifier profiles per regime</H2>
      <P>A profile names the fields a bundle must carry, the retention it needs and the rules (C01…) its records must meet. Running one checks the actual records; a failing rule names them.</P>
      <SimpleTable caption="Verifier profiles" head={['Profile', 'Regime', 'Status', 'Rules']} rows={PROFILES.map((p) => [<C>{p.id}</C>, p.regime, <Badge tone={p.status === 'certified' ? 'ok' : 'neutral'}>{p.status === 'certified' ? 'issued' : p.status}</Badge>, String(p.rules.length)])} />
      <P>A verifier profile is billed as its own line — {rupees(300000)} per regime a year, from L2 — and is not included with a <DocLink to="/developers/packs">regulatory pack</DocLink>. Try them on the <DocLink to="/verify">public verifier</DocLink>: the RBI collections sample fails C02 because contacts were made after 19:00 IST.</P>
    </>
  );
}

/* ── Between organisations ────────────────────────────────── */

const ACTION_RECEIPT = {
  format: 'elan1.action-receipt.v1', issuer: 'ar-org:kaverihealth.in', audience: 'ar-org:northbank.co.in', seq: 812, receiptHash: '6a0f…c31d',
  kid: 'k_kaveri_hsm_3', publicKey: '1e9b…', sig: 'f40c…', issuedAt: '2026-10-27T10:02:00Z', expiresAt: '2026-11-03T10:02:00Z', nonce: '93c0d4e1a8b27f55',
  summary: 'Payment BILL-NB-2210 recorded under supplier-payments rules', receipt: { seq: 812, kind: 'decision', tool: 'zoho_books.record_payment', decision: 'allow', '…': '…' },
};

export function CrossOrg() {
  return (
    <>
      <DocTitle kicker="Between organisations · L3" title="Action Receipts and selective disclosure" lead="At L3 Proven a receipt can travel: issued to a counterparty, checked by them without an account, and bound into their own chain. Selective disclosure reveals only the fields they need; the rest stay committed and checkable." />
      <H2 id="action-receipt">The Action Receipt format</H2>
      <P>Published so that a receipt stays checkable without Elan1 Govern. The issuer signs the receipt hash with its key; the receiver checks the audience, the expiry, the issuer key (pinned, from <C>/.well-known/action-receipt-keys</C>, or through a trust anchor), the content hash and the signature, then records a <C>counterparty.receipt.verified</C> receipt in its own chain.</P>
      <Code title="action-receipt.json" code={j(ACTION_RECEIPT)} />
      <SimpleTable caption="Issuer key routes" head={['Route', 'How the receiver gets the key']} rows={[
        ['pinned', 'Exchanged directly (a call, a signed letter) and stored in the counterparty register.'],
        ['well_known', <><C>https://&lt;issuer domain&gt;/.well-known/action-receipt-keys</C>, a JSON list of kid → public key with validity dates.</>],
        ['trust_anchor', 'A registry both sides trust, such as a regulator’s published list.'],
      ]} />
      <H2 id="disclosure">Selective disclosure (SD-JWT style, RFC 9901)</H2>
      <P>The issuer commits all {DISCLOSABLE_FIELDS.length} fields of a receipt as salted digests — SHA-256 over canonical <C>[salt, name, value]</C> — and signs the sorted list. A counterparty receives only the revealed fields with their salts; each recomputes to a signed digest, and nothing hidden can be swapped without the signature failing. The portal says it in those words: “you are revealing 3 of {DISCLOSABLE_FIELDS.length} committed fields”.</P>
      <SimpleTable caption="Committed fields" head={['Field', 'Holds']} rows={DISCLOSABLE_FIELDS.map((f) => [<C>{f}</C>, FIELD_LABELS[f]])} />
      <H2 id="apis">APIs</H2>
      <Endpoint method="POST" path="/v1/receipts/{seq}/issue" note="Org key · L3" />
      <Code title="Request" code={j({ counterparty_id: 'cp_northbank', reveal: ['decision', 'tool', 'amount', 'approval'], expires_days: 7 })} />
      <Endpoint method="GET" path="/v1/disclosures/{token}" note="Public · the counterparty portal reads this" />
      <Endpoint method="POST" path="/v1/verify/action-receipt" note="Org key · checks a received receipt; only a verified one is added to your chain, and every check is recorded" />
      <Endpoint method="GET" path="/.well-known/action-receipt-keys" note="Public" />
      <P>The counterparty register is listed from L1 — read-only below L3, so you can see who you deal with before you issue anything; issuing and binding receipts needs L3. Each counterparty that verifies holds a seat — {rupees(45000)} a year, paid by the issuer. The counterparty, regulator and partner portals open from a link and show only what was shared. Try the <DocLink to="/verify?input=disclosure">verifier with a disclosure package</DocLink>.</P>
    </>
  );
}

/* ── Earned autonomy ──────────────────────────────────────── */

export function Autonomy() {
  return (
    <>
      <DocTitle kicker="Rules · L3" title="Earned autonomy (A0–A3)" lead="Per agent and action class, autonomy is earned on the record. No API, setting or person sets a level directly: an agent moves up only by a graduation two different people agree to. The guard applies the level on every call after the rulebook has decided." />
      <SimpleTable caption="Autonomy levels" head={['Level', 'Name', 'Effect on decisions']} rows={AUTONOMY_LEVELS.map((a) => {
        const unavailable = a.id === 'A4' || a.id === 'A5';
        return [<C>{a.id}</C>, <span className="inline-flex flex-wrap items-center gap-2">{a.name}{unavailable && <Badge>Not yet available</Badge>}</span>, unavailable ? 'Not yet available. No agent can reach this level.' : a.description];
      })} />
      <UL>
        <li>From L3 every write type starts at <strong>A2 Propose</strong>, set by the platform: a person approves each write, and those approvals build the record. A write type with no level at all is A0 Observe (no grant): its writes are refused.</li>
        <li>Autonomy never relaxes a refusal. A3 leaves the rulebook’s answer alone; it never runs a held call without a person.</li>
        <li>Every proposal, approval, sampled call and revocation is a receipt. The autonomy level in force is sealed into <C>F11 autonomy_level</C>.</li>
        <li><strong>A4 and A5 are not yet available.</strong> No agent can reach them, by graduation or otherwise.</li>
      </UL>
      <H2 id="graduation">Graduation to A3</H2>
      <OL>
        <li><strong>The record.</strong> The agent must have at least <strong>90 days</strong>, <strong>200 records</strong> and <strong>100 approvals</strong> for the action class. Elan1 Govern shows only the numbers — approvals, rejections, reversals, days and median time to decide. It never recommends.</li>
        <li><strong>Two people.</strong> One person proposes the graduation; a different person approves it. The proposer cannot also approve.</li>
        <li><strong>Supervised period.</strong> For the first <strong>30 days</strong> at A3, 1 in 10 calls is sampled for a person to review. The decision response says <C>supervised: true</C>, and <C>sampled: true</C> on a sampled call.</li>
        <li><strong>Revoke.</strong> Any owner or admin can revoke in one press, alone, at any time. The action class drops back to A2 Propose and <C>autonomy.revoked</C> is written.</li>
      </OL>
      <H2 id="graduations-api">Graduations API</H2>
      <Endpoint method="POST" path="/v1/autonomy/graduations" note="Org key · owner or admin · proposes" />
      <Code title="Request" code={j({ agent: 'supplier-payments', tool: 'zoho_books.record_payment', reason: 'Record for this action class: 124 days, 312 records, 141 approvals, 0 reversals.' })} />
      <Endpoint method="POST" path="/v1/autonomy/graduations/{id}/approve" note="Org key · a different owner or admin" />
      <Endpoint method="DELETE" path="/v1/autonomy/grants/{id}" note="One press by one person; writes autonomy.revoked" />
      <P>There is no endpoint that sets a level. The decision response carries <C>autonomy: {'{ level, grant_id, supervised }'}</C> from L3, so the agent can tell an autonomy hold from a rule hold.</P>
    </>
  );
}

/* ── Regulatory packs and erasure ─────────────────────────── */

export function Packs() {
  return (
    <>
      <DocTitle kicker="Regulation · dry run from L1, live from L2" title="Regulatory packs and erasure" lead={`A pack is a declaration and a regime export under one dated obligation, checked against the regime’s verifier profile. It installs from L1 as a dry run and runs live from L2 at ${rupees(135000)} a pack a year. It is admitted only through five gates, G-A to G-E.`} />
      <H2 id="dry-run">Dry run at L1, live from L2</H2>
      <UL>
        <li><strong>At L1</strong> a pack installs as a dry run: its rules run on every call and its reports are produced, each marked “dry run — no regulatory claim until L2”. Checks that need L2 evidence (such as C06, which needs timestamps) are marked not applicable at L1, not failed.</li>
        <li><strong>From L2</strong> the same pack runs live: its declaration is sealed into every record and its exports carry the regulatory claim.</li>
        <li>The verifier profile a pack is checked against is billed as its own line — {rupees(300000)} per regime a year, from L2 — and is not included with the pack.</li>
      </UL>
      <SimpleTable caption="Packs" head={['Pack', 'Regime', 'Profile', 'Exports']} rows={PACKS.map((p) => [<C>{p.name}</C>, p.regime, <C>{p.profileId}</C>, p.exports.map((e) => e.label).join(' · ')])} />
      <H2 id="gates">Admission gates</H2>
      <SimpleTable caption="Gates" head={['Gate', 'Test']} rows={PACKS[0].gates.map((g) => [<C>{g.id}</C>, <><strong>{g.label}.</strong> {g.description}</>])} />
      <H2 id="declaration">The declaration in the rulebook</H2>
      <P>Installing a pack adds its declaration to the rulebooks of the agents that make its writes. From L2 the declaration id and version are sealed into every record (<C>F06</C>, <C>F07</C>).</P>
      <Code title="ledger1 declaration" code={`declaration:\n  id: decl.ledger1\n  version: 1\n  write_types: [sales_invoice.submit, sales_invoice.cancel, purchase_invoice.submit,\n                payment_entry.submit, journal_entry.submit, customer.update]\n  fields: [voucher_no, amount, party, posting_date, edited_by]\n  dual_control_above: 200000   # postings above ₹2,00,000 need a second person`} />
      <H2 id="erasure">DPDP erasure by salt destruction (from L1)</H2>
      <P>Erasure is available at every level, from L1: payloads are salted from the first L1 record, so there is always a salt to destroy.</P>
      <OL>
        <li>A request names the data principal; the identifier is hashed and never stored. Affected records are listed.</li>
        <li>Two approvers, neither the requester, must approve. A 72-hour clock runs from the request.</li>
        <li>Executing removes the inspected values (<C>args_summary</C>) from each affected receipt, in the chain and in every export, and records what is left with the organisation’s key (<C>redacted.kid</C>, <C>redacted.sig</C>). It then deletes the random salt secret, so the salted payload digest (from L2 also <C>F14 payload_hash</C> in the seal) can no longer be linked to the person. Each receipt keeps its original hash; the chain — and from L2 the seals — still verify, and the verifier checks the redaction and notes the unbound payloads.</li>
      </OL>
      <P>Events: <C>erasure.requested</C> and <C>erasure.executed</C>. See <DocLink to="/developers/webhooks">Webhooks</DocLink>.</P>
    </>
  );
}

/* ── Identity: SAML and SCIM ──────────────────────────────── */

export function Identity() {
  return (
    <>
      <DocTitle kicker="Operate" title="Sign-in: SAML, OIDC and SCIM" lead="People sign in with your identity provider over SAML 2.0 or OpenID Connect, and SCIM 2.0 keeps membership in step with your directory. Only the providers an organisation has connected are offered on the sign-in page." />
      <H2 id="saml">SAML 2.0</H2>
      <SimpleTable caption="SAML settings" head={['Item', 'Value']} rows={[
        ['Entity ID', <C>https://govern.elan1.ai/saml/&lt;org&gt;</C>],
        ['ACS URL', <C>https://govern.elan1.ai/saml/&lt;org&gt;/acs</C>],
        ['Binding', 'HTTP-POST for the response; RelayState must match the request this browser sent and is single use.'],
        ['NameID', 'emailAddress'],
        ['Attributes', <><C>email</C>, <C>name</C>, <C>groups</C> — groups map to roles (Govern-Owners → owner, Govern-Admins → admin, Govern-Approvers → approver, Govern-Viewers → viewer).</>],
        ['Metadata', 'Upload your IdP’s metadata URL; its signing certificate fingerprint and expiry are shown in the Agents door, under Organisation.'],
      ]} />
      <P>A person who is not yet a member is created on first sign-in only when just-in-time accounts or SCIM are on, with the role their group maps to; otherwise sign-in is refused and recorded as <C>auth.sso_refused</C>. Every sign-in writes <C>auth.signed_in</C> with the protocol and the assertion id.</P>
      <H2 id="scim">SCIM 2.0</H2>
      <Endpoint method="GET" path="/scim/v2/{org}/Users" note="Bearer scim_… token, shown once" />
      <Endpoint method="POST" path="/scim/v2/{org}/Users" />
      <Endpoint method="GET" path="/scim/v2/{org}/Groups" />
      <Code title="POST /scim/v2/northbank/Users" code={j({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'neha.bhatia@northbank.co.in', name: { formatted: 'Neha Bhatia' }, emails: [{ value: 'neha.bhatia@northbank.co.in', primary: true }], groups: [{ display: 'Govern-Admins' }], active: true })} />
      <P>Setting <C>active: false</C> (or deleting the user) suspends the member at once and ends their sessions; their history stays. Rotate the token in the Agents door, under Organisation — the old token stops working immediately.</P>
    </>
  );
}

/* ── Sovereign installation ───────────────────────────────── */

export function Sovereign() {
  return (
    <>
      <DocTitle kicker="Operate · Sovereign" title="Sovereign installation and air-gapped updates" lead={`Sovereign runs Elan1 Govern on your own infrastructure — ${rupeesShort(PLANS.sovereign.floorPerYear)} per deployment a year, ${rupees(PLANS.sovereign.overageRate, { paise: true })} an action, refused ${rupees(PLANS.sovereign.refusalRate, { paise: true })}. The same receipts and the same verifier; you hold every key and nothing leaves your network.`} />
      <H2 id="components">What you run</H2>
      <SimpleTable caption="Sovereign components" head={['Component', 'Requirement']} rows={[
        ['Kubernetes', '3 control-plane nodes and at least 3 workers across two zones (OpenShift, RKE2 or upstream 1.30+).'],
        ['PostgreSQL 16', 'Primary and synchronous replica, row-level security on every tenant table.'],
        ['OpenBao', 'Secrets, unsealed by Shamir shares (3 of 5).'],
        ['Object-lock storage', 'Ceph, SeaweedFS or Garage, a bucket in compliance mode with 8-year retention.'],
        ['HSM', 'Entrust nShield or Thales Luna, FIPS 140-3 Level 3. The signing key is created in a key ceremony (3 of 5 holders).'],
        ['Timestamp authorities', 'Two RFC 3161 authorities inside your network.'],
        ['Egress', 'Denied by default; the allow-list is empty. No telemetry is sent to elan1.'],
      ]} />
      <H2 id="install">Install</H2>
      <Code title="Terminal (inside your network)" code={`# 1 verify the release bundle you received on media\ngovern bundle verify elan1-govern-2026.10.2.tar --release-key elan1-release.pub\n\n# 2 load images into your registry and install\ngovern bundle load elan1-govern-2026.10.2.tar --registry registry.bank.internal\nhelm install govern ./charts/elan1-govern -n govern -f values-sovereign.yaml\n\n# 3 key ceremony in your HSM (3 of 5 holders present)\ngovern keys ceremony --hsm nshield --quorum 3-of-5`} />
      <H2 id="updates">Air-gapped signed update bundles</H2>
      <OL>
        <li>An update arrives as a bundle on media, signed with the elan1 release key (Ed25519). Its fingerprint is printed in the release notes and on paper.</li>
        <li><strong>Verify and stage</strong>: the signature and digest are checked inside your network; a bundle that does not verify is rejected and recorded.</li>
        <li><strong>Apply</strong>: a person applies the staged bundle. Verify, stage and apply are each a receipt (<C>update.staged</C>, <C>update.applied</C>).</li>
      </OL>
      <P>Operators follow it in the Agents door, under Deployment. Receipts from a Sovereign deployment verify with the same <DocLink to="/developers/verifier">verifier</DocLink> as hosted ones.</P>
    </>
  );
}

/* ── Status page ──────────────────────────────────────────── */

export function StatusDoc() {
  return (
    <>
      <DocTitle kicker="Operate" title="Status page" lead="A public page with the state of every component, 90 days of history, the incident log — and chain integrity for each organisation as a component of its own." />
      <UL>
        <li><strong>Platform</strong> — the decision service, the console and the public verifier.</li>
        <li><strong>Delivery</strong> — approvals by email, Slack, WhatsApp and phone links; webhooks.</li>
        <li><strong>Key custody and storage</strong> — signing keys in AWS KMS or customer HSMs; write-once storage.</li>
        <li><strong>Timestamping</strong> — each RFC 3161 authority.</li>
        <li><strong>Chain integrity</strong> — per organisation: the last checkpoint (sealed in a hash chain at L1, signed from L2), re-verified when the page loads, and from L2 the timestamp lag on the last batch.</li>
      </UL>
      <Endpoint method="GET" path="/v1/status" note="Public · JSON" />
      <div className="my-6 flex flex-wrap items-center gap-4 border border-line bg-surface p-5">
        <div className="min-w-0 flex-1"><p className="font-semibold">Open the status page</p><p className="text-sm text-muted">Refreshes every 2 minutes.</p></div>
        <Link to="/status" className="inline-flex h-10 items-center gap-2 border border-fg bg-fg px-4 text-base font-medium text-canvas hover:bg-fg/90">Status <ArrowRight className="h-4 w-4" aria-hidden /></Link>
      </div>
    </>
  );
}

/* ── Terms and the data processing agreement (drafts) ─────── */

export function Legal() {
  return (
    <>
      <DocTitle kicker="Reference" title="Terms of service and data processing agreement" lead={`The agreements between your organisation and ${LEGAL_ENTITY} for Elan1 Govern. Both are drafts and need legal review before anyone relies on them.`} />
      <LegalDraft />
      <H2 id="terms">Terms of service (draft)</H2>
      <OL>
        <li><strong>The service.</strong> Elan1 Govern checks agents’ tool calls against rulebooks your organisation publishes (from L2 each version is also signed), holds calls for named people, and records every decision as a hash-chained receipt.</li>
        <li><strong>Your responsibilities.</strong> You write and publish your rulebooks, choose your approvers and keep agent keys secret. A decision reflects your rules; it is not advice.</li>
        <li><strong>Check and record.</strong> On the REST and SDK route Elan1 Govern advises and records; your code runs the call. Only the MCP governed run blocks a call.</li>
        <li><strong>Fees.</strong> The platform floor for your assurance level, actions beyond the allowance at the per-action rate, and refused actions at 40% of that rate. GST is added.</li>
        <li><strong>Evidence.</strong> Receipts are tamper-evident. At L1 they are sealed in a hash chain by Elan1 Govern and not yet externally timestamped; from L2 they are also signed, sealed with Seal v6 and timestamped by two authorities.</li>
        <li><strong>Leaving.</strong> You can export every record as an evidence bundle at any time, and it stays verifiable without an account.</li>
      </OL>
      <H2 id="dpa">Data processing agreement (draft)</H2>
      <OL>
        <li><strong>Roles.</strong> Your organisation is the data fiduciary (controller); {LEGAL_ENTITY} is the data processor, under the Digital Personal Data Protection Act 2023 and, where it applies, the GDPR.</li>
        <li><strong>What is processed.</strong> Tool names, the argument values a rule inspected, display identifiers, approver names and channels. Never model prompts, message bodies or full arguments.</li>
        <li><strong>Where.</strong> Hosted data stays in India (AWS ap-south-1). Sovereign deployments keep everything in your data centre.</li>
        <li><strong>Erasure.</strong> From L1, erasure by salt destruction with two approvers and a 72-hour clock; the chain keeps verifying.</li>
        <li><strong>Sub-processors.</strong> AWS (hosting, KMS), the timestamp authorities (they receive a 32-byte root only), and email, Slack and WhatsApp providers for approval messages you switch on. The full <Link to="/legal/sub-processors" className="link">sub-processor list</Link> names each one, what it receives and where; new ones are announced 30 days ahead.</li>
        <li><strong>Breaches.</strong> Notified to your owners without undue delay, with the receipts that show what happened.</li>
      </OL>
      <P>Questions: <a className="link" href="mailto:legal@elan1.ai">legal@elan1.ai</a>.</P>
    </>
  );
}

