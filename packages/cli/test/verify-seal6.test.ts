import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle6ToZip, writeBundleFiles, type EvidenceBundle } from "@gate/core";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { buildBundle6, orgKey } from "../../core/test/seal-v6-builder";

// Bundles the approved console's export code built (frozen in core's Seal v6 fixtures), with each organisation's
// published key fingerprint.
const real = JSON.parse(readFileSync(new URL("../../core/test/fixtures/seal-v6/real-bundles.json", import.meta.url), "utf8")) as Record<string, { bundle: EvidenceBundle; fingerprint: string }>;
const northbank = real.northbank!;
const demo = real.demo!;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function capture() {
  const lines: string[] = [];
  const errs: string[] = [];
  return { lines, errs, out: (l: string) => lines.push(l), err: (l: string) => errs.push(l) };
}

const dir = mkdtempSync(join(tmpdir(), "gate-cli-seal6-"));
let n = 0;
function file(content: Uint8Array | string, ext = "json") {
  const p = join(dir, `b${++n}.${ext}`);
  writeFileSync(p, content);
  return p;
}
async function run(...args: string[]) {
  const c = capture();
  const code = await main(["verify", ...args], c.out, c.err);
  return { code, out: c.lines.join("\n"), err: c.errs.join("\n") };
}

describe("govern verify, Seal v6 bundles", () => {
  it("passes a console-built L2 bundle, as JSON and as a ZIP of its members", async () => {
    for (const p of [file(JSON.stringify(northbank.bundle)), file(bundle6ToZip(northbank.bundle), "zip")]) {
      const pinned = await run(p, "--fingerprint", northbank.fingerprint);
      expect(pinned.code).toBe(0);
      expect(pinned.out.split("\n")[0]).toBe("PASS (exit 0): Pass");
      expect(pinned.out).toContain("organisation: Northbank Industrial Ltd");
      expect(pinned.out).toContain(`key fingerprint: ${northbank.fingerprint} (checked against --fingerprint)`);
      const unpinned = await run(p);
      expect(unpinned.code).toBe(0);
      expect(unpinned.out.split("\n")[0]).toBe("PASS_KEY_FROM_BUNDLE (exit 0): Pass — key taken from the bundle");
      expect(unpinned.out).toContain("pass --fingerprint to check it");
    }
  });

  it("passes the console's L1 auditor pack as internal evidence", async () => {
    const r = await run(file(bundle6ToZip(demo.bundle), "zip"));
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe("PASS_KEY_FROM_BUNDLE (exit 0): Pass — key taken from the bundle");
  });

  it("fails a tampered bundle with exit 1 and names the first failure", async () => {
    const b = clone(northbank.bundle);
    b.receipts[20]!.reason = "edited";
    const r = await run(file(bundle6ToZip(b), "zip"), "--fingerprint", northbank.fingerprint);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err.split("\n")[0]).toBe("FAIL_INTEGRITY (exit 1): Fail — integrity");
    expect(r.err).toMatch(/1\. Bundle and manifest: 1 member do not match the digest in the manifest: receipts\.jsonl\./);
  });

  it("answers a failing profile rule with exit 2", async () => {
    const r = await run(file(JSON.stringify(buildBundle6({ profileId: "iso42001-nist" }).bundle)), "--fingerprint", orgKey().fingerprint);
    expect(r.code).toBe(2);
    expect(r.err.split("\n")[0]).toBe("FAIL_PROFILE (exit 2): Fail — profile rules");
    expect(r.err).toContain("8. Profile rules:");
  });

  it("answers a missing member with exit 3, an unknown format or profile with 4", async () => {
    const noAnchors = clone(northbank.bundle);
    delete noAnchors.anchors;
    expect((await run(file(JSON.stringify(noAnchors)))).code).toBe(3);
    const future = clone(northbank.bundle);
    future.manifest.bundle_format = "elan1.evidence.bundle.v9";
    const r = await run(file(bundle6ToZip(future), "zip"));
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/^UNSUPPORTED \(exit 4\): Unsupported/);
    expect((await run(file(JSON.stringify(northbank.bundle)), "--profile", "in-nowhere")).code).toBe(4);
  });

  it("answers usage errors with exit 5", async () => {
    const p = file(JSON.stringify(northbank.bundle));
    const badFp = await run(p, "--fingerprint", "xyz");
    expect(badFp.code).toBe(5);
    expect(badFp.err).toMatch(/^USAGE \(exit 5\)/);
    expect((await run(file("{}"))).code).toBe(5);
    const noValue = await run(p, "--fingerprint");
    expect(noValue.code).toBe(5);
    expect(noValue.err).toContain("--fingerprint needs a value");
    expect((await run(p, "--profile", "--report")).code).toBe(5);
    const key = await run(p, "--key", p);
    expect(key.code).toBe(5);
    expect(key.err).toContain("--key is for L1 bundles");
    const broken = writeBundleFiles({ "manifest.json": JSON.stringify({ bundle_format: "elan1.evidence.bundle.v1" }), "receipts.jsonl": "{not json" });
    const unreadable = await run(file(broken, "zip"));
    expect(unreadable.code).toBe(5);
    expect(unreadable.err).toContain("The bundle could not be read");
  });

  it("prints the nine-section report with --report, whatever the flag's position", async () => {
    const p = file(JSON.stringify(northbank.bundle));
    for (const args of [[p, "--report", "--profile", "in-mca-audit-trail"], ["--report", p, "--profile", "in-mca-audit-trail"]]) {
      const r = await run(...args);
      expect(r.code).toBe(0);
      for (const title of ["1. VERDICT", "2. CLAIM", "3. SCOPE", "4. INTEGRITY", "5. CLAUSE RESULTS", "6. FIRST FAILURE", "7. NOTES", "8. LIMITS", "9. REPRODUCTION"]) expect(r.out).toContain(title);
      expect(r.out).toContain("Profile checked: in-mca-audit-trail");
    }
    const claimed = await run(file(JSON.stringify(real.northbank_rbi!.bundle)), "--report");
    expect(claimed.out).toContain("Profile claimed: in-rbi-collections v1.0");
    expect(claimed.out).not.toContain("Profile checked");
  });
});
