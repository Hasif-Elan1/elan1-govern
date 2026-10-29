import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { entryModules, livePlan, planFromManifest, transformModule } from "../scripts/live-transform.mjs";
import { __live, type Impl, type OpInfo } from "../src/api/live/call";

// The live build's rewrite of the console's operation modules: which exports it wraps (from the server's own
// manifest), that the rewritten module still behaves as written (hoisting, internal calls, objects of operations),
// and that every call then goes through one entry point with the operation's name, kind and organisation index.

const dir = mkdtempSync(join(tmpdir(), "live-transform-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
/** Rewrite `code` with `plan` and import the result (the runtime import points at the real call.ts). */
async function load(code: string, plan: { fns: Map<string, OpInfo>; objects: Map<string, [string[], OpInfo][]> }) {
  const out = (transformModule(code, plan, "fixture.ts") as string).replace('"@/api/live/call"', JSON.stringify(join(__dirname, "../src/api/live/call.ts")));
  const file = join(dir, `m${seq++}.ts`);
  writeFileSync(file, out);
  return { out, mod: (await import(file)) as Record<string, unknown> };
}

const op = (name: string, async = false, org: number | null = 0): OpInfo => ({ name, async, org });
const fns = (...xs: [string, OpInfo][]) => ({ fns: new Map(xs), objects: new Map<string, [string[], OpInfo][]>() });

let calls: { op: OpInfo; args: unknown[] }[] = [];
beforeEach(() => {
  calls = [];
  __live.install({
    call(o: OpInfo, impl: Impl, args: unknown[], self: unknown) {
      calls.push({ op: o, args });
      return impl.apply(self, args);
    },
  });
});
afterAll(() => __live.install(undefined));

describe("the plan", () => {
  it("reads the entry's namespaces and named exports", () => {
    const m = entryModules(`export { settle } from './shims';\nexport { api } from '@/api';\nexport { x as y } from '@/z';\nexport * as work from '@/features/work/backend';\nexport type { OrgDB } from '@/mock/db';`);
    expect(m.get("api")).toEqual({ spec: "@/api", kind: "named", local: "api" });
    expect(m.get("y")).toEqual({ spec: "@/z", kind: "named", local: "x" });
    expect(m.get("work")).toEqual({ spec: "@/features/work/backend", kind: "namespace" });
    expect(m.has("OrgDB")).toBe(false);
  });

  it("places each operation in its file: the manifest's modules for namespaces, the entry for named exports", () => {
    const manifest = {
      modules: [{ prefix: "work", file: "src/features/work/backend.ts" }, { prefix: "keys", file: "src/mock/keys.ts", flatten: "keysApi" }],
      ops: [
        { name: "work.decide", path: ["work", "decide"], async: true, org: 0 },
        { name: "keys.state", path: ["keys", "state"], async: false, org: 0 },
        { name: "keys.rotate", path: ["keys", "keysApi", "rotate"], async: true, org: 0 },
        { name: "api.today", path: ["api", "today"], async: true, org: 0 },
        { name: "api.ops.note", path: ["api", "ops", "note"], async: false, org: null },
      ],
    };
    const plan = planFromManifest(manifest, entryModules(`export { api } from '@/api';`), (spec: string) => `R:${spec}`, (rel: string) => `F:${rel}`);
    expect([...plan.keys()].sort()).toEqual(["F:src/features/work/backend.ts", "F:src/mock/keys.ts", "R:@/api"]);
    expect(plan.get("F:src/features/work/backend.ts").fns.get("decide")).toEqual({ name: "work.decide", async: true, org: 0 });
    expect(plan.get("F:src/mock/keys.ts").objects.get("keysApi")).toEqual([[["rotate"], { name: "keys.rotate", async: true, org: 0 }]]);
    expect(plan.get("R:@/api").objects.get("api")).toEqual([
      [["today"], { name: "api.today", async: true, org: 0 }],
      [["ops", "note"], { name: "api.ops.note", async: false, org: null }],
    ]);
    expect(() => planFromManifest({ ops: [{ name: "nope.x", path: ["nope", "x"], async: false, org: null }] }, new Map(), () => "", () => "")).toThrow(/does not export/);
  });

  it("covers every operation of the real console, whose modules all rewrite", async () => {
    const { plan, manifest } = await livePlan(join(__dirname, ".."));
    const planned = [...plan.values()].reduce((n: number, p: { fns: Map<string, unknown>; objects: Map<string, unknown[]> }) => n + p.fns.size + [...p.objects.values()].reduce((m, l) => m + l.length, 0), 0);
    expect(planned).toBe(manifest.ops.length);
    const { readFileSync } = await import("node:fs");
    for (const [file, p] of plan) expect(() => transformModule(readFileSync(file, "utf8"), p, file)).not.toThrow();
  }, 60_000);
});

describe("the rewrite", () => {
  it("wraps function declarations, async ones and arrow constants, keeping hoisting and every line in place", async () => {
    const code = [
      "export const early = earlyCall();",
      "function earlyCall() { return decide('org_a', 'x'); }",
      "export function decide(orgId, id) { return `${orgId}:${id}:${helper()}`; }",
      "export async function load(orgId) { return decide(orgId, 'loaded'); }",
      "export const pick = (orgId, n) => n * 2;",
      "export const NOT_AN_OP = 7;",
      "function helper() { return 'h'; }",
    ].join("\n");
    const { out, mod } = await load(code, fns(["decide", op("work.decide")], ["load", op("work.load", true)], ["pick", op("work.pick")]));
    expect(out.split("\n")[2]).toContain("function decide__impl(orgId, id)");
    expect(out.split("\n")[3]).toContain("async function load__impl(orgId)");
    expect(out).not.toMatch(/export function decide__impl|export const pick__impl/);
    // the call made while the module was still loading ran (hoisted), through the wrapper
    expect(mod.early).toBe("org_a:x:h");
    expect(mod.NOT_AN_OP).toBe(7);
    calls = [];
    expect((mod.decide as (...a: unknown[]) => unknown)("org_b", "y")).toBe("org_b:y:h");
    await expect((mod.load as (...a: unknown[]) => Promise<unknown>)("org_c")).resolves.toBe("org_c:loaded:h");
    expect((mod.pick as (...a: unknown[]) => unknown)("org_d", 4)).toBe(8);
    expect(calls.map((c) => [c.op.name, c.op.async, c.op.org, c.args])).toEqual([
      ["work.decide", false, 0, ["org_b", "y"]],
      ["work.load", true, 0, ["org_c"]],
      // the module's own call to an operation goes through the wrapper too (the engine runs it inside the outer one)
      ["work.decide", false, 0, ["org_c", "loaded"]],
      ["work.pick", false, 0, ["org_d", 4]],
    ]);
  });

  it("wraps local export lists and re-exports", async () => {
    const lib = join(dir, "lib.ts");
    writeFileSync(lib, "export function token(orgId) { return `t-${orgId}`; }\nexport const other = 1;\n");
    const code = `function a(orgId) { return 'a' + orgId; }\nconst b = 2;\nexport { a as alpha, b };\nexport { token, other } from ${JSON.stringify(lib)};\n`;
    const { mod } = await load(code, fns(["alpha", op("m.alpha")], ["token", op("m.token")]));
    expect((mod.alpha as (o: string) => string)("1")).toBe("a1");
    expect((mod.token as (o: string) => string)("2")).toBe("t-2");
    expect(mod.b).toBe(2);
    expect(mod.other).toBe(1);
    expect(calls.map((c) => c.op.name)).toEqual(["m.alpha", "m.token"]);
  });

  it("wraps the methods of an operation object, copying a frozen namespace it holds", async () => {
    const code = [
      "const ns = Object.freeze({ __proto__: null, note(token) { return 'noted ' + token; }, keep: 1 });",
      "export const api = {",
      "  async today(orgId) { return { orgId, level: this.levelOf(orgId) }; },",
      "  levelOf(orgId) { return 'l1'; },",
      "  ops: ns,",
      "};",
    ].join("\n");
    const plan = { fns: new Map(), objects: new Map([["api", [[["today"], op("api.today", true)], [["levelOf"], op("api.levelOf")], [["ops", "note"], op("api.ops.note", false, null)]] as [string[], OpInfo][]]]) };
    const { mod } = await load(code, plan);
    const api = mod.api as { today: (o: string) => Promise<unknown>; ops: { note: (t: string) => string; keep: number } };
    await expect(api.today("org_a")).resolves.toEqual({ orgId: "org_a", level: "l1" });
    expect(api.ops.note("tk")).toBe("noted tk");
    expect(api.ops.keep).toBe(1);
    expect(calls.map((c) => [c.op.name, c.op.async, c.op.org])).toEqual([["api.today", true, 0], ["api.levelOf", false, 0], ["api.ops.note", false, null]]);
  });

  it("refuses a plan naming an operation the module does not export in a form it can wrap", () => {
    expect(() => transformModule("export const { a } = { a: () => 1 };", fns(["a", op("m.a")]), "bad.ts")).toThrow(/not exported in a form/);
    expect(() => transformModule("export function b() {}", fns(["missing", op("m.missing")]), "bad.ts")).toThrow(/missing/);
    expect(() => transformModule("const x = {};", { fns: new Map(), objects: new Map([["api", [[["x"], op("api.x")]]]]) }, "bad.ts")).toThrow(/api/);
  });

  it("runs each body as written while no engine is installed (the demonstration and the server)", async () => {
    __live.install(undefined);
    const { mod } = await load("export function f(orgId) { return orgId + '!'; }", fns(["f", op("m.f")]));
    expect((mod.f as (o: string) => string)("x")).toBe("x!");
    expect(calls).toEqual([]);
    expect(__live.installed()).toBe(false);
  });
});
