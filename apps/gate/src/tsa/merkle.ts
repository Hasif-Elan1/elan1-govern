import { createHash } from "node:crypto";

/**
 * RFC 6962 Merkle trees over receipt hashes, exactly as the console computes them
 * (apps/console/src/lib/merkle.ts): leaf = SHA-256(0x00 ‖ receipt hash bytes),
 * node = SHA-256(0x01 ‖ left ‖ right), split at the largest power of two below n.
 * The test pins both to the same vectors. When Merkle moves into @gate/core (plan step 5.1)
 * this file should re-export that one.
 */

export interface PathStep {
  hash: string;
  side: "left" | "right";
}

const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest("hex");

function bytes(hex: string): Buffer {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("not a hex string");
  return Buffer.from(hex, "hex");
}

export const leafHash = (leafHex: string) => sha256(Buffer.from([0]), bytes(leafHex));
export const nodeHash = (leftHex: string, rightHex: string) => sha256(Buffer.from([1]), bytes(leftHex), bytes(rightHex));

const EMPTY = sha256();

function largestPow2Below(n: number) {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

function mth(leaves: string[]): string {
  if (leaves.length === 0) return EMPTY;
  if (leaves.length === 1) return leaves[0] as string;
  const k = largestPow2Below(leaves.length);
  return nodeHash(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}

/** Merkle tree hash over receipt hashes (hex). */
export function merkleRoot(receiptHashes: string[]): string {
  return mth(receiptHashes.map(leafHash));
}

function path(m: number, leaves: string[]): PathStep[] {
  const n = leaves.length;
  if (n <= 1) return [];
  const k = largestPow2Below(n);
  if (m < k) return [...path(m, leaves.slice(0, k)), { hash: mth(leaves.slice(k)), side: "right" }];
  return [...path(m - k, leaves.slice(k)), { hash: mth(leaves.slice(0, k)), side: "left" }];
}

/** Audit path for leaf `index` (RFC 6962 §2.1.1). Each step names the side its sibling sits on. */
export function inclusionPath(receiptHashes: string[], index: number): PathStep[] {
  if (!Number.isInteger(index) || index < 0 || index >= receiptHashes.length) throw new RangeError("leaf index out of range");
  return path(index, receiptHashes.map(leafHash));
}

/** Recompute the root from a receipt hash and its audit path. */
export function rootFromPath(receiptHash: string, steps: PathStep[]): string {
  let h = leafHash(receiptHash);
  for (const s of steps) h = s.side === "right" ? nodeHash(h, s.hash) : nodeHash(s.hash, h);
  return h;
}

export function verifyInclusion(receiptHash: string, steps: PathStep[], root: string): boolean {
  try {
    return rootFromPath(receiptHash, steps) === root;
  } catch {
    return false;
  }
}
