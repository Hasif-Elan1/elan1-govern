"use client";

import { CopyButton, Secret, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";

function Code({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-line bg-sunken p-4 pr-24 font-mono text-[12.5px] leading-relaxed text-ink">{code}</pre>
      <CopyButton value={code} className="absolute top-2.5 right-2.5" />
    </div>
  );
}

/** How to point a real agent at Gate: MCP URL and key, or the SDK. */
export function ConnectAgent({ mcpUrl, gateUrl, apiKey }: { mcpUrl: string; gateUrl: string; apiKey?: string }) {
  const key = apiKey ?? "gk_your_key_here";
  const mcpConfig = JSON.stringify({ mcpServers: { gate: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
  const sdk = `import { createGate } from "@gate/sdk";

const gate = createGate({ url: "${gateUrl}", apiKey: process.env.GATE_KEY! });

const check = await gate.check("zoho.record_bill_payment", { bill_id, amount_inr });
if (check.decision === "allow") {
  const ref = await payInZoho(bill_id, amount_inr);   // your own code
  await gate.record({ checkId: check.checkId!, status: "ok", ref });
} else if (check.decision === "ask") {
  const status = await gate.waitForApproval(check.approvalId!);
  // run it only if status.status === "approved", then gate.record({ approvalId, ... })
}`;
  return (
    <div className="grid gap-5">
      <div className="grid gap-3">
        <div>
          <p className="mb-1.5 text-sm font-medium">MCP server URL</p>
          <Secret value={mcpUrl} />
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium">API key</p>
          {apiKey ? (
            <>
              <Secret value={apiKey} label="Copy key" />
              <p className="mt-1.5 text-[13px] text-wait">This is the only time Gate shows this key. Store it in your agent's secrets.</p>
            </>
          ) : (
            <p className="text-sm text-ink-2">Create a key on the Keys tab. Gate shows each key once and keeps only a hash.</p>
          )}
        </div>
      </div>
      <Tabs defaultValue="mcp">
        <TabsList>
          <TabsTrigger value="mcp">MCP client</TabsTrigger>
          <TabsTrigger value="sdk">TypeScript SDK</TabsTrigger>
        </TabsList>
        <TabsContent value="mcp" className="pt-4">
          <p className="mb-3 text-sm text-ink-2">Add Gate as an MCP server in your agent (Claude, Cursor, or any client that speaks streamable HTTP). The agent sees only the tools your rules mention, and never sees the passwords or tokens of your connected accounts.</p>
          <Code code={mcpConfig} />
        </TabsContent>
        <TabsContent value="sdk" className="pt-4">
          <p className="mb-3 text-sm text-ink-2">For your own agent loop: ask Gate before acting, tell it what happened after.</p>
          <Code code={sdk} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
