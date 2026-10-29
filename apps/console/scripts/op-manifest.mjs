/**
 * The operation manifest for the server's RPC door: every operation src/server/entry.ts exposes, read with the
 * TypeScript compiler API. For each one it records the dotted name the client calls (`api.decide`,
 * `work.reauth`, `orgApi.changeRole` …), the export path to the function, its parameter names, the index of
 * its organisation parameter and the indexes of its actor parameters ("who is acting"). The server overwrites
 * every actor position, and every actor property of an object parameter, with the signed-in user.
 *
 * Run by scripts/build-server.mjs; `node scripts/op-manifest.mjs` prints a summary.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'src/server/entry.ts');

/** Parameter names that hold an organisation id (when their type is a string). */
export const ORG_PARAMS = ['orgId', 'org'];
/**
 * Parameter (and input property) names that name the person acting. Beyond the usual ones, reading every
 * operation's signature found `byUserId` (api.approvalLink). Names of a person acted upon or named by the caller
 * (`memberId`, `issuedTo`, `approverId`, `reviewerId`, `requesterId`, `forUser`, `to` …) are never overwritten.
 */
export const ACTOR_PARAMS = ['userId', 'by', 'actorId', 'actor', 'requestedBy', 'decidedBy', 'who', 'byUserId'];

/**
 * What the entry exports, and how each export becomes operations. `object`: the methods of one exported object
 * (and of the nested objects named in `nested`). `module`: a module namespace's exported functions, with the
 * methods of the object named in `flatten` merged in under the same prefix.
 */
const SOURCES = [
  { prefix: 'api', kind: 'object', exportName: 'api', nested: ['ops', 'records', 'billingDesk'] },
  { prefix: 'orgApi', kind: 'module', exportName: 'orgApi', flatten: 'orgApi' },
  { prefix: 'work', kind: 'module', exportName: 'work' },
  { prefix: 'agents', kind: 'module', exportName: 'agents' },
  { prefix: 'assessments', kind: 'module', exportName: 'assessments' },
  { prefix: 'sovereign', kind: 'module', exportName: 'sovereign', flatten: 'sovereignApi' },
  { prefix: 'deployment', kind: 'module', exportName: 'deployment', flatten: 'deploymentApi' },
  // modules screens call directly; every exported function of each is an operation (a read, or a write that
  // checks the caller's role itself)
  { prefix: 'connectors', kind: 'module', exportName: 'connectors' },
  { prefix: 'tokens', kind: 'module', exportName: 'tokens' },
  { prefix: 'inventory', kind: 'module', exportName: 'inventory' },
  { prefix: 'packs', kind: 'module', exportName: 'packs' },
  { prefix: 'keys', kind: 'module', exportName: 'keys', flatten: 'keysApi' },
  { prefix: 'devpath', kind: 'module', exportName: 'devpath', flatten: 'devpathApi' },
  { prefix: 'recordsDecl', kind: 'module', exportName: 'recordsDecl', flatten: 'declApi' },
  { prefix: 'records', kind: 'module', exportName: 'records' },
  { prefix: 'billing', kind: 'module', exportName: 'billing' },
  { prefix: 'approvalsExt', kind: 'module', exportName: 'approvalsExt' },
  { prefix: 'maintenance', kind: 'module', exportName: 'maintenance' },
  { prefix: 'ops', kind: 'module', exportName: 'ops' },
  { prefix: 'notices', kind: 'module', exportName: 'notices' },
  { prefix: 'consoleOps', kind: 'module', exportName: 'consoleOps' },
];

/**
 * Namespaces entry.ts exports that are not operation modules: the document store the server drives itself, and the
 * console's chain verifier, which the server and its tests call directly (never over RPC).
 */
const NOT_OPS = ['db', 'chainVerifier'];

function program() {
  const cfgPath = join(ROOT, 'tsconfig.json');
  const cfg = ts.getParsedCommandLineOfConfigFile(cfgPath, { noEmit: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
  if (!cfg) throw new Error(`Cannot read ${cfgPath}`);
  return ts.createProgram({ rootNames: [ENTRY], options: cfg.options });
}

const isStringy = (checker, t) => {
  const parts = t.isUnion() ? t.types : [t];
  const named = parts.filter((p) => !(p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
  return named.length > 0 && named.every((p) => p.flags & ts.TypeFlags.StringLike);
};

/** One call signature → the parameter facts the server needs. */
function describe(name, checker, sig, at) {
  const params = sig.getParameters().map((p, index) => {
    const decl = p.valueDeclaration ?? p.declarations?.[0];
    const type = checker.getTypeOfSymbolAtLocation(p, decl ?? at);
    const optional = !!decl && ts.isParameter(decl) && (!!decl.questionToken || !!decl.initializer || !!decl.dotDotDotToken);
    const rest = !!decl && ts.isParameter(decl) && !!decl.dotDotDotToken;
    // actor properties of an input object written in the signature (e.g. input.decidedBy). Named record types
    // (an Approval or a Member handed to a read helper) carry their own history, which is not the caller.
    const props = [];
    const objectParts = (type.isUnion() ? type.types : [type]).filter((x) => x.flags & ts.TypeFlags.Object && x.getSymbol()?.declarations?.[0]?.kind === ts.SyntaxKind.TypeLiteral);
    for (const part of objectParts) {
      for (const prop of checker.getPropertiesOfType(part)) {
        if (!ACTOR_PARAMS.includes(prop.name)) continue;
        const pt = checker.getTypeOfSymbolAtLocation(prop, decl ?? at);
        if (isStringy(checker, pt) && !props.includes(prop.name)) props.push(prop.name);
      }
    }
    return { index, name: p.name, optional, rest, stringy: isStringy(checker, type), props };
  });
  // anything the server could not fill in or check stops the build, rather than reaching the client's control
  for (const p of params) {
    if (ACTOR_PARAMS.includes(p.name) && !p.stringy) throw new Error(`${name}: the parameter ${p.name} names who is acting but is not a string, so the server cannot fill it in.`);
  }
  if (params.filter((p) => ORG_PARAMS.includes(p.name)).length > 1 || params.some((p) => ORG_PARAMS.includes(p.name) && !p.stringy && p.name === 'orgId')) {
    throw new Error(`${name}: the organisation parameter is not one string, so the server cannot check membership.`);
  }
  const org = params.find((p) => ORG_PARAMS.includes(p.name) && p.stringy);
  return {
    params: params.map((p) => p.name),
    optional: params.filter((p) => p.optional).map((p) => p.index),
    org: org ? org.index : null,
    actors: params.filter((p) => ACTOR_PARAMS.includes(p.name) && p.stringy).map((p) => p.index),
    actorProps: params.filter((p) => p.props.length).map((p) => ({ index: p.index, props: p.props })),
    rest: params.some((p) => p.rest),
    async: isPromise(checker, sig.getReturnType()),
  };
}

function isPromise(checker, t) {
  const sym = t.getSymbol();
  return sym?.getName() === 'Promise';
}

/** The callable properties of a type, as [name, signature, declaration]. */
function callables(checker, type, at) {
  const out = [];
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    const t = checker.getTypeOfSymbolAtLocation(prop, decl ?? at);
    const sigs = t.getCallSignatures();
    if (sigs.length) out.push({ name: prop.name, sig: sigs[sigs.length - 1], decl, overloads: sigs.length, type: t });
    else out.push({ name: prop.name, type: t, decl });
  }
  return out;
}

export function buildManifest() {
  const prog = program();
  const checker = prog.getTypeChecker();
  const sf = prog.getSourceFile(ENTRY);
  if (!sf) throw new Error(`Cannot load ${ENTRY}`);
  const exportsOf = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(sf)).map((s) => [s.name, s]));
  // every `export * as X` namespace of the entry is an operation module: one left out of SOURCES would reach the
  // client as a module whose writes never get to the server
  // (`modules`: which source file each prefix is, for the client's live build, which forwards calls by file)
  const modules = [];
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.exportClause || !ts.isNamespaceExport(st.exportClause)) continue;
    const name = st.exportClause.name.text;
    if (NOT_OPS.includes(name)) continue;
    const src = SOURCES.find((s) => s.exportName === name);
    if (!src) throw new Error(`src/server/entry.ts exports the namespace ${name}, which scripts/op-manifest.mjs does not list in SOURCES.`);
    const spec = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : '';
    modules.push({ prefix: src.prefix, file: `${spec.replace(/^@\//, 'src/')}.ts`, ...(src.flatten ? { flatten: src.flatten } : {}) });
  }
  const ops = [];
  const seen = new Map();
  const add = (name, path, d, overloads) => {
    if (seen.has(name)) throw new Error(`Two operations are both called ${name}: ${seen.get(name).join('.')} and ${path.join('.')}`);
    // overloads could put the organisation or the actor at different positions: one signature per operation
    if (overloads > 1) throw new Error(`${name} has ${overloads} signatures; the server needs exactly one.`);
    seen.set(name, path);
    ops.push({ name, path, ...d });
  };

  for (const src of SOURCES) {
    const sym = exportsOf.get(src.exportName);
    if (!sym) throw new Error(`src/server/entry.ts does not export ${src.exportName}`);
    const resolved = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    const type = checker.getTypeOfSymbolAtLocation(resolved, sf);
    for (const m of callables(checker, type, sf)) {
      if (m.sig) {
        add(`${src.prefix}.${m.name}`, [src.exportName, m.name], describe(`${src.prefix}.${m.name}`, checker, m.sig, sf), m.overloads);
        continue;
      }
      const inner = src.kind === 'object' ? src.nested?.includes(m.name) : src.flatten === m.name;
      if (!inner) continue;
      for (const n of callables(checker, m.type, sf)) {
        if (!n.sig) continue;
        const name = src.kind === 'object' ? `${src.prefix}.${m.name}.${n.name}` : `${src.prefix}.${n.name}`;
        add(name, [src.exportName, m.name, n.name], describe(name, checker, n.sig, sf), n.overloads);
      }
    }
  }
  ops.sort((a, b) => a.name.localeCompare(b.name));
  return { generatedFrom: 'apps/console/src/server/entry.ts', orgParams: ORG_PARAMS, actorParams: ACTOR_PARAMS, modules, ops };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = buildManifest();
  const noOrg = m.ops.filter((o) => o.org === null);
  const noActor = m.ops.filter((o) => o.org !== null && !o.actors.length && !o.actorProps.length);
  console.log(`${m.ops.length} operations; ${noOrg.length} without an organisation parameter; ${noActor.length} with an organisation but no actor`);
  if (process.argv.includes('--list')) for (const o of m.ops) console.log(`${o.name}(${o.params.join(', ')}) org=${o.org} actors=${o.actors.join(',')}${o.actorProps.length ? ` props=${JSON.stringify(o.actorProps)}` : ''}${o.async ? '' : ' sync'}`);
}
