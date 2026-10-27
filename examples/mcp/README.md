# Connect an MCP client to Elan1 Govern

Any MCP client can use Elan1 Govern as its tool server. The agent connects to Elan1 Govern only: Elan1 Govern lists the tools, checks every call against your rules, runs the allowed ones with the credentials it holds, and writes a receipt for each decision.

## What you need

From the console: **Agents → your agent → Keys and connection**.

- The **MCP address**: `http://localhost:4000/mcp` locally (your `GATE_PUBLIC_URL` plus `/mcp`). It speaks streamable HTTP.
- An **API key** (`gk_…`). It is shown once; Elan1 Govern stores only its hash. Send it as `Authorization: Bearer gk_…`.

## Claude Code

```bash
claude mcp add --transport http gate http://localhost:4000/mcp --header "Authorization: Bearer gk_your_key"
```

Or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "gate": {
      "type": "http",
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer gk_your_key" }
    }
  }
}
```

## Cursor

In `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "gate": {
      "url": "http://localhost:4000/mcp",
      "headers": { "Authorization": "Bearer gk_your_key" }
    }
  }
}
```

## Claude Desktop

Claude Desktop's config file (`claude_desktop_config.json`, opened from Settings → Developer → Edit Config) starts local servers, so reach Elan1 Govern through a local bridge that forwards to a streamable HTTP server with a header. One such bridge is the `mcp-remote` npm package. It is third-party code that sees your key: read it, and pin an exact version you have checked instead of `latest`.

```json
{
  "mcpServers": {
    "gate": {
      "command": "npx",
      "args": ["-y", "mcp-remote@<pinned-version>", "http://localhost:4000/mcp", "--header", "Authorization:${GATE_AUTH}"],
      "env": { "GATE_AUTH": "Bearer gk_your_key" }
    }
  }
}
```

Restart Claude Desktop after editing the file.

## Any other client

Point it at the MCP address with the `Authorization` header. To check the address and key from a terminal:

```bash
export GATE_KEY=gk_your_key
curl -s http://localhost:4000/mcp \
  -H "Authorization: Bearer $GATE_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## What the agent sees

- **Tools**: the built-in Gmail and Zoho Books tools, the switched-on tools of any MCP server you added under **Connectors → Your MCP servers** (named `<server>.<tool>`, e.g. `crm.issue_refund`), and `gate.approval_status`.
- **Allowed**: the tool's result, as if the agent had called the tool directly.
- **Refused**: a tool error naming the rule, e.g. `Refused by rule "never-delete": …`. Anything no rule allows is refused, and so is anything Elan1 Govern cannot check safely.
- **Needs a person**: a result with `status: pending`, an `approval_id` and the link where a person decides. The agent calls `gate.approval_status` with that `approval_id` (and `wait_seconds`, up to 30) to wait for the decision. Once approved, Elan1 Govern runs the call and `gate.approval_status` returns the result. The agent should not retry the original call.

The full description of the MCP endpoint and the REST API is served at `GET /v1/openapi.json` (no key needed) and checked in at [`docs/openapi.json`](../../docs/openapi.json).

If your agent runs its own tools instead (LangChain, the OpenAI Agents SDK, your own loop), use the REST Event API through the TypeScript SDK (`packages/sdk`) or the Python SDK (`packages/sdk-python`); see [`../python`](../python).
