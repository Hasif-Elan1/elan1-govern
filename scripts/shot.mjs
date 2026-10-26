// Dev helper: screenshot a page, signing in first when SHOT_EMAIL is set.
//   SHOT_EMAIL=owner@demo.test SHOT_PASSWORD=... node scripts/shot.mjs http://localhost:3000/ out.png [width height scheme fullPage]
import { chromium } from "@playwright/test";

const [url, out, w = "1280", h = "860", scheme = "light", full = "0"] = process.argv.slice(2);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: +w, height: +h }, colorScheme: scheme, deviceScaleFactor: 1 });
const p = await ctx.newPage();
if (process.env.SHOT_EMAIL) {
  const base = new URL(url).origin;
  await p.goto(`${base}/login`);
  await p.fill("#email", process.env.SHOT_EMAIL);
  await p.fill("#password", process.env.SHOT_PASSWORD ?? "");
  await p.click("button[type=submit], form button");
  await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
}
await p.goto(url, { waitUntil: "networkidle" });
await p.waitForTimeout(400);
await p.screenshot({ path: out, fullPage: full === "1" });
await b.close();
