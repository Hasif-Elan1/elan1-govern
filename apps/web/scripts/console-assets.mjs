/**
 * Puts the console's build (apps/console/dist) into this app, so Next.js serves it on its own origin:
 *   - the start page → console-dist/index.html, served by app/console-shell with each request's CSP nonce;
 *   - every other file (/assets/…, /icons/…, /sw.js, /sw-assets.json, the manifest and logos) → public/.
 * Both are generated: they are git-ignored and replaced as a whole on every run.
 *
 *   node scripts/console-assets.mjs             copy (the console must be built)
 *   node scripts/console-assets.mjs --if-stale  build the console first if its sources are newer than its build,
 *                                               or its build is not a live one (VITE_DATA=mock)
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONSOLE = join(WEB, "..", "console");
const DIST = join(CONSOLE, "dist");
const PUBLIC = join(WEB, "public");
const SHELL_DIR = join(WEB, "console-dist");
const PLACEHOLDER = "__GOVERN_CSP_NONCE__";

function newest(path) {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let t = st.mtimeMs;
  for (const e of readdirSync(path)) t = Math.max(t, newest(join(path, e)));
  return t;
}

function stale() {
  const index = join(DIST, "index.html");
  if (!existsSync(index)) return "not built";
  // a mock build has no nonce placeholder: it would not run under this app's CSP, and it is not the real console
  if (!readFileSync(index, "utf8").includes(PLACEHOLDER)) return "built for the demonstration (VITE_DATA=mock)";
  const built = statSync(index).mtimeMs;
  const inputs = ["src", "public", "scripts", "index.html", "vite.config.ts", "package.json", "tailwind.config.js", "postcss.config.js"].map((p) => newest(join(CONSOLE, p)));
  return Math.max(...inputs) > built ? "sources changed" : undefined;
}

if (process.argv.includes("--if-stale")) {
  const why = stale();
  if (why) {
    console.log(`Building the console (${why})…`);
    execFileSync("pnpm", ["--filter", "@gate/console", "build:spa"], { stdio: "inherit", env: { ...process.env, VITE_DATA: "live" } });
  }
}

if (!existsSync(join(DIST, "index.html"))) {
  console.error("apps/console/dist is missing: build the console first (pnpm --filter @gate/console build).");
  process.exit(1);
}
if (!readFileSync(join(DIST, "index.html"), "utf8").includes(PLACEHOLDER)) {
  console.error("apps/console/dist is a demonstration build (VITE_DATA=mock). Build it for the real backend (the default) first.");
  process.exit(1);
}

rmSync(PUBLIC, { recursive: true, force: true });
rmSync(SHELL_DIR, { recursive: true, force: true });
mkdirSync(PUBLIC, { recursive: true });
mkdirSync(SHELL_DIR, { recursive: true });
for (const entry of readdirSync(DIST)) {
  if (entry === "index.html") continue;
  cpSync(join(DIST, entry), join(PUBLIC, entry), { recursive: true });
}
cpSync(join(DIST, "index.html"), join(SHELL_DIR, "index.html"));
console.log("The console's build is in apps/web (public/ and console-dist/).");
