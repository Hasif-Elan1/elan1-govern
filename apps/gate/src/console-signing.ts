import { createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { decrypt, encrypt, publicKeyHex, seal6, toConsoleCheckpoint, toConsoleReceipt, verifyText, type Checkpoint, type Receipt, type ReceiptInput } from "@gate/core";
import { forOrg, signWithKey, toCheckpoint, type Append, type ChainKey, type ChainTx } from "@gate/db";
import { z } from "zod";
import { anchorOrg, ANCHORED_LEVELS } from "./anchors";
import { chain, checkpoint } from "./chain";
import { ChainMoved, GATE_ONLY_ACTIONS, type ChainHead } from "./console-chain";
import { openSuccessor } from "./custody";
import type { Deps } from "./deps";
import { providerFor } from "./keys";
import { projectBilling } from "./wiring/billing";

/*
 * What the organisation's key signs for the approved console besides receipts and checkpoints (plans/console-app.md
 * E5; DECISIONS "Console signing"). The console's domain runs in the web app and holds no keys, so it asks for
 * signatures here. No route takes bytes or a digest to sign: each request is structured, this module builds the
 * message itself from it, under its own format (a Seal v6 preimage with the "elan1.seal.v6" domain tag, a disclosure,
 * a bundle manifest …), checks it against the organisation's own chain (a seal is over a real receipt; a disclosure
 * commits a real receipt's values; a manifest lists real receipts, seals, checkpoints, anchors and keys), signs it with
 * the org's active key through its KeyProvider (an HSM-held key signs inside its boundary) and writes a receipt for
 * every signature it makes. Asking for the same message again returns the same signature and writes nothing.
 *
 * Seal v6 records are made here outright: from an organisation's L2 boundary every receipt gets one, with a salt
 * this module keeps (encrypted) for F12 and F14. DPDP erasure destroys those salts and signs the redacted copy of
 * each erased receipt; the Receipt rows themselves are never changed, so the chain keeps verifying.
 */

export const SEAL_ACTION = "seal.signed";
export const ERASED_ACTION = "record.erased";
const SYSTEM = "Elan1 Govern";

/** The receipt each kind of signature writes. */
export const SIGNATURE_ACTIONS = {
  disclosure: "disclosure.signed",
  "disclosure-bundle": "disclosure.bundle_signed",
  "sd-jwt": "disclosure.sd_jwt_signed",
  "evidence-manifest": "evidence.manifest_signed",
  "pack-manifest": "evidence.manifest_signed",
  "usage-statement": "statement.signed",
  residency: "residency.statement_signed",
} as const;
export type SignatureKind = keyof typeof SIGNATURE_ACTIONS;

/** Actions only this module writes (listed in console-chain.ts GATE_ONLY_ACTIONS, so the console may not claim them). */
export const SIGNING_ACTIONS: readonly string[] = [SEAL_ACTION, ERASED_ACTION, ...new Set(Object.values(SIGNATURE_ACTIONS))];

/** The reason an erased receipt carries (the console's own wording; never the caller's). */
export const ERASURE_REASON = "Erased on a data principal’s request: the salt was destroyed and the values the rules inspected were removed.";

/** A request this module will not sign: it does not match the organisation's chain, or is not well formed. */
export class SigningRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningRefused";
  }
}

type ConsoleReceipt = seal6.Receipt;
const AUTONOMY = /^A[0-5]$/;
const LEVELS = ["l2", "l3", "sovereign"] as const;
const hex64 = /^[0-9a-f]{64}$/;
const isoTime = (s: string) => Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === s;

/* ── Signing with the org key, through its provider ───────────────────────── */

const opened = new Map<string, KeyObject>();

/**
 * Ed25519 over raw bytes with the key `key` names, wherever it is held: inside a provider that signs (the software
 * HSM), or unwrapped here. The signature is checked against the stored public key before it is used.
 */
async function signBytes(deps: Deps, orgId: string, tx: ChainTx, key: ChainKey, message: Uint8Array): Promise<Uint8Array> {
  const row = await tx.orgKey.findFirst({ where: { kid: key.kid } });
  if (!row) throw new Error(`no signing key ${key.kid} for this organisation`);
  const provider = providerFor(deps, row.provider);
  let sig: Uint8Array;
  if (provider.signBytes) sig = await provider.signBytes({ orgId, kid: row.kid, ref: row.privateKeyEnc }, message);
  else {
    const id = `${orgId}:${row.kid}`;
    let k = opened.get(id);
    if (!k) {
      k = createPrivateKey(await provider.unwrap(row.privateKeyEnc, { orgId, kid: row.kid }));
      opened.set(id, k);
    }
    sig = new Uint8Array(edSign(null, Buffer.from(message), k));
  }
  if (!edVerify(null, Buffer.from(message), createPublicKey(row.publicKey), Buffer.from(sig))) {
    throw new Error(`the "${provider.name}" key provider returned a signature that does not verify with key ${row.kid}`);
  }
  return sig;
}

/** Ed25519 over the UTF-8 of a message this module built (a hex digest), as the chain signs: `ed25519:<base64>`. */
async function signTextChecked(tx: ChainTx, key: ChainKey, text: string): Promise<string> {
  const sig = await signWithKey(key, text);
  const row = await tx.orgKey.findFirst({ where: { kid: key.kid }, select: { publicKey: true } });
  if (!row || !verifyText(row.publicKey, text, sig)) throw new Error(`the signature over the ${text.slice(0, 8)}… message does not verify with key ${key.kid}`);
  return sig;
}

/* ── The organisation's chain, as the console reads it ───────────────────── */

async function consoleReceipt(tx: ChainTx, seq: number): Promise<ConsoleReceipt | undefined> {
  const row = await tx.receipt.findFirst({ where: { seq }, select: { body: true } });
  return row ? (toConsoleReceipt(row.body as unknown as Receipt) as unknown as ConsoleReceipt) : undefined;
}

/** A receipt as the console holds it now: its erased copy when an erasure redacted it. */
async function shownReceipt(tx: ChainTx, seq: number): Promise<ConsoleReceipt | undefined> {
  const red = await tx.receiptRedaction.findFirst({ where: { seq }, select: { receipt: true } });
  return red ? (red.receipt as unknown as ConsoleReceipt) : consoleReceipt(tx, seq);
}

/** The first approval result naming `seq` (how the console finds it), or the one at `approvalSeq` after checking it. */
async function approvalResult(tx: ChainTx, seq: number, approvalSeq?: number): Promise<ConsoleReceipt | undefined> {
  if (approvalSeq === undefined) {
    const row = await tx.receipt.findFirst({ where: { kind: "approval", body: { path: ["ref_seq"], equals: seq } }, orderBy: { seq: "asc" }, select: { seq: true } });
    return row ? shownReceipt(tx, row.seq) : undefined;
  }
  const r = await shownReceipt(tx, approvalSeq);
  if (!r || r.kind !== "approval" || r.ref_seq !== seq) throw new SigningRefused(`#${approvalSeq} is not an approval result of #${seq}.`);
  return r;
}

async function receiptAt(tx: ChainTx, seq: unknown, hash?: unknown): Promise<ConsoleReceipt> {
  if (!Number.isInteger(seq) || (seq as number) < 1) throw new SigningRefused("A receipt number is not valid.");
  const r = await shownReceipt(tx, seq as number);
  if (!r) throw new SigningRefused(`There is no receipt #${seq as number} in this organisation's chain.`);
  if (hash !== undefined && r.hash !== hash) throw new SigningRefused(`Receipt #${seq as number} does not have the hash given.`);
  return r;
}

/* ── Seal v6 ──────────────────────────────────────────────────────────────── */

const saltAad = (orgId: string, seq: number) => `seal-salt:${orgId}:${seq}`;

/** The lexicon hash every seal of an organisation carries (F15), as the console computes it. */
export const lexiconHash = (orgId: string) => seal6.sha256Hex(seal6.canonical({ lexicon: "elan1.lexicon.v1", org: orgId, fields: seal6.SEAL_FIELDS.map((f) => f.name) }));

export const SealInput = z
  .object({
    /** The first receipt of the organisation's L2 boundary: needed for its first seal, ignored afterwards. */
    fromSeq: z.number().int().min(1).optional(),
    /** F11 for receipts whose autonomy grant the console holds (decisions and outcomes at L3), by seq. */
    autonomy: z.record(z.string().regex(/^\d{1,9}$/), z.string().regex(AUTONOMY)).optional(),
    /** The assurance level each receipt was written at, as contiguous runs from a seq on. */
    levels: z.array(z.object({ level: z.enum(LEVELS), fromSeq: z.number().int().min(1) }).strict()).max(20).optional(),
  })
  .strict();
export type SealInput = z.infer<typeof SealInput>;

export interface SealRow {
  seq: number;
  receiptHash: string;
  level: string;
  values: string[];
  recordId: string;
  digest: string;
  kid: string;
  sig: string;
  payloadUnbound: boolean;
}

/** A stored seal as the console's SealRecord. */
export function sealRecordOf(s: Pick<SealRow, "seq" | "receiptHash" | "level" | "values" | "digest" | "kid" | "sig" | "payloadUnbound">): seal6.SealRecord {
  return {
    format: seal6.SEAL_FORMAT,
    seq: s.seq,
    receiptHash: s.receiptHash,
    level: s.level as seal6.LevelId,
    fields: seal6.SEAL_FIELDS.map((f, i) => ({ id: f.id, name: f.name, value: s.values[i] ?? "" })),
    preimageBytes: seal6.sealPreimage(s.values).length,
    digest: s.digest,
    kid: s.kid,
    sig: s.sig,
    ...(s.payloadUnbound ? { payloadUnbound: true } : {}),
  };
}

/**
 * Seal every receipt from the last seal (or the L2 boundary) to the head, inside a chain transaction: the 16 fields
 * from the receipt itself, a fresh salt kept encrypted, F03 linking to the seal before, F13 counting the record's
 * earlier seals, then the org key's signature over the digest. One `seal.signed` receipt records the run and is
 * sealed with it, so the head is sealed when this returns. Nothing new to seal: nothing is written.
 */
async function sealInTx(deps: Deps, orgId: string, append: Append, tx: ChainTx, key: ChainKey, input: SealInput): Promise<{ seals: SealRow[]; receipt?: Receipt }> {
  const org = await tx.org.findFirstOrThrow({ select: { level: true } });
  if (!ANCHORED_LEVELS.includes(org.level)) throw new SigningRefused("Seal v6 records start at L2 Attested; this organisation is not at L2.");
  const last = await tx.sealRecord.findFirst({ orderBy: { seq: "desc" } });
  const start = last ? last.seq + 1 : input.fromSeq;
  if (start === undefined) throw new SigningRefused("The first seal needs the organisation's L2 boundary (fromSeq).");
  const rows = await tx.receipt.findMany({ where: { seq: { gte: start } }, orderBy: { seq: "asc" }, select: { seq: true, body: true, action: true } });
  if (!rows.some((r) => r.action !== SEAL_ACTION)) return { seals: [] };
  rows.forEach((r, i) => {
    if (r.seq !== start + i) throw new Error(`the receipt chain has a gap at #${start + i}`);
  });
  const lex = lexiconHash(orgId);
  const levels = [...(input.levels ?? [])].sort((a, b) => a.fromSeq - b.fromSeq);
  const levelAt = (seq: number) => levels.filter((l) => l.fromSeq <= seq).at(-1)?.level ?? org.level;
  const autonomyOf = (r: ConsoleReceipt) => {
    if (r.kind !== "decision" && r.kind !== "outcome") return "A0";
    const own = r.details?.autonomy;
    if (typeof own === "string" && AUTONOMY.test(own)) return own;
    return input.autonomy?.[String(r.seq)] ?? "A0";
  };
  let prev = last?.digest;
  const counts = new Map<string, number>();
  const out: SealRow[] = [];
  const salts = new Map<number, string>();
  // a receipt erased before it was sealed: its payload hash is the one the erasure froze, and it has no salt left
  const erased = new Map((await tx.receiptRedaction.findMany({ where: { seq: { gte: start } }, select: { seq: true, receipt: true } })).map((x) => [x.seq, x.receipt as unknown as ConsoleReceipt]));

  const sealOne = async (body: Receipt) => {
    const r = toConsoleReceipt(body) as unknown as ConsoleReceipt;
    const frozen = erased.get(r.seq)?.redacted?.payloadHash;
    const salt = frozen ? undefined : randomBytes(16).toString("hex");
    const rid = seal6.sealedRecordId(r, salt);
    if (!counts.has(rid)) counts.set(rid, await tx.sealRecord.count({ where: { recordId: rid } }));
    const version = counts.get(rid)! + 1;
    counts.set(rid, version);
    const level = levelAt(r.seq);
    const ctx = { prevDigest: prev ?? r.prev_hash, autonomy: autonomyOf(r), recordVersion: version, salt, lexiconHash: lex, level: level as seal6.LevelId, ...(frozen ? { frozenRecordId: rid } : {}) };
    const fields = seal6.sealFields(r, ctx, frozen);
    const digest = seal6.digestOfFields(fields);
    const sig = Buffer.from(await signBytes(deps, orgId, tx, key, Buffer.from(digest, "hex"))).toString("hex");
    prev = digest;
    if (salt) salts.set(r.seq, salt);
    out.push({ seq: r.seq, receiptHash: r.hash, level, values: seal6.fieldValues(fields), recordId: rid, digest, kid: key.kid!, sig, payloadUnbound: !!frozen });
  };

  for (const r of rows) await sealOne(r.body as unknown as Receipt);
  const first = out[0]!;
  const receipt = await append({ kind: "admin", actor: SYSTEM, action: SEAL_ACTION, details: { from_seq: first.seq, to_seq: out.at(-1)!.seq, count: out.length + 1, last_digest: out.at(-1)!.digest.slice(0, 16), kid: key.kid! } });
  await sealOne(receipt);
  await tx.sealRecord.createMany({
    data: out.map((s) => {
      const salt = salts.get(s.seq);
      return { orgId, ...s, saltEnc: salt ? encrypt(deps.env.GATE_MASTER_KEY, salt, saltAad(orgId, s.seq)) : null };
    }),
  });
  return { seals: out, receipt };
}

/** Seal the organisation's receipts up to the head (see sealInTx). */
export async function sealUpTo(deps: Deps, orgId: string, input: SealInput) {
  return chain(deps, orgId, (append, tx, key) => sealInTx(deps, orgId, append, tx, key, input));
}

/** A record's salt while it exists (for an auditor who is shown the payload); undefined once an erasure destroyed it. */
export async function sealSalt(deps: Deps, orgId: string, seq: number): Promise<string | undefined> {
  const row = await forOrg(orgId, deps.db).sealRecord.findFirst({ where: { seq }, select: { saltEnc: true } });
  return row?.saltEnc ? decrypt(deps.env.GATE_MASTER_KEY, row.saltEnc, saltAad(orgId, seq)) : undefined;
}

/* ── DPDP erasure ─────────────────────────────────────────────────────────── */

export const ErasureInput = z
  .object({
    /** The console's erasure request id and the data principal's reference (never an identifier). */
    request: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
    subjectRef: z.string().trim().max(80).optional(),
    seqs: z.array(z.number().int().min(1)).min(1).max(2000),
    /** When the erasure was executed (the console's executedAt): no later than now. */
    at: z.string().refine(isoTime, "an ISO time"),
  })
  .strict();
export type ErasureInput = z.infer<typeof ErasureInput>;

export interface Redaction {
  seq: number;
  /** The erased receipt, as the console shows and exports it. */
  receipt: ConsoleReceipt;
  /** F14 as sealed (frozen), and F12 as sealed. */
  payloadHash: string;
  recordId: string;
}

/**
 * Erase receipts on the organisation's real chain: for each, the values the rules inspected are removed from the
 * copy the console shows and exports (args_summary becomes { erased: true }), and the org key signs that copy with
 * its original hash, as the console's verifier checks it; the record's salt is destroyed, so its seal's F14 and
 * F12 can no longer be linked to the payload, and the seal still verifies. One `record.erased` receipt names them.
 * A receipt already erased is returned as it was.
 */
async function eraseInTx(deps: Deps, orgId: string, append: Append, tx: ChainTx, key: ChainKey, input: ErasureInput, actor: string): Promise<{ receipt?: Receipt; redactions: Redaction[] }> {
  if (Date.parse(input.at) > Date.now() + 60_000) throw new SigningRefused("An erasure cannot be dated in the future.");
  const seqs = [...new Set(input.seqs)].sort((a, b) => a - b);
  const done = await tx.receiptRedaction.findMany({ where: { seq: { in: seqs } } });
  const out: Redaction[] = [];
  const fresh: Redaction[] = [];
  for (const seq of seqs) {
    const had = done.find((d) => d.seq === seq);
    const seal = await tx.sealRecord.findFirst({ where: { seq } });
    if (had) {
      const r = had.receipt as unknown as ConsoleReceipt;
      out.push({ seq, receipt: r, payloadHash: String(r.redacted?.payloadHash ?? ""), recordId: seal?.recordId ?? seal6.sealedRecordId(r, undefined) });
      continue;
    }
    const r = await consoleReceipt(tx, seq);
    if (!r) throw new SigningRefused(`There is no receipt #${seq} in this organisation's chain.`);
    if (r.kind === "admin" && GATE_ONLY_ACTIONS.has(r.action ?? "")) throw new SigningRefused(`Receipt #${seq} is a record Elan1 Govern keeps; it cannot be erased.`);
    // a record not sealed (L1, or not yet): its payload hash is salted with a salt that is discarded at once, and a
    // seal made later freezes that hash (sealInTx)
    const payloadHash = seal ? (seal.values as string[])[13]! : seal6.payloadHash(randomBytes(16).toString("hex"), seal6.payloadOf(r));
    const recordId = seal ? seal.recordId : seal6.sealedRecordId(r, undefined);
    const base = { ...r, args_summary: { erased: true }, redacted: { fields: ["args_summary"], reason: ERASURE_REASON, ...(input.subjectRef ? { request: input.subjectRef } : {}), payloadHash, at: input.at, kid: key.kid! } } as ConsoleReceipt;
    const sig = await signTextChecked(tx, key, seal6.redactionMessage(base));
    const erased = { ...base, redacted: { ...base.redacted!, sig } } as ConsoleReceipt;
    fresh.push({ seq, receipt: erased, payloadHash, recordId });
    out.push(fresh.at(-1)!);
  }
  if (!fresh.length) return { redactions: out };
  const destroyed = await tx.sealRecord.count({ where: { seq: { in: fresh.map((f) => f.seq) }, saltEnc: { not: null } } });
  const receipt = await append({
    kind: "admin",
    actor,
    action: ERASED_ACTION,
    details: { request: input.request, ...(input.subjectRef ? { subject_ref: input.subjectRef } : {}), count: fresh.length, first_seq: fresh[0]!.seq, last_seq: fresh.at(-1)!.seq, seqs: fresh.map((f) => f.seq).join(",").slice(0, 2000), salts_destroyed: destroyed },
  });
  await tx.receiptRedaction.createMany({ data: fresh.map((f) => ({ orgId, seq: f.seq, receipt: f.receipt as object, erasureSeq: receipt.seq })) });
  await tx.sealRecord.updateMany({ where: { seq: { in: fresh.map((f) => f.seq) } }, data: { saltEnc: null, payloadUnbound: true } });
  return { receipt, redactions: out };
}

/* ── Other signatures: each built here from a structured request ─────────── */

const str = (max: number) => z.string().max(max);
const committedList = z.array(z.object({ name: str(40), digest: z.string().regex(hex64) }).strict()).max(20);
const saltMap = z.record(str(40), z.string().regex(/^[0-9a-f]{32}$/));
const futureIso = z.string().refine(isoTime, "an ISO time").refine((s) => Date.parse(s) > Date.now() && Date.parse(s) < Date.now() + 400 * 86_400_000, "a time in the next 400 days");

const DisclosureReq = z
  .object({
    base: z.object({ orgId: str(80), seq: z.number().int().min(1), receiptHash: str(100), audience: z.string().trim().min(1).max(200), expiresAt: futureIso, committed: committedList }).strict(),
    salts: saltMap,
    approvalSeq: z.number().int().min(1).optional(),
  })
  .strict();

const BundleReq = z
  .object({
    base: z
      .object({
        format: z.literal("elan1.disclosure.bundle.v1"),
        orgId: str(80),
        audience: z.string().regex(/^ar-org:[a-z0-9-]+(\.[a-z0-9-]+)+$/).max(200),
        expiresAt: futureIso,
        range: z.object({ fromSeq: z.number().int().min(1), toSeq: z.number().int().min(1), count: z.number().int().min(1).max(200), kinds: z.enum(["decisions", "all"]) }).strict(),
        fields: z.array(z.enum(seal6.DISCLOSABLE_FIELDS)).min(1).max(seal6.DISCLOSABLE_FIELDS.length),
        items: z.array(z.object({ seq: z.number().int().min(1), receiptHash: str(100), committed: committedList }).strict()).min(1).max(200),
      })
      .strict(),
    secret: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

const SdJwtReq = z
  .object({
    header: z.object({ alg: z.literal("EdDSA"), typ: z.literal("example+sd-jwt"), kid: str(40) }).strict(),
    payload: z
      .object({
        iss: str(200),
        aud: z.string().trim().min(1).max(200),
        iat: z.number().int(),
        exp: z.number().int(),
        _sd_alg: z.literal("sha-256"),
        _sd: z.array(str(60)).max(20),
        receipt: z.object({ org: str(80), seq: z.number().int().min(1), hash: str(100), kid: str(40) }).strict(),
      })
      .strict(),
    salts: saltMap,
    approvalSeq: z.number().int().min(1).optional(),
  })
  .strict();

const json = z.unknown();
const EvidenceManifestReq = z
  .object({
    manifest: z.record(z.string(), json),
    public_keys: z.record(str(40), z.string().regex(hex64)),
    receipts: z.array(z.record(z.string(), json)).min(1).max(50_000),
    checkpoints: z.array(z.record(z.string(), json)).max(50_000),
    seals: z.array(z.record(z.string(), json)).max(50_000),
    anchors: z.object({ authorities: z.array(z.record(z.string(), json)).max(20), batches: z.array(z.record(z.string(), json)).max(5000) }).strict(),
    declarations: json,
    profile: json,
    readme: z.string().max(200_000),
    lexicon: json.optional(),
  })
  .strict();

const PackManifestReq = z
  .object({
    manifest: z.record(z.string(), json),
    public_keys: z.record(str(40), z.string().regex(hex64)),
    receipts: z.array(z.record(z.string(), json)).min(1).max(50_000),
    checkpoints: z.array(z.record(z.string(), json)).max(50_000),
    summary_pdf: z.string().max(5_000_000),
    compliance_map: json,
    readme: z.string().max(200_000),
  })
  .strict();

const UsageStatementReq = z
  .object({
    body: z
      .object({
        format: z.literal("elan1.usage.statement.v1"),
        org: str(80),
        orgName: str(200),
        period: z.object({ from: z.string().refine(isoTime), to: z.string().refine(isoTime), label: str(80) }).strict(),
        counts: z.object({ decisions: z.number().int(), committed: z.number().int(), refused: z.number().int(), pending: z.number().int(), sandbox: z.number().int() }).strict(),
        units: z.number(),
        head: z.object({ seq: z.number().int().min(0), hash: str(100) }).strict(),
        meterDigest: z.string().regex(hex64),
      })
      .strict(),
  })
  .strict();

const ResidencyReq = z
  .object({
    statement: z
      .object({ org: str(80), domain: z.string().trim().min(1).max(200), stores: z.array(z.string().regex(/^[^@]{1,120}@[^@]{1,200}$/)).min(1).max(12), at: z.string().refine(isoTime) })
      .strict(),
  })
  .strict();

export const SignatureRequest = z.discriminatedUnion("kind", [
  z.object({ id: str(120), kind: z.literal("disclosure"), input: DisclosureReq }).strict(),
  z.object({ id: str(120), kind: z.literal("disclosure-bundle"), input: BundleReq }).strict(),
  z.object({ id: str(120), kind: z.literal("sd-jwt"), input: SdJwtReq }).strict(),
  z.object({ id: str(120), kind: z.literal("evidence-manifest"), input: EvidenceManifestReq }).strict(),
  z.object({ id: str(120), kind: z.literal("pack-manifest"), input: PackManifestReq }).strict(),
  z.object({ id: str(120), kind: z.literal("usage-statement"), input: UsageStatementReq }).strict(),
  z.object({ id: str(120), kind: z.literal("residency"), input: ResidencyReq }).strict(),
  z.object({ id: str(120), kind: z.literal("erasure"), input: ErasureInput }).strict(),
]);
export type SignatureRequest = z.infer<typeof SignatureRequest>;

/** A message to sign, built by this module, and what the receipt for it says. */
interface Prepared {
  message: string;
  details: Record<string, string | number | boolean>;
  /** How the signature is handed back: `ed25519:<base64>` (what verifySig reads), or base64url for a JWT. */
  encoding: "chain" | "b64url";
}

const sameValues = (a: unknown, b: unknown) => seal6.canonical(a) === seal6.canonical(b);

function checkCommitted(values: Record<string, string>, committed: { name: string; digest: string }[], salts: Record<string, string>, what: string) {
  const names = Object.keys(values).sort();
  if (committed.length !== names.length || committed.some((c, i) => c.name !== names[i])) throw new SigningRefused(`${what} does not commit the receipt's ${names.length} fields in order.`);
  for (const c of committed) {
    const salt = salts[c.name];
    if (!salt || seal6.disclosureDigest(salt, c.name, values[c.name]!) !== c.digest) throw new SigningRefused(`${what}: the ${c.name} commitment is not over the receipt's own value.`);
  }
}

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const saltFor = (secret: string, seq: number, name: string) => seal6.sha256Hex(`${secret}:${seq}:${name}`).slice(0, 32);

/** The canonical manifest of a disclosure bundle, as the console signs it (apps/console/src/lib/disclosure.ts bundleManifest). */
function bundleManifest(b: z.infer<typeof BundleReq>["base"]) {
  return seal6.canonical({
    format: b.format,
    iss: b.orgId,
    aud: b.audience,
    exp: b.expiresAt,
    range: { from: b.range.fromSeq, to: b.range.toSeq, count: b.range.count, kinds: b.range.kinds },
    fields: [...b.fields].sort(),
    items: b.items.map((i) => [i.seq, i.receiptHash, i.committed.map((c) => c.digest).sort()]),
  });
}

/** The organisation's public keys as the console publishes them: every key, and every successor bound before it signs. */
async function realKeys(tx: ChainTx): Promise<Record<string, string>> {
  const keys = await tx.orgKey.findMany({ orderBy: { createdAt: "asc" }, select: { kid: true, publicKey: true } });
  const bound = await tx.keySuccessor.findMany({ where: { activatedAt: null }, orderBy: { boundAt: "asc" }, select: { kid: true, publicKey: true } });
  return Object.fromEntries([...keys, ...bound].map((k) => [k.kid, publicKeyHex(k.publicKey)]));
}

/** Every receipt listed is the chain's own (or its erased copy), in order and without gaps. */
async function checkReceipts(tx: ChainTx, receipts: Record<string, unknown>[]) {
  const seqs = receipts.map((r) => r.seq as number);
  const lo = seqs[0]!;
  if (!seqs.every((s, i) => Number.isInteger(s) && s === lo + i)) throw new SigningRefused("The receipts are not one contiguous run.");
  const rows = await tx.receipt.findMany({ where: { seq: { gte: lo, lte: seqs.at(-1)! } }, orderBy: { seq: "asc" }, select: { seq: true, body: true } });
  const red = new Map((await tx.receiptRedaction.findMany({ where: { seq: { gte: lo, lte: seqs.at(-1)! } } })).map((r) => [r.seq, r.receipt]));
  if (rows.length !== receipts.length) throw new SigningRefused("The receipts listed are not all in the organisation's chain.");
  rows.forEach((row, i) => {
    const want = red.get(row.seq) ?? toConsoleReceipt(row.body as unknown as Receipt);
    if (!sameValues(receipts[i], want)) throw new SigningRefused(`Receipt #${row.seq} is not the chain's receipt.`);
  });
}

async function checkCheckpoints(tx: ChainTx, cps: Record<string, unknown>[]) {
  if (!cps.length) return;
  const rows = await tx.checkpoint.findMany({ where: { seq: { in: cps.map((c) => c.seq as number) } } });
  for (const c of cps) {
    const row = rows.find((x) => x.seq === c.seq && x.sig === c.sig);
    if (!row || !sameValues(c, toConsoleCheckpoint(toCheckpoint(row) as Checkpoint))) throw new SigningRefused(`Checkpoint #${String(c.seq)} is not one the chain signed.`);
  }
}

async function checkSeals(tx: ChainTx, seals: Record<string, unknown>[]) {
  if (!seals.length) return;
  const rows = await tx.sealRecord.findMany({ where: { seq: { in: seals.map((s) => s.seq as number) } } });
  for (const s of seals) {
    const row = rows.find((x) => x.seq === s.seq);
    if (!row || !sameValues(s, sealRecordOf({ ...row, values: row.values as string[] }))) throw new SigningRefused(`Seal #${String(s.seq)} is not the seal Elan1 Govern made.`);
  }
}

async function checkAnchors(tx: ChainTx, anchors: { authorities: Record<string, unknown>[]; batches: Record<string, unknown>[] }) {
  if (!anchors.batches.length) return;
  const rows = await tx.anchorBatch.findMany({ where: { id: { in: anchors.batches.map((b) => String(b.id)) } } });
  for (const b of anchors.batches) {
    const row = rows.find((x) => x.id === b.id);
    const tokens = (b.tokens as { der?: string }[] | undefined) ?? [];
    const stored = (row?.tokens as { der: string }[] | undefined) ?? [];
    if (!row || row.root !== b.root || row.fromSeq !== b.firstSeq || row.toSeq !== b.lastSeq || tokens.length !== stored.length || tokens.some((t, i) => t.der !== stored[i]!.der)) {
      throw new SigningRefused(`Anchor batch ${String(b.id)} is not one Elan1 Govern timestamped.`);
    }
  }
}

function activeKid(key: ChainKey, named: unknown, what: string) {
  if (named !== key.kid) throw new SigningRefused(`${what} names key ${String(named)}, but the organisation signs with ${key.kid} now.`);
}

/** Usage counts for a period, from the chain, exactly as the console's meter counts them (apps/console/src/mock/sovereign.ts meterFor). */
async function meterFor(tx: ChainTx, from: number, to: number) {
  const all = (await tx.receipt.findMany({ orderBy: { seq: "asc" }, select: { body: true } })).map((r) => toConsoleReceipt(r.body as unknown as Receipt) as unknown as ConsoleReceipt & { environment?: string });
  const inRange = all.filter((r) => {
    const t = Date.parse(r.ts);
    return t >= from && t <= to;
  });
  const allDecisions = inRange.filter((r) => r.kind === "decision" && !!r.decision);
  const decisions = allDecisions.filter((r) => r.environment !== "sandbox");
  const resolved = new Map<number, string>();
  for (const r of all) if (r.kind === "approval" && r.ref_seq !== undefined) resolved.set(r.ref_seq, r.decision ?? "");
  let committed = 0;
  let refused = 0;
  let pending = 0;
  const lines: string[] = [];
  for (const r of decisions) {
    let q = 0;
    if (r.decision === "allow") {
      committed++;
      q = 1;
    } else if (r.decision === "refuse") {
      refused++;
      q = 0.4;
    } else if (r.decision === "ask") {
      const res = resolved.get(r.seq);
      if (res === undefined) pending++;
      else if (res === "allow") {
        committed++;
        q = 1;
      } else {
        refused++;
        q = 0.4;
      }
    }
    lines.push(`${r.seq}:${q}`);
  }
  const units = Math.round((committed + refused * 0.4) * 10) / 10;
  const head = inRange.at(-1) ?? [...all].reverse().find((r) => Date.parse(r.ts) <= to) ?? all[0]!;
  return { counts: { decisions: decisions.length, committed, refused, pending, sandbox: allDecisions.length - decisions.length }, units, head: { seq: head.seq, hash: head.hash }, meterDigest: seal6.sha256Hex(lines.join("|")) };
}

async function prepare(orgId: string, tx: ChainTx, key: ChainKey, req: Exclude<SignatureRequest, { kind: "erasure" }>): Promise<Prepared> {
  switch (req.kind) {
    case "disclosure": {
      const { base, salts, approvalSeq } = req.input;
      if (base.orgId !== orgId) throw new SigningRefused("A disclosure names another organisation.");
      const r = await receiptAt(tx, base.seq, base.receiptHash);
      const values = seal6.fieldValuesOf(r, await approvalResult(tx, base.seq, approvalSeq));
      checkCommitted(values, base.committed, salts, `The disclosure of #${base.seq}`);
      return { message: seal6.disclosureMessage(base), details: { seq: base.seq, audience: base.audience, committed: base.committed.length, expires: base.expiresAt.slice(0, 10) }, encoding: "chain" };
    }
    case "disclosure-bundle": {
      const { base, secret } = req.input;
      if (base.orgId !== orgId) throw new SigningRefused("A disclosure bundle names another organisation.");
      const lo = Math.min(base.range.fromSeq, base.range.toSeq);
      const hi = Math.max(base.range.fromSeq, base.range.toSeq);
      if (base.items.length !== base.range.count) throw new SigningRefused("A disclosure bundle's count does not match its receipts.");
      for (const it of base.items) {
        if (it.seq < lo || it.seq > hi) throw new SigningRefused(`#${it.seq} is outside the bundle's range.`);
        const r = await receiptAt(tx, it.seq, it.receiptHash);
        if (base.range.kinds === "decisions" && r.kind !== "decision") throw new SigningRefused(`#${it.seq} is not a decision.`);
        const values = seal6.fieldValuesOf(r, await approvalResult(tx, it.seq));
        const salts = Object.fromEntries(Object.keys(values).map((n) => [n, saltFor(secret, it.seq, n)]));
        checkCommitted(values, it.committed, salts, `The bundle's commitments for #${it.seq}`);
      }
      return { message: seal6.sha256Hex(bundleManifest(base)), details: { from_seq: lo, to_seq: hi, receipts: base.items.length, audience: base.audience, fields: base.fields.length, expires: base.expiresAt.slice(0, 10) }, encoding: "chain" };
    }
    case "sd-jwt": {
      const { header, payload, salts, approvalSeq } = req.input;
      activeKid(key, header.kid, "The SD-JWT header");
      if (payload.receipt.org !== orgId) throw new SigningRefused("The SD-JWT names another organisation.");
      const r = await receiptAt(tx, payload.receipt.seq, payload.receipt.hash);
      if (r.kid !== payload.receipt.kid) throw new SigningRefused("The SD-JWT names another key for the receipt.");
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(payload.iat - now) > 600 || payload.exp <= now || payload.exp > now + 400 * 86_400) throw new SigningRefused("The SD-JWT's times are not now and in the next 400 days.");
      const values = seal6.fieldValuesOf(r, await approvalResult(tx, payload.receipt.seq, approvalSeq)) as Record<string, string>;
      const sd = seal6.DISCLOSABLE_FIELDS.map((name) => {
        const salt = salts[name];
        if (!salt) throw new SigningRefused(`The SD-JWT has no salt for ${name}.`);
        return b64url(Buffer.from(seal6.sha256Hex(b64url(JSON.stringify([salt, name, values[name]]))), "hex"));
      }).sort();
      if (!sameValues(sd, payload._sd)) throw new SigningRefused("The SD-JWT's digests are not over the receipt's own values.");
      return { message: `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`, details: { seq: r.seq, audience: payload.aud, committed: sd.length, format: "sd-jwt" }, encoding: "b64url" };
    }
    case "evidence-manifest": {
      const b = req.input;
      const m = b.manifest;
      if (m.org_id !== orgId || m.tenant_id !== orgId || m.bundle_format !== "elan1.evidence.bundle.v1") throw new SigningRefused("The manifest is not this organisation's evidence bundle.");
      activeKid(key, m.signing_kid, "The manifest");
      if (!sameValues(b.public_keys, await realKeys(tx))) throw new SigningRefused("keys.json is not the organisation's keys.");
      await checkReceipts(tx, b.receipts);
      await checkCheckpoints(tx, b.checkpoints);
      await checkSeals(tx, b.seals);
      await checkAnchors(tx, b.anchors);
      const first = b.receipts[0]!.seq as number;
      const last = b.receipts.at(-1)!.seq as number;
      if (m.record_count !== b.receipts.length || m.first_seq !== first || m.last_seq !== last || m.checkpoints !== b.checkpoints.length) throw new SigningRefused("The manifest's counts do not match its members.");
      const contents: Record<string, unknown> = { "receipts.jsonl": b.receipts, "seals.jsonl": b.seals, "checkpoints.json": b.checkpoints, "anchors.json": b.anchors, "keys.json": b.public_keys, "declarations.json": b.declarations, "profile/ (profile.json + VERIFY.txt)": { profile: b.profile, readme: b.readme }, [seal6.LEXICON_MEMBER]: b.lexicon };
      const members = m.members as { path: string; sha256: string; bytes: number }[] | undefined;
      if (!Array.isArray(members) || !members.length) throw new SigningRefused("The manifest lists no members.");
      for (const x of members) {
        if (x.path === "manifest.json") continue;
        if (!(x.path in contents) || contents[x.path] === undefined || !sameValues(x, { path: x.path, ...seal6.memberDigest(contents[x.path]) })) throw new SigningRefused(`The manifest's digest of ${x.path} is not over the member given.`);
      }
      return { message: seal6.manifestMessage(m as seal6.BundleManifest), details: { format: "elan1.evidence.bundle.v1", first_seq: first, last_seq: last, records: b.receipts.length, seals: b.seals.length, batches: b.anchors.batches.length }, encoding: "chain" };
    }
    case "pack-manifest": {
      const b = req.input;
      const m = b.manifest;
      if (m.org_id !== orgId || m.format !== "auditor-pack/1" || m.digest_of !== "file") throw new SigningRefused("The manifest is not this organisation's auditor pack.");
      activeKid(key, m.sealing_kid, "The manifest");
      if (!sameValues(b.public_keys, await realKeys(tx))) throw new SigningRefused("keys.json is not the organisation's keys.");
      await checkReceipts(tx, b.receipts);
      await checkCheckpoints(tx, b.checkpoints);
      const first = b.receipts[0]!;
      const last = b.receipts.at(-1)!;
      if (m.record_count !== b.receipts.length || m.first_seq !== first.seq || m.last_seq !== last.seq || m.last_hash !== last.hash || m.checkpoints !== b.checkpoints.length) throw new SigningRefused("The manifest's counts do not match its files.");
      const files = seal6.l1PackFiles(b as unknown as Parameters<typeof seal6.l1PackFiles>[0]);
      const members = m.members as { path: string; sha256: string; bytes: number }[] | undefined;
      if (!Array.isArray(members) || !members.length) throw new SigningRefused("The manifest lists no files.");
      for (const x of members) {
        if (x.path === "manifest.json") continue;
        const text = files[x.path];
        if (text === undefined || !sameValues(x, { path: x.path, ...seal6.fileDigest(text) })) throw new SigningRefused(`The manifest's digest of ${x.path} is not over the file given.`);
      }
      return { message: seal6.manifestMessage(m as seal6.BundleManifest), details: { format: "auditor-pack/1", first_seq: first.seq as number, last_seq: last.seq as number, records: b.receipts.length }, encoding: "chain" };
    }
    case "usage-statement": {
      const { body } = req.input;
      const org = await tx.org.findFirstOrThrow({ select: { name: true } });
      if (body.org !== orgId) throw new SigningRefused("The statement names another organisation.");
      const from = Date.parse(body.period.from);
      const to = Date.parse(body.period.to);
      if (!(from < to) || to > Date.now() + 60_000) throw new SigningRefused("The statement's period must end by now.");
      const m = await meterFor(tx, from, to);
      if (!sameValues({ counts: body.counts, units: body.units, head: body.head, meterDigest: body.meterDigest }, m)) throw new SigningRefused("The statement's counts are not the chain's for that period.");
      void org;
      return { message: seal6.sha256Hex(seal6.canonical(body)), details: { kind: "usage", from: body.period.from, to: body.period.to, units: body.units, head_seq: body.head.seq }, encoding: "chain" };
    }
    case "residency": {
      const { statement } = req.input;
      if (statement.org !== orgId) throw new SigningRefused("The statement names another organisation.");
      const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
      if (Date.parse(statement.at) !== day) throw new SigningRefused("A residency statement is dated today (00:00 UTC).");
      return { message: seal6.sha256Hex(seal6.canonical(statement)), details: { domain: statement.domain.slice(0, 120), stores: statement.stores.length, date: statement.at.slice(0, 10) }, encoding: "chain" };
    }
  }
}

/* ── One write: the console operation's receipts, its signatures and erasures ── */

export interface FlushInput {
  base: ChainHead;
  receipts: ReceiptInput[];
  checkpoint?: boolean;
  requests: SignatureRequest[];
  actor: string;
}

export interface FlushResult {
  receipts: Receipt[];
  /** The signature for each request id (an erasure's is empty), and its key. */
  signatures: { id: string; kid: string; sig: string }[];
  /** Receipts this module wrote after the operation's own: one per new signature, one per erasure. */
  extra: Receipt[];
  redactions: Redaction[];
  checkpoint?: Checkpoint;
}

/** Replace every request id (a provisional signature) inside the operation's receipts with its real signature. */
function substitute<T>(value: T, sigs: Map<string, string>): T {
  if (!sigs.size) return value;
  let text = JSON.stringify(value);
  for (const [id, sig] of sigs) text = text.split(id).join(sig);
  return JSON.parse(text) as T;
}

/**
 * Write a console operation that asked for signatures: under the chain lock, after `base` (refused whole if the
 * chain moved), every request is checked and signed; the operation's receipts are written with the real signatures
 * in place of the provisional ones; then each new signature's receipt and each erasure's `record.erased`. With
 * `checkpoint`, the new head is signed too.
 */
export async function flushSigned(deps: Deps, orgId: string, input: FlushInput): Promise<FlushResult> {
  const bad = input.receipts.find((r) => r.action !== undefined && GATE_ONLY_ACTIONS.has(r.action));
  if (bad) throw new SigningRefused(`Only Elan1 Govern writes ${bad.action} receipts.`);
  const out = await chain(deps, orgId, async (append, tx, key) => {
    const head = await tx.receipt.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, hash: true } });
    if ((head?.seq ?? 0) !== input.base.seq || (head?.hash ?? input.base.hash) !== input.base.hash) throw new ChainMoved(head ?? { seq: 0, hash: input.base.hash });
    const pending: { id: string; kind: SignatureKind; prepared: Prepared }[] = [];
    const erasures: ErasureInput[] = [];
    for (const req of input.requests) {
      if (req.kind === "erasure") erasures.push(req.input);
      else pending.push({ id: req.id, kind: req.kind, prepared: await prepare(orgId, tx, key, req) });
    }
    // signatures first (their receipts come after the operation's), so a receipt that quotes one carries the real one
    const signed: { id: string; kind: SignatureKind; prepared: Prepared; sig: string }[] = [];
    for (const p of pending) {
      const had = await tx.consoleSignature.findFirst({ where: { kind: p.kind, message: p.prepared.message, kid: key.kid! } });
      signed.push({ ...p, sig: had?.sig ?? (await signTextChecked(tx, key, p.prepared.message)) });
    }
    const encoded = new Map(signed.map((s) => [s.id, s.prepared.encoding === "b64url" ? b64url(Buffer.from(s.sig.slice("ed25519:".length), "base64")) : s.sig]));
    const receipts: Receipt[] = [];
    for (const r of input.receipts) receipts.push(await append(substitute(r, encoded)));
    // as for any console write (console-chain.ts): what billing receipts say goes into the ledger in this transaction
    await projectBilling(tx, orgId, receipts);
    const extra: Receipt[] = [];
    for (const s of signed) {
      const had = await tx.consoleSignature.findFirst({ where: { kind: s.kind, message: s.prepared.message, kid: key.kid! } });
      if (had) continue;
      const receipt = await append({ kind: "admin", actor: input.actor, action: SIGNATURE_ACTIONS[s.kind], details: { ...s.prepared.details, kid: key.kid!, message: s.prepared.message.slice(0, 16) } });
      await tx.consoleSignature.create({ data: { orgId, kind: s.kind, message: s.prepared.message, kid: key.kid!, sig: s.sig, receiptSeq: receipt.seq } });
      extra.push(receipt);
    }
    const redactions: Redaction[] = [];
    for (const e of erasures) {
      const r = await eraseInTx(deps, orgId, append, tx, key, e, input.actor);
      if (r.receipt) extra.push(r.receipt);
      redactions.push(...r.redactions);
    }
    return { receipts, signatures: signed.map((s) => ({ id: s.id, kid: key.kid!, sig: encoded.get(s.id)! })), extra, redactions };
  });
  const cp = input.checkpoint ? ((await checkpoint(deps, orgId)) ?? undefined) : undefined;
  return { ...out, ...(cp ? { checkpoint: cp } : {}) };
}

/** "Anchor now": batch and timestamp the organisation's new receipts with the configured authorities. */
export async function anchorNow(deps: Deps, orgId: string) {
  const org = await forOrg(orgId, deps.db).org.findFirstOrThrow({ select: { level: true } });
  if (!ANCHORED_LEVELS.includes(org.level)) throw new SigningRefused("Records are timestamped from L2 Attested.");
  return anchorOrg(deps, orgId);
}

/* ── Successor keys, for the console's custody screens (custody.ts does the rest) ── */

/**
 * Withdraw the successor bound and waiting, before it signed: `key.bound_withdrawn`. The key is never used; its row
 * stays, with the withdrawal time, so the key.bound receipt keeps naming a key that exists.
 */
export async function withdrawSuccessor(deps: Deps, orgId: string, actor: string, reason: string) {
  return chain(deps, orgId, async (append, tx) => {
    const s = await openSuccessor(tx);
    if (!s) throw new SigningRefused("No successor key is waiting to sign.");
    const r = await append({ kind: "admin", actor, action: "key.bound_withdrawn", details: { kid: s.kid, bound_seq: s.boundSeq, reason: reason.slice(0, 300) } });
    await tx.keySuccessor.update({ where: { id: s.id }, data: { withdrawnAt: new Date(r.ts) } });
    return { kid: s.kid, seq: r.seq };
  });
}
