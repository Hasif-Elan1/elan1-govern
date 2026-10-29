import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { shamir } from "../src/index";
import { combine, parseShare, split } from "../src/shamir";

/** n, k with 2 <= k <= n. */
const nk = fc.integer({ min: 2, max: 12 }).chain((n) => fc.tuple(fc.constant(n), fc.integer({ min: 2, max: n })));
/** n, k and a shuffled pick of at least k distinct share indexes. */
const pick = nk.chain(([n, k]) => fc.tuple(fc.constant(n), fc.constant(k), fc.shuffledSubarray([...Array(n).keys()], { minLength: k })));
const secretArb = fc.uint8Array({ minLength: 1, maxLength: 48 });

/** Replaces the character at i with a different hex digit. */
function flip(text: string, i: number): string {
  const c = text[i]!;
  const next = c === "0" ? "1" : "0";
  return text.slice(0, i) + next + text.slice(i + 1);
}

describe("shamir secret sharing", () => {
  it("is exported from the core index", () => {
    expect(shamir.split).toBe(split);
    expect(shamir.combine).toBe(combine);
  });

  it("any k of n shares, in any order, recover the secret", () => {
    fc.assert(
      fc.property(secretArb, pick, (secret, [n, k, chosen]) => {
        const shares = split(secret, n, k);
        expect(shares).toHaveLength(n);
        expect(combine(chosen.map((i) => shares[i]!))).toEqual(secret);
      }),
      { numRuns: 200 },
    );
  });

  it("fewer than k shares are refused", () => {
    fc.assert(
      fc.property(secretArb, nk, (secret, [n, k]) => {
        const shares = split(secret, n, k);
        expect(() => combine(shares.slice(0, k - 1))).toThrow(`${k} shares are needed`);
      }),
    );
  });

  it("a tampered share fails its checksum", () => {
    fc.assert(
      fc.property(secretArb, nk, fc.nat(), (secret, [n, k], at) => {
        const shares = split(secret, n, k);
        const victim = shares[at % n]!;
        // Change one hex character of the payload (after the fourth dash).
        const start = victim.split("-").slice(0, 4).join("-").length + 1;
        const end = victim.lastIndexOf("-");
        const tampered = flip(victim, start + (at % (end - start)));
        expect(() => parseShare(tampered)).toThrow(/checksum mismatch/);
        const set = shares.slice(0, k).map((s) => (s === victim ? tampered : s));
        if (set.includes(tampered)) expect(() => combine(set)).toThrow(/checksum mismatch/);
      }),
    );
  });

  it("k-1 shares look uniformly random whatever the secret (statistical sanity check)", () => {
    // For two very different secrets, the bytes of 2 shares of a 3-of-5 split should be uniform
    // over 0..255: a chi-squared statistic far above its mean (255 degrees of freedom) would mean
    // the shares leak something about the secret.
    const runs = 4096;
    const chi = (counts: number[], total: number) => counts.reduce((s, c) => s + (c - total / 256) ** 2 / (total / 256), 0);
    for (const fill of [0x00, 0xff, 0x5a]) {
      const secret = new Uint8Array(4).fill(fill);
      const first = new Array<number>(256).fill(0);
      const second = new Array<number>(256).fill(0);
      for (let i = 0; i < runs; i++) {
        const [a, b] = split(secret, 5, 3).map(parseShare);
        for (const byte of a!.data) first[byte]!++;
        for (const byte of b!.data) second[byte]!++;
      }
      // mean 255, standard deviation about 22.6: 400 is more than six deviations out
      expect(chi(first, runs * 4)).toBeLessThan(400);
      expect(chi(second, runs * 4)).toBeLessThan(400);
      // and no byte of the secret shows through more than chance would allow
      expect(first[fill]! / (runs * 4)).toBeLessThan(2 / 256);
    }
  });

  it("shares from different splits, duplicates and mismatched shares are refused", () => {
    const secret = new Uint8Array([1, 2, 3, 4]);
    const a = split(secret, 5, 3);
    const b = split(secret, 5, 3);
    expect(() => combine([a[0]!, a[1]!, b[2]!])).toThrow(/different key ceremonies/);
    // the same share twice counts once
    expect(() => combine([a[0]!, a[0]!, a[1]!])).toThrow("3 shares are needed; 2 given");
    expect(combine([a[0]!, a[1]!, a[2]!, a[3]!])).toEqual(secret);
    expect(() => combine([])).toThrow("no shares given");

    // An extra share that is well formed but off the polynomial is caught.
    const forged = parseShare(a[3]!);
    forged.data[0] = forged.data[0]! ^ 1;
    const hex = Buffer.from(forged.data).toString("hex");
    const check = createHash("sha256").update(`gss1|${forged.set}|3|4|${hex}`).digest("hex").slice(0, 8);
    expect(() => combine([a[0]!, a[1]!, a[2]!, `gss1-${forged.set}-3-4-${hex}-${check}`])).toThrow("share 4 does not match the others");

    // Two different shares claiming the same number.
    const other = `gss1-${forged.set}-3-1-${hex}-${createHash("sha256").update(`gss1|${forged.set}|3|1|${hex}`).digest("hex").slice(0, 8)}`;
    expect(() => combine([a[0]!, other, a[2]!])).toThrow("two different shares are both numbered 1");

    // Shares of one set with a different k or length do not belong together.
    const shortHex = hex.slice(0, 4);
    const short = `gss1-${forged.set}-3-5-${shortHex}-${createHash("sha256").update(`gss1|${forged.set}|3|5|${shortHex}`).digest("hex").slice(0, 8)}`;
    expect(() => combine([a[0]!, a[1]!, short])).toThrow("do not belong together");
  });

  it("validates its inputs", () => {
    expect(() => split(new Uint8Array(), 5, 3)).toThrow(/non-empty/);
    expect(() => split("secret" as unknown as Uint8Array, 5, 3)).toThrow(/non-empty/);
    expect(() => split(new Uint8Array([1]), 5, 1)).toThrow(/2 <= k <= n <= 255/);
    expect(() => split(new Uint8Array([1]), 2, 3)).toThrow(/2 <= k <= n <= 255/);
    expect(() => split(new Uint8Array([1]), 256, 3)).toThrow(/2 <= k <= n <= 255/);
    expect(() => split(new Uint8Array([1]), 5.5, 3)).toThrow(/2 <= k <= n <= 255/);
    expect(split(new Uint8Array([9]), 255, 255)).toHaveLength(255);
    for (const bad of ["", "nope", "gss1-zz-3-1-00-00000000", "gss1-00000000-1-1-00-00000000", "gss1-00000000-3-256-00-00000000", "gss1-00000000-3-1-0-00000000", 42 as unknown as string]) {
      expect(() => parseShare(bad)).toThrow("not a key share");
    }
  });

  it("is deterministic given the random source, and evaluates real polynomials", () => {
    // f(x) = 7 + 1x + 2x^2 over GF(256): known points let us check the field arithmetic by hand.
    let calls = 0;
    const random = (size: number) => (calls++ === 0 ? new Uint8Array([0xde, 0xad, 0xbe, 0xef]) : new Uint8Array([1, 2]).slice(0, size));
    const shares = split(new Uint8Array([7]), 3, 3, random).map(parseShare);
    expect(shares[0]!.set).toBe("deadbeef");
    // x=1: 7 ^ 1 ^ 2 = 4; x=2: 7 ^ 2 ^ (2*4=8) = 13; x=3: 7 ^ 3 ^ 2*mul(3,3)=2*5=10 -> 7^3^10 = 14
    expect(shares.map((s) => s.data[0])).toEqual([4, 13, 14]);
  });
});
