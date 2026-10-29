/**
 * Connector operations for the Records door. The shared API has no calls for these yet, so they run here
 * against the organisation's database the same way the API does: validate, change, write a signed admin
 * receipt. A real backend replaces this file with API calls without touching the screens.
 *
 * Tool catalogue: rules match tags through the tool catalogue (TOOLS). Upstream and pack tools are registered
 * in it with the tags a person confirmed, so tag rules, "Try an action" and Activity see them.
 */
import type { Connector, ConnectorTool, PackId, RiskTag } from '@/types';
import { db } from '@/api';
import { TOOLS } from '@/mock/catalog';
import { doorState, pause, clone, recordChange } from '@/features/records/ext';
import { checkUpstreamUrl, serverSlug, upstreamUrlProblem } from './parts';
import { guardDestination, isSovereign } from '@/mock/sovereign';

/** Owners and admins of the organisation only (their member record decides: suspended or removed people cannot). */
function requireManager(orgId: string, userId: string) {
  const role = db.memberRole(orgId, userId);
  if (role !== 'owner' && role !== 'admin') throw new Error('Owners and admins can do this; your role cannot.');
}

const now = () => new Date().toISOString();
const isBuiltIn = (c: Pick<Connector, 'kind'>) => c.kind === 'gmail' || c.kind === 'zoho_books';
export const isPackConnector = (c: Pick<Connector, 'id'>) => c.id.startsWith('con_pack_');
export const packOfConnector = (c: Pick<Connector, 'id'>) => (isPackConnector(c) ? (c.id.slice('con_pack_'.length) as PackId) : undefined);

function find(orgId: string, id: string) {
  const c = db.getDB(orgId).connectors.find((x) => x.id === id);
  if (!c) throw new Error('This connector no longer exists in this organisation.');
  return c;
}

/* ── Tool catalogue ───────────────────────────────────────── */

/**
 * Put a connector's tools in this organisation's own catalogue (the guard and the rule evaluator read it; built-in
 * tools keep their fixed tags). The shared seeded catalogue is never changed, so one organisation's tags never
 * reach another.
 */
export function registerTools(orgId: string, c: Connector) {
  if (isBuiltIn(c)) return;
  const d = db.getDB(orgId);
  const st = doorState(orgId);
  const own = (d.toolDefs ??= {});
  for (const t of c.tools) {
    own[t.name] = { name: t.name, description: t.description, tags: t.tags.slice(), connector: c.id };
    if (!TOOLS.some((x) => x.name === t.name) && !st.registeredTools.includes(t.name)) st.registeredTools.push(t.name);
  }
}

/** Keep the catalogue in step with this organisation's connectors (call when its connectors load). */
export function syncCatalogue(orgId: string) {
  for (const c of db.getDB(orgId).connectors) registerTools(orgId, c);
}

/* ── Deriving tools from a server (deterministic, by what the server is for) ── */

const SERVER_KINDS: { match: RegExp; tools: [string, string][] }[] = [
  { match: /crm|sales|salesforce|hubspot/, tools: [['search_accounts', 'Search customer accounts'], ['get_contact', 'Read a customer contact'], ['update_opportunity', 'Update an opportunity stage and value'], ['export_contacts', 'Export contacts as CSV and email the file']] },
  { match: /hr|recruit|talent|hiring|people/, tools: [['list_candidates', 'List candidates for a role'], ['read_application', 'Read a job application and CV'], ['send_candidate_email', 'Email a candidate'], ['update_employee', 'Change an employee record']] },
  { match: /ticket|support|helpdesk|jira|freshdesk|zendesk/, tools: [['search_tickets', 'Search support tickets'], ['reply_ticket', 'Send a reply to the customer on a ticket'], ['close_ticket', 'Close a ticket'], ['delete_ticket', 'Delete a ticket']] },
  { match: /warehouse|inventory|stock|erp|sap/, tools: [['get_stock', 'Read stock levels for an item'], ['create_purchase_order', 'Create a purchase order'], ['adjust_stock', 'Adjust stock after a count'], ['delete_purchase_order', 'Delete a purchase order']] },
  { match: /pay|razorpay|stripe|billing|refund/, tools: [['get_payment', 'Read a payment'], ['create_refund', 'Refund a payment to the customer'], ['create_payout', 'Pay out to a beneficiary account'], ['list_settlements', 'List settlements']] },
  { match: /docs|drive|sharepoint|wiki|confluence|files/, tools: [['search_documents', 'Search documents'], ['read_document', 'Read a document'], ['share_document', 'Share a document with an outside address'], ['delete_document', 'Delete a document']] },
  { match: /deploy|infra|kubernetes|k8s|devops|ci/, tools: [['list_services', 'List running services'], ['read_logs', 'Read service logs'], ['deploy', 'Deploy a service to production'], ['grant_role', 'Grant a person a role on a cluster']] },
];
const GENERIC: [string, string][] = [['search', 'Search records'], ['get_record', 'Read one record'], ['create_record', 'Create a record'], ['update_record', 'Update a record']];

const WORDS: [RegExp, RiskTag][] = [
  [/search|list|get|read|lookup|fetch/, 'reads_data'],
  [/create|update|adjust|record|close|post|reply/, 'writes_data'],
  [/delete|remove|purge/, 'deletes'],
  [/pay|refund|payout|transfer|settle/, 'moves_money'],
  [/send|email|share|export|reply|sms|whatsapp|call/, 'sends_external'],
  [/contact|candidate|employee|application|customer|patient|borrower/, 'personal_data'],
  [/grant|role|permission|access/, 'changes_access'],
  [/deploy|migrate|restart/, 'changes_production'],
];

/** Suggested risk tags from a fixed word list over the tool's name and description. A person confirms them. */
export function suggestTags(name: string, description: string): RiskTag[] {
  const text = `${name} ${description}`.toLowerCase();
  const out: RiskTag[] = [];
  for (const [re, tag] of WORDS) if (re.test(text) && !out.includes(tag)) out.push(tag);
  return out;
}

/** The tools a server lists, derived from what its name and address say it is for. */
export function deriveTools(name: string, url: string): ConnectorTool[] {
  const slug = serverSlug(name);
  const text = `${name} ${url}`.toLowerCase();
  const kind = SERVER_KINDS.find((k) => k.match.test(text));
  return (kind?.tools ?? GENERIC).map(([tool, description]) => {
    const full = `${slug}.${tool}`;
    return { name: full, description, tags: [], suggestedTags: suggestTags(tool, description), enabled: false, calls7d: 0 };
  });
}

/* ── What a server lists today (for sync and drift) ───────── */

/** Upstream servers whose listing changed since they were connected (seeded drift, so sync has something to find). */
const DRIFT: Record<string, { changed?: Record<string, string>; added?: [string, string][] }> = {
  con_platform: { changed: { 'platform.deploy': 'Deploy a service to production, including database migrations' }, added: [['platform.rollback', 'Roll a service back to its previous release']] },
};

function currentListing(c: Connector): ConnectorTool[] {
  const pack = packOfConnector(c);
  if (pack) return PACK_CONNECTORS[pack].tools.map((t) => ({ ...t }));
  if (isBuiltIn(c)) {
    const listed = TOOLS.filter((t) => t.connector === c.id);
    return listed.length ? listed.map((t) => ({ name: t.name, description: t.description, tags: t.tags, enabled: true, calls7d: 0 })) : c.tools.map((t) => ({ ...t }));
  }
  const d = DRIFT[c.id];
  if (!d) return c.tools.map((t) => ({ ...t }));
  const base: ConnectorTool[] = c.tools.map((t) => ({ ...t, description: d.changed?.[t.name] ?? t.description }));
  for (const [name, description] of d.added ?? []) if (!base.some((t) => t.name === name)) base.push({ name, description, tags: [], suggestedTags: suggestTags(name, description), enabled: false, calls7d: 0 });
  return base;
}

export interface SyncDiff {
  connector: string;
  checked: number;
  changed: { tool: string; before: string; after: string }[];
  added: string[];
  removed: string[];
  switchedOff: string[];
  seq: number;
}

/** List the server's tools again, compare names and descriptions, switch off changed tools until a person reviews them. */
export async function syncConnector(orgId: string, id: string, userId: string): Promise<SyncDiff> {
  await pause(700, 1200);
  requireManager(orgId, userId);
  const c = find(orgId, id);
  if (c.status === 'disconnected') throw new Error('This connector is disconnected. Reconnect it before syncing.');
  if (c.status === 'error') {
    recordChange(orgId, userId, 'connector.sync_failed', { connector: c.name });
    throw new Error('The server did not answer. Nothing changed; its tools stay as they were.');
  }
  const listing = currentListing(c);
  const changed: SyncDiff['changed'] = [];
  const added: string[] = [];
  const switchedOff: string[] = [];
  for (const t of listing) {
    const mine = c.tools.find((x) => x.name === t.name);
    if (!mine) {
      c.tools.push({ ...t, tags: [], suggestedTags: t.suggestedTags ?? suggestTags(t.name, t.description), enabled: false, calls7d: 0 });
      added.push(t.name);
    } else if (mine.description !== t.description) {
      changed.push({ tool: t.name, before: mine.description, after: t.description });
      mine.description = t.description;
      mine.suggestedTags = suggestTags(t.name, t.description);
      if (mine.enabled) { mine.enabled = false; switchedOff.push(t.name); }
    }
  }
  const removed = c.tools.filter((t) => !listing.some((x) => x.name === t.name)).map((t) => t.name);
  c.tools = c.tools.filter((t) => !removed.includes(t.name));
  c.lastSyncAt = now();
  registerTools(orgId, c);
  const r = recordChange(orgId, userId, 'connector.synced', { connector: c.name, tools: c.tools.length, changed: changed.length, added: added.length, removed: removed.length, switched_off: switchedOff.length });
  return { connector: c.name, checked: listing.length, changed, added, removed, switchedOff, seq: r.seq };
}

/* ── Tags, credentials, address, lifecycle ────────────────── */

export async function setToolTags(orgId: string, id: string, tool: string, tags: RiskTag[], userId: string) {
  await pause();
  requireManager(orgId, userId);
  const c = find(orgId, id);
  if (isBuiltIn(c)) throw new Error('Built-in tools carry fixed risk tags.');
  const t = c.tools.find((x) => x.name === tool);
  if (!t) throw new Error(`No tool ${tool} on ${c.name}.`);
  t.tags = tags.slice();
  registerTools(orgId, c);
  recordChange(orgId, userId, 'tool.tags_changed', { connector: c.name, tool, tags: tags.join(',') || 'none' });
  return clone(c);
}

export interface LiveInput { clientId: string; secret: string; region: string; account: string }

/** The cloud host a built-in connector's live account is reached at (Gmail through Google, Zoho Books in the chosen data centre). */
export function cloudHostOf(c: Pick<Connector, 'kind'>, region?: string): string | undefined {
  if (c.kind === 'gmail') return 'gmail.googleapis.com';
  if (c.kind === 'zoho_books') return `www.zohoapis.${(region ?? 'zoho.in').replace(/^zoho\./, '') || 'in'}`;
  return undefined;
}

/** Connect a live account (the organisation's own OAuth app or API key), run a test listing, and switch the mode. */
export async function connectLive(orgId: string, id: string, input: LiveInput, userId: string) {
  await pause(900, 1500);
  requireManager(orgId, userId);
  const c = find(orgId, id);
  if (input.clientId.trim().length < 6) throw new Error('Enter the client ID of your own OAuth app (or API client).');
  if (input.secret.trim().length < 8) throw new Error('Enter the client secret or API key (at least 8 characters).');
  if (!input.account.trim()) throw new Error('Name the account or organisation to connect.');
  // Sovereign deny-all egress: Google Workspace and Zoho's cloud are outside the network. The test call is refused
  // and recorded as egress.blocked; guardDestination throws with the reason and the receipt.
  const cloud = cloudHostOf(c, input.region);
  if (cloud && isSovereign(orgId)) guardDestination(orgId, `https://${cloud}`, `Connectors (${c.name})`, userId);
  const listed = currentListing(c);
  const from = c.mode;
  c.mode = 'live';
  c.status = 'connected';
  c.region = input.region;
  c.authHeader = `OAuth client ${input.clientId.trim().slice(0, 6)}… · secret ••••••••${input.secret.trim().slice(-4)}`;
  c.connectedAt = now();
  c.lastSyncAt = now();
  if (isBuiltIn(c) && !c.name.includes('—')) c.name = `${c.name} — ${input.account.trim()}`;
  const r = recordChange(orgId, userId, 'connector.mode_changed', { connector: c.name, from, to: 'live', region: input.region, account: input.account.trim(), tools_listed: listed.length });
  return { connector: clone(c), toolsListed: listed.length, seq: r.seq };
}

export async function switchToDemo(orgId: string, id: string, userId: string) {
  await pause();
  requireManager(orgId, userId);
  const c = find(orgId, id);
  c.mode = 'demo';
  c.status = 'demo';
  recordChange(orgId, userId, 'connector.mode_changed', { connector: c.name, from: 'live', to: 'demo' });
  return clone(c);
}

export async function replaceCredential(orgId: string, id: string, headerName: string, secret: string, userId: string) {
  await pause(400, 800);
  requireManager(orgId, userId);
  const c = find(orgId, id);
  if (secret.trim().length < 8) throw new Error('Paste the new credential (at least 8 characters).');
  c.authHeader = `${headerName}: ${headerName === 'Authorization' ? 'Bearer ' : ''}••••••••${secret.trim().slice(-4)}`;
  if (c.status === 'error') c.status = 'connected';
  recordChange(orgId, userId, 'connector.credential_replaced', { connector: c.name, header: headerName });
  return clone(c);
}

export async function changeAddress(orgId: string, id: string, url: string, userId: string, opts: UrlOpts) {
  await pause(400, 800);
  requireManager(orgId, userId);
  const c = find(orgId, id);
  const err = checkUpstreamUrl(url, refuseOutside(orgId, url, opts, userId));
  if (err) throw new Error(err);
  const from = c.url ?? '';
  c.url = url.trim();
  recordChange(orgId, userId, 'connector.address_changed', { connector: c.name, from, to: c.url });
  return clone(c);
}

/** Disconnect: every tool is switched off, so calls to them are refused by default. */
export async function disconnect(orgId: string, id: string, reason: string, userId: string) {
  await pause(300, 600);
  requireManager(orgId, userId);
  const c = find(orgId, id);
  const on = c.tools.filter((t) => t.enabled).length;
  c.tools.forEach((t) => { t.enabled = false; });
  c.status = 'disconnected';
  recordChange(orgId, userId, 'connector.disconnected', { connector: c.name, tools_switched_off: on, reason: reason || 'not given' });
  return clone(c);
}

export async function reconnect(orgId: string, id: string, userId: string) {
  await pause(500, 900);
  requireManager(orgId, userId);
  const c = find(orgId, id);
  c.status = c.mode === 'demo' ? 'demo' : 'connected';
  c.lastSyncAt = now();
  recordChange(orgId, userId, 'connector.reconnected', { connector: c.name, tools_on: 0 });
  return clone(c);
}

/** Remove the connector. Its tools leave the catalogue; agents that named them are refused by default. */
export async function removeConnector(orgId: string, id: string, userId: string) {
  await pause(400, 700);
  requireManager(orgId, userId);
  const d = db.getDB(orgId);
  const c = find(orgId, id);
  if (isBuiltIn(c)) throw new Error('Built-in connectors can be disconnected but not removed.');
  d.connectors = d.connectors.filter((x) => x.id !== id);
  for (const a of d.agents) a.connectorIds = a.connectorIds.filter((x) => x !== id);
  const st = doorState(orgId);
  for (const t of c.tools) {
    if (d.toolDefs?.[t.name]?.connector === id) delete d.toolDefs[t.name];
    st.registeredTools = st.registeredTools.filter((x) => x !== t.name);
  }
  recordChange(orgId, userId, 'connector.removed', { connector: c.name, tools: c.tools.length });
}

/* ── Adding an MCP server ─────────────────────────────────── */

export interface UrlOpts { sovereign: boolean; allow: string[]; /** the organisation's own domain (optional: older callers omit it) */ domain?: string }

/**
 * Sovereign deny-all egress: a public MCP server address is refused, and the attempt is recorded as egress.blocked
 * (mock/sovereign.ts guardDestination throws with the reason and the receipt). Internal hosts pass through to the
 * usual address checks.
 */
function refuseOutside(orgId: string, url: string, given: UrlOpts, userId: string): UrlOpts {
  const opts = { ...given, domain: given.domain ?? db.getDB(orgId).org.domain };
  if (isSovereign(orgId) && upstreamUrlProblem(url, { ...opts, sovereign: true })?.egress) guardDestination(orgId, url.trim(), 'Connectors (MCP server)', userId);
  return opts;
}

export async function addUpstreamServer(orgId: string, input: { name: string; url: string; headerName: string; secret: string }, userId: string, opts: UrlOpts) {
  await pause(900, 1500);
  requireManager(orgId, userId);
  const err = checkUpstreamUrl(input.url, refuseOutside(orgId, input.url, opts, userId));
  if (err) throw new Error(err);
  const d = db.getDB(orgId);
  const slug = serverSlug(input.name);
  if (d.connectors.some((c) => serverSlug(c.name) === slug)) throw new Error('Another server already uses this name.');
  const c: Connector = {
    id: `con_${Date.now().toString(36)}`, kind: 'mcp_upstream', name: input.name.trim(), status: 'connected', mode: 'live', url: input.url.trim(),
    authHeader: `${input.headerName}: ${input.headerName === 'Authorization' ? 'Bearer ' : ''}••••••••${input.secret.trim().slice(-4)}`,
    connectedAt: now(), lastSyncAt: now(), heldCredential: true, tools: deriveTools(input.name, input.url),
  };
  d.connectors.push(c);
  registerTools(orgId, c);
  recordChange(orgId, userId, 'connector.added', { connector: c.name, tools: c.tools.length, enabled: 0, address: c.url! });
  return clone(c);
}

/* ── Sovereign: internal hosts allowed for upstream servers ── */

export function allowlist(orgId: string) {
  return clone(doorState(orgId).allowlist);
}

export async function setAllowlist(orgId: string, entries: string[], userId: string) {
  await pause();
  requireManager(orgId, userId);
  const clean = Array.from(new Set(entries.map((e) => e.trim().toLowerCase()).filter(Boolean)));
  for (const e of clean) {
    if (!/^(\*\.)?[a-z0-9.-]+$/.test(e) && !/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(e)) throw new Error(`“${e}” is not a host name, *.domain or an IPv4 address or CIDR range.`);
  }
  const st = doorState(orgId);
  st.allowlist = { entries: clean, updatedAt: now(), updatedBy: userId };
  recordChange(orgId, userId, 'connector.allowlist_updated', { entries: clean.length, list: clean.join(',').slice(0, 200) || 'empty' });
  return clone(st.allowlist);
}

/* ── Pack connectors (ledger1, invoice1, collect1) ────────── */

const tool = (name: string, description: string, tags: RiskTag[], enabled: boolean): ConnectorTool => ({ name, description, tags, enabled, calls7d: 0 });

export const PACK_CONNECTORS: Record<PackId, { name: string; purpose: string; tools: ConnectorTool[]; liveFields: { id: string; label: string; region: string[] } }> = {
  ledger1: {
    name: 'Tally Prime — audit-trail ledger (ledger1)',
    purpose: 'Vouchers and masters in the books, with the edit log the MCA audit trail needs (Rule 3(1)).',
    tools: [
      tool('tally.read_daybook', 'Read the day book and the voucher edit log', ['reads_data'], true),
      tool('tally.post_voucher', 'Post a sales, purchase, payment or journal voucher', ['writes_data', 'moves_money'], false),
      tool('tally.cancel_voucher', 'Cancel a voucher (a reversal entry, never a delete)', ['writes_data'], false),
      tool('tally.update_party', 'Change a customer or vendor master record', ['writes_data', 'personal_data'], false),
    ],
    liveFields: { id: 'Tally company name', label: 'Tally Prime server (ODBC/XML gateway)', region: ['On premises', 'Tally on AWS ap-south-1'] },
  },
  invoice1: {
    name: 'GST e-invoicing — Invoice Registration Portal (invoice1)',
    purpose: 'Register invoices with the IRP for an IRN, cancel within 24 hours, and check buyer GSTINs.',
    tools: [
      tool('gst.verify_gstin', 'Check a buyer GSTIN against the GST register', ['reads_data'], true),
      tool('irp.get_irn', 'Read an e-invoice by its IRN', ['reads_data'], true),
      tool('irp.generate_irn', 'Register an invoice with the IRP and get its IRN and signed QR code', ['writes_data', 'sends_external'], false),
      tool('irp.cancel_irn', 'Cancel an IRN (only within 24 hours of issue)', ['writes_data', 'deletes'], false),
    ],
    liveFields: { id: 'GSTIN', label: 'GST Suvidha Provider (GSP) API client', region: ['IRP 1 (einvoice1.gst.gov.in)', 'IRP 2 (einvoice2.gst.gov.in)'] },
  },
  collect1: {
    name: 'Collections contact gateway — dialler, SMS and WhatsApp (collect1)',
    purpose: 'Every borrower contact goes through here, so time of day, template and daily cap are checked first.',
    tools: [
      tool('collect.read_account', 'Read a borrower account, overdue days and contact consent', ['reads_data', 'personal_data'], true),
      tool('collect.send_sms', 'Send a reminder SMS from a DLT-registered template', ['sends_external', 'personal_data'], false),
      tool('collect.send_whatsapp', 'Send a WhatsApp reminder from an approved template', ['sends_external', 'personal_data'], false),
      tool('collect.place_call', 'Queue an outbound call through the dialler', ['sends_external', 'personal_data'], false),
      tool('collect.record_promise', 'Record a promise to pay', ['writes_data', 'personal_data'], false),
      tool('collect.send_final_notice', 'Send a final notice before recovery action', ['sends_external', 'personal_data'], false),
    ],
    liveFields: { id: 'Sender ID / DLT entity ID', label: 'Dialler and messaging provider API', region: ['India (Mumbai)', 'India (Chennai)'] },
  },
};

/** Make sure every installed pack has its connector (demo mode, tools tagged, writes switched off). */
export function ensurePackConnectors(orgId: string, userId = 'system'): string[] {
  const d = db.getDB(orgId);
  const added: string[] = [];
  for (const p of d.platform.packs) {
    const id = `con_pack_${p.id}`;
    if (d.connectors.some((c) => c.id === id)) continue;
    const def = PACK_CONNECTORS[p.id];
    if (!def) continue;
    const host = d.org.deployment === 'sovereign' ? `packs.${d.org.domain ?? `${d.org.slug}.in`}` : 'packs.elan1.ai';
    const c: Connector = { id, kind: 'mcp_upstream', name: def.name, status: 'demo', mode: 'demo', url: `https://${host}/${p.id}/mcp`, region: d.org.residency, connectedAt: now(), lastSyncAt: now(), heldCredential: true, tools: def.tools.map((t) => ({ ...t })) };
    d.connectors.push(c);
    registerTools(orgId, c);
    recordChange(orgId, userId, 'connector.added', { connector: c.name, pack: p.id, tools: c.tools.length, enabled: c.tools.filter((t) => t.enabled).length, mode: 'demo' });
    added.push(c.name);
  }
  return added;
}
