import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { signRequest } from "@gate/core";
import { runDemoAgent, type DemoStep } from "./agent";

// `pnpm demo`: run the scripted AP agent against a running Elan1 Govern.

function loadDotEnv() {
  const file = resolve(import.meta.dirname, "../../../../.env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1] as string] === undefined) process.env[m[1] as string] = (m[2] as string).replace(/^"(.*)"$/, "$1");
  }
}

const tty = process.stdout.isTTY;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const WORD: Record<DemoStep["decision"], string> = { allow: c("32", "allowed"), ask: c("33", "waiting"), refuse: c("31", "refused"), error: c("31", "error  ") };

async function main() {
  loadDotEnv();
  const gate = process.env.GATE_PUBLIC_URL ?? "http://localhost:4000";
  const key = process.env.DEMO_AGENT_KEY;
  if (!key) {
    console.error("DEMO_AGENT_KEY is not set. Copy .env.example to .env and run `pnpm run setup` first.");
    process.exit(1);
  }
  const wait = !process.argv.includes("--no-wait");

  // Fresh mock mailbox and ledger, so the demo can be run again and again (dev only).
  if (process.env.INTERNAL_API_SECRET) {
    const path = "/internal/demo/reset";
    const res = await fetch(`${gate}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-gate-signature": signRequest(process.env.INTERNAL_API_SECRET, "POST", path, "{}") },
      body: "{}",
    }).catch(() => null);
    if (!res) {
      console.error(`Cannot reach Elan1 Govern at ${gate}. Start it with \`pnpm dev\`.`);
      process.exit(1);
    }
  }

  console.log(`\n${c("1", "Elan1 Govern demo")} · AP agent → ${gate}/mcp\n`);
  const steps = await runDemoAgent({
    url: `${gate}/mcp`,
    apiKey: key,
    waitForApproval: wait,
    onApproval: (url) => {
      console.log(`${c("33", "   Waiting for you.")} Sign in as the owner and approve it:\n   ${c("4", url)}`);
      if (wait) console.log(`   ${c("2", "(watching for a decision; Ctrl+C to stop)")}`);
    },
    onStep: (s) => {
      const label = s.label.padEnd(48);
      const extra = s.detail && s.step !== 3 ? c("2", `  ${s.detail}`) : s.step === 3 && s.detail && !s.detail.startsWith("http") ? c("2", `  ${s.detail}`) : "";
      console.log(`${c("2", String(s.step))}  ${label} ${WORD[s.decision]}  ${c("2", s.rule)}${extra}`);
    },
  });

  const expected: DemoStep["decision"][] = ["allow", "allow", "ask", "refuse", "refuse"];
  const ok = steps.length === 5 && steps.every((s, i) => s.decision === expected[i]);
  console.log(ok ? `\n${c("32", "All 5 steps behaved as the rulebook says.")} See them in Activity: ${process.env.WEB_URL ?? "http://localhost:3000"}/activity\n` : `\n${c("31", "Some steps did not match the expected decisions.")}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
