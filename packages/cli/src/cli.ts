import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  generateKeyPair,
  keyFingerprint,
  parseRulebookYaml,
  publicKeyFromPrivate,
  rulebookToYaml,
  signRulebook,
  verifyEvidenceFile,
  verifyRulebook,
} from "@gate/core";

const HELP = `gate — offline tools for Gate evidence and rulebooks

  gate verify <bundle.zip> [--key public.pem]   Check every receipt, link and signature
  gate sign <rulebook.yaml> --key private.pem [--out file]
                                                Validate and sign a rulebook
  gate keygen [--out-dir dir]                   Create an Ed25519 key pair

No account or network needed.`;

type Out = (line: string) => void;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(argv: string[], out: Out = console.log, err: Out = console.error): Promise<number> {
  const [cmd, ...rest] = argv;
  const positional = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));

  if (cmd === "verify") {
    const file = positional[0];
    if (!file || !existsSync(file)) {
      err("Usage: gate verify <bundle.zip> [--key public.pem]");
      return 2;
    }
    const keyFile = flag(rest, "--key");
    const r = verifyEvidenceFile(new Uint8Array(readFileSync(file)), keyFile ? { expectedPublicKeyPem: readFileSync(keyFile, "utf8") } : {});
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
      err("Usage: gate sign <rulebook.yaml> --key private.pem [--out file]");
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
