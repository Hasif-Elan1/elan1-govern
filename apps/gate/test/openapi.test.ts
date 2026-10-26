import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openApiSpec, openApiText } from "../src/openapi";
import { makeApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  ctx = await makeApp();
});
afterAll(() => ctx.app.close());

type Obj = Record<string, unknown>;
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** A light structural check of an OpenAPI 3.1 document: the parts tools rely on. */
function problems(doc: Obj): string[] {
  const out: string[] = [];
  if (typeof doc.openapi !== "string" || !/^3\.1\.\d+$/.test(doc.openapi)) out.push("openapi must be 3.1.x");
  const info = doc.info as Obj | undefined;
  if (!info || typeof info.title !== "string" || typeof info.version !== "string") out.push("info.title and info.version are required");
  const paths = doc.paths as Record<string, Obj> | undefined;
  if (!paths || typeof paths !== "object") out.push("paths is required");
  const schemes = ((doc.components as Obj | undefined)?.securitySchemes ?? {}) as Obj;
  const opIds = new Set<string>();
  for (const [path, item] of Object.entries(paths ?? {})) {
    if (!path.startsWith("/")) out.push(`${path}: paths start with /`);
    const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const [method, op] of Object.entries(item)) {
      if (!METHODS.includes(method)) {
        out.push(`${path}: unknown key ${method}`);
        continue;
      }
      const o = op as Obj;
      const where = `${method.toUpperCase()} ${path}`;
      if (typeof o.operationId === "string") {
        if (opIds.has(o.operationId)) out.push(`${where}: duplicate operationId`);
        opIds.add(o.operationId);
      }
      const responses = o.responses as Obj | undefined;
      if (!responses || !Object.keys(responses).length) out.push(`${where}: needs responses`);
      for (const [code, r] of Object.entries(responses ?? {})) {
        if (!/^([1-5]\d\d|[1-5]XX|default)$/.test(code)) out.push(`${where}: bad response code ${code}`);
        if (typeof (r as Obj).description !== "string") out.push(`${where} ${code}: needs a description`);
      }
      const params = (o.parameters ?? []) as Obj[];
      for (const name of templated) {
        if (!params.some((p) => p.in === "path" && p.name === name && p.required === true)) out.push(`${where}: path parameter ${name} must be declared and required`);
      }
      for (const p of params) if (!["query", "header", "path", "cookie"].includes(String(p.in))) out.push(`${where}: bad parameter location`);
      for (const s of (o.security ?? doc.security ?? []) as Obj[]) for (const k of Object.keys(s)) if (!(k in schemes)) out.push(`${where}: unknown security scheme ${k}`);
    }
  }
  // Every $ref points at something in this document.
  const walk = (v: unknown, at: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}/${i}`));
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Obj)) {
      if (k === "$ref" && typeof x === "string") {
        const target = x.startsWith("#/") ? x.slice(2).split("/").reduce<unknown>((acc, part) => (acc as Obj | undefined)?.[part], doc) : undefined;
        if (target === undefined) out.push(`${at}: unresolved $ref ${x}`);
      } else walk(x, `${at}/${k}`);
    }
  };
  walk(doc, "#");
  return out;
}

describe("OpenAPI", () => {
  it("is a valid OpenAPI 3.1 document covering the agent API and MCP", () => {
    const spec = openApiSpec() as unknown as Obj;
    expect(problems(spec)).toEqual([]);
    expect(Object.keys(spec.paths as Obj).sort()).toEqual(["/mcp", "/v1/approvals/{id}", "/v1/check", "/v1/openapi.json", "/v1/record"]);
    const schemas = (spec.components as Obj).schemas as Obj;
    expect(Object.keys(schemas)).toEqual(expect.arrayContaining(["CheckRequest", "CheckResponse", "RecordRequest", "RecordResponse", "ApprovalStatus", "Error"]));
    expect(JSON.stringify(spec)).not.toContain('"$schema"');
    const mcp = (spec.paths as Record<string, Obj>)["/mcp"]!.post as Obj;
    expect((mcp["x-mcp-tools"] as { name: string }[]).map((t) => t.name)).toContain("gate.approval_status");
  });

  it("the structural check catches mistakes", () => {
    expect(problems({ openapi: "3.0.0", paths: { x: { get: { responses: {} } }, "/a/{id}": { post: { responses: { "200": {} }, parameters: [{ in: "body" }], security: [{ nope: [] }] }, foo: {} } }, info: {}, z: { $ref: "#/nowhere" } })).toEqual([
      "openapi must be 3.1.x",
      "info.title and info.version are required",
      "x: paths start with /",
      "GET x: needs responses",
      "POST /a/{id} 200: needs a description",
      "POST /a/{id}: path parameter id must be declared and required",
      "POST /a/{id}: bad parameter location",
      "POST /a/{id}: unknown security scheme nope",
      "/a/{id}: unknown key foo",
      "#/z: unresolved $ref #/nowhere",
    ]);
  });

  it("the checked-in docs/openapi.json matches the code (run: pnpm --filter @gate/gate openapi)", () => {
    expect(readFileSync(join(__dirname, "../../../docs/openapi.json"), "utf8")).toBe(openApiText());
  });

  it("is served without auth at /v1/openapi.json", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.json()).toMatchObject({ openapi: "3.1.0", servers: [{ url: ctx.deps.env.GATE_PUBLIC_URL }] });
  });
});
