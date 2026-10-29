import { Link } from 'react-router-dom';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui';
import { WEBHOOK_EVENTS } from '@/features/settings/orgApi';
import { DocTitle, H2, H3, P, UL, OL, C, Code, CodeTabs, Note, DocLink, FieldsTable, SimpleTable } from '../docs';

const j = (x: unknown) => JSON.stringify(x, null, 2);

/* ── Webhooks ─────────────────────────────────────────────── */

const PAYLOADS = {
  receipt: { id: 'evt_01JB7X2Q4M', type: 'receipt.created', created_at: '2026-10-27T09:14:03Z', org: 'demo-traders', data: { seq: 6218, kind: 'decision', agent: 'invoice-bot', tool: 'zoho_books.record_payment', decision: 'ask', rule_id: 'pay-large', hash: '0be3c1…', prev_hash: '7a9d22…' } },
  pending: { id: 'evt_01JB7X2Q5N', type: 'approval.pending', created_at: '2026-10-27T09:14:03Z', org: 'demo-traders', data: { approval_id: 'apr_9f2k1c', agent: 'invoice-bot', tool: 'zoho_books.record_payment', rule_id: 'pay-large', approver_group: 'finance', expires_at: '2026-10-28T09:14:03Z', receipt_seq: 6218, console_url: 'https://govern.elan1.ai/approvals/apr_9f2k1c' } },
  resolved: { id: 'evt_01JB7Y0A1C', type: 'approval.resolved', created_at: '2026-10-27T09:31:40Z', org: 'demo-traders', data: { approval_id: 'apr_9f2k1c', status: 'approved', decided_by: 'u_venkat', channel: 'slack', receipt_seq: 6218, result_seq: 6231, outcome: 'ok' } },
  alert: { id: 'evt_01JB7Z9K3D', type: 'alert.created', created_at: '2026-10-27T10:02:11Z', org: 'demo-traders', data: { alert_id: 'al_8x2c', detector: 'amount_outlier', severity: 'high', agent: 'invoice-bot', baseline: 'median ₹38,000', observed: '₹9,40,000', related_seqs: [6240] } },
  escalated: { id: 'evt_01JB80A2EF', type: 'approval.escalated', created_at: '2026-10-27T10:44:03Z', org: 'northbank', data: { approval_id: 'apr_3k1x9q', from_group: 'finance', to_group: 'owners', after_minutes: 60, receipt_seq: 1622 } },
  anchored: { id: 'evt_01JB80C7QZ', type: 'timestamp.anchored', created_at: '2026-10-27T09:30:48Z', org: 'northbank', data: { batch_id: 'mb_northbank_1972214', first_seq: 1631, last_seq: 1642, root: 'e4c1…9f20', tokens: [{ tsa: 'eMudhra TSA (India)', gen_time: '2026-10-27T09:30:41Z' }, { tsa: 'DigiCert Timestamp Authority (global)', gen_time: '2026-10-27T09:30:48Z' }], status: 'anchored' } },
  counterparty: { id: 'evt_01JB81D0RM', type: 'counterparty.receipt', created_at: '2026-10-27T11:05:12Z', org: 'kaveri-health', data: { direction: 'received', issuer: 'ar-org:northbank.co.in', seq: 1598, verification: 'verified', bound_seq: 1290 } },
  erasure: { id: 'evt_01JB82F4TT', type: 'erasure.executed', created_at: '2026-10-27T12:00:00Z', org: 'kaveri-health', data: { request_id: 'er_7c2a', approvers: 2, salts_destroyed: 3, affected_seals: 3, chain_verifies: true, receipt_seq: 1302 } },
};

const VERIFY_TS = `import { createHmac, timingSafeEqual } from 'node:crypto';

/** Verify X-Elan1-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">. */
export function verifyWebhook(rawBody: string, header: string, secret: string, toleranceS = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceS) return false; // replay window: 5 minutes
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  const want = Buffer.from(expected, 'hex');
  return given.length === want.length && timingSafeEqual(given, want);
}

// Express: read the raw body — a re-serialised JSON body will not match.
app.post('/hooks/elan1', express.raw({ type: 'application/json' }), (req, res) => {
  const ok = verifyWebhook(req.body.toString('utf8'), req.header('X-Elan1-Signature') ?? '', process.env.ELAN1_WEBHOOK_SECRET!);
  if (!ok) return res.sendStatus(400);
  const event = JSON.parse(req.body.toString('utf8'));
  queue.push(event); // acknowledge fast, work later
  res.sendStatus(204);
});`;

const VERIFY_PY = `import hmac, hashlib, time

def verify_webhook(raw_body: bytes, header: str, secret: str, tolerance_s: int = 300) -> bool:
    """Verify X-Elan1-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">."""
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts.get("t", "0"))
    if not t or abs(time.time() - t) > tolerance_s:  # replay window: 5 minutes
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))

# Flask
@app.post("/hooks/elan1")
def hook():
    if not verify_webhook(request.get_data(), request.headers.get("X-Elan1-Signature", ""), os.environ["ELAN1_WEBHOOK_SECRET"]):
        abort(400)
    queue.put(request.get_json())
    return "", 204`;

export function Webhooks() {
  return (
    <>
      <DocTitle kicker="Events and evidence" title="Webhooks" lead="Elan1 Govern posts events to your HTTPS endpoint as they happen — a receipt written, an approval waiting, decided or escalated, an alert raised, a batch timestamped, a counterparty receipt checked, an erasure carried out. Each delivery is signed with your endpoint's secret." />
      <H2 id="events">Events</H2>
      <SimpleTable caption="Webhook events" head={['Event', 'Sent when']} rows={WEBHOOK_EVENTS.map((e) => [<C>{e.id}</C>, e.what])} />
      <P>Level upgrades (<C>level.upgraded</C>, with the boundary sequence), key ceremonies (<C>key.ceremony</C>) and the stages of a Sovereign update (<C>update.staged</C>, <C>update.applied</C>) are admin receipts: subscribe to <C>receipt.created</C> and filter on <C>data.action</C>.</P>
      <P>Add endpoints in the Assurance door, under <strong>Exports → Webhooks</strong>, and choose events per endpoint. The secret (<C>whsec_…</C>) is shown once.</P>

      <H2 id="payloads">Payloads</H2>
      <CodeTabs samples={[
        { key: 'r', label: 'receipt.created', title: 'POST body', code: j(PAYLOADS.receipt) },
        { key: 'p', label: 'approval.pending', title: 'POST body', code: j(PAYLOADS.pending) },
        { key: 'v', label: 'approval.resolved', title: 'POST body', code: j(PAYLOADS.resolved) },
        { key: 'a', label: 'alert.created', title: 'POST body', code: j(PAYLOADS.alert) },
        { key: 'e', label: 'approval.escalated', title: 'POST body', code: j(PAYLOADS.escalated) },
        { key: 't', label: 'timestamp.anchored', title: 'POST body · L2', code: j(PAYLOADS.anchored) },
        { key: 'c', label: 'counterparty.receipt', title: 'POST body · L3', code: j(PAYLOADS.counterparty) },
        { key: 'x', label: 'erasure.executed', title: 'POST body', code: j(PAYLOADS.erasure) },
      ]} />
      <P>Payloads carry ids and the values rules inspected, never full arguments or message bodies — the same minimisation as receipts.</P>

      <H2 id="signatures">Verify the signature</H2>
      <Code title="Headers" code={`Content-Type: application/json\nX-Elan1-Event: approval.pending\nX-Elan1-Delivery: dlv_01JB7X2Q5P\nX-Elan1-Signature: t=1761556443,v1=5f2b9c0e…`} />
      <OL>
        <li>Read the raw request body before any JSON parsing.</li>
        <li>Compute HMAC-SHA256 of <C>{'<t>.<raw body>'}</C> with your endpoint secret.</li>
        <li>Compare with <C>v1</C> in constant time, and reject a <C>t</C> more than 5 minutes old.</li>
      </OL>
      <CodeTabs samples={[
        { key: 'ts', lang: 'typescript', label: 'TypeScript', title: 'verify-webhook.ts', code: VERIFY_TS },
        { key: 'py', lang: 'python', label: 'Python', title: 'verify_webhook.py', code: VERIFY_PY },
        { key: 'sdk', label: 'With the SDK', title: 'TypeScript', code: `import { verifyWebhook } from '@elan1/govern';\n\nconst event = verifyWebhook(rawBody, req.header('X-Elan1-Signature'), secret); // throws if invalid` },
      ]} />

      <H2 id="delivery">Delivery and retries</H2>
      <UL>
        <li>Answer with any 2xx within 10 seconds. Anything else is a failure.</li>
        <li>Failed deliveries are retried with growing gaps, up to <strong>8 delivery attempts</strong> in all. Each attempt is listed with its status and timing in the console.</li>
        <li>Events can arrive out of order or more than once. Use the event <C>id</C> to ignore repeats, and the receipt <C>seq</C> to order.</li>
        <li>An endpoint that keeps failing is marked failing; deliveries are not queued beyond the 8 attempts. For a complete record, read the chain — the receipts, not the webhooks, are the evidence.</li>
      </UL>
    </>
  );
}

/* ── Receipts ─────────────────────────────────────────────── */

const RECEIPT = {
  seq: 6218, ts: '2026-10-27T09:14:03.412Z', org: 'org_demo', kind: 'decision', agent: 'invoice-bot', tool: 'zoho_books.record_payment',
  args_summary: { vendor: 'Kalyani Metals', amount: 240000 }, args_hash: 'c0d4…', rulebook: { version: 7, hash: 'a41f…' },
  rule_id: 'pay-large', decision: 'ask', reason: 'Payments over ₹50,000 need the finance controller.',
  approval: { id: 'apr_9f2k1c', status: 'pending' }, prev_hash: '7a9d22…', kid: 'k_demo_2610_2', hash: '0be3c1…', sig: '9e51…',
};

export function Receipts() {
  return (
    <>
      <DocTitle kicker="Events and evidence" title="Receipts and verification" lead="Every decision, approval, outcome and admin change is one receipt: canonical JSON, hashed with SHA-256, sealed with an Ed25519 key and linked to the one before it. Change any receipt and the chain names it." />
      <Code title="A decision receipt" code={j(RECEIPT)} />

      <H2 id="fields">The 22 fields</H2>
      <FieldsTable caption="Receipt fields" rows={[
        { name: 'seq', type: 'integer', desc: 'Gap-free sequence per organisation.' },
        { name: 'ts', type: 'date-time', desc: 'When the receipt was written.' },
        { name: 'org', type: 'string', desc: 'The organisation.' },
        { name: 'kind', type: 'string', desc: <><C>decision</C> · <C>approval</C> · <C>outcome</C> · <C>admin</C></> },
        { name: 'agent', type: 'string', desc: 'The agent slug.' },
        { name: 'tool', type: 'string', desc: 'The tool name.' },
        { name: 'args_summary', type: 'object', desc: 'Display identifiers and only the values a rule inspected. An email keeps the recipient domain, not the address.' },
        { name: 'args_hash', type: 'string', desc: 'SHA-256 over canonical tool and arguments, so the full call can be matched later without storing it.' },
        { name: 'rulebook', type: '{ version, hash }', desc: 'The published rulebook version it was decided under (from L2 that version is also signed).' },
        { name: 'rule_id', type: 'string', desc: 'The deciding rule, or a system refusal id.' },
        { name: 'decision', type: 'string', desc: <><C>allow</C> · <C>ask</C> · <C>refuse</C></> },
        { name: 'reason', type: 'string', desc: 'The rule\'s reason.' },
        { name: 'approval', type: 'object', desc: <>Id, status, approver, channel and <C>self_approval</C>.</> },
        { name: 'outcome', type: 'object', desc: <><C>ok</C> · <C>error</C> · <C>not_run</C>, with a reference and timing.</> },
        { name: 'ref_seq', type: 'integer', desc: 'The receipt this one refers to — an approval points at its ask.' },
        { name: 'actor', type: 'string', desc: 'The person or system behind an approval or admin change.' },
        { name: 'action', type: 'string', desc: <>Admin action, such as <C>rulebook.published</C>, <C>key.rotated</C>, <C>evidence.exported</C>.</> },
        { name: 'details', type: 'object', desc: <>Extra facts, such as <C>details.channel</C>.</> },
        { name: 'prev_hash', type: 'string', desc: 'The hash of the receipt before. The first receipt links to 64 zeros.' },
        { name: 'kid', type: 'string', desc: 'The id of the key that sealed the receipt.' },
        { name: 'hash', type: 'string', desc: 'SHA-256 over the canonical JSON of every other field, without hash and sig.' },
        { name: 'sig', type: 'string', desc: 'Ed25519 over the hash, by the key in kid.' },
      ]} />
      <Note tone="info" title="Sealed at L1, signed from L2">At L1 Elan1 Govern seals each record with its own Ed25519 key, so an L1 chain is described as <em>sealed in a hash chain by Elan1 Govern, not yet externally timestamped</em>. We do not call L1 records signed while the decision on L1 key custody (DR-017) is pending. From L2 each record is also sealed with <DocLink to="/developers/seal">Seal v6</DocLink>, signed by a key in AWS KMS and timestamped by two authorities.</Note>
      <Note tone="neutral" title="Never in a receipt">Full arguments, message bodies, prompts, email addresses, or values no rule inspected.</Note>

      <H2 id="hashing">Canonical JSON, SHA-256, Ed25519</H2>
      <OL>
        <li>Drop <C>hash</C> and <C>sig</C>, and any field without a value.</li>
        <li>Serialise as canonical JSON: keys sorted at every level, no whitespace.</li>
        <li><C>hash</C> = lower-case hex SHA-256 of those bytes (UTF-8).</li>
        <li><C>sig</C> = Ed25519 over the hash string, by the key named in <C>kid</C>.</li>
        <li><C>prev_hash</C> = the previous receipt's <C>hash</C>, which is itself inside the hashed content — so changing one receipt breaks its own hash, and removing one breaks the next link.</li>
      </OL>
      <CodeTabs samples={[
        { key: 'ts', lang: 'typescript', label: 'TypeScript', code: `import { sha256 } from '@noble/hashes/sha256';\nimport { bytesToHex, utf8ToBytes, hexToBytes } from '@noble/hashes/utils';\nimport * as ed from '@noble/ed25519';\n\nconst canonical = (v: unknown): string =>\n  v === null || typeof v !== 'object' ? JSON.stringify(v)\n  : Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'\n  : '{' + Object.keys(v).filter((k) => (v as any)[k] !== undefined).sort()\n      .map((k) => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';\n\nexport async function checkReceipt(r: any, publicKeyHex: string) {\n  const { hash, sig, ...body } = r;\n  const recomputed = bytesToHex(sha256(utf8ToBytes(canonical(body))));\n  const keyOk = await ed.verifyAsync(hexToBytes(sig), utf8ToBytes(hash), hexToBytes(publicKeyHex));\n  return { hashOk: recomputed === hash, keyOk };\n}` },
        { key: 'py', lang: 'python', label: 'Python', code: `import hashlib, json\nfrom nacl.signing import VerifyKey\n\ndef canonical(v) -> str:\n    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)\n\ndef check_receipt(r: dict, public_key_hex: str) -> dict:\n    body = {k: v for k, v in r.items() if k not in ("hash", "sig") and v is not None}\n    recomputed = hashlib.sha256(canonical(body).encode()).hexdigest()\n    try:\n        VerifyKey(bytes.fromhex(public_key_hex)).verify(r["hash"].encode(), bytes.fromhex(r["sig"]))\n        key_ok = True\n    except Exception:\n        key_ok = False\n    return {"hash_ok": recomputed == r["hash"], "key_ok": key_ok}` },
      ]} />

      <H2 id="checkpoints">Checkpoints</H2>
      <P>Every hour on the hour — and on demand — Elan1 Govern seals a checkpoint with its key: <C>{'{org, seq, hash, ts, kid}'}</C> for the current head of the chain. A checkpoint fixes everything up to that receipt; the newest receipts wait for the next one. Key rotation is itself a receipt, and old keys stay in the pack so earlier receipts still verify.</P>

      <H2 id="levels">What each level adds</H2>
      <SimpleTable caption="Evidence by assurance level" head={['Level', 'Each receipt is', 'Export']} rows={[
        [<Badge>L1 Guarded</Badge>, 'Sealed in a hash chain by Elan1 Govern, with a checkpoint every hour. Not yet externally timestamped.', <>Auditor pack (<C>auditor-pack/1</C>), 7 members, with a sealed manifest</>],
        [<Badge tone="info">L2 Attested</Badge>, <>Also sealed with <DocLink to="/developers/seal">Seal v6</DocLink> by a key in AWS KMS, and placed in a Merkle batch <DocLink to="/developers/anchors">timestamped by two authorities</DocLink>.</>, <>Evidence bundle (<C>elan1.evidence.bundle.v1</C>), 8 members</>],
        [<Badge tone="info">L3 Proven</Badge>, 'Signed with a key the organisation holds in its own HSM; can be issued to counterparties as an Action Receipt.', 'Evidence bundle, plus disclosure packages'],
        [<Badge tone="info">Sovereign</Badge>, 'Signed in the organisation’s own HSM and timestamped by its own two authorities, on its own infrastructure.', 'Evidence bundle'],
      ]} />

      <H2 id="auditor-pack">The auditor pack (L1)</H2>
      <P>Owners, admins and auditors export from <strong>Assurance → Exports</strong>. The export is a receipt too. From L2 the same button produces the 8-member <DocLink to="/developers/seal">evidence bundle</DocLink>, which keeps the manifest, keys, receipts and checkpoints, so tools built for those parts of the pack keep working. The L1 auditor pack is free; each L2+ evidence bundle is billed at ₹2,500.</P>
      <P>The pack has 7 members, as files in a ZIP or as one JSON document. The manifest lists the SHA-256 of every other member and is itself sealed with Elan1 Govern’s key (<C>manifest_seal</C>), so a removed receipt, a cut-off tail or an edited file shows. Packs made before 28 October 2026 have no manifest seal.</P>
      <FieldsTable caption="Auditor pack members" nameHeader="Member" rows={[
        { name: 'manifest.json', type: 'object', desc: <>Format <C>auditor-pack/1</C>, organisation, range, counts, the last receipt’s hash, the enforcement mode, key ids and fingerprints, created at and by, and the SHA-256 of every other member. Sealed: the seal is <C>manifest_seal</C>, by the key named in <C>sealing_kid</C>.</> },
        { name: 'keys.json', type: 'map', desc: <>Key id → Ed25519 public key (hex). Every key that sealed something in the range, retired ones included. In the JSON form: <C>public_keys</C>.</> },
        { name: 'receipts.jsonl', type: 'list', desc: <>The receipts in sequence order, one per line. In the JSON form: <C>receipts</C>.</> },
        { name: 'checkpoints.json', type: 'list', desc: <>The sealed checkpoints whose head is in the range. In the JSON form: <C>checkpoints</C>.</> },
        { name: 'summary.pdf', type: 'file', desc: <>A summary to read and file: what the pack claims, the counts, the enforcement mode, the compliance map and how to verify it. In the JSON form: <C>summary_pdf</C>.</> },
        { name: 'compliance-map.json', type: 'object', desc: <>Frameworks and requirements, with the receipts in this pack that evidence each one. In the JSON form: <C>compliance_map</C>.</> },
        { name: 'README.txt', type: 'text', desc: <>What each file is and how to check the pack offline. In the JSON form: <C>readme</C>.</> },
      ]} />

      <H3 id="member-names">Bundle member names and the specification</H3>
      <P>The evidence bundle’s member names differ from the names in the specification. They are kept as they are, because bundles already exported use them and a renamed member would no longer verify. The lexicon member was added on 28 October 2026; bundles made before then have none and still verify, with a note in the report.</P>
      <SimpleTable caption="Evidence bundle members and the specification’s names" head={['In the bundle', 'In the specification', 'Holds']} rows={[
        [<C>manifest.json</C>, <C>manifest.json</C>, 'Same name. The range, counts, assurance levels and the SHA-256 of every other member; signed.'],
        [<C>receipts.jsonl</C>, <C>chain.json</C>, 'The receipts in range, in sequence order, one per line.'],
        [<C>seals.jsonl</C>, <C>seals.jsonl</C>, 'Same name. A Seal v6 record for every receipt made at L2 or above.'],
        [<C>checkpoints.json</C>, <span className="text-muted">none</span>, 'An extra member the specification does not list: the checkpoints whose head is in the range, kept so tools built for the L1 auditor pack keep working.'],
        [<C>anchors.json</C>, <C>anchors/</C>, 'One file instead of a folder: the Merkle batches and their timestamp tokens, with the authorities’ keys.'],
        [<C>keys.json</C>, <C>keys.json</C>, 'Same name. Every public key that signed something in the range.'],
        [<C>declarations.json</C>, <C>declarations/</C>, 'One file instead of a folder: the rulebook versions used, and the context the verifier profile rules read.'],
        [<C>profile/</C>, <C>VERIFY.txt</C>, <><C>VERIFY.txt</C> sits in the <C>profile/</C> folder, beside <C>profile.json</C> (the verifier profile claimed, if any).</>],
        [<C>lexicon.json</C>, <C>lexicon/</C>, 'One file instead of a folder: every rule id and refusal code the receipts use, with what each means. Required in the specification; optional for the verifier here, because bundles made before 28 October 2026 have none. When the signed manifest lists it, its digest is checked.'],
      ]} />

      <H2 id="verify">Verify</H2>
      <P>Packs and bundles are checked by the same verifier, which answers with one of <DocLink to="/developers/verifier">six result codes</DocLink> and a nine-section report.</P>
      <SimpleTable caption="govern verify exit codes" head={['Exit', 'Code', 'Meaning']} rows={[
        [<Badge tone="ok">0</Badge>, <C>PASS · PASS_UNANCHORED_TAIL · PASS_KEY_FROM_BUNDLE</C>, 'Intact. The variants say the newest records await their timestamp, or that the key came from the file. A batch timestamped by only one authority is reported as degraded in the report — not a failure.'],
        [<Badge tone="bad">1</Badge>, <C>FAIL_INTEGRITY</C>, 'A hash, link, signature, seal, Merkle root or timestamp does not verify. Names the first failure.'],
        [<Badge tone="bad">2</Badge>, <C>FAIL_PROFILE</C>, 'Integrity holds, but a rule of the claimed verifier profile fails.'],
        [<Badge tone="held">3</Badge>, <C>INCOMPLETE</C>, 'Something needed is missing — a member, a seal, a key.'],
        [<Badge>4</Badge>, <C>UNSUPPORTED</C>, 'A format or profile this verifier does not know.'],
        [<Badge>5</Badge>, <C>USAGE</C>, 'The input is not a bundle, or an option is wrong.'],
      ]} />
      <Note tone="held" title="The key-trust caveat">A pack or bundle carries its own public keys. Without <C>--fingerprint</C> — a fingerprint you obtained from the organisation separately — a file made up from scratch with a different key would also verify, which is why the result is then <C>PASS_KEY_FROM_BUNDLE</C>. At L1 receipts are sealed in a hash chain by Elan1 Govern and are not yet externally timestamped; from L2 each 15-minute batch is timestamped by two independent authorities, so the time no longer rests on Elan1 Govern alone.</Note>      <div className="my-6 flex flex-wrap items-center gap-4 border border-line bg-surface p-5">
        <ShieldCheck className="h-6 w-6 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Check a pack in your browser</p>
          <p className="text-sm text-muted">The public verifier runs these checks in the page. Nothing is uploaded.</p>
        </div>
        <Link to="/verify" className="inline-flex h-10 items-center gap-2 border border-fg bg-fg px-4 text-base font-medium text-canvas hover:bg-fg/90">Open the verifier <ArrowRight className="h-4 w-4" aria-hidden /></Link>
      </div>
    </>
  );
}

/* ── CLI ──────────────────────────────────────────────────── */

export function Cli() {
  return (
    <>
      <DocTitle kicker="Events and evidence" title="CLI" lead="govern is a single command-line tool for auditors and operators. verify works offline with no account and gives one of six result codes; sign and keygen are for organisations that hold their own keys; bundle verifies Sovereign update bundles." />
      <Code title="Install" code={`npm install -g @elan1/govern-cli     # or\npipx install elan1-govern\n\ngovern --version`} />

      <H2 id="verify">govern verify</H2>
      <P>Checks an L1 auditor pack or an L2+ evidence bundle (the ZIP or its JSON) the same way the <DocLink to="/verify">public verifier</DocLink> does: the manifest and member digests, keys, signatures, previous-hash links, checkpoints, Merkle roots and both timestamp tokens, every Seal v6 record and, with <C>--profile</C>, a regime’s rules. It names the first failure and writes the nine-section report.</P>
      <Code title="Terminal" code={`govern verify bundle.zip --fingerprint 4b0e9a17c2d35f68\n\nPASS (exit 0) · 411 records verify, 67 sealed and 65 timestamped by two authorities\norganisation: Northbank Industrial Ltd · key 4b0e9a17c2d35f68 (supplied)\n\n$ echo $?\n0`} />
      <SimpleTable caption="verify options" head={['Option', 'What it does']} rows={[
        [<C>--fingerprint HEX</C>, 'The 16-hex fingerprint you obtained from the organisation. Without it the file\'s own keys are used and the best result is PASS_KEY_FROM_BUNDLE.'],
        [<C>--key FILE</C>, 'Trust only this public key file (an alternative to --fingerprint).'],
        [<C>--profile ID</C>, <>Also check a verifier profile, e.g. <C>in-mca-audit-trail</C>. A failing rule gives FAIL_PROFILE (exit 2).</>],
        [<C>--report FILE</C>, 'Write the nine-section report as text (or .json).'],
      ]} />
      <Code title="A broken bundle" code={`govern verify bundle.zip\n\nFAIL_INTEGRITY (exit 1) · broken at #1,598\nfirst failure: seal #1,598 digest — expected b7e2…44f0, found 0d13…9a72\nthe receipt was changed after it was signed\n\n$ echo $?\n1`} />

      <H2 id="sign">govern sign</H2>
      <P>Signs a rulebook file with a key you hold, for organisations that publish rulebooks from their own pipeline. The console verifies the signature against the organisation's registered key before the version can go live.</P>
      <Code title="Terminal" code={`govern sign invoice-bot.yaml --key org-private-key.pem --out invoice-bot.signed.yaml`} />

      <H2 id="keygen">govern keygen</H2>
      <P>Creates an Ed25519 key pair and prints its key id and fingerprint. Publish the fingerprint where your auditors can find it — on your website or in a signed letter — so they can pass it to <C>verify</C>.</P>
      <Code title="Terminal" code={`govern keygen --out org\n\nwrote org-private-key.pem (keep it secret) and org-public-key.pem\nkid: k_demo_2610_3  fingerprint: 4b0e9a17c2d35f68`} />
      <H3 id="exit-codes">Exit codes</H3>
      <P><C>0</C> PASS (and its two variants) · <C>1</C> FAIL_INTEGRITY · <C>2</C> FAIL_PROFILE · <C>3</C> INCOMPLETE · <C>4</C> UNSUPPORTED · <C>5</C> USAGE. Precedence when several apply: 1, then 3, then 2.</P>
    </>
  );
}
