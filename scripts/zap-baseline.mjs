// OWASP ZAP baseline scan (spider + passive scan) against the running web app and gate service.
// Fails on any High (or Critical) alert. Writes zap-report.json and zap-report.html.
//
//   pnpm security:zap            # uses a local ZAP install (zap.sh on PATH)
//   pnpm security:zap --docker   # uses the official ghcr.io/zaproxy/zaproxy image (CI)
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, root } from "./lib.mjs";

const env = loadEnv();
const WEB = process.env.ZAP_TARGET ?? env.WEB_URL ?? "http://localhost:3000";
const GATE = env.GATE_PUBLIC_URL ?? "http://localhost:4000";
const RISK = { 0: "Informational", 1: "Low", 2: "Medium", 3: "High" };

if (process.argv.includes("--docker")) {
  // zap-baseline.py exits 1 on FAIL (High by default config), 2 on WARN only.
  const r = spawnSync(
    "docker",
    ["run", "--rm", "--network", "host", "-v", `${root}:/zap/wrk:rw`, "ghcr.io/zaproxy/zaproxy:stable", "zap-baseline.py", "-t", WEB, "-J", "zap-report.json", "-r", "zap-report.html", "-c", "zap-baseline.conf", "-I"],
    { stdio: "inherit" },
  );
  process.exit(r.status === 2 ? 0 : (r.status ?? 1));
}

const PORT = 8090;
const api = async (path) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  if (!res.ok) throw new Error(`ZAP ${path} -> ${res.status}`);
  return path.startsWith("/OTHER") ? res.text() : res.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const zap = spawn("zap.sh", ["-daemon", "-host", "127.0.0.1", "-port", String(PORT), "-config", "api.disablekey=true", "-config", "api.addrs.addr.name=127.0.0.1", "-dir", mkdtempSync(join(tmpdir(), "zap-"))], { stdio: "ignore" });
const stop = async () => {
  await api("/JSON/core/action/shutdown/").catch(() => zap.kill());
};

try {
  for (let i = 0; ; i++) {
    try {
      await api("/JSON/core/view/version/");
      break;
    } catch {
      if (i > 120) throw new Error("ZAP did not start");
      await sleep(1000);
    }
  }
  console.log(`ZAP is up. Spidering ${WEB} and ${GATE}…`);
  for (const target of [WEB, `${WEB}/login`, `${WEB}/signup`, `${GATE}/healthz`, `${GATE}/mcp`]) {
    await api(`/JSON/core/action/accessUrl/?url=${encodeURIComponent(target)}&followRedirects=true`).catch(() => undefined);
  }
  const { scan } = await api(`/JSON/spider/action/scan/?url=${encodeURIComponent(WEB)}&maxChildren=50&recurse=true`);
  for (;;) {
    const { status } = await api(`/JSON/spider/view/status/?scanId=${scan}`);
    if (Number(status) >= 100) break;
    await sleep(1000);
  }
  for (;;) {
    const { recordsToScan } = await api("/JSON/pscan/view/recordsToScan/");
    if (Number(recordsToScan) === 0) break;
    await sleep(1000);
  }

  const alerts = [];
  for (const base of [WEB, GATE]) alerts.push(...(await api(`/JSON/core/view/alerts/?baseurl=${encodeURIComponent(base)}&start=0&count=5000`)).alerts);
  const byKey = new Map();
  for (const a of alerts) {
    const k = `${a.pluginId}|${a.name}`;
    const risk = { Informational: 0, Low: 1, Medium: 2, High: 3 }[a.risk] ?? Number(a.riskcode ?? 0);
    const e = byKey.get(k) ?? { name: a.name, pluginId: a.pluginId, risk, urls: new Set() };
    e.urls.add(a.url);
    byKey.set(k, e);
  }
  const rows = [...byKey.values()].sort((a, b) => b.risk - a.risk);
  writeFileSync(join(root, "zap-report.json"), JSON.stringify(rows.map((r) => ({ ...r, risk: RISK[r.risk], urls: [...r.urls] })), null, 2));
  writeFileSync(join(root, "zap-report.html"), await api("/OTHER/core/other/htmlreport/"));

  console.log("\nZAP baseline results");
  for (const r of rows) console.log(`  ${RISK[r.risk].padEnd(13)} ${r.name} (${r.pluginId}), ${r.urls.size} URL${r.urls.size === 1 ? "" : "s"}`);
  const high = rows.filter((r) => r.risk >= 3);
  console.log(`\n${high.length ? `✖ ${high.length} High finding(s).` : "✓ No High or Critical findings."} Reports: zap-report.html, zap-report.json`);
  await stop();
  process.exit(high.length ? 1 : 0);
} catch (e) {
  console.error(e.message);
  await stop();
  process.exit(1);
}
