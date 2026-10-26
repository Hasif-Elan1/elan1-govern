// pnpm run setup: .env, dependencies, database, demo data. Safe to run again.
import { copyFileSync } from "node:fs";
import { ensureServices, existsSync, loadEnv, root, run } from "./lib.mjs";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`✖ Elan1 Govern needs Node 22.12 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
if (!existsSync(`${root}.env`)) {
  copyFileSync(`${root}.env.example`, `${root}.env`);
  console.log("→ created .env from .env.example");
}
const env = loadEnv();
const ci = process.argv.includes("--ci");

if (!ci) run("pnpm", ["install"]);
await ensureServices(env);
console.log("→ applying database migrations");
run("pnpm", ["--filter", "@gate/db", "exec", "prisma", "migrate", "deploy"], { env: { ...process.env, ...env } });
if (env.TEST_DATABASE_URL) {
  run("pnpm", ["--filter", "@gate/db", "exec", "prisma", "migrate", "deploy"], { env: { ...process.env, ...env, DATABASE_URL: env.TEST_DATABASE_URL } });
}
console.log("→ seeding the demo org");
run("pnpm", ["db:seed"], { env: { ...process.env, ...env } });
console.log(`\n✓ Ready. Run \`pnpm dev\`, then open ${env.WEB_URL || "http://localhost:3000"}\n`);
