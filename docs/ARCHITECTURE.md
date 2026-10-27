# Architecture

Elan1 Govern is a governance platform for AI agents. It has two halves that share one data model:

- **Runtime control.** Every tool call an agent makes passes through Elan1 Govern, which decides *allow*, *ask a person* or *refuse* from a signed rulebook, and records a signed receipt.
- **Governance.** A registry of AI systems, owners, risk assessments, frameworks and controls, whose evidence is computed from those receipts instead of written by hand.

This document explains how the pieces fit, the invariants that keep it safe, and where to extend it.

## System overview

```
                     ┌─────────────────────────── Elan1 Govern service (apps/gate, Fastify) ───────────────────────────┐
 AI agent ──MCP────▶ │  /mcp (stateless streamable HTTP)      guard.ts                                          │
 (any MCP client)    │  /v1/check · /v1/record · /v1/approvals  ├─ authenticate API key (hash lookup)          │
 SDK agent ──REST──▶ │                                          ├─ load signed rulebook (verify Ed25519)       │
                     │                                          ├─ registry: built-in + org's upstream tools   │──▶ Gmail
                     │                                          ├─ validate args, compute quota usage          │──▶ Zoho Books (zoho.in)
                     │                                          ├─ core.decide() → allow | ask | refuse        │──▶ any upstream MCP server
                     │                                          ├─ run via connector (tokens decrypted in RAM) │
                     │                                          └─ append receipt (serialized hash chain)      │
                     │  approvals.ts: hold → notify → resolve → run → second receipt; expiry                   │
                     │  evidence.ts: bundles, auditor pack PDF, checkpoints                                    │
                     │  /internal/* (HMAC-signed): the only way the web app changes chain-affecting state      │
                     └──────────────────────────────────────────────┬──────────────────────────────────────────┘
                                                                    │ Prisma (PostgreSQL)
 People ──HTTPS──▶ Web console (apps/web, Next.js) ─────────────────┘   receipts, approvals, agents, rulebooks,
                   route() wrapper: rate limit → CSRF → session → permission → fresh auth → zod         keys (encrypted), tokens (encrypted)
                                                                    
 Auditor ──zip──▶ govern verify (packages/cli) ── packages/core verifier, offline, no account
```

## Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `packages/core` | Pure logic, no I/O: canonical JSON, crypto, key rings, tool registry, rulebook schema, decision engine, receipts, chain and bundle verification, plain-language descriptions, risk questionnaire, assessment templates and scoring, and the framework library and industry packs (`@gate/core/frameworks`). Browser-safe subset at `@gate/core/browser`. | zod, yaml, fflate |
| `packages/db` | Prisma schema and migrations, `forOrg()` tenant scoping, serialized chain writer, quota usage, lookups that start from a secret. | core, Prisma |
| `packages/connectors` | Gmail, Zoho Books (India data centre) and mock connectors behind one `Connector` interface. OAuth helpers. | core |
| `packages/sdk` | `check` / `record` / `waitForApproval` for agents with their own loop. | none |
| `packages/cli` | `govern verify`, `govern sign`, `govern keygen`. | core |
| `apps/gate` | The guard: MCP server, REST Event API (+ OpenAPI), approvals, upstream MCP proxy, evidence and framework reports, webhooks, pg-boss jobs, key provider and rotation, internal admin API, OAuth callbacks. | core, db, connectors |
| `apps/web` | The console: operations (Today, Approvals, Activity, Agents, Rulebooks, Connectors) and governance (Inventory, Assessments, Evidence, Compliance), plus SSO. Reads with `forOrg`, writes chain-affecting state only through the gate service. | core, db |

Dependency direction is one way: `core ← db ← apps`, `core ← connectors ← gate`. Core never imports I/O; the web app never imports connectors (it can't hold OAuth tokens).

## Invariants

These are enforced in code and covered by tests. Changing any of them is a security change.

1. **Default refuse.** A call no rule allows is refused. Unknown tools, unloadable rulebooks, invalid arguments, a paused agent and any exception in the guard all end in *refuse*, with a receipt when one can be written.
2. **Strictest wins.** When rules match, refuse beats ask beats allow. Quotas can only turn an allow into an ask, never loosen.
3. **Only signed rulebooks run.** Elan1 Govern verifies the Ed25519 signature on every load. Publishing validates the tool names strictly; loading tolerates a tool that has since disappeared (it can only match nothing).
4. **One writer per chain.** Receipts are appended inside one transaction holding a per-org Postgres advisory lock, so `seq` has no gaps and `prev_hash` always points at the previous receipt.
5. **Tenant scoping.** Every tenant query goes through `forOrg(orgId)`, which ANDs `orgId` into filters and sets it on writes. `packages/db/test/isolation.test.ts` fails the build if app code touches a tenant table on the raw client.
6. **Secrets stay where they belong.** OAuth tokens and org signing keys are AES-256-GCM encrypted with `GATE_MASTER_KEY`, which only the gate service has. The web app cannot sign anything; agents never see a token.
7. **Minimal receipts.** Receipts store an argument hash, display identifiers and only the values rules inspected (a domain instead of an address, field names instead of values). Never bodies or prompts.

## The decision pipeline

`apps/gate/src/guard.ts` runs for every MCP `tools/call` and every `POST /v1/check`:

1. Look up the agent from the API key (SHA-256 hash, constant-time compare). Refuse if paused.
2. Load the active rulebook and verify its signature against the org key.
3. Build the org's **tool registry** (`registryFor`): built-in tools plus tools discovered from upstream connectors. Each tool has an argument schema and **risk tags** (`moves_money`, `sends_external`, `personal_data`, `deletes`, `changes_access`, `changes_production`, `reads_data`, `writes_data`).
4. Validate arguments against the tool's schema.
5. Compute usage for each **quota** that applies (count and/or sum of a field over a window: `day` in the org's time zone, or a rolling duration). One parameterised SQL query per quota.
6. `decide()` (pure, in core): match rules by tool name or by tag, evaluate conditions (`eq`, `lt`, `lte`, `gt`, `gte`, `in`, `to_domain_in`, `fields_include`), pick the strictest, apply quotas.
7. Act: run via the connector and write one receipt; or hold for approval (receipt + approval row + single-use signed links + email); or refuse with a receipt naming the rule.
8. Held approvals also queue Slack and WhatsApp messages (`apps/gate/src/chat/`) as background jobs. Chat decisions arrive on signed inbound endpoints (`routes/chat.ts`) and go through the same `resolveApproval` as the web app; buttons appear only when the deciding rule has `approve_in_chat` and passes `chatApprovalBlocker` (core `chat.ts`).

Rules can target a tool (`tool: zoho.record_bill_payment`) or every tool with a tag (`tag: moves_money`). Tag rules are what let one rulebook govern tools Elan1 Govern has never seen, which is what makes it work across industries.

## Evidence

- **Receipt:** canonical JSON → SHA-256 → Ed25519 signature; linked by `prev_hash`.
- **Checkpoint:** a signed statement of the chain head, taken hourly and on demand. It catches a truncated tail.
- **Bundle:** receipts JSONL, checkpoints, public key, and a signed manifest (range, anchor, count, last hash, file hashes). `govern verify` re-derives everything offline and names the first broken receipt.
- **Auditor pack:** a bundle plus a PDF summary generated from the same receipts, including the compliance map.

## Extending Elan1 Govern

| To add… | Do this |
|---|---|
| A new built-in connector | Implement `Connector` in `packages/connectors`, add its tools (schema + tags + summary fields) to the registry, handle its OAuth in `apps/gate/src/routes/oauth.ts`. |
| A third-party tool with no code | Point Elan1 Govern at its MCP server (upstream connector); tag its tools in the console. |
| A rule condition | Add it to `ConditionSchema`/`checkWhen` in `rulebook.ts` and `ruleMatches` in `engine.ts`, with unit and property tests. |
| A compliance framework | Add requirements and control mappings to the framework library (data); evidence counts come from receipts. |
| A permission | Add it to `apps/web/src/server/policy.ts`, use it in `route({ permission })`, and extend both authz matrix tests. |

## Operations

- **Configuration:** environment only, validated at startup; missing or weak secrets stop the process. `APP_ENV=production` also refuses the development sample secrets.
- **Scaling:** both services are stateless apart from the database. Background work (approval expiry, checkpoints, webhook delivery) runs on pg-boss in Postgres, so several Elan1 Govern instances are safe. Rate limits are per process today (planned: shared store).
- **Observability:** structured JSON logs with request ids and no personal data; `/healthz` reports the database and recent health alerts (for example a receipt that could not be written).

See [SECURITY.md](../SECURITY.md) for the threat model and [DECISIONS.md](../DECISIONS.md) for the choices behind all this.
