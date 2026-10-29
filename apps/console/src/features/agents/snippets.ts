/**
 * Copy-paste connection snippets for a new agent. Every snippet uses the agent's own MCP address, key and the
 * organisation's own endpoints (its residency domain, or its own domain on a Sovereign deployment).
 * MCP snippets connect through the governed run; REST and the Python SDK are check and record (advisory).
 */
import type { Endpoints } from './backend';

export type SnippetId = 'claude' | 'claude-code' | 'cursor' | 'langchain' | 'openai' | 'rest' | 'sdk';

export interface Snippet { id: SnippetId; label: string; title: string; code: string; note: string }

export function buildSnippets(slug: string, url: string, key: string, sampleTool: string, agentName: string, ep: Endpoints): Snippet[] {
  const server = `elan1-govern-${slug}`;
  return [
    {
      id: 'claude',
      label: 'Claude Desktop',
      title: 'claude_desktop_config.json',
      note: 'Add this under mcpServers, then restart Claude Desktop. The governed tools appear in the tools menu.',
      code: JSON.stringify({ mcpServers: { [server]: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${key}`] } } }, null, 2),
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      title: 'Terminal',
      note: 'Run once in your project. Check it with claude mcp list.',
      code: `claude mcp add --transport http ${server} \\\n  ${url} \\\n  --header "Authorization: Bearer ${key}"`,
    },
    {
      id: 'cursor',
      label: 'Cursor',
      title: '.cursor/mcp.json',
      note: 'Save in your project (or ~/.cursor/mcp.json for every project), then enable the server in Cursor settings.',
      code: JSON.stringify({ mcpServers: { [server]: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
    },
    {
      id: 'langchain',
      label: 'LangChain',
      title: 'Python · langchain-mcp-adapters',
      note: 'pip install langchain-mcp-adapters. Each tool call goes through Elan1 Govern before it runs.',
      code: `from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "${server}": {
        "transport": "streamable_http",
        "url": "${url}",
        "headers": {"Authorization": "Bearer ${key}"},
    }
})

tools = await client.get_tools()  # only the tools this agent may call`,
    },
    {
      id: 'openai',
      label: 'OpenAI Agents SDK',
      title: 'Python · openai-agents',
      note: 'pip install openai-agents. A refused call returns an error result to the agent; it does not run.',
      code: `from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

async with MCPServerStreamableHttp(
    name="${server}",
    params={
        "url": "${url}",
        "headers": {"Authorization": "Bearer ${key}"},
    },
) as govern:
    agent = Agent(name="${agentName.replace(/"/g, '')}", mcp_servers=[govern])
    result = await Runner.run(agent, "List today's unread invoices")`,
    },
    {
      id: 'sdk',
      label: 'Python SDK',
      title: 'Python · elan1-govern',
      note: 'pip install elan1-govern. Check and record: Elan1 Govern decides and records; your code holds its own credentials and runs the call. Run only on "allow", then record what happened.',
      code: `from elan1_govern import Govern

govern = Govern(api_key="${key}", base_url="https://${ep.host}")

decision = govern.check(tool="${sampleTool}", args={"limit": 1})
if decision.allowed:
    result = run_${sampleTool.replace(/[^a-z0-9]+/gi, '_')}(limit=1)  # your own call
    govern.record(decision, outcome="ok", ref=result.id)
elif decision.asked:
    print("Held for", decision.approver_group, "— receipt", decision.receipt)
else:
    print("Refused by", decision.rule_id)`,
    },
    {
      id: 'rest',
      label: 'REST · /v1/check',
      title: 'curl',
      note: 'Check and record: Elan1 Govern decides and records; your agent holds its own credentials and runs the call. Run only on "allow".',
      code: `curl -X POST ${ep.checkUrl} \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"tool": "${sampleTool}", "args": {"limit": 1}}'

# → {"decision": "allow" | "ask" | "refuse", "rule_id": "…", "receipt": 4102}`,
    },
  ];
}
