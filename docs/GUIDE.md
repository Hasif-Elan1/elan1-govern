# Your guide to Elan1 Govern

This is the plain-English guide: what was built, how to run it, how to use it, and how to remove any part of it.

## 1. What Elan1 Govern is, in one minute

Companies now let AI agents do real work: send emails, pay bills, issue refunds, change records. Elan1 Govern sits between the agent and those tools.

- **Before** an agent does anything, Elan1 Govern checks your rules and says **yes**, **ask a person first**, or **no**.
- **Every** decision becomes a **receipt** that is signed and chained to the one before it. Nobody can quietly change history, and an auditor can check that offline.
- Around that, Elan1 Govern keeps the **paperwork**: a list of every AI system you use, risk assessments with sign-off, and which laws and standards (EU AI Act, NIST, ISO 42001, GDPR, HIPAA, SOC 2, India's DPDP and RBI rules, Colorado and New York City rules) your evidence supports.

It works for any industry. The built-in demo is an accounts-payable agent (Indian invoices in Gmail, payments in Zoho Books) because it shows all three answers clearly.

## 2. What was built

Everything below is working code with tests. Each item says where to find it in the app.

| Area | What it does | Where |
|---|---|---|
| **The guard** | Checks every tool call against a signed rulebook; refuses anything not allowed; refuses if anything goes wrong | Elan1 Govern service (`apps/gate`) |
| **Approvals** | Holds risky actions for a named person, by email or on the phone, with the evidence (invoice, vendor, amount); single-use links; asks for your password again before approving | Approvals |
| **Receipts and proof** | Signed, chained receipts; hourly checkpoints; one-click "Verify this receipt"; downloadable auditor pack checked with `govern verify` | Activity, Evidence |
| **Today screen** | What's waiting for you, today's numbers, live activity | Today |
| **Agents** | Registry of agents with owner, risk level, keys and an instant pause switch; a 3-step "Add agent" wizard | Agents |
| **Rules** | A visual rule builder kept in sync with the text version; "Try an action" test panel; versions and differences; sign and publish | Rulebooks |
| **Rules for any industry** | Rules can name one tool, or a kind of action (anything that moves money, contacts outsiders, deletes data…); limits like "50 emails an hour" | Rulebooks |
| **Connectors** | Gmail and Zoho Books (India), demo data by default; **any MCP server** can be put behind Elan1 Govern, with each tool tagged and switched on by you | Connectors |
| **AI inventory** | Every AI system you use, not only agents: owner, data it touches, stage, risk, next review | Inventory |
| **Assessments** | Risk triage, impact assessment and data-protection check; scores explained; a different person must sign off | Assessments |
| **Compliance** | Ten framework libraries; coverage from real evidence; gaps called out; framework report PDF; all marked "Draft — needs legal review" | Compliance |
| **Industry packs** | Starter rules and frameworks for finance, healthcare, HR, support, sales, engineering, and general; chosen during sign-up | Sign-up, Add agent |
| **Team and security** | Roles (Owner, Admin, Approver, Viewer, Auditor); auditors can switch between client companies; two-step sign-in; **single sign-on** (Okta, Microsoft, Google) | Settings |
| **Platform** | Background jobs that survive restarts, webhooks, an API description (OpenAPI), signing-key rotation | Settings, `docs/openapi.json` |
| **For developers** | MCP address + key for any agent; a small SDK; the `gate` command line (`verify`, `sign`, `keygen`) | README |

**Quality checks that pass:** 409 automated tests, plus 19 browser tests covering sign-up, approving on a phone, the rule builder, the demo, and security (every role against every page, other companies' data, forged links, CSRF, injection attacks). Dependency audit, semgrep, gitleaks and the OWASP ZAP scan are clean of serious findings. Details are in `SECURITY.md`.

## 3. How to run it

### On this computer (already set up)

Everything was installed for your user only (no admin rights needed) in `~/.local`. Open a terminal and run:

```bash
export PATH=~/.local/bin:$PATH
cd ~/Documents/elan-Governce
pg_ctl -D ~/.local/pgdata/gate -l ~/.local/pgdata/gate.log -o "-p 5432 -k /tmp" start   # the database, if it isn't running
pnpm dev
```

Then open **http://localhost:3000** and sign in as `owner@demo.test`. The password is `DEMO_OWNER_PASSWORD` in the `.env` file. Emails (approval links) appear at **http://localhost:8025**.

### On any other computer

With Docker installed:

```bash
cp .env.example .env
docker compose up
```

Without Docker: install Node 22, pnpm 10 and PostgreSQL 16, then `cp .env.example .env && pnpm run setup && pnpm dev`.

> The `docker compose` setup was written but could not be tested on this machine, because Docker needs administrator rights here.

### Before real customers use it

Run `pnpm run secrets`, put the new values in `.env`, and set `APP_ENV=production`. Elan1 Govern refuses to start in production with the sample secrets.

## 4. A five-minute tour

1. Sign in. **Today** shows actions waiting for you.
2. In a second terminal run `pnpm demo`. The demo agent reads invoices, pays ₹18,000 on its own, asks you about ₹2,00,000, and is stopped from changing a bank account.
3. Open **Approvals**, look at the invoice and vendor, press **Approve**. The demo finishes.
4. Open **Activity**, click the payment, press **Verify this receipt**.
5. Open **Evidence**, download the auditor pack, and check it: `pnpm govern verify ~/Downloads/auditor-pack-….zip`.
6. Look at **Compliance**, **Inventory** and **Assessments** to see the governance side.

## 5. How to remove things

Everything is in one folder, and the tools were installed only for your user, so nothing is hard to undo.

| To remove… | Do this |
|---|---|
| **The demo data** | Delete the demo users and orgs: `psql -h localhost -U gate gate -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'` then `pnpm db:migrate` (starts with an empty database). |
| **The whole database** | `pg_ctl -D ~/.local/pgdata/gate stop && rm -rf ~/.local/pgdata` |
| **A connected account (Gmail, Zoho, an MCP server)** | Connectors → **Disconnect** or **Remove**. Elan1 Govern deletes the stored tokens; agents get an error for those tools from then on. |
| **An agent** | Agents → the agent → switch **Running** off (instant), and revoke its keys on the Keys tab. History is kept on purpose. |
| **Single sign-on** | Settings → Single sign-on → turn it off. Password sign-in works again. |
| **A feature from the code** | Each feature is a folder: for example `apps/web/src/app/(app)/inventory` and `…/assessments` (inventory), `…/compliance` and `packages/core/src/frameworks` (frameworks), `apps/gate/src/upstream*.ts` (MCP servers). Remove the folder, its sidebar line in `apps/web/src/components/shell.tsx`, and its tests; run `pnpm typecheck` to find anything else that referred to it. |
| **The project** | Delete the `~/Documents/elan-Governce` folder. |
| **The tools installed for this** | `rm -rf ~/.local/opt/node-v22.* ~/.local/opt/ZAP_* ~/.local/opt/mailpit ~/.local/opt/gitleaks ~/.local/mamba ~/.local/opt/bin/micromamba` and remove the matching links in `~/.local/bin` (`node npm npx corepack pnpm git postgres pg_ctl initdb createdb psql java semgrep pysemgrep gitleaks mailpit micromamba zap.sh`). Playwright's browser is in `~/.cache/ms-playwright`. |

## 6. What is not done yet, and why

| Item | Why |
|---|---|
| `docker compose up` not tested | Docker needs admin rights on this computer. Run `! sudo apt install docker.io docker-compose-v2` in this chat if you want me to test it. |
| Real Gmail and Zoho Books not tried live | They need your own Google and Zoho developer apps (about 15 minutes each; the README explains). The code is tested against fake versions of both APIs. |
| Legal review of the compliance mappings | They are carefully worded drafts, clearly marked. A lawyer or CA should review them before you rely on them with customers. |
| SAML sign-in, SCIM user sync, cloud key vaults (KMS) | Planned next. OIDC single sign-on and the key-rotation interface are built so they can be added without redesign. |
| SOC 2 certification for Elan1 Govern itself | That is a process with an auditor, not code. The controls it needs are largely in place. |

## 7. Where to read more

- `README.md`: setup, the demo, connecting agents and accounts.
- `docs/PRODUCT.md`: the product story for investors.
- `docs/ARCHITECTURE.md`: how it fits together, for engineers.
- `SECURITY.md`: the threat model and scanner results.
- `DECISIONS.md`: every choice made where the brief left room.
