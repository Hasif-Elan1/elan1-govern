// pnpm dev: Elan1 Govern on :4000 and the web app on :3000, with prefixed logs.
import { spawn } from "node:child_process";
import { ensureServices, loadEnv, root } from "./lib.mjs";

const env = loadEnv();
await ensureServices(env);

const procs = [
  ["gate", ["--filter", "@gate/gate", "dev"], "\x1b[36m"],
  ["web ", ["--filter", "@gate/web", "dev"], "\x1b[35m"],
].map(([name, args, color]) => {
  const p = spawn("pnpm", args, { cwd: root, env: { ...process.env, ...env, FORCE_COLOR: "1" } });
  const tag = `${color}${name}\x1b[0m │ `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) out.write(`${tag}${l}\n`);
    });
  };
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on("exit", (code) => {
    console.log(`${tag}exited (${code})`);
    shutdown(code ?? 1);
  });
  return p;
});

console.log(`\n  Web   ${env.WEB_URL || "http://localhost:3000"}\n  Elan1 Govern  ${env.GATE_PUBLIC_URL || "http://localhost:4000"}/mcp\n  Mail  http://localhost:8025\n`);

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
