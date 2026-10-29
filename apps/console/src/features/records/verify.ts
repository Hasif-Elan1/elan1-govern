/**
 * Verify one record's receipts in the browser.
 *  - Every receipt: SHA-256 over canonical JSON against its hash, then the Ed25519 signature.
 *  - Receipts written at L2 or above: the Seal v6 record (16 fields, digest, signature, binding), the RFC 6962
 *    inclusion proof against its Merkle batch root, and each RFC 3161 timestamp token against the authority's key.
 * Receipts written before the organisation's L2 boundary keep their level: signed and chained, not sealed.
 */
import { useEffect, useRef, useState } from 'react';
import type { LevelId, Receipt, TsaAuthority } from '@/types';
import { api } from '@/api';
import { contentOk, verifySig } from '@/lib/crypto';
import { verifyInclusion } from '@/lib/merkle';
import { verifySeal } from '@/lib/seal';
import { tokenMessage } from '@/lib/verify6';
import { atLeast } from '@/lib/levels';
import type { RecordEntry } from './lib';
import { levelOfReceipt } from './level';

export interface RecordVerifyL2 {
  sealed: number;
  sealsOk: number;
  payloadUnbound: number;
  anchored: number;
  proofsOk: number;
  tokensOk: number;
  tokens: number;
  authorities: string[];
  unanchored: number[];
  beforeBoundary: number;
}

export interface RecordVerifyState {
  state: 'idle' | 'running' | 'done';
  done: number;
  total: number;
  /** receipts checked (total also counts seal and proof checks) */
  receipts: number;
  failed: { seq: number; why: string }[];
  noKey: number[];
  kids: string[];
  first?: number;
  last?: number;
  ms?: number;
  l2?: RecordVerifyL2;
  /** The organisation's level when the check ran. */
  level: LevelId;
}

export function recordReceipts(entry: RecordEntry): Receipt[] {
  const bySeq = new Map<number, Receipt>();
  for (const e of entry.events) for (const r of e.receipts) bySeq.set(r.seq, r);
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

export function useRecordVerify(orgId: string, entry: RecordEntry, publicKeys: Record<string, string>, level: LevelId, history: { level: LevelId; from: string }[] | undefined) {
  const [st, setSt] = useState<RecordVerifyState>({ state: 'idle', done: 0, total: 0, receipts: 0, failed: [], noKey: [], kids: [], level });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = async () => {
    const list = recordReceipts(entry);
    const t0 = performance.now();
    const failed: { seq: number; why: string }[] = [];
    const noKey: number[] = [];
    const kids = new Set<string>();
    const sealedList = atLeast(level, 'l2') ? list.filter((r) => atLeast(levelOfReceipt(r, history, level), 'l2')) : [];
    const total = list.length + sealedList.length;
    setSt({ state: 'running', done: 0, total, receipts: list.length, failed, noKey, kids: [], level });

    // 1. hash and signature, every receipt
    for (let i = 0; i < list.length; i += 20) {
      for (const r of list.slice(i, i + 20)) {
        kids.add(r.kid);
        const pub = publicKeys[r.kid];
        if (!contentOk(r, publicKeys)) failed.push({ seq: r.seq, why: r.redacted ? 'The erased receipt does not match its redaction signature.' : 'The content does not match its hash.' });
        else if (!pub) noKey.push(r.seq);
        // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
        else if (!verifySig(r.hash, r.sig, pub)) failed.push({ seq: r.seq, why: `The ${atLeast(levelOfReceipt(r, history, level), 'l2') ? 'signature' : 'Ed25519 seal'} does not verify against the named key.` });
      }
      if (!alive.current) return;
      setSt((p) => ({ ...p, done: Math.min(list.length, i + 20) }));
      await new Promise((res) => setTimeout(res, 0));
    }

    // 2. L2 and above: seal, inclusion proof, timestamp tokens
    let l2: RecordVerifyL2 | undefined;
    if (atLeast(level, 'l2')) {
      l2 = { sealed: 0, sealsOk: 0, payloadUnbound: 0, anchored: 0, proofsOk: 0, tokensOk: 0, tokens: 0, authorities: [], unanchored: [], beforeBoundary: list.length - sealedList.length };
      let authorities: TsaAuthority[] = [];
      try { const v = await api.anchors(orgId, 1); authorities = [...v.authorities, ...(v.previousAuthorities ?? [])]; } catch { /* checked per token below */ }
      const auth = new Map(authorities.map((a) => [a.id, a]));
      const usedAuth = new Set<string>();
      for (let i = 0; i < sealedList.length; i += 8) {
        const chunk = sealedList.slice(i, i + 8);
        const results = await Promise.all(chunk.map(async (r) => {
          const [seal, proof] = await Promise.all([
            api.seal(orgId, r.seq).catch((e: Error) => ({ error: e.message })),
            api.inclusionProof(orgId, r.seq).catch((e: Error) => ({ error: e.message })),
          ]);
          return { r, seal, proof };
        }));
        for (const { r, seal, proof } of results) {
          if ('error' in seal) failed.push({ seq: r.seq, why: `Seal could not be read: ${seal.error}` });
          else if (seal.sealed) {
            l2.sealed++;
            if (seal.payloadUnbound) l2.payloadUnbound++;
            const c = verifySeal(seal.seal, publicKeys[seal.seal.kid], r);
            if (c.structure && c.digest && c.signature && c.binding) l2.sealsOk++;
            else failed.push({ seq: r.seq, why: `Seal v6 check failed (${[!c.structure && 'structure', !c.digest && 'digest', !c.signature && 'signature', !c.binding && 'binding'].filter(Boolean).join(', ')}).` });
          }
          if ('error' in proof) {
            if (/unanchored tail|not yet timestamped/i.test(proof.error)) l2.unanchored.push(r.seq);
            else failed.push({ seq: r.seq, why: proof.error });
          } else {
            l2.anchored++;
            const inc = proof.receiptHash === r.hash && verifyInclusion(r.hash, proof.path, proof.root);
            if (inc) l2.proofsOk++;
            else failed.push({ seq: r.seq, why: `The inclusion proof does not lead to the root of batch ${proof.batchId}.` });
            const distinct = new Set<string>();
            for (const t of proof.tokens) {
              l2.tokens++;
              const a = auth.get(t.tsaId);
              const ok = !!a && t.imprint === proof.root && verifySig(tokenMessage(t), t.sig, a.publicKey);
              if (ok) { l2.tokensOk++; distinct.add(t.tsaId); usedAuth.add(a!.name); }
              else failed.push({ seq: r.seq, why: `Timestamp ${t.serial.slice(0, 10)} from ${t.tsaName} does not verify over the batch root.` });
            }
            if (distinct.size < 2 && proof.tokens.length) failed.push({ seq: r.seq, why: 'Fewer than two timestamp authorities signed its batch.' });
          }
        }
        if (!alive.current) return;
        setSt((p) => ({ ...p, done: Math.min(total, list.length + i + 8) }));
      }
      l2.authorities = Array.from(usedAuth);
    }

    if (!alive.current) return;
    setSt({ state: 'done', done: total, total, receipts: list.length, failed, noKey, kids: Array.from(kids), first: list[0]?.seq, last: list[list.length - 1]?.seq, ms: Math.round(performance.now() - t0), l2, level });
  };

  return { ...st, run: () => { void run(); } };
}

export type RecordVerify = ReturnType<typeof useRecordVerify>;
