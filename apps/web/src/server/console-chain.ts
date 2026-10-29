import "server-only";
import { randomBytes } from "node:crypto";
import { CHAIN_FIELDS, GENESIS_HASH, fromConsoleReceipt, isChainFormat, publicKeyHex, toConsoleCheckpoint, toConsoleReceipt, type Checkpoint, type Receipt } from "@gate/core";
import { forOrg, orgPublicKeys, toCheckpoint } from "@gate/db";
import type { ChainWriter, DocCheckpoint, DocReceipt, SigningKind } from "@gate/console/server";
import { HttpError } from "./api";
import { applyRedactions, noteKid, rememberKid, syncSigned, type SignatureRequest, type SignatureSink } from "./console-signing";
import { gate } from "./gate";

/*
 * The console's receipts on the organisation's real chain (plans/console-app.md E5). The console's domain runs in
 * this process (console-domain.ts) but signs nothing: it hands every receipt to this writer as provisional, with
 * the next seq and a pending hash, and before the bridge saves an operation's documents it writes them to the gate
 * in one call (POST /internal/orgs/:org/console-receipts), which appends them under the chain lock with the org's
 * own key. The real receipts then take the provisional ones' place. Their seqs are the same, because:
 *  - before an operation runs, its organisation's document is brought up to the real chain (syncDoc): receipts the
 *    gate wrote itself (the guard, approvals, jobs, the web app's events) are added, so the document's head is the
 *    real head;
 *  - the write names that head (`base`), and the gate refuses it whole if anything was appended since. The bridge
 *    then undoes the operation and runs it again on the new head (ChainRetry), so the chain never forks.
 * A seeded demo organisation's generated history is written into its real chain once, when its document is first
 * built, keeping each receipt's time (POST /internal/orgs/:org/console-history), and the document is built on the
 * real receipts. Checkpoints and public keys come from the gate's Checkpoint and OrgKey rows.
 */

export interface Head {
  seq: number;
  hash: string;
}

interface SigningKeyRow {
  kid: string;
  fingerprint: string;
  algorithm: string;
  status: string;
  createdAt: string;
  retiredAt?: string;
  receiptsSigned: number;
  publishedAt?: string;
  revokedAt?: string;
  revokedReason?: string;
}

/** The parts of an organisation document this module reads and writes. */
export interface ChainDoc {
  org: { id: string; keyFingerprint?: string };
  receipts: DocReceipt[];
  checkpoints: DocCheckpoint[];
  publicKeys: Record<string, string>;
  signingKeys: SigningKeyRow[];
}

/** The operation must run again: the chain moved under it, or it opened an organisation the chain had not prepared. */
export class ChainRetry extends Error {
  constructor(message = "The organisation's chain moved while the change was being made.") {
    super(message);
    this.name = "ChainRetry";
  }
}

const toDoc = (r: Receipt) => toConsoleReceipt(r) as unknown as DocReceipt;
const cpToDoc = (c: Checkpoint) => toConsoleCheckpoint(c) as unknown as DocCheckpoint;

/** What the gate is sent for a receipt: core's format, without what the chain fills in (the history keeps `ts`). */
function bodyOf(r: DocReceipt, keep: readonly string[] = []): Record<string, unknown> {
  const body: Record<string, unknown> = { ...fromConsoleReceipt(r as unknown as Record<string, unknown>) };
  for (const f of CHAIN_FIELDS) if (!keep.includes(f)) delete body[f];
  return body;
}

/**
 * The demo's generated history tells of key rotations (into KMS, an HSM ceremony …) that never happened to the
 * organisation's real key. A `key.rotated` receipt would make every verifier retire the real key at that point,
 * so in the real chain they are recorded under their own name and say what they are.
 */
export const IMPORTED_ROTATION = "key.rotated.demo";

function historyBody(r: DocReceipt): Record<string, unknown> {
  const { redacted: _r, ...rest } = r as DocReceipt & { redacted?: unknown };
  const body = bodyOf(rest as DocReceipt, ["ts"]);
  if (body.action === "key.rotated") body.action = IMPORTED_ROTATION;
  return body;
}

/** The gate's error reply as a bridge error. */
function gateFailure(orgId: string, status: number, data: { error?: string }): Error {
  if (status === 409) return new ChainRetry();
  if (status === 404) return new HttpError(404, `${orgId} is not set up in Elan1 Govern yet (run pnpm db:seed).`);
  if (status === 422) return new HttpError(409, data.error ?? "Elan1 Govern refused to record this.");
  return new HttpError(502, data.error ?? "Elan1 Govern could not record this, so nothing was changed. Try again.");
}

async function call<T>(orgId: string, path: string, body: unknown): Promise<T> {
  let r: { status: number; data: T & { error?: string } };
  try {
    r = await gate<T & { error?: string }>("POST", `/internal/orgs/${encodeURIComponent(orgId)}/${path}`, body);
  } catch {
    throw new HttpError(503, "Elan1 Govern is not reachable, so nothing was recorded or changed. Try again.");
  }
  if (r.status !== 200) throw gateFailure(orgId, r.status, r.data);
  return r.data;
}

/** The real chain's head, or the genesis head when the organisation has no receipt yet. */
export async function realHead(orgId: string): Promise<Head> {
  const db = forOrg(orgId);
  // what the organisation's document is built with names the key Elan1 Govern signs with (console-signing.ts)
  await rememberKid(orgId);
  const last = await db.receipt.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, hash: true } });
  if (last) return { seq: last.seq, hash: last.hash };
  if (!(await db.org.findFirst({ select: { id: true } }))) throw new HttpError(404, `${orgId} is not set up in Elan1 Govern yet (run pnpm db:seed).`);
  return { seq: 0, hash: GENESIS_HASH };
}

/** A seeded organisation's history as its real chain holds it: the setup receipts before it, and the imported ones. */
export interface ImportedHistory {
  setup: DocReceipt[];
  imported: DocReceipt[];
}

/** Write a seeded organisation's generated history into its real chain (once). Returns the real receipts. */
export async function importHistory(orgId: string, base: Head, generated: DocReceipt[]): Promise<ImportedHistory> {
  try {
    const out = await call<{ receipts: Receipt[] }>(orgId, "console-history", { base, receipts: generated.map(historyBody) });
    const setup = await forOrg(orgId).receipt.findMany({ where: { seq: { lte: base.seq } }, orderBy: { seq: "asc" }, select: { body: true } });
    return { setup: setup.map((r) => toDoc(r.body as Receipt)), imported: out.receipts.map(toDoc) };
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) {
      throw new HttpError(409, `The console document of ${orgId} is missing but its chain already holds activity, so the demo history cannot be imported again. Restore the document, or reset the demo database (pnpm db:reset, then pnpm db:seed).`);
    }
    throw e;
  }
}

/**
 * The writer the domain's `append` hands receipts to on the server (apps/console/src/mock/db.ts ChainWriter). It
 * collects one operation's provisional receipts and checkpoint requests; the bridge flushes them (flushChain).
 */
export class ConsoleChain implements ChainWriter, SignatureSink {
  /** Part of every provisional hash and signature: a document holding it holds something not yet written. */
  readonly nonce = randomBytes(8).toString("hex");
  private pending = new Map<string, DocReceipt[]>();
  private cps = new Map<string, DocCheckpoint[]>();
  /** Signatures the operation asked of the organisation's key (console-signing.ts), written with its receipts. */
  private sigs = new Map<string, SignatureRequest[]>();
  private sigCount = 0;
  /** Who the operation runs as: the signatures' receipts name them (Elan1 Govern when nobody does). */
  actor: string | undefined;
  /** The operation running (its manifest name), or undefined for a state read. */
  op: string | undefined;
  private bases = new Map<string, Head>();
  private histories = new Map<string, ImportedHistory>();
  /** What the domain asked for during an operation that was not prepared (an organisation it opened for the first time). */
  private needs = new Map<string, { generated?: DocReceipt[] }>();
  /** Organisations whose write was refused because their chain moved: brought up to it before the next attempt. */
  readonly stale = new Set<string>();

  base(orgId: string): Head {
    const b = this.bases.get(orgId);
    if (b) return b;
    if (!this.needs.has(orgId)) this.needs.set(orgId, {});
    throw new ChainRetry(`${orgId} is opened for the first time; its chain is prepared first.`);
  }

  /** The generated history's place is taken by the real chain: its setup receipts, then the history as imported. */
  history(orgId: string, generated: DocReceipt[]): DocReceipt[] {
    const h = this.histories.get(orgId);
    if (!h) {
      this.needs.set(orgId, { generated });
      throw new ChainRetry(`${orgId}'s history is written to its chain first.`);
    }
    if (h.imported.length !== generated.length || h.imported.some((r, i) => r.seq !== generated[i]!.seq || r.kind !== generated[i]!.kind)) {
      throw new Error(`${orgId}'s generated history no longer matches the history in its chain.`);
    }
    return structuredClone([...h.setup, ...h.imported]);
  }

  receipt(orgId: string, r: DocReceipt) {
    const list = this.pending.get(orgId) ?? [];
    list.push(r);
    this.pending.set(orgId, list);
  }

  checkpoint(orgId: string, cp: DocCheckpoint) {
    const list = this.cps.get(orgId) ?? [];
    list.push(cp);
    this.cps.set(orgId, list);
  }

  /** A signature the domain asked for: a stand-in now, the organisation's real signature once the operation is written. */
  signature(orgId: string, kind: SigningKind, input: unknown): string {
    const id = `${SIGN_STANDIN}${++this.sigCount}:${this.nonce}`;
    const list = this.sigs.get(orgId) ?? [];
    list.push({ id, kind, input: structuredClone(input) });
    this.sigs.set(orgId, list);
    return id;
  }

  signaturesOf(orgId: string) {
    return this.sigs.get(orgId) ?? [];
  }

  hasBase(orgId: string) {
    return this.bases.has(orgId);
  }

  setBase(orgId: string, head: Head) {
    this.bases.set(orgId, head);
  }

  setHistory(orgId: string, history: ImportedHistory) {
    this.histories.set(orgId, history);
  }

  /** Organisations whose generated history this process wrote into their chain. */
  importedOrgs(): string[] {
    return [...this.histories.keys()];
  }

  /** The history the domain generated for `orgId` and asked to have written (taken: asked once). */
  takeGenerated(orgId: string): DocReceipt[] | undefined {
    const n = this.needs.get(orgId);
    this.needs.delete(orgId);
    return n?.generated;
  }

  /** Prepare what the operation asked for (the chain head, the history import), so it can run again. */
  async prepareNeeds(): Promise<boolean> {
    if (!this.needs.size) return false;
    for (const [orgId, need] of [...this.needs]) {
      this.needs.delete(orgId);
      if (!this.bases.has(orgId)) this.bases.set(orgId, await realHead(orgId));
      if (need.generated) this.histories.set(orgId, await importHistory(orgId, this.bases.get(orgId)!, need.generated));
    }
    return true;
  }

  /** Organisations with receipts or checkpoints to write, `last` last. */
  writes(last: string): string[] {
    const orgs = new Set([...this.pending.keys(), ...this.cps.keys(), ...this.sigs.keys()]);
    return [...orgs].sort((a, b) => Number(a === last) - Number(b === last));
  }

  pendingOf(orgId: string) {
    return this.pending.get(orgId) ?? [];
  }

  checkpointsOf(orgId: string) {
    return this.cps.get(orgId) ?? [];
  }

  /** Forget one operation's provisional writes and needs (it finished, or was undone). */
  reset() {
    this.pending.clear();
    this.cps.clear();
    this.sigs.clear();
    this.needs.clear();
    this.actor = undefined;
    this.op = undefined;
  }

  /** Forget everything (a fresh process). */
  forget() {
    this.reset();
    this.bases.clear();
    this.histories.clear();
    this.stale.clear();
  }
}

/** The organisation's document no longer continues its real chain (the database was restored or reset under it). */
function diverged(orgId: string, seq: number) {
  return new HttpError(409, `The console document of ${orgId} no longer matches its chain at #${seq} (was the database restored?). Nothing was changed.`);
}

/** Add the receipts the real chain has after the document's head. Returns whether there were any. */
async function pullReceipts(orgId: string, d: ChainDoc): Promise<boolean> {
  const db = forOrg(orgId);
  const head = d.receipts[d.receipts.length - 1]!;
  const at = await db.receipt.findFirst({ where: { seq: head.seq }, select: { hash: true } });
  if (at?.hash !== head.hash) throw diverged(orgId, head.seq);
  const rows = await db.receipt.findMany({ where: { seq: { gt: head.seq } }, orderBy: { seq: "asc" }, select: { body: true } });
  for (const r of rows) d.receipts.push(toDoc(r.body as Receipt));
  return rows.length > 0;
}

/**
 * Bring a document up to its organisation's real chain: receipts the chain has after the document's head, the
 * checkpoints, and the public keys (every key, with when it was retired). A document whose receipts are not the
 * chain's (a fresh organisation's placeholder genesis) takes the chain's receipts whole. Returns whether it changed.
 */
export async function syncDoc(orgId: string, d: ChainDoc): Promise<boolean> {
  const db = forOrg(orgId);
  let changed = false;
  const head = d.receipts[d.receipts.length - 1];
  if (!head || d.receipts.some((r) => !isChainFormat(r))) {
    const rows = await db.receipt.findMany({ orderBy: { seq: "asc" }, select: { body: true } });
    d.receipts = rows.map((r) => toDoc(r.body as Receipt));
    changed = true;
  } else {
    changed = await pullReceipts(orgId, d);
  }
  // seals, erasures and timestamps Elan1 Govern made (console-signing.ts); sealing may write a receipt
  const gateSigned = await syncSigned(orgId, d);
  if (gateSigned.written.length) await pullReceipts(orgId, d);
  changed = gateSigned.changed || changed;

  const last = d.checkpoints[d.checkpoints.length - 1];
  const real = d.checkpoints.length > 0 && d.checkpoints.every((c) => isChainFormat(c));
  const cps = await db.checkpoint.findMany({ where: real && last ? { seq: { gt: last.seq } } : {}, orderBy: { seq: "asc" } });
  if (!real) {
    d.checkpoints = cps.map((c) => cpToDoc(toCheckpoint(c)));
    changed = true;
  } else if (cps.length) {
    d.checkpoints.push(...cps.map((c) => cpToDoc(toCheckpoint(c))));
    changed = true;
  }

  const keys = await orgPublicKeys(orgId);
  const signed = new Map<string, number>();
  for (const r of d.receipts) signed.set(r.kid, (signed.get(r.kid) ?? 0) + 1);
  const publicKeys = Object.fromEntries(keys.map((k) => [k.kid, publicKeyHex(k.publicKeyPem)]));
  const signingKeys: SigningKeyRow[] = keys.map((k) => ({
    kid: k.kid,
    fingerprint: k.kid,
    algorithm: "Ed25519",
    status: k.retiredAt ? "retired" : "active",
    createdAt: k.createdAt,
    ...(k.retiredAt ? { retiredAt: k.retiredAt } : {}),
    receiptsSigned: signed.get(k.kid) ?? 0,
  }));
  // successors bound ahead of signing are published from binding (verifiers can pin them before they sign), and one
  // withdrawn before it signed stays listed as withdrawn (apps/gate/src/custody.ts)
  for (const s of await db.keySuccessor.findMany({ where: { activatedAt: null }, orderBy: { boundAt: "asc" } })) {
    const at = s.boundAt.toISOString();
    publicKeys[s.kid] = publicKeyHex(s.publicKey);
    signingKeys.push({
      kid: s.kid, fingerprint: s.kid, algorithm: "Ed25519", status: s.withdrawnAt ? "revoked" : "bound", createdAt: at, receiptsSigned: 0, publishedAt: at,
      ...(s.withdrawnAt ? { revokedAt: s.withdrawnAt.toISOString(), revokedReason: "Withdrawn before it signed" } : {}),
    });
  }
  const active = keys.find((k) => !k.retiredAt)?.kid ?? keys[keys.length - 1]?.kid;
  if (active) noteKid(orgId, active);
  if (JSON.stringify(d.publicKeys) !== JSON.stringify(publicKeys) || JSON.stringify(d.signingKeys) !== JSON.stringify(signingKeys) || d.org.keyFingerprint !== active) {
    d.publicKeys = publicKeys;
    d.signingKeys = signingKeys;
    if (active) d.org.keyFingerprint = active;
    changed = true;
  }
  return changed;
}

/** Provisional values (hashes, signatures, checkpoint ids) and what took their place. */
export interface Fixes {
  strings: Map<string, string>;
  /** The real receipt or checkpoint for a provisional receipt's hash or checkpoint's signature. */
  objects: Map<string, DocReceipt | DocCheckpoint>;
}

function replaceInPlace(target: object, source: object) {
  const t = target as Record<string, unknown>;
  for (const k of Object.keys(t)) delete t[k];
  Object.assign(t, structuredClone(source));
}

/**
 * Write every organisation's provisional receipts (the operation's own last) and on-demand checkpoints to the real
 * chain, and put the real ones in their place in the documents. A write refused because the chain moved marks the
 * organisation stale and throws ChainRetry; so does any other failure after another organisation's receipts were
 * written (an operation that writes into two organisations' chains, such as a counterparty's): those organisations
 * are brought up to their chains before the operation runs again. Their receipts from the failed attempt stay in
 * their chains.
 */
export async function flushChain(chain: ConsoleChain, docOf: (orgId: string) => ChainDoc | undefined, lockOrg: string): Promise<Fixes> {
  const fixes: Fixes = { strings: new Map(), objects: new Map() };
  const written: string[] = [];
  try {
    await flushEach(chain, docOf, lockOrg, fixes, written);
  } catch (e) {
    for (const orgId of written) chain.stale.add(orgId);
    throw e;
  }
  return fixes;
}

async function flushEach(chain: ConsoleChain, docOf: (orgId: string) => ChainDoc | undefined, lockOrg: string, fixes: Fixes, written: string[]) {
  for (const orgId of chain.writes(lockOrg)) {
    const d = docOf(orgId);
    if (!d) throw new Error(`${orgId} has receipts to write but its document is not open.`);
    const rs = chain.pendingOf(orgId);
    const cps = chain.checkpointsOf(orgId);
    const sigs = chain.signaturesOf(orgId);
    const first = rs[0];
    const docHead = d.receipts[d.receipts.length - 1]!;
    const base: Head = first ? { seq: first.seq - 1, hash: first.prev_hash } : cps[0] && !sigs.length ? { seq: cps[0].seq, hash: cps[0].hash } : { seq: docHead.seq, hash: docHead.hash };
    let out: { receipts: Receipt[]; checkpoint?: Checkpoint } & Partial<SignedWrite>;
    try {
      // signatures go with the receipts in one chain write: the gate checks and signs each, and records it
      out = sigs.length
        ? await call(orgId, "console-signing/flush", { base, receipts: rs.map((r) => bodyOf(r)), checkpoint: cps.length > 0, requests: sigs, actor: chain.actor ?? "Elan1 Govern" })
        : await call(orgId, "console-receipts", { base, receipts: rs.map((r) => bodyOf(r)), checkpoint: cps.length > 0 });
    } catch (e) {
      if (e instanceof ChainRetry) chain.stale.add(orgId);
      throw e;
    }
    written.push(orgId);
    if (out.receipts.length !== rs.length || out.receipts.some((r, i) => r.seq !== rs[i]!.seq)) {
      throw new Error(`${orgId}'s chain wrote the receipts at other seqs than the document holds.`);
    }
    rs.forEach((p, i) => {
      const real = toDoc(out.receipts[i]!);
      fixes.strings.set(p.hash, real.hash);
      fixes.strings.set(p.sig, real.sig);
      fixes.objects.set(p.hash, real);
      replaceInPlace(p, real);
    });
    for (const s of out.signatures ?? []) fixes.strings.set(s.id, s.sig);
    // the receipts the gate wrote after the operation's (one per signature, one per erasure) continue the document
    for (const x of out.extra ?? []) {
      const r = toDoc(x);
      if (r.prev_hash !== d.receipts[d.receipts.length - 1]?.hash) throw new Error(`${orgId}'s chain wrote the signing receipts out of order.`);
      d.receipts.push(r);
    }
    if (out.redactions?.length) applyRedactions(orgId, d, out.redactions);
    if (cps.length) {
      if (!out.checkpoint) throw new Error(`${orgId}'s chain signed no checkpoint.`);
      const real = cpToDoc(out.checkpoint);
      d.checkpoints = d.checkpoints.filter((c) => !cps.includes(c));
      if (!d.checkpoints.some((c) => c.seq === real.seq && c.sig === real.sig)) d.checkpoints.push(real);
      for (const c of cps) {
        fixes.strings.set(c.id, real.id);
        fixes.strings.set(c.sig, real.sig);
        fixes.objects.set(c.sig, real);
      }
    }
  }
}

/** What a signature's stand-in starts with until the gate's signature replaces it (followed by a count and the nonce). */
export const SIGN_STANDIN = "pending:sign:";

/** The real value for a provisional string: an exact match, or a text that quotes signature stand-ins (a file's JSON). */
function fixedString(x: string, strings: ReadonlyMap<string, string>): string | undefined {
  const to = strings.get(x);
  if (to !== undefined || !x.includes(SIGN_STANDIN)) return to;
  let out = x;
  for (const [from, real] of strings) if (from.startsWith(SIGN_STANDIN) && out.includes(from)) out = out.split(from).join(real);
  return out === x ? undefined : out;
}

/** The receipts the gate wrote for an operation's signatures and erasures, and what it returned for them. */
interface SignedWrite {
  signatures: { id: string; kid: string; sig: string }[];
  extra: Receipt[];
  redactions: { seq: number; receipt: unknown; payloadHash: string; recordId: string }[];
}

/** Replace, in place, every string in `root` that is a provisional value with the real one. */
export function replaceStrings(root: unknown, strings: ReadonlyMap<string, string>) {
  if (!strings.size) return;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (typeof x === "string") {
          const to = fixedString(x, strings);
          if (to !== undefined) v[i] = to;
        } else if (x && typeof x === "object") walk(x);
      }
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        const x = o[k];
        if (typeof x === "string") {
          const to = fixedString(x, strings);
          if (to !== undefined) o[k] = to;
        } else if (x && typeof x === "object") walk(x);
      }
    }
  };
  walk(root);
}

/** An operation's (JSON) result with provisional receipts, checkpoints and values replaced by the real ones. */
export function fixResult(value: unknown, fixes: Fixes): unknown {
  if (!fixes.strings.size) return value;
  const fix = (v: unknown): unknown => {
    if (typeof v === "string") return fixedString(v, fixes.strings) ?? v;
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const real = (typeof o.hash === "string" && fixes.objects.get(o.hash)) || (typeof o.sig === "string" && fixes.objects.get(o.sig));
      if (real) return structuredClone(real);
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, fix(x)]));
    }
    return v;
  };
  return fix(value);
}
