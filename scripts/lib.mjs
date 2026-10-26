import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";

export const root = new URL("..", import.meta.url).pathname;

export function loadEnv() {
  const env = {};
  for (const line of readFileSync(`${root}.env`, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return env;
}

export function has(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

export function portOpen(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.once("timeout", () => (s.destroy(), resolve(false)));
  });
}

export async function waitForPort(host, port, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await portOpen(host, port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) {
    console.error(`\n✖ ${cmd} ${args.join(" ")} failed`);
    process.exit(r.status ?? 1);
  }
}

export function dbAddress(url) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 5432) };
}

/** Start Postgres and Mailpit with Docker when they are not already running. */
export async function ensureServices(env) {
  const db = dbAddress(env.DATABASE_URL);
  const needDb = !(await portOpen(db.host, db.port));
  const needMail = !(await portOpen(env.SMTP_HOST || "localhost", Number(env.SMTP_PORT || 1025)));
  if ((needDb || needMail) && has("docker")) {
    const services = [needDb && "postgres", needMail && "mailpit"].filter(Boolean);
    console.log(`→ starting ${services.join(" and ")} with docker compose`);
    spawnSync("docker", ["compose", "up", "-d", ...services], { stdio: "inherit", cwd: root });
    // Compose services are on the default ports; expose them to the host.
  } else if (needMail && has("mailpit")) {
    console.log("→ starting mailpit");
    spawn("mailpit", ["--smtp", `0.0.0.0:${env.SMTP_PORT || 1025}`, "--listen", "0.0.0.0:8025"], { stdio: "ignore", detached: true }).unref();
  }
  if (!(await waitForPort(db.host, db.port, needDb ? 60 : 2))) {
    console.error(`✖ Postgres is not reachable at ${db.host}:${db.port}. Start it, or install Docker and run again.`);
    process.exit(1);
  }
  if (needMail && !(await waitForPort(env.SMTP_HOST || "localhost", Number(env.SMTP_PORT || 1025), 10))) {
    console.warn("! Mailpit is not running, so approval emails will not be delivered. The approval page still works.");
  }
}

export { existsSync };
