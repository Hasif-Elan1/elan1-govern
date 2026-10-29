import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CODE_LABELS,
  detectBundleProfile,
  generateKeyPair,
  keyFingerprint,
  parseRulebookYaml,
  publicKeyFromPrivate,
  readEvidenceFile6,
  reportSections,
  rulebookToYaml,
  signRulebook,
  verifyBundle6,
  verifyEvidenceFile,
  verifyRulebook,
  type VerifyBundleResult,
} from "@gate/core";

const HELP = `govern — offline tools for Elan1 Govern evidence and rulebooks

  govern verify <bundle.zip> [--key public.pem]   Check every receipt, link and signature
  govern verify <bundle> [--fingerprint fp] [--profile id|none] [--report]
                                                A Seal v6 evidence bundle (ZIP or JSON): one of six
                                                result codes; exit 0 only for a pass
  govern sign <rulebook.yaml> --key private.pem [--out file]
                                                Validate and sign a rulebook
  govern keygen [--out-dir dir]                   Create an Ed25519 key pair

No account or network needed.`;

type Out = (line: string) => void;

/** Flags that take no value. */
const SWITCHES = new Set(["--report"]);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * A Seal v6 bundle (the console's elan1.evidence.bundle.v1, or its auditor-pack/1): the six-code verifier. Prints
 * the result code with its plain-English line and the verdict; --report prints the nine-section report.
 */
function verifySealV6(bytes: Uint8Array, rest: string[], out: Out, err: Out): number {
  if (rest.includes("--key")) {
    err("USAGE (exit 5): Usage error");
    err("  --key is for L1 bundles. For a Seal v6 bundle, pass --fingerprint with the key fingerprint you obtained from the organisation.");
    return 5;
  }
  const missing = ["--fingerprint", "--profile"].find((f) => rest.includes(f) && (flag(rest, f) === undefined || flag(rest, f)!.startsWith("--")));
  if (missing) {
    err("USAGE (exit 5): Usage error");
    err(`  ${missing} needs a value.`);
    return 5;
  }
  let input: unknown;
  try {
    input = readEvidenceFile6(bytes);
  } catch (e) {
    err("USAGE (exit 5): Usage error");
    err(`  The bundle could not be read: ${(e as Error).message}`);
    return 5;
  }
  const fingerprint = flag(rest, "--fingerprint");
  const profile = flag(rest, "--profile");
  const r = verifyBundle6(input, { ...(fingerprint !== undefined ? { expectedFingerprint: fingerprint } : {}), ...(profile !== undefined ? { profileId: profile } : {}) });
  const say = r.exitCode === 0 ? out : err;
  for (const line of summaryLines(r)) say(line);
  if (rest.includes("--report")) {
    const manifest = (input && typeof input === "object" && "manifest" in input && input.manifest && typeof input.manifest === "object" ? input.manifest : {}) as Parameters<typeof reportSections>[1];
    for (const sec of reportSections(r, manifest, { profileChecked: profile ?? "claimed" })) {
      say("");
      say(`${sec.n}. ${sec.title.toUpperCase()}  ${sec.text}`);
      for (const l of sec.lines) say(`   ${l.label}: ${l.value}`);
    }
  }
  return r.exitCode;
}

function summaryLines(r: VerifyBundleResult): string[] {
  const lines = [`${r.code} (exit ${r.exitCode}): ${CODE_LABELS[r.code]}`, `  ${r.headline}`];
  if (r.org) lines.push(`  organisation: ${r.org}`);
  if (r.fingerprint) lines.push(`  key fingerprint: ${r.fingerprint} (${r.keySource === "supplied" ? "checked against --fingerprint" : "taken from the bundle; pass --fingerprint to check it"})`);
  const first = r.sections.find((s) => s.state === "fail" || s.state === "incomplete");
  if (r.exitCode !== 0 && first) lines.push(`  ${first.number}. ${first.title}: ${first.detail}`);
  return lines;
}

export async function main(argv: string[], out: Out = console.log, err: Out = console.error): Promise<number> {
  const [cmd, ...rest] = argv;
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1]?.startsWith("--") && !SWITCHES.has(rest[i - 1]!)));

  if (cmd === "verify") {
    const file = positional[0];
    if (!file || !existsSync(file)) {
      err("Usage: govern verify <bundle> [--key public.pem] [--fingerprint fp] [--profile id|none] [--report]");
      return 2;
    }
    const bytes = new Uint8Array(readFileSync(file));
    if (detectBundleProfile(bytes) === "seal-v6") return verifySealV6(bytes, rest, out, err);
    const keyFile = flag(rest, "--key");
    const r = verifyEvidenceFile(bytes, keyFile ? { expectedPublicKeyPem: readFileSync(keyFile, "utf8") } : {});
    if (r.ok) {
      out(`Chain intact: ${r.count} receipts`);
      if (r.count) out(`  receipts ${r.firstSeq}–${r.lastSeq}, ${r.checkpoints} signed checkpoint${r.checkpoints === 1 ? "" : "s"}`);
      if ("org" in r && r.org) out(`  organisation: ${r.org}`);
      if ("fingerprint" in r && r.fingerprint) out(`  key fingerprint: ${r.fingerprint}`);
      if ("keys" in r && r.keys && r.keys.length > 1) {
        out(`  signing keys: ${r.keys.map((k) => `${k.kid} (${k.retiredAt ? `retired ${k.retiredAt.slice(0, 10)}` : "current"})`).join(", ")}`);
      }
      return 0;
    }
    err(r.seq !== null ? `Chain broken at receipt ${r.seq}: ${r.reason}` : `Not verified: ${r.reason}`);
    return 1;
  }

  if (cmd === "sign") {
    const file = positional[0];
    const keyFile = flag(rest, "--key");
    if (!file || !keyFile) {
      err("Usage: govern sign <rulebook.yaml> --key private.pem [--out file]");
      return 2;
    }
    const parsed = parseRulebookYaml(readFileSync(file, "utf8"));
    if (!parsed.ok) {
      err("The rulebook has problems:");
      for (const e of parsed.errors) err(`  - ${e}`);
      return 1;
    }
    const privateKeyPem = readFileSync(keyFile, "utf8");
    const { signature: _old, ...unsigned } = parsed.rulebook;
    const signed = signRulebook(unsigned, privateKeyPem);
    if (!verifyRulebook(signed, publicKeyFromPrivate(privateKeyPem))) {
      err("Signing failed: the signature does not verify.");
      return 1;
    }
    const dest = flag(rest, "--out") ?? file;
    writeFileSync(dest, rulebookToYaml(signed));
    out(`Signed version ${signed.version} for ${signed.agent} → ${dest}`);
    out(`  key fingerprint: ${keyFingerprint(publicKeyFromPrivate(privateKeyPem))}`);
    return 0;
  }

  if (cmd === "keygen") {
    const dir = resolve(flag(rest, "--out-dir") ?? ".");
    const priv = resolve(dir, "gate-key.pem");
    const pub = resolve(dir, "gate-key.pub.pem");
    if (existsSync(priv)) {
      err(`${priv} already exists; not overwriting it.`);
      return 1;
    }
    const k = generateKeyPair();
    writeFileSync(priv, k.privateKeyPem, { mode: 0o600 });
    chmodSync(priv, 0o600);
    writeFileSync(pub, k.publicKeyPem);
    out(`Private key: ${priv} (keep it secret)`);
    out(`Public key:  ${pub}`);
    out(`Fingerprint: ${keyFingerprint(k.publicKeyPem)}`);
    return 0;
  }

  out(HELP);
  return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 2;
}
