import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENESIS, buildBundle, buildReceipt, generateKeyPair, keyFingerprint, readBundleFiles, writeBundleFiles, type Receipt } from "@gate/core";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";

function capture() {
  const lines: string[] = [];
  const errs: string[] = [];
  return { lines, errs, out: (l: string) => lines.push(l), err: (l: string) => errs.push(l) };
}

const keys = generateKeyPair();
function bundle(n: number) {
  const receipts: Receipt[] = [];
  let head = GENESIS;
  for (let i = 0; i < n; i++) {
    const r = buildReceipt({ kind: "decision", tool: "gmail.search", decision: "allow", args_summary: { i } }, { org: "o", ts: "2026-10-26T00:00:00Z", head }, keys.privateKeyPem);
    receipts.push(r);
    head = { seq: r.seq, hash: r.hash };
  }
  return buildBundle({ org: { id: "o", name: "Acme" }, range: { from: "2026-10-26", to: "2026-10-26" }, anchor: GENESIS, receipts, checkpoints: [], publicKeyPem: keys.publicKeyPem, privateKeyPem: keys.privateKeyPem, generatedAt: "2026-10-26T00:00:00Z" });
}

describe("govern verify", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-cli-"));
  it("says the chain is intact", async () => {
    const file = join(dir, "ok.zip");
    writeFileSync(file, bundle(4));
    const c = capture();
    expect(await main(["verify", file], c.out, c.err)).toBe(0);
    expect(c.lines[0]).toBe("Chain intact: 4 receipts");
    expect(c.lines.join("\n")).toMatch(/organisation: Acme/);
    const pub = join(dir, "pub.pem");
    writeFileSync(pub, keys.publicKeyPem);
    expect(await main(["verify", file, "--key", pub], c.out, c.err)).toBe(0);
  });
  it("names the edited receipt", async () => {
    const files = readBundleFiles(bundle(4));
    files["receipts.jsonl"] = files["receipts.jsonl"]!.replace('"i":2', '"i":99');
    const file = join(dir, "bad.zip");
    writeFileSync(file, writeBundleFiles(files));
    const c = capture();
    expect(await main(["verify", file], c.out, c.err)).toBe(1);
    expect(c.errs[0]).toBe("Chain broken at receipt 3: receipt 3 was changed after it was written");
  });
  it("verifies a bundle that spans a key rotation, and rejects a retired key's late receipt", async () => {
    const next = generateKeyPair();
    const kidA = keyFingerprint(keys.publicKeyPem);
    const kidB = keyFingerprint(next.publicKeyPem);
    const make = (lateOldKey: boolean) => {
      const receipts: Receipt[] = [];
      let head = GENESIS;
      const add = (input: Parameters<typeof buildReceipt>[0], ts: string, k: { privateKeyPem: string }, kid: string) => {
        const r = buildReceipt(input, { org: "o", ts, head, kid }, k.privateKeyPem);
        receipts.push(r);
        head = { seq: r.seq, hash: r.hash };
      };
      add({ kind: "decision", tool: "gmail.search", decision: "allow" }, "2026-10-26T01:00:00.000Z", keys, kidA);
      add({ kind: "admin", actor: "o@x.in", action: "key.rotated", details: { old_kid: kidA, new_kid: kidB } }, "2026-10-26T02:00:00.000Z", keys, kidA);
      add({ kind: "decision", tool: "gmail.search", decision: "allow" }, "2026-10-26T03:00:00.000Z", lateOldKey ? keys : next, lateOldKey ? kidA : kidB);
      return buildBundle({
        org: { id: "o", name: "Acme" },
        range: { from: "2026-10-26", to: "2026-10-26" },
        anchor: GENESIS,
        receipts,
        checkpoints: [],
        publicKeyPem: next.publicKeyPem,
        privateKeyPem: next.privateKeyPem,
        publicKeys: [{ publicKeyPem: keys.publicKeyPem, retiredAt: "2026-10-26T02:00:00.000Z" }, { publicKeyPem: next.publicKeyPem }],
        generatedAt: "2026-10-26T04:00:00.000Z",
      });
    };
    const ok = join(dir, "rotated.zip");
    writeFileSync(ok, make(false));
    const c = capture();
    expect(await main(["verify", ok], c.out, c.err)).toBe(0);
    expect(c.lines.join("\n")).toContain(`signing keys: ${kidA} (retired 2026-10-26), ${kidB} (current)`);
    const bad = join(dir, "late.zip");
    writeFileSync(bad, make(true));
    expect(await main(["verify", bad], c.out, c.err)).toBe(1);
    expect(c.errs.at(-1)).toBe(`Chain broken at receipt 3: receipt 3 signed with key ${kidA} after it was retired`);
  });
  it("reports unreadable files and usage", async () => {
    const file = join(dir, "junk.zip");
    writeFileSync(file, "junk");
    const c = capture();
    expect(await main(["verify", file], c.out, c.err)).toBe(1);
    expect(c.errs[0]).toMatch(/^Not verified/);
    expect(await main(["verify"], c.out, c.err)).toBe(2);
    expect(await main(["verify", join(dir, "missing.zip")], c.out, c.err)).toBe(2);
  });
});

describe("govern keygen and sign", () => {
  it("creates keys, signs a rulebook, and refuses bad input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-cli-"));
    const c = capture();
    expect(await main(["keygen", "--out-dir", dir], c.out, c.err)).toBe(0);
    expect(statSync(join(dir, "gate-key.pem")).mode & 0o777).toBe(0o600);
    expect(await main(["keygen", "--out-dir", dir], c.out, c.err)).toBe(1);

    const rb = join(dir, "rb.yaml");
    writeFileSync(rb, "version: 3\nagent: ap-bot\nowner: a@b.in\ndefault: refuse\nrules:\n  - id: r\n    tool: gmail.search\n    decide: allow\n");
    expect(await main(["sign", rb, "--key", join(dir, "gate-key.pem")], c.out, c.err)).toBe(0);
    expect(readFileSync(rb, "utf8")).toMatch(/^signature: ed25519:/m);
    expect(await main(["sign", rb, "--key", join(dir, "gate-key.pem"), "--out", join(dir, "again.yaml")], c.out, c.err)).toBe(0);

    writeFileSync(rb, "version: 3\ndefault: allow\n");
    const bad = capture();
    expect(await main(["sign", rb, "--key", join(dir, "gate-key.pem")], bad.out, bad.err)).toBe(1);
    expect(bad.errs.join("\n")).toMatch(/default must be refuse/);
    expect(await main(["sign", rb], c.out, c.err)).toBe(2);
  });
  it("prints help", async () => {
    const c = capture();
    expect(await main([], c.out, c.err)).toBe(0);
    expect(c.lines[0]).toMatch(/^govern/);
    expect(await main(["nope"], c.out, c.err)).toBe(2);
  });
});

describe("govern staff", () => {
  it("refuses anything but add <email>, remove <email> or list, before it reads any database", async () => {
    for (const args of [["staff"], ["staff", "add"], ["staff", "add", "not-an-email"], ["staff", "promote", "a@b.in"], ["staff", "add", "a@b.in", "extra"], ["staff", "list", "a@b.in"]]) {
      const c = capture();
      expect(await main(args, c.out, c.err)).toBe(2);
      expect(c.errs.join("\n")).toMatch(/^Usage: govern staff add <email>/);
    }
  });
});
