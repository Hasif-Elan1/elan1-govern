# Gate

**Rules, approvals and proof for AI agents that do real work.**

1. Your agent calls its tools through Gate. Before anything runs, Gate checks a signed rulebook and answers **allow**, **ask a person**, or **refuse**. Anything no rule allows is refused, and if Gate itself fails, it refuses.
2. Every decision becomes a **receipt**: hash-chained and signed, so any later edit is detectable. An auditor can check an exported bundle offline with one command, no account needed.
3. A **registry** of agents, owners, risk tiers and rulebooks, mapped to frameworks (EU AI Act, NIST AI RMF, ISO/IEC 42001, India DPDP, RBI FREE-AI). The auditor pack is generated from real receipts, not written by hand.
4. One rulebook both **blocks** actions and **produces the compliance proof**. It works with any MCP agent or through a tiny SDK.
5. The first use case runs end to end: an accounts-payable agent that reads vendor invoices in Gmail, creates bills in Zoho Books and records payments. Small payments go through, large ones wait for approval, and changing a vendor's bank details is always refused.

![Today](docs/screenshots/02-today.png)

---

## Start it

**One command, from a fresh clone**

```bash
cp .env.example .env
docker compose up            # web on :3000, gate on :4000, mail on :8025
```

**Or without Docker** (Node 22.12+, pnpm 10, PostgreSQL 16 running locally):

```bash
cp .env.example .env
pnpm run setup && pnpm dev
```

> `pnpm run setup`, not `pnpm setup`: the latter is a built-in pnpm command.

`setup` installs dependencies, starts Postgres and Mailpit with Docker if they aren't running, applies migrations, and seeds the demo org. `dev` starts the gate service and the web app.

Sign in at **http://localhost:3000** as `owner@demo.test`, with the password in `.env` (`DEMO_OWNER_PASSWORD`). Approval emails land in Mailpit at **http://localhost:8025**.

The values in `.env.example` are **for development only**. For production, generate real ones with `pnpm run secrets` and set `APP_ENV=production`; Gate refuses to start with the sample secrets in that mode.

---

## The demo, step by step

```bash
pnpm demo
```

A scripted accounts-payable agent connects to Gate over MCP, using mock Gmail and Zoho Books with Indian vendor invoices:

```
Gate demo · AP agent → http://localhost:4000/mcp

1  Read 3 invoice emails                            allowed  read-mail
2  Pay ₹18,000 to Kaveri Logistics for KL-1187      allowed  pay-small  PAY-8801
   Waiting for you. Sign in as the owner and approve it:
   http://localhost:3000/approvals/apr_…
3  Pay ₹2,00,000 to Sharma Traders for INV-2291     waiting  pay-large  approved · PAY-8802
4  Change Sharma Traders' bank account and IFSC     refused  no-bank-change
5  Delete an email (a tool Gate does not offer)     refused  default

All 5 steps behaved as the rulebook says.
```

**Step 3 waits for you.** Open the link (or the email in Mailpit), check the vendor, the bill and the invoice, and press **Approve**. Gate runs the payment and the demo finishes. It works the same on a phone:

<img src="docs/screenshots/14-approval-phone.png" width="300" alt="Approving on a phone">

Then look around:

| | |
|---|---|
| ![Approvals](docs/screenshots/03-approvals.png) **Approvals**: the action in plain words, the rule, the vendor and invoice, time left. | ![Activity](docs/screenshots/04-activity.png) **Activity**: every receipt on one chain. Open one and press *Verify this receipt*. |
| ![Rule builder](docs/screenshots/08-rule-builder.png) **Rulebooks**: build rules visually or in YAML (kept in sync), try an action, compare versions, sign and publish. | ![Evidence](docs/screenshots/10-evidence.png) **Evidence**: chain status, checkpoints, the auditor pack, and the compliance map with live evidence counts. |
| ![Agents](docs/screenshots/06-agent.png) **Agents**: owner, risk tier, keys, and a kill switch. | ![Add agent](docs/screenshots/07-add-agent.png) **Add agent**: name, five risk questions, connect tools, copy the MCP address and key. |

More: [connectors](docs/screenshots/09-connectors.png), [settings](docs/screenshots/11-settings.png), [dark mode](docs/screenshots/12-today-dark.png), [sign-in](docs/screenshots/01-sign-in.png).

**Check the evidence yourself.** On the Evidence page, download the auditor pack, then:

```bash
pnpm gate verify ~/Downloads/auditor-pack-2026-10-01-to-2026-10-26.zip
# Chain intact: 31 receipts
#   receipts 1–31, 2 signed checkpoints
#   organisation: Demo Traders Pvt Ltd
#   key fingerprint: 17f410d32e400e2d
```

Change one byte in `receipts.jsonl` and it names the receipt: `Chain broken at receipt 12: receipt 12 was changed after it was written`.

New users get the same demo from the **Try the demo agent** button after sign-up.

---

## Connect a real agent

Every agent gets an **MCP address** and an **API key** (Agents → your agent → *Keys and connection*). The key is shown once; Gate stores only its hash.

**Any MCP client** (Claude, Cursor, your own), using streamable HTTP:

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

The agent sees the tools, Gate decides each call. A refusal comes back as a tool error naming the rule. An action that needs a person returns `status: pending` and an `approval_id`; the agent calls `gate.approval_status` to wait up to 30 seconds at a time for the decision and the result.

**Your own agent loop**, with the TypeScript SDK (`packages/sdk`):

```ts
import { createGate } from "@gate/sdk";

const gate = createGate({ url: "http://localhost:4000", apiKey: process.env.GATE_KEY! });

const check = await gate.check("zoho.record_bill_payment", { bill_id, amount_inr });
if (check.decision === "allow") {
  const ref = await payInZoho(bill_id, amount_inr);          // your code runs the tool
  await gate.record({ checkId: check.checkId!, status: "ok", ref });
} else if (check.decision === "ask") {
  const s = await gate.waitForApproval(check.approvalId!);
  if (s.status === "approved") { /* run it, then gate.record({ approvalId: check.approvalId!, status: "ok" }) */ }
}
```

REST equivalents: `POST /v1/check`, `POST /v1/record`, `GET /v1/approvals/:id?wait=30`.

---

## Connect real Gmail and Zoho Books

The mock connectors are the default, so everything works with no accounts. To use real ones:

**Gmail (Google OAuth)**
1. In Google Cloud Console, create an OAuth client of type *Web application*.
2. Add the redirect URI `http://localhost:4000/oauth/gmail/callback` (your Gate URL in production).
3. Enable the Gmail API. The scopes requested are `gmail.readonly` and `gmail.compose` only.
4. Put the client id and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then restart.
5. Connectors → Gmail → **Connect a Google account**.

**Zoho Books (India data centre)**
1. At https://api-console.zoho.in create a *Server-based application*.
2. Redirect URI: `http://localhost:4000/oauth/zoho/callback`.
3. Set `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET` in `.env`. `ZOHO_ACCOUNTS_URL` and `ZOHO_API_URL` already point at `zoho.in`.
4. Connectors → Zoho Books → **Connect Zoho Books**. Gate picks the first Books organisation on the account.

Tokens go straight to Gate's callback and are stored encrypted (AES-256-GCM); the web app and the agent never see them. Set `CONNECTOR_MODE=live` to make new connectors default to real accounts.

---

## What's inside

```
apps/web            Next.js console (App Router, Tailwind, shadcn-style components, lucide)
apps/gate           Fastify service: MCP server, REST Event API, approvals, evidence export
packages/core       Rule engine, receipt chain, crypto, bundle verifier (pure, no I/O)
packages/db         Prisma schema, tenant-scoped client (forOrg), serialized chain writer
packages/connectors Gmail, Zoho Books (zoho.in) and mock connectors
packages/sdk        gate.check() / gate.record() / gate.waitForApproval()
packages/cli        gate verify | sign | keygen
e2e                 Playwright end-to-end and security tests
```

| Command | What it does |
|---|---|
| `pnpm test` | Unit and integration tests (Vitest, real Postgres) |
| `pnpm test:coverage` | Same, with coverage (core ≥ 95%, overall ≥ 80% enforced) |
| `pnpm test:e2e` | Playwright: onboarding, phone approval, rule builder, demo, authz matrix, CSRF, injection |
| `pnpm lint` · `pnpm typecheck` | ESLint, strict TypeScript |
| `pnpm security` | `pnpm audit`, semgrep, gitleaks |
| `pnpm security:zap` | OWASP ZAP baseline against the running stack |
| `pnpm gate verify <zip>` | Check an evidence bundle or auditor pack offline |
| `pnpm gate keygen` · `pnpm gate sign <yaml> --key k.pem` | Make keys and sign rulebooks offline |

Read next: [SECURITY.md](SECURITY.md) (threat model and scanner results), [DECISIONS.md](DECISIONS.md) (choices made where the brief was open), [PLAN.md](PLAN.md).
