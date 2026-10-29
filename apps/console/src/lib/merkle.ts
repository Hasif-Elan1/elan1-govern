/**
 * RFC 6962 Merkle trees (Certificate Transparency style), real SHA-256.
 * Leaf hash = SHA-256(0x00 ‖ leaf), node hash = SHA-256(0x01 ‖ left ‖ right). Leaves are the 32-byte
 * receipt hashes. Used for 15-minute anchor batches and receipt inclusion proofs.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

export function leafHash(leafHex: string): string {
  return bytesToHex(sha256(concatBytes(LEAF, hexToBytes(leafHex))));
}

export function nodeHash(leftHex: string, rightHex: string): string {
  return bytesToHex(sha256(concatBytes(NODE, hexToBytes(leftHex), hexToBytes(rightHex))));
}

const EMPTY = bytesToHex(sha256(new Uint8Array()));

function largestPow2Below(n: number) {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

function mth(leaves: string[]): string {
  if (leaves.length === 0) return EMPTY;
  if (leaves.length === 1) return leaves[0];
  const k = largestPow2Below(leaves.length);
  return nodeHash(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}

/** Merkle tree hash over receipt hashes (hex). */
export function merkleRoot(receiptHashes: string[]): string {
  return mth(receiptHashes.map(leafHash));
}

function path(m: number, leaves: string[]): { hash: string; side: 'left' | 'right' }[] {
  const n = leaves.length;
  if (n <= 1) return [];
  const k = largestPow2Below(n);
  if (m < k) return [...path(m, leaves.slice(0, k)), { hash: mth(leaves.slice(k)), side: 'right' }];
  return [...path(m - k, leaves.slice(k)), { hash: mth(leaves.slice(0, k)), side: 'left' }];
}

/** Audit path for leaf `index` (RFC 6962 §2.1.1). Each step names the side its sibling sits on. */
export function inclusionPath(receiptHashes: string[], index: number) {
  return path(index, receiptHashes.map(leafHash));
}

/** Recompute the root from a leaf and its audit path. */
export function rootFromPath(receiptHash: string, steps: { hash: string; side: 'left' | 'right' }[]): string {
  let h = leafHash(receiptHash);
  for (const s of steps) h = s.side === 'right' ? nodeHash(h, s.hash) : nodeHash(s.hash, h);
  return h;
}

export function verifyInclusion(receiptHash: string, steps: { hash: string; side: 'left' | 'right' }[], root: string): boolean {
  try {
    return rootFromPath(receiptHash, steps) === root;
  } catch {
    return false;
  }
}
