import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { TENANT_MODELS } from "../src/tenant";

const ROOT = join(__dirname, "../../..");
const SCAN = ["apps/gate/src", "apps/web/src", "packages/connectors/src", "packages/sdk/src", "packages/cli/src"];

function files(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(files(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

describe("tenant isolation", () => {
  it("no app code touches a tenant table on the raw client", () => {
    const models = [...TENANT_MODELS, "Org"].map((m) => m[0]!.toLowerCase() + m.slice(1)).join("|");
    // The raw client is `prisma` (or `deps.db` in the gate service). Scoped clients come from forOrg().
    const raw = new RegExp(`\\b(?:prisma|deps\\.db|ctx\\.db)\\s*\\.\\s*(?:${models})\\b`);
    const offenders: string[] = [];
    for (const dir of SCAN) {
      for (const f of files(join(ROOT, dir))) {
        readFileSync(f, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (raw.test(line)) offenders.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the scan itself catches a raw tenant query", () => {
    const models = [...TENANT_MODELS, "Org"].map((m) => m[0]!.toLowerCase() + m.slice(1)).join("|");
    const raw = new RegExp(`\\b(?:prisma|deps\\.db|ctx\\.db)\\s*\\.\\s*(?:${models})\\b`);
    expect(raw.test("await prisma.receipt.findMany()")).toBe(true);
    expect(raw.test("await deps.db.approval.update()")).toBe(true);
    expect(raw.test("await prisma.consoleState.findMany()")).toBe(true);
    expect(raw.test("await prisma.user.findFirst()")).toBe(false);
    expect(raw.test("await forOrg(id).receipt.findMany()")).toBe(false);
  });
});
