import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle6ToZip, type EvidenceBundle } from "@gate/core";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { buildRealBundle, flipDer, type TsaFixture } from "../../core/test/seal-v6-real-builder";

// A bundle of the artefacts the server produces: receipts from the organisation's real chain, seals over them, real
// RFC 3161 tokens from the gate's own local authorities (frozen in core's fixtures), the chain kid as the fingerprint.
const tsa = JSON.parse(readFileSync(new URL("../../core/test/fixtures/seal-v6-real/tsa.json", import.meta.url), "utf8")) as TsaFixture;
const built = buildRealBundle(tsa);
const kid = built.key.kid;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const dir = mkdtempSync(join(tmpdir(), "gate-cli-seal6-real-"));
let n = 0;
function file(content: Uint8Array | string, ext = "json") {
  const p = join(dir, `b${++n}.${ext}`);
  writeFileSync(p, content);
  return p;
}
async function run(...args: string[]) {
  const lines: string[] = [];
  const errs: string[] = [];
  const code = await main(["verify", ...args], (l) => lines.push(l), (l) => errs.push(l));
  return { code, out: lines.join("\n"), err: errs.join("\n") };
}

describe("govern verify, a bundle of real chain receipts and real timestamps", () => {
  it("passes pinned to the chain kid, as JSON and as a ZIP of its members", async () => {
    for (const p of [file(JSON.stringify(built.bundle)), file(bundle6ToZip(built.bundle), "zip")]) {
      const pinned = await run(p, "--fingerprint", kid);
      expect(pinned.code).toBe(0);
      expect(pinned.out.split("\n")[0]).toBe("PASS (exit 0): Pass");
      expect(pinned.out).toContain(`key fingerprint: ${kid} (checked against --fingerprint)`);
      const unpinned = await run(p);
      expect(unpinned.code).toBe(0);
      expect(unpinned.out.split("\n")[0]).toBe("PASS_KEY_FROM_BUNDLE (exit 0): Pass — key taken from the bundle");
    }
  });

  it("fails with exit 1 when a timestamp token's DER was changed", async () => {
    const b: EvidenceBundle = clone(built.bundle);
    b.anchors!.batches[0]!.tokens[0]!.der = flipDer(b.anchors!.batches[0]!.tokens[0]!.der!);
    const r = await run(file(JSON.stringify(built.resign(b))), "--fingerprint", kid);
    expect(r.code).toBe(1);
    expect(r.err.split("\n")[0]).toBe("FAIL_INTEGRITY (exit 1): Fail — integrity");
    expect(r.err).toContain("6. Anchors and timestamps: A timestamp token on batch b_1 does not verify.");
  });
});
