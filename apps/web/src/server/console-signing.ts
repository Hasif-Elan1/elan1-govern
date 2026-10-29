import "server-only";
import { createHash, X509Certificate } from "node:crypto";
import { seal6, type Receipt } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import type { DocAnchorBatch, DocReceipt, DocSeal, DocTsaAuthority, SavedDoc, SigningKind } from "@gate/console/server";
import { HttpError } from "./api";
import type { Domain } from "./console-domain";
import { gate } from "./gate";
import { log } from "./log";

/*
 * The console's signatures on the organisation's real key (plans/console-app.md E5; DECISIONS "Console signing").
 * The documents hold no signing keys, so the domain signs nothing on the server:
 *  - a signature (a disclosure, a bundle manifest, a usage statement …) is asked for as a structured request the
 *    domain records through `setOrgSigner`, with a stand-in in its place; the bridge sends the requests with the
 *    operation's receipts (console-chain.ts flushEach → POST /internal/orgs/:org/console-signing/flush), where the
 *    gate checks each against the chain, builds the message itself and signs it with the org's key, and the real
 *    signatures replace the stand-ins before anything is saved or returned. An erasure goes the same way: the gate
 *    destroys the salts, signs the redacted receipts and returns them (applyRedactions);
 *  - Seal v6 records and timestamped Merkle batches are made by the gate and read from its tables before every
 *    operation (syncSigned); the domain's sealOf, anchorBatches and tsaAuthorities read them from here.
 * In the browser none of this is set and the demo signs as it always has.
 */

interface SealCache {
  bySeq: Map<number, DocSeal>;
  since: Date;
}
interface AnchorCache {
  batches: Map<string, DocAnchorBatch & { createdAt: number }>;
  since: Date;
}
interface Redacted {
  seq: number;
  receipt: DocReceipt & { redacted?: { sig?: string; payloadHash?: string } };
}

const seals = new Map<string, SealCache>();
const anchors = new Map<string, AnchorCache>();
const redactions = new Map<string, Redacted[]>();
let authorities: DocTsaAuthority[] = [];
let installed: Domain | undefined;

/** A signature request the domain made during an operation, and the stand-in it holds until the gate's replaces it. */
export interface SignatureRequest {
  id: string;
  kind: SigningKind;
  input: unknown;
}

/** Where the domain's signature requests go during an operation (the bridge's ConsoleChain), and which operation runs. */
export interface SignatureSink {
  signature(orgId: string, kind: SigningKind, input: unknown): string;
  readonly op: string | undefined;
}

/**
 * Operations that read Seal v6 records (a seal view, an export or a bundle, an evidence request, the close-out, an
 * erasure, a verification): the organisation's new receipts are sealed before they run. Sealing writes a
 * seal.signed receipt, so it is not done for every operation; a receipt sealed later gets the same fields.
 */
const READS_SEALS = /seal|export|bundle|closeout|firstbundle|collectrequest|fulfilrequest|erasure|verify|anchor/i;
let sink: SignatureSink | undefined;

/** Each organisation's active key id as the gate holds it (read when its chain is opened, and on every sync). */
const kids = new Map<string, string>();

/** Read the organisation's active key id from the gate's keys (before its document is built). */
export async function rememberKid(orgId: string) {
  const k = await forOrg(orgId).orgKey.findFirst({ where: { retiredAt: null }, orderBy: { createdAt: "desc" }, select: { kid: true } });
  if (k) kids.set(orgId, k.kid);
}

export function noteKid(orgId: string, kid: string) {
  kids.set(orgId, kid);
}

const activeKid = (domain: Domain, orgId: string) => {
  const d = domain.db.peekDB(orgId) as unknown as { signingKeys?: { kid: string; status: string }[] } | undefined;
  const kid = kids.get(orgId) ?? d?.signingKeys?.find((k) => k.status === "active")?.kid;
  if (!kid) throw new Error(`${orgId} has no signing key in Elan1 Govern yet.`);
  return kid;
};

/** Make the domain's signatures Elan1 Govern's, and its seals and timestamps the gate's (console-domain.ts load). */
export function installSigning(domain: Domain, to: SignatureSink) {
  installed = domain;
  sink = to;
  domain.serverSigning.setOrgSigner({ kid: (orgId) => activeKid(domain, orgId), request: (orgId, kind, input) => to.signature(orgId, kind, input) });
  domain.serverSigning.setServerEvidence({
    seal: (orgId, seq, receiptHash) => {
      const s = seals.get(orgId)?.bySeq.get(seq);
      return s && s.receiptHash === receiptHash ? structuredClone(s) : undefined;
    },
    batches: (orgId) => [...(anchors.get(orgId)?.batches.values() ?? [])].sort((a, b) => a.firstSeq - b.firstSeq).map(({ createdAt: _c, ...b }) => structuredClone(b)),
    authorities: () => structuredClone(authorities),
  });
}

/* ── Seals ────────────────────────────────────────────────────────────── */

type SealRow = { seq: number; receiptHash: string; level: string; values: unknown; digest: string; kid: string; sig: string; payloadUnbound: boolean; updatedAt: Date };

const docSeal = (s: SealRow): DocSeal => {
  const values = s.values as string[];
  return {
    format: "elan1.seal.v6",
    seq: s.seq,
    receiptHash: s.receiptHash,
    level: s.level,
    fields: seal6.SEAL_FIELDS.map((f, i) => ({ id: f.id, name: f.name, value: values[i] ?? "" })),
    preimageBytes: seal6.sealPreimage(values).length,
    digest: s.digest,
    kid: s.kid,
    sig: s.sig,
    ...(s.payloadUnbound ? { payloadUnbound: true } : {}),
  };
};

/** Bring this process's copy of the organisation's seals up to the gate's table. Returns the last sealed seq. */
async function loadSeals(orgId: string): Promise<number> {
  const db = forOrg(orgId);
  const last = (await db.sealRecord.findFirst({ orderBy: { seq: "desc" }, select: { seq: true } }))?.seq ?? 0;
  let c = seals.get(orgId);
  // the table was emptied or cut back (a database reset): start again
  if (c && [...c.bySeq.keys()].some((q) => q > last)) c = undefined;
  if (!c) {
    c = { bySeq: new Map(), since: new Date(0) };
    seals.set(orgId, c);
  }
  const rows = await db.sealRecord.findMany({ where: { updatedAt: { gte: c.since } }, orderBy: { seq: "asc" } });
  for (const r of rows) {
    c.bySeq.set(r.seq, docSeal(r));
    if (r.updatedAt > c.since) c.since = r.updatedAt;
  }
  return last;
}

/* ── Timestamps ───────────────────────────────────────────────────────── */

interface GateToken {
  tsaId: string;
  tsaName: string;
  der: string;
  genTime: string;
  serial: string;
  policyOid: string;
  imprint: string;
  chain: string[];
}

async function loadAuthorities(ids: Set<string>) {
  if ([...ids].every((id) => authorities.some((a) => a.id === id))) return;
  const rows = await prisma.tsaKey.findMany({ orderBy: { id: "asc" } });
  const known = new Map(rows.map((r) => [r.id, r]));
  authorities = [...new Set([...rows.map((r) => r.id), ...ids])].flatMap((id): DocTsaAuthority[] => {
    const row = known.get(id);
    if (!row) return [];
    const cert = new X509Certificate(row.certPem);
    return [
      {
        id,
        name: row.name,
        scope: "Local",
        url: "",
        policyOid: "",
        publicKey: Buffer.from(cert.publicKey.export({ format: "der", type: "spki" })).toString("hex"),
        fingerprint: createHash("sha256").update(cert.raw).digest("hex").slice(0, 16),
        status: "operational",
        certPem: row.certPem,
      },
    ];
  });
}

/** Bring this process's copy of the organisation's timestamped batches up to the gate's table. */
async function loadAnchors(orgId: string, d: { receipts: DocReceipt[] }) {
  const db = forOrg(orgId);
  const where = { status: { not: "failed" } };
  let c = anchors.get(orgId);
  if (c && (await db.anchorBatch.count({ where })) < c.batches.size) c = undefined;
  if (!c) {
    c = { batches: new Map(), since: new Date(0) };
    anchors.set(orgId, c);
  }
  const rows = await db.anchorBatch.findMany({ where: { ...where, createdAt: { gte: c.since } }, orderBy: { createdAt: "asc" } });
  if (!rows.length) return;
  const tsas = new Set<string>();
  const tsOf = new Map(d.receipts.map((r) => [r.seq, r.ts]));
  for (const b of rows) {
    const created = b.createdAt.getTime();
    const tokens = (b.tokens as unknown as GateToken[]).map((t) => {
      tsas.add(t.tsaId);
      return { tsaId: t.tsaId, tsaName: t.tsaName, genTime: t.genTime, serial: t.serial, policyOid: t.policyOid, status: "granted" as const, imprint: t.imprint, sig: "", delaySeconds: Math.max(0, Math.round((Date.parse(t.genTime) - created) / 1000)), der: t.der, chain: t.chain };
    });
    c.batches.set(b.id, { id: b.id, windowStart: tsOf.get(b.fromSeq) ?? b.createdAt.toISOString(), windowEnd: b.createdAt.toISOString(), firstSeq: b.fromSeq, lastSeq: b.toSeq, count: b.toSeq - b.fromSeq + 1, root: b.root, tokens, status: "anchored", createdAt: created });
    if (b.createdAt > c.since) c.since = b.createdAt;
  }
  await loadAuthorities(tsas);
}

/* ── Erasures ─────────────────────────────────────────────────────────── */

/** The receipts an erasure redacted, as the gate signed them: put in place in the document, with F14 and F12 recorded. */
export function applyRedactions(orgId: string, d: { receipts: DocReceipt[] }, list: { seq: number; receipt: unknown; payloadHash?: string; recordId?: string }[]): boolean {
  const domain = installed;
  let changed = false;
  for (const x of list) {
    const i = d.receipts.findIndex((r) => r.seq === x.seq);
    const want = x.receipt as Redacted["receipt"];
    const cur = d.receipts[i] as Redacted["receipt"] | undefined;
    if (i < 0 || !cur) continue;
    if (cur.redacted?.sig !== want.redacted?.sig) {
      d.receipts[i] = structuredClone(want);
      changed = true;
    }
    const payloadHash = x.payloadHash ?? String(want.redacted?.payloadHash ?? "");
    const recordId = x.recordId ?? seals.get(orgId)?.bySeq.get(x.seq)?.fields[11]?.value ?? seal6.sealedRecordId(want as unknown as seal6.Receipt, undefined);
    const platform = (d as unknown as { platform?: { erased?: Record<number, string>; erasedRecordIds?: Record<number, string> } }).platform;
    if (domain && platform && (platform.erased?.[x.seq] !== payloadHash || platform.erasedRecordIds?.[x.seq] !== recordId)) {
      domain.serverSigning.noteErased(d as unknown as SavedDoc, x.seq, payloadHash, recordId);
      changed = true;
    }
  }
  return changed;
}

async function loadRedactions(orgId: string): Promise<Redacted[]> {
  const db = forOrg(orgId);
  const cached = redactions.get(orgId);
  const n = await db.receiptRedaction.count();
  if (cached && cached.length === n) return cached;
  const rows = await db.receiptRedaction.findMany({ orderBy: { seq: "asc" }, select: { seq: true, receipt: true } });
  const list = rows.map((r) => ({ seq: r.seq, receipt: r.receipt as unknown as Redacted["receipt"] }));
  redactions.set(orgId, list);
  return list;
}

/* ── Before every operation ───────────────────────────────────────────── */

const levelOf = (d: unknown) => (d as { org?: { plan?: string } }).org?.plan;

/**
 * Bring an open organisation's document up to what the gate signed: its erased receipts in place, and (from L2) every
 * receipt sealed (the gate seals the new ones now and records it with a seal.signed receipt, which is returned for
 * the caller to add), the seals and timestamped batches in this process for the domain to read. Returns whether the
 * document changed, and the receipts the gate wrote meanwhile.
 */
export async function syncSigned(orgId: string, d: { receipts: DocReceipt[] }): Promise<{ changed: boolean; written: Receipt[] }> {
  const domain = installed;
  if (!domain) return { changed: false, written: [] };
  const written: Receipt[] = [];
  let changed = applyRedactions(orgId, d, await loadRedactions(orgId));
  const sealed = await loadSeals(orgId);
  const head = d.receipts.at(-1)?.seq ?? 0;
  if (READS_SEALS.test(sink?.op ?? "") && ["l2", "l3", "sovereign"].includes(levelOf(d) ?? "") && head > sealed) {
    const plan = domain.serverSigning.sealPlan(d as unknown as SavedDoc, sealed + 1);
    if (plan.fromSeq !== undefined && head >= plan.fromSeq) {
      const r = await gate<{ sealed?: number; receipt?: Receipt; error?: string }>("POST", `/internal/orgs/${encodeURIComponent(orgId)}/console-signing/seal`, { fromSeq: plan.fromSeq, autonomy: plan.autonomy, levels: plan.levels }).catch(() => undefined);
      if (!r) throw new HttpError(503, "Elan1 Govern is not reachable, so nothing was recorded or changed. Try again.");
      if (r.status === 200 && r.data.receipt) written.push(r.data.receipt);
      // an organisation the gate holds below L2 (its level not moved yet) keeps its receipts unsealed until it is
      else if (r.status !== 200) log("warn", "console.seal_refused", { orgId, status: r.status, err: r.data.error ?? "" });
      await loadSeals(orgId);
    }
  }
  await loadAnchors(orgId, d);
  if (written.length) changed = true;
  return { changed, written };
}

/** Forget this process's copies (tests, as a fresh process would start). */
export function forgetSigned() {
  kids.clear();
  seals.clear();
  anchors.clear();
  redactions.clear();
  authorities = [];
}
