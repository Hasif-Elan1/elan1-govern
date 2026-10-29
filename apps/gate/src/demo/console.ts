import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { attachIssuedKey, guardSyncChanges, guardSyncPayload, issuedSecret, signRequest, type ConsoleDocView, type ConsoleDomainFacts, type GuardSyncPayload } from "@gate/core";
import { consoleState, forOrg, prisma } from "@gate/db";
import type { DemoStep } from "./agent";

// `pnpm demo --console`: real traffic for the approved console. In Demo Traders (org_demo) it issues a sandbox key
// to invoice-bot with the console's own operation, on the organisation's stored console document, and applies it
// to the guard the way the web app does (the same message to POST /internal/orgs/org_demo/console-sync). Then an
// agent holding only that key makes MCP calls through the running gate that the console's seeded rulebook allows,
// holds for the Finance group, and refuses. The held call appears on the console's Approvals screen.

const ORG = "org_demo";
const AGENT = "invoice-bot";
const ADMIN = "u_rahul"; // Rahul Menon, Platform Lead (admin)

interface Domain {
  db: {
    setPersistence(p: { load(orgId: string): unknown; save(orgId: string): void } | undefined): void;
    getDB(orgId: string): unknown;
    peekDB(orgId: string): unknown;
    dropFromMemory(orgId: string): void;
    setActiveOrg(orgId: string): void;
    exportDoc(orgId: string): (Record<string, unknown> & { savedAt?: number }) | undefined;
    orgToolDefs(orgId: string): { name: string; description?: string; tags: string[]; connector: string }[];
    toolTagsIn(d: unknown, tool: string): string[] | undefined;
  };
  settle(): Promise<boolean>;
  api: { approverGroups(orgId: string): { id: string; name: string; members: string[] }[]; allowedApprovers(orgId: string, id: string): string[]; setToolEnabled(orgId: string, connectorId: string, tool: string, enabled: boolean, userId: string): Promise<unknown> };
  agents: { issueKey(orgId: string, slug: string, input: { label: string; environment: "sandbox" }, userId: string): Promise<{ secret: string; key: { prefix: string } }> };
  work: { namedLists(orgId: string): Record<string, string[]> };
}

type ViewDoc = ConsoleDocView & { connectors: { id: string; tools: { name: string; enabled?: boolean }[] }[] };

function facts(domain: Domain): ConsoleDomainFacts {
  const d = domain.db.getDB(ORG);
  return {
    groups: domain.api.approverGroups(ORG),
    tools: domain.db.orgToolDefs(ORG).map((t) => ({ ...t, tags: domain.db.toolTagsIn(d, t.name) ?? t.tags })),
    lists: domain.work.namedLists(ORG),
    allowedApprovers: (id) => domain.api.allowedApprovers(ORG, id),
  };
}

/** One console operation on the stored document, saved and applied to the guard, as the web app runs it. */
async function consoleOp<T>(domain: Domain, gate: string, secretOf: (r: T) => unknown, op: () => Promise<T>): Promise<T> {
  return consoleState.withLock(ORG, async (tx) => {
    const row = await consoleState.load(ORG, tx);
    const stored = row ? (JSON.parse(row.json) as Record<string, unknown>) : undefined;
    domain.db.setPersistence({ load: () => (stored ? structuredClone(stored) : undefined), save: () => undefined });
    // always from the stored document: the web app may have saved since
    domain.db.dropFromMemory(ORG);
    domain.db.getDB(ORG);
    domain.db.setActiveOrg(ORG);
    const before = stored ? guardSyncPayload(stored as unknown as ConsoleDocView, { ...facts(domain), allowedApprovers: () => [] }) : undefined;
    const result = await op();
    await domain.settle();
    const { savedAt: _savedAt, ...doc } = domain.db.exportDoc(ORG)!;
    const version = await consoleState.save(ORG, JSON.stringify(doc), row?.version ?? 0, tx);
    const after = guardSyncPayload(domain.db.peekDB(ORG) as ConsoleDocView, facts(domain));
    const secret = issuedSecret(secretOf(result));
    if (secret && !attachIssuedKey(after, before, secret)) throw new Error("The new key could not be matched to its agent.");
    const payload: GuardSyncPayload = { ...after, actor: ADMIN, changes: guardSyncChanges(before, after) };
    const path = `/internal/orgs/${ORG}/console-sync`;
    const body = JSON.stringify(payload);
    const res = await fetch(`${gate}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-gate-signature": signRequest(process.env.INTERNAL_API_SECRET!, "POST", path, body) }, body });
    const out = (await res.json().catch(() => ({}))) as { error?: string; keys?: { created: string[] } };
    if (res.status !== 200) throw new Error(`The guard did not take the console's change (${res.status} ${out.error ?? ""}).`);
    if (secret && !out.keys?.created.length) throw new Error("The guard did not register the new key.");
    await consoleState.notify({ orgId: ORG, kind: "agent", version }).catch(() => undefined);
    return result;
  });
}

export async function runConsoleDemo(opts: { gate: string; internal: string; web: string; wait: boolean; onStep: (s: DemoStep) => void; onApproval: (url: string) => void; log: (line: string) => void }): Promise<DemoStep[]> {
  const bundle = resolve(import.meta.dirname, "../../../console/dist-server/domain.mjs");
  if (!existsSync(bundle)) throw new Error("The console's domain is not built. Run `pnpm --filter @gate/console build:server` first.");
  if (!process.env.INTERNAL_API_SECRET) throw new Error("INTERNAL_API_SECRET is not set. Copy .env.example to .env first.");
  if (!(await forOrg(ORG).org.findFirst({ select: { id: true } }))) throw new Error("Demo Traders (org_demo) is not in the database. Run `pnpm db:seed` with DEMO_CONSOLE_PASSWORD set.");
  const domain = (await import(pathToFileURL(bundle).href)) as Domain;

  // the console's own operations: switch on zoho_books.delete_bill (so the rulebook's no-deletes rule decides it), then issue a sandbox key
  const zoho = ((await consoleState.load(ORG)) ? (JSON.parse((await consoleState.load(ORG))!.json) as ViewDoc) : undefined)?.connectors.find((c) => c.id === "con_zoho");
  if (!zoho || zoho.tools.find((t) => t.name === "zoho_books.delete_bill")?.enabled !== true) {
    await consoleOp(domain, opts.internal, () => undefined, () => domain.api.setToolEnabled(ORG, "con_zoho", "zoho_books.delete_bill", true, ADMIN));
    opts.log("Switched on zoho_books.delete_bill in the console, so invoice-bot's no-deletes rule decides it.");
  }
  const issued = await consoleOp(domain, opts.internal, (r) => r, () => domain.agents.issueKey(ORG, AGENT, { label: `pnpm demo --console ${new Date().toISOString().slice(0, 16)}`, environment: "sandbox" }, ADMIN));
  opts.log(`Issued sandbox key ${issued.key.prefix}… to ${AGENT} in the console; the guard knows it by its hash only.`);

  const client = new Client({ name: "invoice-bot-demo", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${opts.gate}/mcp`), { requestInit: { headers: { authorization: `Bearer ${issued.secret}` } } }));
  const steps: DemoStep[] = [];
  type Gate = { decision?: DemoStep["decision"]; rule_id?: string; approval_id?: string; status?: string; ref?: string | null; outcome?: { ref?: string } };
  const meta = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })) as { structuredContent?: { gate?: Gate } }).structuredContent?.gate ?? {};
  const step = (n: number, label: string, g: Gate, detail?: string) => {
    const s: DemoStep = { step: n, label, decision: g.decision ?? "error", rule: g.rule_id ?? "?", ...(detail ? { detail } : {}) };
    steps.push(s);
    opts.onStep(s);
  };
  try {
    const read = await meta("gmail.read_inbox", { query: "invoice" });
    step(1, "Read the accounts-payable inbox", read, read.ref ?? undefined);
    const small = await meta("zoho_books.record_payment", { amount: 18000, vendor: "northwind", bill: "NW-1187" });
    step(2, "Pay ₹18,000 to Northwind (an approved vendor)", small, small.ref ?? undefined);
    const large = await meta("zoho_books.record_payment", { amount: 240000, vendor: "Northwind Traders", bill: "NW-2291" });
    let detail: string | undefined;
    if (large.approval_id) {
      opts.onApproval(`${opts.web}/approvals/${large.approval_id}`);
      if (opts.wait) {
        const until = Date.now() + 30 * 60_000;
        for (;;) {
          const st = await meta("gate.approval_status", { approval_id: large.approval_id, wait_seconds: 30 });
          if (st.status && st.status !== "pending") {
            detail = `${st.status}${st.outcome?.ref ? ` · ${st.outcome.ref}` : ""}`;
            break;
          }
          if (Date.now() > until) {
            detail = "still waiting; stopped watching";
            break;
          }
        }
      } else detail = `approval ${large.approval_id}`;
    }
    step(3, "Pay ₹2,40,000 to Northwind Traders for NW-2291", large, detail);
    step(4, "Delete a bill in Zoho Books", await meta("zoho_books.delete_bill", { bill_id: "bill_1187" }));
    step(5, "Pay ₹18,000 to a vendor not on the approved list", await meta("zoho_books.record_payment", { amount: 18000, vendor: "Unknown Traders" }));
  } finally {
    await client.close();
    await prisma.$disconnect();
  }
  return steps;
}
