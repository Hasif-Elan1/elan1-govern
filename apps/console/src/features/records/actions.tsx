/**
 * What a person can do with a record's evidence: export it, share it with fields redacted (SD-JWT style),
 * issue its receipts to the counterparty it names (L3), and request DPDP erasure of the personal data in it.
 * Each action writes a receipt. Features above the organisation's level show their upgrade path instead.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock3, ExternalLink, EyeOff, ShieldCheck, XCircle } from 'lucide-react';
import type { Counterparty, DisclosurePackage, ErasureRequest, LevelId } from '@/types';
import { api, db } from '@/api';
import { useNow } from '@/hooks/useQuery';
import { useOrgId, useUser } from '@/store/session';
import { canonical, sha256Hex, signText } from '@/lib/crypto';
import { DISCLOSABLE_FIELDS, FIELD_LABELS, commitFields, disclosureMessage, fieldValuesOf, verifyDisclosure, type DisclosableField, type DisclosureCheck } from '@/lib/disclosure';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { countdown, date, dateTime, n, plural } from '@/lib/format';
import { userName } from '@/mock/users';
import { cn } from '@/lib/cn';
import { Banner, Button, Checkbox, CopyButton, Dialog, Field, Input, Select, StatusChip, Textarea, toast } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { TYPE_META, describeEvent, type RecordEntry } from './lib';
import { LevelPreview, downloadText, evidenceClaim, levelOfReceipt } from './level';
import { recordReceipts } from './verify';
import type { ErasurePlan } from '@/mock/records';
import { ErasurePlanView } from '@/features/erasure/plan';
import { FirstIssueWarning, useFirstIssue } from '@/features/counterparties/shared';
import { PlanUpsell, SmartLink } from '@/shell/access';

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Counterparties in the register that this record names (by domain or by name). */
export function matchCounterparties(entry: RecordEntry, cps: Counterparty[]): Counterparty[] {
  const ref = entry.ref;
  if (TYPE_META[ref.type].group !== 'counterparties') return [];
  const id = ref.id.toLowerCase();
  const nm = compact(ref.name);
  return cps.filter((c) => {
    if (c.domain === id || id.endsWith(`.${c.domain}`)) return true;
    const cn_ = compact(c.name);
    const stem = compact(c.domain.split('.')[0]);
    return (nm.length >= 5 && (cn_.startsWith(nm) || nm.startsWith(cn_))) || (stem.length >= 5 && nm.startsWith(stem));
  });
}

/** Sequence numbers in this record whose salt was destroyed, with when. */
export function erasedSeqs(entry: RecordEntry, requests: ErasureRequest[] | undefined): Map<number, ErasureRequest> {
  const out = new Map<number, ErasureRequest>();
  if (!requests) return out;
  const seqs = new Set(recordReceipts(entry).map((r) => r.seq));
  for (const e of requests) if (e.status === 'executed') for (const s of e.affectedSeqs) if (seqs.has(s)) out.set(s, e);
  return out;
}

/** Erasure requests that concern this record: opened for its identifier, or touching its receipts. */
export function erasuresFor(entry: RecordEntry, requests: ErasureRequest[] | undefined): ErasureRequest[] {
  if (!requests) return [];
  const h = sha256Hex(entry.ref.id.trim().toLowerCase());
  const seqs = new Set(recordReceipts(entry).map((r) => r.seq));
  return requests.filter((e) => e.subjectHash === h || e.affectedSeqs.some((s) => seqs.has(s)));
}

function writeEvents(entry: RecordEntry) {
  return entry.events.filter((e) => !(e.read && e.decision === 'allow'));
}

function ReceiptPicker({ entry, value, onChange, id }: { entry: RecordEntry; value: number | undefined; onChange: (seq: number) => void; id: string }) {
  const evs = writeEvents(entry).length ? writeEvents(entry) : entry.events;
  return (
    <Select id={id} value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
      {evs.slice(0, 60).map((ev) => (
        <option key={ev.seq} value={ev.seq}>#{n(ev.seq)} · {ev.tool} · {ev.decision} · {date(ev.ts)}</option>
      ))}
    </Select>
  );
}

function FieldPicker({ value, onChange }: { value: DisclosableField[]; onChange: (v: DisclosableField[]) => void }) {
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2 border border-line p-3">
        {DISCLOSABLE_FIELDS.map((f) => (
          <Checkbox key={f} checked={value.includes(f)} onChange={(on) => onChange(on ? [...value, f] : value.filter((x) => x !== f))} label={FIELD_LABELS[f]} />
        ))}
      </div>
      <p className="mt-2 text-sm" aria-live="polite">
        You are revealing <span className="num font-semibold">{value.length}</span> of <span className="num font-semibold">{DISCLOSABLE_FIELDS.length}</span> committed fields.
        <span className="text-muted"> The others stay hidden as salted digests and are still bound by the signature.</span>
      </p>
    </div>
  );
}

function CheckSteps({ check }: { check: DisclosureCheck }) {
  return (
    <ul className="border border-line divide-y divide-line">
      {check.steps.map((s) => (
        <li key={s.label} className="px-3 py-2 flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">
          <StatusChip size="sm" tone={s.state === 'pass' ? 'ok' : s.state === 'fail' ? 'bad' : 'neutral'} icon={<ShieldCheck className="h-3 w-3" aria-hidden />}>{s.state === 'pass' ? 'Pass' : s.state === 'fail' ? 'Fail' : 'Not checked'}</StatusChip>
          <span className="font-medium">{s.label}</span>
          <span className="text-muted basis-full sm:basis-auto sm:flex-1 min-w-0">{s.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/* ── Export record evidence ───────────────────────────────── */

export async function exportRecordEvidence(orgId: string, userId: string, entry: RecordEntry, publicKeys: Record<string, string>, level: LevelId, history: { level: LevelId; from: string }[] | undefined, erasures: ErasureRequest[] | undefined) {
  const receipts = recordReceipts(entry);
  const org = api.org(orgId);
  const sealed = atLeast(level, 'l2') ? receipts.filter((r) => atLeast(levelOfReceipt(r, history, level), 'l2')) : [];
  const seals = [];
  const proofs = [];
  for (let i = 0; i < sealed.length; i += 10) {
    const chunk = sealed.slice(i, i + 10);
    const res = await Promise.all(chunk.map(async (r) => ({ seal: await api.seal(orgId, r.seq).catch(() => undefined), proof: await api.inclusionProof(orgId, r.seq).catch(() => undefined) })));
    for (const x of res) {
      if (x.seal?.sealed) seals.push(x.seal.seal);
      if (x.proof) proofs.push(x.proof);
    }
  }
  const av = sealed.length ? await api.anchors(orgId, 1) : undefined;
  const authorities = av ? [...av.authorities, ...(av.previousAuthorities ?? [])] : [];
  const kids = Array.from(new Set(receipts.map((r) => r.kid)));
  const erased = erasedSeqs(entry, erasures);
  const bundle = {
    format: 'elan1.record.evidence.v1',
    organisation: { id: org.id, name: org.name, key_fingerprint: org.keyFingerprint },
    record: { key: entry.ref.key, type: entry.ref.type, id: entry.ref.id, name: entry.ref.name },
    generated_at: new Date().toISOString(),
    generated_by: userName(userId),
    level: LEVEL_INFO[level].label,
    claim: evidenceClaim(level),
    receipts,
    public_keys: Object.fromEntries(kids.map((k) => [k, publicKeys[k]])),
    seals,
    inclusion_proofs: proofs,
    timestamp_authorities: authorities,
    erasures: Array.from(new Set(erased.values())).map((e) => ({ subject_ref: e.subjectRef, subject_hash: e.subjectHash, executed_at: e.executedAt, receipts: e.affectedSeqs.filter((s) => erased.has(s)) })),
    how_to_verify: [
      // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
      `For each receipt: SHA-256 over canonical JSON of the receipt without hash and sig must equal hash; the Ed25519 ${level === 'l1' ? 'seal (sig)' : 'signature'} over hash must verify with public_keys[kid].`,
      ...(seals.length ? ['For each seal: SHA-256 over the length-prefixed preimage of the 16 fields must equal digest; the signature verifies with the same key; F02 and F04 bind the receipt.', 'For each inclusion proof: RFC 6962 leaf and node hashes along path must reproduce root; each timestamp token signs that root.'] : []),
    ],
    limits: 'These receipts are not consecutive in the chain. Their previous-hash links point at receipts about other records, so this file alone cannot show that nothing was removed between them; the whole-chain export (Assurance › Exports) does that.',
  };
  const text = JSON.stringify(bundle, null, 2);
  downloadText(`record-${entry.ref.type}-${entry.ref.id.replace(/[^\w.-]+/g, '_')}-${org.slug}.json`, text);
  db.logAdmin(orgId, userId, 'record.evidence_exported', { record: entry.ref.key, receipts: receipts.length, seals: seals.length, proofs: proofs.length, digest: sha256Hex(canonical(bundle)).slice(0, 16) });
  return { receipts: receipts.length, seals: seals.length, proofs: proofs.length };
}

/* ── Share with redaction ─────────────────────────────────── */

/** L2: build and sign a redacted package in this browser (a file); L3: also publish it on the counterparty portal. */
export function ShareDialog({ open, onClose, entry, level, defaultAudience }: { open: boolean; onClose: () => void; entry: RecordEntry; level: LevelId; defaultAudience: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const first = writeEvents(entry)[0] ?? entry.events[0];
  const [seq, setSeq] = useState<number | undefined>(first?.seq);
  const [fields, setFields] = useState<DisclosableField[]>(['decision', 'tool', 'ts']);
  const [audience, setAudience] = useState(defaultAudience);
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [result, setResult] = useState<{ pkg: DisclosurePackage; check: DisclosureCheck; portal?: string; file?: string }>();
  useEffect(() => { if (open) { setSeq(first?.seq); setFields(['decision', 'tool', 'ts']); setAudience(defaultAudience); setDays('30'); setErr(undefined); setResult(undefined); } }, [open]);

  const l3 = atLeast(level, 'l3');
  const ev = entry.events.find((e) => e.seq === seq);
  // L3: the volume and reversal warning before the first package to an audience, acknowledged and recorded
  const aud = audience.trim() || 'ar-org:unspecified';
  const firstIssue = useFirstIssue(l3 && open ? aud : undefined, seq);
  const [ack, setAck] = useState(false);
  useEffect(() => { setAck(false); }, [aud]);
  const needsAck = l3 && !!firstIssue.info?.first && !ack;

  const create = async () => {
    if (!user || !ev) return;
    setBusy(true); setErr(undefined);
    try {
      if (l3) {
        const pkg = await api.createDisclosure(orgId, { seq: ev.seq, fields, audience: aud, expiresDays: Number(days) }, user.id, { acknowledgeFirstIssue: ack });
        setResult({ pkg, check: verifyDisclosure(pkg), portal: `${window.location.origin}/counterparty/${pkg.token}` });
        toast.ok('Disclosure created', `Revealing ${pkg.revealed.length} of ${pkg.committed.length} committed fields. The receipt is on the chain.`);
      } else {
        // L2: commit all 11 fields with fresh salts, reveal the chosen ones, sign the digest list with the organisation's key
        const d = db.getDB(orgId);
        const key = d.keys[d.keys.length - 1].key;
        const decision = ev.receipts[0];
        const values = fieldValuesOf(decision, ev.approvalReceipt);
        const { committed, salts } = commitFields(values);
        const now = Date.now();
        const base = { id: `dp_file_${now.toString(36)}`, orgId, issuerName: d.org.name, seq: decision.seq, receiptHash: decision.hash, createdAt: new Date(now).toISOString(), createdBy: user.id, audience: audience.trim() || 'ar-org:unspecified', token: '', expiresAt: new Date(now + Number(days) * 864e5).toISOString(), committed, revealed: fields.slice().sort().map((f) => ({ name: f, salt: salts[f], value: values[f] })), kid: key.kid, publicKey: key.publicKeyHex, sig: '', status: 'active' as const, views: 0 };
        const pkg: DisclosurePackage = { ...base, sig: signText(disclosureMessage(base), key) };
        const check = verifyDisclosure(pkg);
        const file = `disclosure-${d.org.slug}-${decision.seq}.json`;
        downloadText(file, JSON.stringify({ format: 'elan1.disclosure.v1', package: pkg, verify: 'For each revealed field, SHA-256 over canonical([salt, name, value]) must appear in committed; the Ed25519 signature over SHA-256(canonical({iss, seq, receipt_hash, aud, exp, digests})) must verify with publicKey, which you compare with a fingerprint obtained from the issuer.' }, null, 2));
        db.logAdmin(orgId, user.id, 'disclosure.exported', { seq: decision.seq, revealed: pkg.revealed.length, committed: pkg.committed.length, audience: pkg.audience, record: entry.ref.key });
        setResult({ pkg, check, file });
        toast.ok('Redacted file saved', `Revealing ${pkg.revealed.length} of ${pkg.committed.length} committed fields.`);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!atLeast(level, 'l2')) {
    return (
      <Dialog open={open} onClose={onClose} title="Share with redaction" size="lg" description="Send someone this record's evidence with only the fields they need, the rest hidden but still checkable.">
        <LevelPreview need="l2" what="Redacted sharing commits every field as a salted digest and reveals only the ones you choose; the recipient checks them against your signature." shows="Here you would pick a receipt, tick the fields to reveal and save a signed file — and from L3, publish it on a counterparty portal link." />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} size="lg" title={result ? 'Redacted package ready' : 'Share with redaction'}
      description={result ? undefined : l3 ? 'Every field is committed as a salted digest. Only the fields you tick are revealed; the counterparty checks them on a portal link without signing in.' : 'Every field is committed as a salted digest. Only the fields you tick are revealed; you get a signed file the recipient checks on their own machine.'}
      footer={result ? <Button variant="primary" onClick={onClose}>Done</Button> : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<EyeOff className="h-4 w-4" aria-hidden />} loading={busy} disabled={!fields.length || !ev || needsAck || (l3 && firstIssue.loading)} onClick={create}>{l3 ? 'Create disclosure' : 'Sign and save file'}</Button>
        </>
      )}>
      {result ? (
        <div className="space-y-4">
          <Banner tone={result.check.valid ? 'ok' : 'bad'} title={`Revealing ${result.check.revealedCount} of ${result.check.committedCount} committed fields`}>
            Checked here the way the recipient will check it. Receipt <ReceiptLink seq={result.pkg.seq} />, audience <span className="font-mono">{result.pkg.audience}</span>, valid until {dateTime(result.pkg.expiresAt)}.
          </Banner>
          {result.portal && (
            <Field label="Portal link (no sign-in)" htmlFor="share-link">
              <div className="flex gap-2">
                <Input id="share-link" mono readOnly value={result.portal} />
                <CopyButton text={result.portal} />
              </div>
            </Field>
          )}
          {result.file && <p className="text-sm text-muted">Saved as <span className="font-mono text-fg">{result.file}</span>. A redacted file is not on the portal; sharing it is up to you.</p>}
          <CheckSteps check={result.check} />
          {result.portal && <SmartLink to="/assurance/disclosure" hideWhenBlocked className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline underline-offset-2">Every disclosure, and withdrawing one <ExternalLink className="h-3.5 w-3.5" aria-hidden /></SmartLink>}
        </div>
      ) : (
        <div className="space-y-5">
          {err && <Banner tone="bad" title="Could not create the package">{err}</Banner>}
          <Field label="Receipt to share" htmlFor="share-seq" hint={ev ? `${ev.agent} asked to ${describeEvent(ev)}.` : undefined}>
            <ReceiptPicker id="share-seq" entry={entry} value={seq} onChange={setSeq} />
          </Field>
          <Field label="Fields to reveal">
            <FieldPicker value={fields} onChange={setFields} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <Field label="Audience" htmlFor="share-aud" hint="Who it is for, e.g. ar-org:auditor.example.in. The recipient checks it is meant for them.">
              <Input id="share-aud" mono value={audience} onChange={(e) => setAudience(e.target.value)} />
            </Field>
            <Field label="Valid for" htmlFor="share-days">
              <Select id="share-days" value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
              </Select>
            </Field>
          </div>
          {l3 && <FirstIssueWarning info={firstIssue.info} acknowledged={ack} onChange={setAck} what="disclosure" />}
          <PlanUpsell to="l3" what="A portal link for counterparties is part of L3 Proven." />
        </div>
      )}
    </Dialog>
  );
}

/* ── Issue receipts to a counterparty (L3) ────────────────── */

export function IssueDialog({ open, onClose, entry, level, register, matched }: { open: boolean; onClose: () => void; entry: RecordEntry; level: LevelId; register?: { counterparties: Counterparty[]; seatPrice: number }; matched: Counterparty[] }) {
  const orgId = useOrgId();
  const user = useUser();
  const first = writeEvents(entry)[0] ?? entry.events[0];
  const [cpId, setCpId] = useState<string>(matched[0]?.id ?? register?.counterparties[0]?.id ?? '');
  const [seq, setSeq] = useState<number | undefined>(first?.seq);
  const [fields, setFields] = useState<DisclosableField[]>(['decision', 'tool', 'ts', 'approval']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<Awaited<ReturnType<typeof api.issueToCounterparty>>>();
  useEffect(() => { if (open) { setCpId(matched[0]?.id ?? register?.counterparties[0]?.id ?? ''); setSeq(first?.seq); setErr(undefined); setDone(undefined); } }, [open]);
  // the volume and reversal warning before the first receipt to this counterparty, acknowledged and recorded
  const target = register?.counterparties.find((c) => c.id === cpId);
  const firstIssue = useFirstIssue(open && atLeast(level, 'l3') && target ? `ar-org:${target.domain}` : undefined, seq);
  const [ack, setAck] = useState(false);
  useEffect(() => { setAck(false); }, [cpId]);
  const needsAck = !!firstIssue.info?.first && !ack;

  if (!atLeast(level, 'l3')) {
    return (
      <Dialog open={open} onClose={onClose} title="Issue receipts to a counterparty" size="lg" description="Send a counterparty a receipt they can verify against your key, revealing only the fields they need.">
        <LevelPreview need="l3" what="Verification between organisations: a counterparty in your register receives the receipt and checks it with your pinned key." shows={`Here you would pick ${entry.ref.name} from the counterparty register, choose the receipt and fields, and see their verifier's answer. Each counterparty that verifies holds a seat (₹45,000 a year).`} />
      </Dialog>
    );
  }
  const cps = register?.counterparties ?? [];
  const cp = cps.find((c) => c.id === cpId);
  const issue = async () => {
    if (!user || !seq || !cp) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await api.issueToCounterparty(orgId, seq, cp.id, fields, user.id, { acknowledgeFirstIssue: ack });
      setDone(r);
      toast.ok(`Receipt issued to ${cp.name}`, `Revealing ${r.disclosure.revealed.length} of ${r.disclosure.committed.length} committed fields.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={done ? 'Receipt issued' : `Issue receipts to ${cp?.name ?? 'a counterparty'}`}
      description={done ? undefined : 'The counterparty receives the receipt with only the fields you reveal and checks it against your key.'}
      footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!cp || !seq || !fields.length || needsAck || firstIssue.loading} onClick={issue}>Issue receipt</Button>
        </>
      )}>
      {done ? (
        <div className="space-y-4">
          <Banner tone={done.receipt.verification.state === 'verified' ? 'ok' : done.receipt.verification.state === 'failed' ? 'bad' : 'held'} title={done.receipt.verification.state === 'verified' ? `${done.receipt.counterpartyName}'s verifier reported a pass` : done.receipt.verification.state === 'pending' ? `Sent — ${done.receipt.counterpartyName} has not verified it yet` : `${done.receipt.counterpartyName}'s verifier reported ${done.receipt.verification.state}`}>
            {done.receipt.summary}. Receipt <ReceiptLink seq={done.receipt.seq} />.
          </Banner>
          {done.disclosure.token && (
            <Field label="Their portal link" htmlFor="issue-link">
              <div className="flex gap-2">
                <Input id="issue-link" mono readOnly value={`${window.location.origin}/counterparty/${done.disclosure.token}`} />
                <CopyButton text={`${window.location.origin}/counterparty/${done.disclosure.token}`} />
              </div>
            </Field>
          )}
          <Link to="/assurance/counterparties" className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline underline-offset-2">Counterparty register <ExternalLink className="h-3.5 w-3.5" aria-hidden /></Link>
        </div>
      ) : cps.length === 0 ? (
        <Banner tone="info" title="The counterparty register is empty" actions={<Link to="/assurance/counterparties" className="text-sm font-medium underline underline-offset-2">Add a counterparty</Link>}>
          Add {entry.ref.name} to the register with its key fingerprint first. Each counterparty that verifies holds a seat.
        </Banner>
      ) : (
        <div className="space-y-5">
          {err && <Banner tone="bad" title="Could not issue the receipt">{err}</Banner>}
          {matched.length === 0 && (
            <Banner tone="neutral" title={`${entry.ref.name} is not in the counterparty register`} actions={<Link to="/assurance/counterparties" className="text-sm font-medium underline underline-offset-2">Open the register</Link>}>
              You can still issue to another registered counterparty, or add {entry.ref.name} first.
            </Banner>
          )}
          <Field label="Counterparty" htmlFor="issue-cp">
            <Select id="issue-cp" value={cpId} onChange={(e) => setCpId(e.target.value)}>
              {cps.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.domain} · {c.verification.replace('_', ' ')}</option>)}
            </Select>
          </Field>
          {cp && (
            <p className="text-sm text-muted">
              Seats <span className="num text-fg">{cp.seatsUsed} of {cp.seats}</span> in use · {plural(cp.issued, 'receipt')} issued · {n(cp.received)} received · key {cp.keyFingerprint ? <span className="font-mono text-fg">{cp.keyFingerprint}</span> : 'not pinned yet'} ({cp.keyRoute.replace('_', ' ')})
            </p>
          )}
          <Field label="Receipt" htmlFor="issue-seq"><ReceiptPicker id="issue-seq" entry={entry} value={seq} onChange={setSeq} /></Field>
          <Field label="Fields to reveal"><FieldPicker value={fields} onChange={setFields} /></Field>
          <FirstIssueWarning info={firstIssue.info} acknowledged={ack} onChange={setAck} />
        </div>
      )}
    </Dialog>
  );
}

/* ── DPDP erasure on a record ─────────────────────────────── */

export function ErasureDialog({ open, onClose, entry, level, history }: { open: boolean; onClose: () => void; entry: RecordEntry; level: LevelId; history: { level: LevelId; from: string }[] | undefined }) {
  const orgId = useOrgId();
  const user = useUser();
  const [ref, setRef] = useState('');
  const [identifier, setIdentifier] = useState(entry.ref.id);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [made, setMade] = useState<ErasureRequest>();
  // the erasure plan is shown before the request is opened; statutory retention can refuse it (recorded)
  const [plan, setPlan] = useState<{ needle: string; plan: ErasurePlan }>();
  const [planning, setPlanning] = useState(false);
  const [refused, setRefused] = useState<{ subjectRef: string; seq?: number }>();
  const needle = identifier.trim().toLowerCase();
  const current = plan && plan.needle === needle ? plan.plan : undefined;
  useEffect(() => { if (open) { setRef(''); setIdentifier(entry.ref.id); setReason(''); setTried(false); setErr(undefined); setMade(undefined); setPlan(undefined); setRefused(undefined); } }, [open, entry.ref.id]);
  const preview = async () => {
    if (needle.length < 3) { setErr('Enter at least 3 characters to search for.'); return; }
    setPlanning(true); setErr(undefined);
    try { setPlan({ needle, plan: await api.records.erasurePlan(orgId, needle) }); } catch (x) { setErr((x as Error).message); } finally { setPlanning(false); }
  };

  const sealedHere = useMemo(() => recordReceipts(entry).filter((r) => atLeast(levelOfReceipt(r, history, level), 'l2')).length, [entry, history, level]);

  // erasure is available from L1 (decision 6c): every record is salted from the first L1 record
  const reasonErr = reason.trim().length < 8 ? 'Say why, in a sentence (for example the data principal\'s request under Section 12).' : undefined;
  const submit = async () => {
    setTried(true);
    if (reasonErr || !user || !current) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await api.records.openErasure(orgId, { subjectRef: ref, identifier, reason }, user.id);
      if (r.outcome === 'refused') {
        setRefused({ subjectRef: r.refusal.subjectRef, seq: r.refusal.seq });
        setPlan({ needle, plan: r.plan });
        toast.info('Erasure refused and recorded', `Every matching record is under statutory retention (${r.refusal.bases.join(', ')}).`);
        return;
      }
      const e = r.request;
      setMade(e);
      toast.ok('Erasure requested', `${plural(e.affected, 'receipt')} affected${r.plan.held.length ? `, ${r.plan.held.length} held by statutory retention` : ''}. Two other people approve within 72 hours.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={made ? 'Erasure requested' : 'Request erasure (DPDP)'}
      description={made ? undefined : 'The identifier is hashed at once and never stored. Two different people approve, neither of them you; then the salt is destroyed.'}
      footer={made ? (
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Link to="/records/erasure" className="inline-flex items-center justify-center h-10 px-4 font-medium bg-fg text-canvas border border-fg hover:bg-fg/90">Follow it under Erasure</Link>
        </>
      ) : refused ? (
        <Button variant="primary" onClick={onClose}>Close</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" loading={planning} onClick={preview}>{current ? 'Refresh the plan' : 'Show the plan'}</Button>
          <Button variant={current?.outcome === 'refused' ? 'danger' : 'primary'} loading={busy} disabled={!current} onClick={submit}>{current?.outcome === 'refused' ? 'Record the refusal' : 'Open the request'}</Button>
        </>
      )}>
      {made ? (
        <div className="space-y-3 text-sm">
          <Banner tone="held" title={`${made.subjectRef} — waiting for 2 approvals`}>
            Due {dateTime(made.dueAt)}. {plural(made.affected, 'receipt')} will have their values removed and their payload salt destroyed when it is executed. Receipt <ReceiptLink seq={made.seq} />.
          </Banner>
          <p className="text-muted">Subject hash <span className="font-mono text-fg">{made.subjectHash.slice(0, 24)}…</span> — the identifier itself was not stored.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {err && <Banner tone="bad" title="Could not open the request">{err}</Banner>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Subject reference" htmlFor="er-ref" hint="Your case number, e.g. DP-2026-0231. Left blank, one is made.">
              <Input id="er-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="DP-2026-…" />
            </Field>
            <Field label="Scope — identifier to erase" htmlFor="er-id" hint="Matched against every receipt, from L1. Hashed, never stored.">
              <Input id="er-id" mono value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
            </Field>
          </div>
          <Field label="Reason" required htmlFor="er-reason" error={tried ? reasonErr : undefined}>
            <Textarea id="er-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} invalid={tried && !!reasonErr} />
          </Field>
          <p className="text-sm text-muted">
            This record has <span className="num text-fg">{plural(recordReceipts(entry).length, 'receipt')}</span>, each salted from the first L1 record.
            {sealedHere > 0 && <> <span className="num text-fg">{n(sealedHere)}</span> of them also carry a Seal v6 record (L2 and above), which will mark its payload hash unbound.</>}
          </p>
          {refused && <Banner tone="bad" title={`${refused.subjectRef} refused — nothing erased`}>The refusal is recorded{refused.seq !== undefined ? <> as <ReceiptLink seq={refused.seq} /></> : ''} with the plan below.</Banner>}
          <div className="border border-line bg-sunken/30 p-4" aria-live="polite">
            {current ? <ErasurePlanView plan={current} /> : <p className="text-sm text-muted">Show the plan to see the fields, systems and exports this erasure touches, and what statutory retention holds back. It must be shown before the request is opened.</p>}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** The erasure requests that concern this record, with the live 72-hour clock. */
export function ErasureStatus({ requests, className }: { requests: ErasureRequest[]; className?: string }) {
  const now = useNow(30_000);
  if (!requests.length) return null;
  return (
    <div className={cn('space-y-3', className)}>
      {requests.map((e) => {
        if (e.status === 'rejected') {
          // a request that was sent back is closed: no clock, never overdue
          return (
            <Banner key={e.id} tone="neutral" title={`${e.subjectRef}: sent back — not erased`}
              actions={<SmartLink to={`/records/erasure#${e.id}`} hideWhenBlocked className="text-sm font-medium underline underline-offset-2 whitespace-nowrap">Open the request</SmartLink>}>
              <span className="inline-flex flex-wrap items-center gap-x-2">
                <XCircle className="h-3.5 w-3.5" aria-hidden />
                <span>Rejected. The payload hashes keep their salt and nothing was erased.</span>
              </span>
            </Banner>
          );
        }
        const overdue = e.status !== 'executed' && new Date(e.dueAt).getTime() < now;
        const tone = e.status === 'executed' ? 'ok' : overdue ? 'bad' : 'held';
        const title = e.status === 'executed'
          ? `Erased under DPDP — salt destroyed ${e.executedAt ? date(e.executedAt) : ''} (${e.subjectRef})`
          : e.status === 'approved' ? `${e.subjectRef}: approved by 2 people — ready to execute` : `${e.subjectRef}: erasure requested — ${e.approvals.length} of ${e.required} approvals`;
        return (
          <Banner key={e.id} tone={tone} title={title}
            actions={<SmartLink to={`/records/erasure#${e.id}`} hideWhenBlocked className="text-sm font-medium underline underline-offset-2 whitespace-nowrap">Open the request</SmartLink>}>
            {e.status === 'executed' ? (
              <>Payload hashes of {plural(e.affected, 'receipt')} are now unlinkable to the person. The chain {e.chainStillVerifies ? 'still verifies' : 'was not re-checked'}{e.executedBy ? ` · executed by ${userName(e.executedBy)}` : ''}.</>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-x-2">
                <Clock3 className="h-3.5 w-3.5" aria-hidden />
                <span className="num">{overdue ? `Overdue by ${countdown(new Date(2 * now - new Date(e.dueAt).getTime()).toISOString(), now)}` : `${countdown(e.dueAt, now)} left of the 72-hour clock`}</span>
                <span>· {e.approvals.length ? `approved by ${e.approvals.map((a) => userName(a.userId)).join(' and ')}` : 'no approvals yet'}</span>
              </span>
            )}
          </Banner>
        );
      })}
    </div>
  );
}

/** Quick reference for the pinned-field text of an erased value. */
export function erasedText(e: ErasureRequest) {
  return `Erased — salt destroyed ${e.executedAt ? date(e.executedAt) : ''}`.trim();
}
