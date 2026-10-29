/**
 * Live builds (VITE_DATA=live): every console operation the server's RPC door runs goes through one entry point,
 * `__live.call` (src/api/live/call.ts), so the client can run it locally, send it to the server, or both.
 *
 * Which exports are operations, whether each is async and which file each namespace is come from the operation
 * manifest the server itself uses (scripts/op-manifest.mjs: `ops` and `modules`); the entry's named exports
 * (`export { api } from '@/api'`) from src/server/entry.ts. Nothing is listed twice. Each operation module is then
 * rewritten:
 *
 *  - an exported function `f` becomes `function f__impl` (same place, same lines), and a wrapper is appended:
 *      export function f(...__args) { return __live.call("work.f", f__impl, __args, this, 1, 0); }
 *    Function declarations stay hoisted, which the mock's import cycles need. `export async function`,
 *    `export const f = …` and `export { f }` / `export { f } from "…"` are handled the same way;
 *  - an exported object of operations (`api`, `orgApi` …) keeps its shape: its methods are wrapped at the end of the
 *    module with `__live.wrap(api, [...])`, nested objects included (`api.ops`, `api.records` …).
 *
 * An operation the plan names but the module does not export stops the build: a gap would silently run locally.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

/** The runtime the wrappers call; imports nothing, so it is ready before any operation module runs. */
export const RUNTIME = '@/api/live/call';

/**
 * The modules src/server/entry.ts exposes: export name → { spec, kind, local }. `namespace` for
 * `export * as work from '…'`; `named` for `export { api } from '…'` (local: the module's own name for it).
 */
export function entryModules(source) {
  const sf = ts.createSourceFile('entry.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out = new Map();
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || st.isTypeOnly || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const clause = st.exportClause;
    if (clause && ts.isNamespaceExport(clause)) out.set(clause.name.text, { spec, kind: 'namespace' });
    else if (clause && ts.isNamedExports(clause)) {
      for (const el of clause.elements) {
        if (el.isTypeOnly) continue;
        out.set(el.name.text, { spec, kind: 'named', local: (el.propertyName ?? el.name).text });
      }
    }
  }
  return out;
}

/** Resolve an import specifier of the console (`@/…` or relative to src/server) to a source file. */
export function resolveSpec(spec, srcDir) {
  const base = spec.startsWith('@/') ? join(srcDir, spec.slice(2)) : resolve(join(srcDir, 'server'), spec);
  for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.(ts|tsx)$/.test(p) && existsSync(p)) return p;
  }
  throw new Error(`src/server/entry.ts exports ${spec}, which does not resolve to a source file.`);
}

/**
 * The rewrite plan: source file → { fns: Map<export, op>, objects: Map<export, [path, op][]> }, where op is
 * { name, async, org }. Built from the manifest's operation paths ([entryExport, moduleExport, …properties]).
 *
 * Which file an operation lives in: the manifest's `modules` (prefix → file, for each `export * as X` namespace of
 * the entry) where it lists the operation's prefix; otherwise the entry's own exports (`export { api } from '@/api'`,
 * from entryModules). `resolveFile(spec)` turns an entry specifier into a file, `rootFile(rel)` a manifest file.
 */
export function planFromManifest(manifest, modules, resolveFile, rootFile = (rel) => rel) {
  const plan = new Map();
  const byPrefix = new Map((manifest.modules ?? []).map((m) => [m.prefix, m]));
  const forFile = (file) => {
    let p = plan.get(file);
    if (!p) plan.set(file, (p = { fns: new Map(), objects: new Map() }));
    return p;
  };
  for (const op of manifest.ops) {
    const [entryName, ...rest] = op.path;
    const listed = byPrefix.get(op.name.split('.')[0]);
    const mod = listed ? { kind: 'namespace' } : modules.get(entryName);
    if (!mod) throw new Error(`${op.name}: the manifest names ${entryName}, which src/server/entry.ts does not export.`);
    const file = listed ? rootFile(listed.file) : resolveFile(mod.spec);
    // a namespace's first step is the module's export; a named export is the module's export itself
    const exportName = mod.kind === 'namespace' ? rest[0] : mod.local;
    const props = mod.kind === 'namespace' ? rest.slice(1) : rest;
    if (!exportName) throw new Error(`${op.name}: no export to wrap.`);
    const info = { name: op.name, async: !!op.async, org: op.org ?? null };
    const p = forFile(file);
    if (!props.length) p.fns.set(exportName, info);
    else {
      const list = p.objects.get(exportName) ?? [];
      list.push([props, info]);
      p.objects.set(exportName, list);
    }
  }
  return plan;
}

const hasExport = (node) => !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const hasDefault = (node) => !!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
const exportKeyword = (node) => node.modifiers.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** Text edits applied back to front, so the positions of earlier ones still hold. */
function applyEdits(code, edits) {
  let out = code;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

const lit = (v) => JSON.stringify(v);
const call = (impl, op) => `return __live.call(${lit(op.name)}, ${impl}, __args, this, ${op.async ? 1 : 0}, ${op.org === null ? 'null' : op.org});`;
const wrapper = (exported, impl, op) => `export function ${exported}(...__args) { ${call(impl, op)} }`;
/** For `export { local as name }`: the local binding stays (it may be an import of the same name); the export moves. */
const listWrapper = (exported, impl, op) => `function ${exported}__live(...__args) { ${call(impl, op)} }\nexport { ${exported}__live as ${exported} };`;

/**
 * Rewrite one operation module. `code` is the module's JavaScript or TypeScript; `plan` its entry from
 * planFromManifest. Lines are kept where they are (wrappers are appended), so stack traces still point home.
 */
export function transformModule(code, plan, file = 'module.ts') {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.ES2022, true, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = [];
  const imports = [];
  const appended = [];
  const done = new Set();
  /** Local name of each exported object, for the wraps. */
  const locals = new Map();

  const removeKeyword = (node) => {
    const kw = exportKeyword(node);
    let end = kw.end;
    while (code[end] === ' ') end++;
    edits.push({ start: kw.getStart(sf), end, text: '' });
  };

  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && hasExport(st) && !hasDefault(st)) {
      const name = st.name.text;
      const op = plan.fns.get(name);
      if (!op || !st.body) continue; // overload signatures have no body; the implementation is the one to wrap
      removeKeyword(st);
      edits.push({ start: st.name.getStart(sf), end: st.name.end, text: `${name}__impl` });
      appended.push(wrapper(name, `${name}__impl`, op));
      done.add(name);
    } else if (ts.isVariableStatement(st) && hasExport(st)) {
      const decls = st.declarationList.declarations;
      let ops = 0;
      for (const d of decls) {
        if (!ts.isIdentifier(d.name)) continue;
        const name = d.name.text;
        locals.set(name, name);
        const op = plan.fns.get(name);
        if (!op) continue;
        ops++;
        edits.push({ start: d.name.getStart(sf), end: d.name.end, text: `${name}__impl` });
        appended.push(wrapper(name, `${name}__impl`, op));
        done.add(name);
      }
      // the impl stays module-private unless the statement also exports something that is not an operation
      if (ops && ops === decls.length) removeKeyword(st);
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly && st.exportClause && ts.isNamedExports(st.exportClause)) {
      const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
      const keep = [];
      let changed = false;
      for (const el of st.exportClause.elements) {
        const exported = el.name.text;
        const local = (el.propertyName ?? el.name).text;
        if (!from) locals.set(exported, local);
        const op = el.isTypeOnly ? undefined : plan.fns.get(exported);
        if (!op) { keep.push(el.getText(sf)); continue; }
        changed = true;
        done.add(exported);
        if (from) {
          imports.push(`import { ${local} as ${exported}__impl } from ${lit(from)};`);
          appended.push(listWrapper(exported, `${exported}__impl`, op));
        } else {
          appended.push(listWrapper(exported, local, op));
        }
      }
      if (changed) {
        const text = keep.length ? `export { ${keep.join(', ')} }${from ? ` from ${lit(from)}` : ''};` : '';
        edits.push({ start: st.getStart(sf), end: st.end, text });
      }
    } else if ((ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st)) && st.name && hasExport(st)) {
      locals.set(st.name.text, st.name.text);
    }
  }

  const missing = [...plan.fns.keys()].filter((n) => !done.has(n));
  if (missing.length) throw new Error(`${file}: the operations ${missing.join(', ')} are not exported in a form the live build can wrap.`);

  for (const [exported, list] of plan.objects) {
    const local = locals.get(exported);
    if (!local) throw new Error(`${file}: the operation object ${exported} is not a local export, so its methods cannot be wrapped.`);
    const entries = list.map(([path, op]) => `[${lit(path)}, ${lit(op.name)}, ${op.async ? 1 : 0}, ${op.org === null ? 'null' : op.org}]`);
    appended.push(`__live.wrap(${local}, [${entries.join(', ')}]);`);
  }

  const head = `import { __live } from ${lit(RUNTIME)};${imports.length ? ` ${imports.join(' ')}` : ''} `;
  // the import goes on the first line, so every original line keeps its number
  return `${head}${applyEdits(code, edits)}\n/* live build: console operations (scripts/live-transform.mjs) */\n${appended.join('\n')}\n`;
}

/** Everything the Vite plugin needs, read once: the console root's entry and manifest → plan by absolute file. */
export async function livePlan(consoleRoot) {
  const { readFileSync } = await import('node:fs');
  const { buildManifest } = await import('./op-manifest.mjs');
  const src = join(consoleRoot, 'src');
  const modules = entryModules(readFileSync(join(src, 'server/entry.ts'), 'utf8'));
  const manifest = buildManifest();
  const plan = planFromManifest(manifest, modules, (spec) => resolveSpec(spec, src), (rel) => {
    const file = join(consoleRoot, rel);
    if (!existsSync(file)) throw new Error(`The operation manifest lists ${rel}, which does not exist.`);
    return file;
  });
  return { plan, manifest, files: [...plan.keys()].map((f) => resolve(f)), root: dirname(src) };
}
