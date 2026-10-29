import { createHash, randomBytes } from "node:crypto";

/**
 * Shamir secret sharing over GF(2^8), for customer-held key ceremonies (3 of 5 custodians).
 *
 * Each byte of the secret is the constant term of its own random polynomial of degree k-1; share x
 * holds every polynomial's value at x (1..n). Any k shares give the polynomials back by Lagrange
 * interpolation; k-1 shares are uniformly random and say nothing about the secret.
 *
 * A share is text a custodian can keep: `gss1-<set>-<k>-<x>-<hex>-<check>`. `set` is random per
 * split, so shares from two ceremonies never mix; `check` is a SHA-256 checksum of the rest, so a
 * mistyped or altered share is refused by name instead of silently recovering a wrong secret.
 * The checksum is not a MAC (anyone can recompute it): callers that need the recovered secret to be
 * authentic check it themselves, e.g. it is an AES-GCM key that must open its backup.
 */

// GF(2^8) with the AES polynomial x^8 + x^4 + x^3 + x + 1, using 3 as the generator for log tables.
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    const doubled = (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x ^= doubled; // x * 3 = x * 2 + x
  }
  for (let i = 255; i < 510; i++) EXP[i] = EXP[i - 255]!;
}

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);
// b is never 0 here: it is x_j ^ x_m for distinct share numbers.
const div = (a: number, b: number) => (a === 0 ? 0 : EXP[LOG[a]! + 255 - LOG[b]!]!);

const PREFIX = "gss1";

export interface ShareInfo {
  /** Random id shared by every share of one split. */
  set: string;
  /** Shares needed to recover the secret. */
  k: number;
  /** This share's number, 1..n. */
  x: number;
  data: Uint8Array;
}

const checksum = (set: string, k: number, x: number, hex: string) =>
  createHash("sha256").update(`${PREFIX}|${set}|${k}|${x}|${hex}`).digest("hex").slice(0, 8);

function encode(s: ShareInfo): string {
  const hex = Buffer.from(s.data).toString("hex");
  return [PREFIX, s.set, s.k, s.x, hex, checksum(s.set, s.k, s.x, hex)].join("-");
}

/** Reads a share and checks its checksum. Throws on anything malformed or altered. */
export function parseShare(share: string): ShareInfo {
  const parts = typeof share === "string" ? share.trim().split("-") : [];
  const [prefix, set, kText, xText, hex, check] = parts;
  if (parts.length !== 6 || prefix !== PREFIX) throw new Error("not a key share");
  if (!/^[0-9a-f]{8}$/.test(set!) || !/^[1-9][0-9]{0,2}$/.test(kText!) || !/^[1-9][0-9]{0,2}$/.test(xText!) || !/^(?:[0-9a-f]{2})+$/.test(hex!)) {
    throw new Error("not a key share");
  }
  const k = Number(kText);
  const x = Number(xText);
  if (k < 2 || k > 255 || x > 255) throw new Error("not a key share");
  if (check !== checksum(set!, k, x, hex!)) throw new Error(`share ${x} is damaged or was changed (checksum mismatch)`);
  return { set: set!, k, x, data: new Uint8Array(Buffer.from(hex!, "hex")) };
}

/**
 * Splits `secret` into `n` shares, any `k` of which recover it (2 <= k <= n <= 255).
 * `random` is for tests only; it must return `size` uniformly random bytes.
 */
export function split(secret: Uint8Array, n: number, k: number, random: (size: number) => Uint8Array = randomBytes): string[] {
  if (!(secret instanceof Uint8Array) || secret.length === 0) throw new Error("the secret must be a non-empty byte array");
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 2 || n < k || n > 255) throw new Error("need whole numbers with 2 <= k <= n <= 255");
  const set = Buffer.from(random(4)).toString("hex");
  const shares = Array.from({ length: n }, () => new Uint8Array(secret.length));
  const coeffs = new Uint8Array(k);
  for (let i = 0; i < secret.length; i++) {
    coeffs[0] = secret[i]!;
    coeffs.set(random(k - 1), 1);
    for (let x = 1; x <= n; x++) {
      // Horner's rule from the highest coefficient down.
      let y = 0;
      for (let c = k - 1; c >= 0; c--) y = mul(y, x) ^ coeffs[c]!;
      shares[x - 1]![i] = y;
    }
  }
  coeffs.fill(0);
  return shares.map((data, i) => encode({ set, k, x: i + 1, data }));
}

/** The value at `at` of the polynomial through `points`, byte by byte. */
function interpolate(points: readonly ShareInfo[], at: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let j = 0; j < points.length; j++) {
    // Lagrange basis l_j(at) = prod_{m != j} (at - x_m) / (x_j - x_m); minus is xor in GF(2^8).
    let basis = 1;
    for (let m = 0; m < points.length; m++) {
      if (m !== j) basis = mul(basis, div(at ^ points[m]!.x, points[j]!.x ^ points[m]!.x));
    }
    const data = points[j]!.data;
    for (let i = 0; i < length; i++) out[i] = out[i]! ^ mul(data[i]!, basis);
  }
  return out;
}

/**
 * Recovers the secret from at least k shares of one split. Shares beyond the first k are checked
 * against the recovered polynomials, so an inconsistent extra share is refused rather than ignored.
 */
export function combine(shares: readonly string[]): Uint8Array {
  const parsed = [...new Set(shares)].map(parseShare);
  const first = parsed[0];
  if (!first) throw new Error("no shares given");
  const seen = new Set<number>();
  for (const s of parsed) {
    if (s.set !== first.set) throw new Error("these shares come from different key ceremonies");
    if (s.k !== first.k || s.data.length !== first.data.length) throw new Error("these shares do not belong together");
    if (seen.has(s.x)) throw new Error(`two different shares are both numbered ${s.x}`);
    seen.add(s.x);
  }
  if (parsed.length < first.k) throw new Error(`${first.k} shares are needed; ${parsed.length} given`);
  const base = parsed.slice(0, first.k);
  for (const extra of parsed.slice(first.k)) {
    const expected = interpolate(base, extra.x, first.data.length);
    if (!expected.every((b, i) => b === extra.data[i])) throw new Error(`share ${extra.x} does not match the others`);
  }
  return interpolate(base, 0, first.data.length);
}
