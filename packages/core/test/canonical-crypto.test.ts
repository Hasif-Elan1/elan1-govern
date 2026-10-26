import { describe, expect, it } from "vitest";
import { canonicalize, omit } from "../src/canonical";
import {
  GENESIS_HASH,
  decrypt,
  encrypt,
  hashCanonical,
  hashToken,
  hmacSign,
  hmacVerify,
  keyFingerprint,
  publicKeyFromPrivate,
  randomToken,
  safeEqual,
  sha256,
  signText,
  verifyText,
} from "../src/crypto";
import { KEYS, OTHER_KEYS } from "./fixtures";

const KEY = "a".repeat(64);

describe("canonicalize", () => {
  it("sorts keys and strips whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  });
  it("drops undefined members and maps undefined array items to null", () => {
    expect(canonicalize({ a: undefined, b: [undefined] })).toBe('{"b":[null]}');
  });
  it("normalises -0", () => expect(canonicalize(-0)).toBe("0"));
  it("accepts null-prototype objects", () => expect(canonicalize(Object.assign(Object.create(null), { a: 1 }))).toBe('{"a":1}'));
  it("rejects non-JSON values", () => {
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(new Date())).toThrow();
    expect(() => canonicalize(() => 1)).toThrow();
    expect(() => canonicalize(1n)).toThrow();
  });
  it("omit copies without keys", () => {
    const o = { a: 1, b: 2 };
    expect(omit(o, ["b"])).toEqual({ a: 1 });
    expect(o.b).toBe(2);
  });
});

describe("hashing and signing", () => {
  it("prefixes sha256", () => {
    expect(sha256("")).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(GENESIS_HASH).toMatch(/^sha256:0{64}$/);
    expect(hashCanonical({ b: 1, a: 2 })).toBe(hashCanonical({ a: 2, b: 1 }));
  });
  it("signs and verifies", () => {
    const sig = signText(KEYS.privateKeyPem, "hello");
    expect(sig.startsWith("ed25519:")).toBe(true);
    expect(verifyText(KEYS.publicKeyPem, "hello", sig)).toBe(true);
    expect(verifyText(KEYS.publicKeyPem, "hellO", sig)).toBe(false);
    expect(verifyText(OTHER_KEYS.publicKeyPem, "hello", sig)).toBe(false);
  });
  it("never throws on junk", () => {
    expect(verifyText(KEYS.publicKeyPem, "x", "nope")).toBe(false);
    expect(verifyText(KEYS.publicKeyPem, "x", "ed25519:AAAA")).toBe(false);
    expect(verifyText("not a key", "x", `ed25519:${Buffer.alloc(64).toString("base64")}`)).toBe(false);
    expect(verifyText(KEYS.publicKeyPem, "x", 5 as unknown as string)).toBe(false);
  });
  it("derives the public key and a fingerprint", () => {
    expect(publicKeyFromPrivate(KEYS.privateKeyPem)).toBe(KEYS.publicKeyPem);
    expect(keyFingerprint(KEYS.publicKeyPem)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyFingerprint(KEYS.publicKeyPem)).not.toBe(keyFingerprint(OTHER_KEYS.publicKeyPem));
  });
});

describe("AES-256-GCM", () => {
  it("round-trips and binds AAD", () => {
    const ct = encrypt(KEY, "secret-token", "org1");
    expect(ct).not.toContain("secret");
    expect(decrypt(KEY, ct, "org1")).toBe("secret-token");
    expect(() => decrypt(KEY, ct, "org2")).toThrow();
    expect(() => decrypt("b".repeat(64), ct, "org1")).toThrow();
  });
  it("uses a fresh IV each time", () => expect(encrypt(KEY, "x")).not.toBe(encrypt(KEY, "x")));
  it("rejects bad keys and payloads", () => {
    expect(() => encrypt("short", "x")).toThrow(/32 bytes/);
    expect(() => decrypt(KEY, "v2.a.b.c")).toThrow(/bad ciphertext/);
    const [v, iv, tag, ct] = encrypt(KEY, "hello").split(".");
    const flipped = Buffer.from(ct!, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decrypt(KEY, [v, iv, tag, flipped.toString("base64")].join("."))).toThrow();
  });
});

describe("tokens", () => {
  it("are 256-bit and hashed", () => {
    const t = randomToken("gk_");
    expect(t.startsWith("gk_")).toBe(true);
    expect(Buffer.from(t.slice(3), "base64url")).toHaveLength(32);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken()).not.toBe(randomToken());
  });
  it("compares in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
  it("HMAC tokens verify and reject tampering", () => {
    const t = hmacSign(KEY, { id: "x", exp: 5 });
    expect(hmacVerify(KEY, t)).toEqual({ exp: 5, id: "x" });
    expect(hmacVerify("b".repeat(64), t)).toBeNull();
    expect(hmacVerify(KEY, `${t}x`)).toBeNull();
    expect(hmacVerify(KEY, "nodot")).toBeNull();
    const forged = `${Buffer.from("{not json").toString("base64url")}`;
    const mac = t.split(".")[1];
    expect(hmacVerify(KEY, `${forged}.${mac}`)).toBeNull();
  });
  it("returns null when a validly-signed body is not JSON", async () => {
    const { createHmac } = await import("node:crypto");
    const body = Buffer.from("{oops").toString("base64url");
    const mac = createHmac("sha256", Buffer.from(KEY, "hex")).update(body).digest("base64url");
    expect(hmacVerify(KEY, `${body}.${mac}`)).toBeNull();
  });
});

describe("request signing", () => {
  it("binds method, path, body and time", async () => {
    const { signRequest, verifyRequest } = await import("../src/crypto");
    const now = 1_800_000_000_000;
    const h = signRequest(KEY, "post", "/internal/x", '{"a":1}', now);
    expect(verifyRequest(KEY, h, "POST", "/internal/x", '{"a":1}', now)).toBe(true);
    expect(verifyRequest(KEY, h, "POST", "/internal/x", '{"a":2}', now)).toBe(false);
    expect(verifyRequest(KEY, h, "GET", "/internal/x", '{"a":1}', now)).toBe(false);
    expect(verifyRequest(KEY, h, "POST", "/internal/y", '{"a":1}', now)).toBe(false);
    expect(verifyRequest(KEY, h, "POST", "/internal/x", '{"a":1}', now + 120_000)).toBe(false);
    expect(verifyRequest("b".repeat(64), h, "POST", "/internal/x", '{"a":1}', now)).toBe(false);
    expect(verifyRequest(KEY, undefined, "POST", "/internal/x", "", now)).toBe(false);
    expect(verifyRequest(KEY, "t=1,v=zz", "POST", "/", "", now)).toBe(false);
  });
});
