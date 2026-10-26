import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface DemoStep {
  step: number;
  label: string;
  decision: "allow" | "ask" | "refuse" | "error";
  rule: string;
  detail?: string;
}

interface GateMeta {
  decision?: string;
  rule_id?: string;
  approval_id?: string;
  approval_url?: string;
  status?: string;
  ref?: string | null;
  outcome?: { ref?: string };
  message?: string;
}

type CallResult = { isError?: boolean; content?: unknown; structuredContent?: { gate?: GateMeta } };

/**
 * A scripted accounts-payable agent. It talks to Gate over MCP exactly like a real
 * agent would, and only knows its API key: never a Gmail or Zoho Books token.
 */
export async function runDemoAgent(opts: {
  url: string;
  apiKey: string;
  waitForApproval: boolean;
  log?: (line: string) => void;
  onStep?: (s: DemoStep) => void;
  onApproval?: (url: string) => void;
  maxWaitMinutes?: number;
}): Promise<DemoStep[]> {
  const log = opts.log ?? (() => {});
  const client = new Client({ name: "ap-bot-demo", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), { requestInit: { headers: { authorization: `Bearer ${opts.apiKey}` } } });
  await client.connect(transport);
  const steps: DemoStep[] = [];
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallResult;
  const record = (s: DemoStep) => {
    steps.push(s);
    opts.onStep?.(s);
  };
  const meta = (r: CallResult) => r.structuredContent?.gate ?? {};
  const decisionOf = (r: CallResult): DemoStep["decision"] => (meta(r).decision as DemoStep["decision"]) ?? (r.isError ? "error" : "allow");
  const body = (r: CallResult) => {
    const c = r.content as { type: string; text?: string }[] | undefined;
    try {
      return JSON.parse(c?.[0]?.text ?? "null") as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  try {
    // 1. Find and read the invoice emails.
    const search = await call("gmail.search", { query: "invoice has:attachment" });
    const found = ((body(search)?.messages as { message_id: string }[] | undefined) ?? []).slice(0, 3);
    log(`found ${found.length} invoice emails`);
    let readAllowed = 0;
    let readRule = "read-mail";
    for (const m of found) {
      const r = await call("gmail.read_message", { message_id: m.message_id });
      if (decisionOf(r) === "allow") readAllowed++;
      readRule = meta(r).rule_id ?? readRule;
    }
    record({ step: 1, label: `Read ${found.length} invoice emails`, decision: readAllowed === found.length && found.length > 0 ? "allow" : "refuse", rule: readRule });

    // 2. A small payment: allowed.
    const small = await call("zoho.record_bill_payment", { bill_id: "bill_1187", amount_inr: 18000, reference: "NEFT demo" });
    record({ step: 2, label: "Pay ₹18,000 to Kaveri Logistics for KL-1187", decision: decisionOf(small), rule: meta(small).rule_id ?? "?", detail: meta(small).ref ?? undefined });

    // 3. A large payment: waits for a person.
    const large = await call("zoho.record_bill_payment", { bill_id: "bill_2291", amount_inr: 200000, reference: "NEFT demo" });
    const lm = meta(large);
    const s3: DemoStep = { step: 3, label: "Pay ₹2,00,000 to Sharma Traders for INV-2291", decision: decisionOf(large), rule: lm.rule_id ?? "?" };
    if (lm.approval_url) {
      s3.detail = lm.approval_url;
      opts.onApproval?.(lm.approval_url);
    }
    if (opts.waitForApproval && lm.approval_id) {
      const until = Date.now() + (opts.maxWaitMinutes ?? 30) * 60_000;
      for (;;) {
        const st = meta(await call("gate.approval_status", { approval_id: lm.approval_id, wait_seconds: 30 }));
        if (st.status && st.status !== "pending") {
          s3.detail = `${st.status}${st.outcome?.ref ? ` · ${st.outcome.ref}` : ""}`;
          break;
        }
        if (Date.now() > until) {
          s3.detail = "still waiting; stopped watching";
          break;
        }
      }
    }
    record(s3);

    // 4. Changing a vendor's bank details: always refused.
    const bank = await call("zoho.update_vendor", { vendor_id: "v_sharma", fields: { bank_account: "009988776655", ifsc: "SBIN0001234" } });
    record({ step: 4, label: "Change Sharma Traders' bank account and IFSC", decision: decisionOf(bank), rule: meta(bank).rule_id ?? "?" });

    // 5. A tool Gate does not know: refused by default.
    const unknown = await call("gmail.delete_message", { message_id: "m_104" });
    record({ step: 5, label: "Delete an email (a tool Gate does not offer)", decision: decisionOf(unknown), rule: meta(unknown).rule_id ?? "?" });
  } finally {
    await client.close();
  }
  return steps;
}
