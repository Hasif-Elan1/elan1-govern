# Security

Elan1 Govern sits between AI agents and the systems they act on, so it is built to **fail closed**: if it cannot be sure an action is allowed, the action does not happen. This document is the threat model (STRIDE), the controls, where each one is tested, and the current scanner results.

Report a vulnerability privately to **hello@elan1.ai**. Please don't open a public issue.

## Components and trust boundaries

```
 AI agent ──(API key, MCP / REST)──▶ Elan1 Govern service ──(OAuth tokens, only here)──▶ Gmail · Zoho Books
                                        │   ▲
                         signed internal │   │ HMAC-signed requests
                                        ▼   │
 People ──(session cookie, CSRF)──▶ Web app ─┘          Auditor ──(zip)──▶ govern verify (offline)
                                        │
                                        ▼
                                   PostgreSQL (receipts, approvals, encrypted keys and tokens)
```

| Boundary | What crosses it | Trust |
|---|---|---|
| Agent → Elan1 Govern | Tool calls with a bearer API key | Untrusted. Every call is checked against a signed rulebook. |
| Browser → Web | People using the console | Untrusted until signed in; role-checked on every request. |
| Web → Elan1 Govern (internal API) | Approvals, publishing, org creation, exports | Authenticated with HMAC over method, path, body and time (±60 s). |
| Elan1 Govern → Gmail/Zoho | OAuth access | Tokens exist only inside Elan1 Govern, encrypted at rest. |
| Elan1 Govern → upstream MCP servers | Allowed tool calls, with the org's stored auth header | The URL is customer-supplied: only http(s), no internal addresses in production, no redirects, timeouts and a size cap. The header exists only inside Elan1 Govern, encrypted at rest. |
| Bundle → Auditor | Evidence zip | Verified offline with the org's public key. No trust in Elan1 Govern needed. |

Secrets are split so no single component holds everything:

| Secret | Holder | Used for |
|---|---|---|
| `GATE_MASTER_KEY` | Elan1 Govern only | AES-256-GCM encryption of each org's Ed25519 signing key, all OAuth tokens and upstream MCP auth headers |
| `GATE_MASTER_KEY` | Elan1 Govern only | AES-256-GCM encryption (via the `KeyProvider`) of each org's Ed25519 signing keys, all OAuth tokens and webhook signing secrets, and the replay store's call arguments |
| `INTERNAL_API_SECRET` | Elan1 Govern and web | HMAC on internal calls and OAuth `state` |
| `APPROVAL_LINK_SECRET` | Elan1 Govern and web | HMAC on emailed approval links |
| `WEB_ENC_KEY` | Web only | AES-256-GCM encryption of TOTP secrets |

The web app **cannot sign receipts or rulebooks**. Only Elan1 Govern can.

## STRIDE threat model

Test locations: `core` = `packages/core/test`, `db` = `packages/db/test`, `gate` = `apps/gate/test`, `web` = `apps/web/test`, `e2e` = `e2e/` (Playwright).

### Elan1 Govern service (the guard)

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | An attacker calls tools as an agent | API keys are 256-bit random, shown once, stored as SHA-256, compared in constant time; revoked keys stop at once | `gate/api.test.ts` "creates agents with keys, rotates and revokes keys"; `gate/flow.test.ts` "rejects missing and bad keys" |
| **S** | Forged web→Elan1 Govern internal call | HMAC over method + path + SHA-256(body) + timestamp, 60 s window | `core/canonical-crypto.test.ts` "request signing"; `gate/api.test.ts` "requires a valid signature bound to method, path and body" |
| **T** | Rulebook edited in the database to loosen rules | Rulebooks are Ed25519-signed by the org key; Elan1 Govern refuses to load an unsigned or altered one and raises a health alert | `core/rulebook.test.ts` "loads only signed, valid rulebooks"; `gate/flow.test.ts` "a rulebook with a bad signature is not loaded" |
| **T** | Agent sends malformed or oversized arguments | Every tool's arguments are validated with a strict zod schema; invalid → refused with a receipt; 1 MB body limit | `gate/flow.test.ts` "invalid arguments are refused" |
| **R** | An action happens with no record | Every decision writes a receipt before returning; allowed calls write after running, and if that write fails the agent is refused and a health alert names the action (see DECISIONS.md #15) | `gate/flow.test.ts` "fail closed" |
| **I** | Agent reads OAuth tokens | Tokens never leave Elan1 Govern: not in tool results, errors, approvals or health output | `gate/api.test.ts` "never shows them to the agent" |
| **I** | Receipts leak email bodies, prompts or bank details | Receipts keep only an argument hash, display identifiers and the fields a rule inspected (domain not address; field names not values) | `core/engine.test.ts` "refuses bank changes", "asks for replies"; `gate/flow.test.ts` "allow: runs the tool" |
| **D** | Agent floods Elan1 Govern | Per-key rate limit (300/min) on MCP and REST; long-polls capped at 30 s | config in `apps/gate/src/app.ts` |
| **E** | Agent uses a tool no rule allows, or an unknown tool | Default is always `refuse`; strictest matching rule wins; limits only ever tighten | `core/engine.test.ts` properties; `gate/flow.test.ts` "unknown tool" |
| **E** | Elan1 Govern breaks and lets things through | Any exception → refuse + receipt; if the database is down → refuse, nothing runs | `gate/flow.test.ts` "if the database fails mid-call…", "if the database is unreachable…" |
| **E** | A paused agent keeps acting | Status checked on every call | `gate/flow.test.ts` "a paused agent is refused instantly" |

### Approvals

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | Someone approves who shouldn't | Must be signed in, hold Owner/Admin/Approver, be named in the rule's approver group, and have signed in within 10 minutes (re-auth with password + TOTP) | `e2e/security.spec.ts` "approval links…"; `gate/flow.test.ts` "only listed approvers…" |
| **T** | Approval link forged or edited | Links are HMAC-signed `{org, approval, link, expiry}` | `e2e/security.spec.ts` (tampered, other approval) |
| **R** | Approver denies approving | The second receipt names the approver, time, result and (if so) that they set up the agent | `gate/flow.test.ts` "ask -> approve"; `e2e/security.spec.ts` self-approval |
| **E** | Link replay or use after expiry | Single-use DB row consumed atomically with the decision; expiry checked; expired approvals are refused with a receipt | `gate/flow.test.ts` "approval links are single-use", "ask -> expire"; `e2e/security.spec.ts` |
| **E** | Self-approval hides a conflict of interest | Allowed but warned in the UI and flagged on the receipt | `e2e/flows.spec.ts`, `e2e/security.spec.ts` |
| **E** | Someone signs off their own AI assessment | The submitter can never approve or send back their own assessment (checked by user id, and again in the update itself); only owners and admins review | `core/assessments.test.ts` "separation of duties"; `e2e/security.spec.ts` "assessments: drafters submit…" |
| **R** | An inventory change or sign-off leaves no record | Each one is a signed receipt; if Elan1 Govern cannot write it, the change is undone | `web/inventory.test.ts` "undoes the change"; `e2e/governance.spec.ts` |

### Web app

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | Password guessing | argon2id; lockout after 5 failures with doubling back-off (max 1 h); 10 attempts per account per 15 min; constant-time path for unknown emails; optional TOTP | `web/server.test.ts` "locks the account…"; `e2e/security.spec.ts` "login is rate limited per account" |
| **S** | Session theft | 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie, stored hashed; 7-day expiry; new token on every sign-in | `e2e/security.spec.ts` "session cookie is httpOnly and secure" |
| **T** | CSRF | Session-bound token in `x-csrf-token` (double-submit cookie when signed out) **and** same-origin check on every write | `e2e/security.spec.ts` "CSRF…" |
| **T** | SQL injection | Prisma parameterised queries only; no raw SQL with user input | `e2e/security.spec.ts` "SQL injection and XSS payloads…" |
| **T** | XSS | React escaping; strict CSP with per-request nonce and `strict-dynamic`; no `dangerouslySetInnerHTML` | `e2e/security.spec.ts` (payloads in every text field, no dialog fires) |
| **I** | One tenant reads another's data | Every tenant query goes through `forOrg(orgId)`, which ANDs the org into every filter; a test fails the build if code touches a tenant table on the raw client | `db/db.test.ts` "forOrg…"; `db/isolation.test.ts`; `e2e/security.spec.ts` "another org cannot…" |
| **I** | PII in logs | Structured JSON logs carry request ids and user ids, never emails, bodies or tokens; Elan1 Govern redacts `authorization`, `cookie` and signature headers and logs paths without query strings | `apps/web/src/server/log.ts`, `apps/gate/src/app.ts` |
| **D** | Flooding sign-in or approvals | Per-IP limits (login 10/min, sign-up 5/min, approvals 30/min, writes 120/min) plus per-account limits | `web/server.test.ts` "rate limits"; `e2e/security.spec.ts` |
| **E** | A role does more than it should | One permission table (`apps/web/src/server/policy.ts`) used by every route; only owners can touch owners; the last owner can't be removed | `web/policy.test.ts`; `e2e/security.spec.ts` "authz matrix" (5 roles × every route and page) |
| **S** | Someone signs in through another company's identity provider | SSO applies only to domains proven by a DNS TXT record; only verified claims block other orgs; the IdP's email must be verified and inside a verified domain | `web/sso.test.ts` |
| **T** | SSO response forged or replayed into another browser | Authorization code flow with PKCE (S256), state and nonce, kept in an AES-GCM-encrypted httpOnly cookie that lasts 10 minutes; id_token signature, issuer and audience checked by `openid-client` | `web/sso.test.ts` |
| **E** | SSO users granted too much | New SSO users get the org's default role, which can never be Owner; existing memberships are unchanged | `apps/web/src/app/api/settings/sso/route.ts` |
| **E** | Clickjacking, sniffing | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, HSTS, strict `Referrer-Policy`, `Permissions-Policy` | `e2e/security.spec.ts` "security headers are set" |

### Connectors

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | OAuth callback forged (login CSRF / account mix-up) | `state` is HMAC-signed `{org, connector, actor, expiry, nonce}`; wrong kind, expired or forged state is rejected | `gate/api.test.ts` "rejects forged, expired and mismatched OAuth state" |
| **T** | Header injection when sending email | CR/LF stripped from every header value | `connectors/live.test.ts` "refuses header injection in replies" |
| **I** | Tokens at rest | AES-256-GCM with 16-byte tags, AAD bound to org and connector | `core/canonical-crypto.test.ts` "AES-256-GCM" |
| **E** | Agent reaches beyond the allowed tools | Only 10 built-in tools exist; no delete, forward or settings tools; Gmail scopes are `readonly` + `compose` | `gate/flow.test.ts` "lists only the allowed tools" |

### Upstream MCP servers

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | A server URL that points Elan1 Govern at its own network or cloud metadata (SSRF) | Only `http(s)`, no credentials in the URL; with `UPSTREAM_ALLOW_PRIVATE=false` (the production default) loopback, private, link-local, CGNAT, multicast, IPv4-mapped and NAT64 addresses are refused, checked when the server is added **and** inside the socket's DNS lookup on every connection, so DNS rebinding cannot swap the address; redirects are never followed; 15 s timeout and 5 MB response cap | `gate/upstream.test.ts` "refuses private, loopback and non-http addresses…", "checks the address again on every connection", "classifies addresses" |
| **I** | Upstream auth header stolen from the database, logs or responses | AES-256-GCM with AAD bound to org and server id; write-only in the web app (a password field, never shown again); never in receipts (only the URL's origin), errors, tool lists or results; an upstream that echoes it gets `[redacted]` | `gate/upstream.test.ts` "adds, syncs, governs…" (scans every response, receipt and approval), "reports a rejected auth header without echoing anything" |
| **I** | Upstream error text leaks headers or personal data into receipts | Upstream errors become short fixed messages (timeout, HTTP status, "reported an error"); receipts keep the same minimised summaries as built-in tools | `gate/upstream.test.ts` "reports a rejected auth header…" |
| **E** | Confused deputy: an agent uses Elan1 Govern's stored credentials for something its rules don't allow | Elan1 Govern forwards only calls the guard allowed or a person approved, under the calling agent's own signed rulebook; default refuse; tools are switched off until a person reviews their tags; unknown, disabled and removed tools are refused before any rule runs; arguments are checked against the upstream's input schema | `gate/upstream.test.ts` (delete refused and never reaches the upstream, disabled tool refused, invalid arguments refused, refund held until approved) |
| **E** | An upstream shadows a built-in tool or another server | Tool names are `<server>.<tool>`; `gate`, `gmail` and `zoho` are reserved; server names are unique per org | `gate/upstream.test.ts` "reports a rejected auth header…" (reserved and duplicate names) |
| **T** | A malicious upstream changes a tool's behaviour or schema after review | Re-sync refreshes descriptions and schemas but keeps the person's tags and on/off choice; every sync and change writes an admin receipt. Tool descriptions come from the upstream and reach the agent's model, so only add servers you trust | admin receipts in `gate/upstream.test.ts` |

### Evidence chain

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **T** | Receipt edited, deleted, reordered or inserted | SHA-256 hash chain over canonical JSON, Ed25519 signature on each hash; verifier names the first broken receipt | `core/chain.test.ts` (unit + property tests) |
| **T** | Tail of the chain cut off | Hourly signed checkpoints; signed bundle manifest records the last seq and hash | `core/chain.test.ts` "catches a truncated tail" |
| **T** | Gaps from concurrent writes | One transaction with a per-org Postgres advisory lock | `db/db.test.ts`, `gate/flow.test.ts` "concurrent calls produce a gap-free, valid chain" |
| **R** | Org disputes a bundle | Signed with the org key; the verifier prints the key fingerprint, which the Evidence page also shows | `packages/cli/test/cli.test.ts` |
| **I** | Bundle leaks personal data | Same minimised receipts as above | as above |
| **D** | Zip bomb sent to the verifier | Uncompressed size capped at 512 MB before reading | `packages/core/src/bundle.ts` |

### Webhooks

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | Someone forges an Elan1 Govern event to a customer's endpoint | Every delivery carries `gate-signature: t=…,v1=HMAC-SHA256(secret, "t.body")` with a 256-bit per-endpoint secret, shown once and stored AES-GCM-encrypted; `verifyWebhook` in the SDK compares in constant time | `gate/webhooks.test.ts` "signed Stripe-style"; `sdk/webhook.test.ts` |
| **T** | A captured delivery is replayed later | The timestamp is inside the signed text; `verifyWebhook` rejects anything more than 5 minutes off. `gate-delivery` lets receivers drop duplicates | `sdk/webhook.test.ts` "rejects old or future timestamps" |
| **I** | SSRF: an admin points a webhook at the cloud metadata service or an internal host | http(s) only, no URL credentials, no redirects, 10 s timeout. The address is checked after DNS inside the socket's `lookup`, so the connection uses exactly the checked address (no DNS-rebinding window). Private, loopback, link-local, CGNAT, multicast, reserved and IPv4-mapped IPv6 ranges are refused unless `WEBHOOK_ALLOW_PRIVATE=true` (default only outside production) | `gate/webhooks.test.ts` "SSRF…", "classifies addresses", "does not follow redirects" |
| **I** | Webhook payloads or logs leak personal data or tokens | Payloads are the already-minimised receipts; delivery errors are short fixed phrases (no URLs, headers or response bodies); receipts and logs name the endpoint's host, never its path or query | `gate/webhooks.test.ts` "creates an endpoint…" |
| **D** | A slow or dead endpoint slows agents down | Events are enqueued after the receipt commits and delivered by background jobs; the guard never waits. At most 20 endpoints per org; 8 attempts, then the delivery is marked failed | `gate/webhooks.test.ts` "retries with backoff…" |
| **E** | A viewer adds an endpoint to exfiltrate events | `webhooks:manage` is owner/admin only; writes go through the signed internal API and leave `webhook.created` / `webhook.deleted` receipts | `web/policy.test.ts`; `e2e/security.spec.ts` authz matrix; `e2e/platform.spec.ts` |

### Signing keys and rotation

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | A stolen old key signs new receipts after rotation | Rotation retires the old key at the time of the `key.rotated` receipt, which the old key itself signs and which names the new key. Verifiers reject anything a key signed after its retirement, using both the signed key list in the bundle and the rotation receipt in the chain. Rulebooks are re-signed and the guard trusts only the active key | `core/keys.test.ts` "a retired key cannot keep signing"; `cli/cli.test.ts` "rejects a retired key's late receipt" |
| **T** | A receipt's `kid` is changed to blame or excuse a key | `kid` is covered by the receipt hash and the signature; a key id must equal the fingerprint of its PEM | `core/keys.test.ts` "the kid is covered by the hash", "rejects a tampered key list" |
| **T** | A write races the rotation and is signed by the retired key | Every chain write resolves its key after taking the org's chain lock, and rotation runs under the same lock | `gate/keys.test.ts` "writes racing a rotation never use the retired key" |
| **R** | An org denies a rotation happened, or when | The handover is a receipt on the chain; bundles list each key with its retirement time in the signed manifest | `gate/keys.test.ts` "rotation…" |
| **I** | Private keys at rest | Wrapped by a `KeyProvider` (env master key, AES-256-GCM, AAD bound to org and key id); a cloud KMS can implement the same interface | `gate/keys.test.ts` |
| **E** | A non-owner rotates the key | `keys:rotate` is owner-only and needs a sign-in within 10 minutes | `web/policy.test.ts`; `e2e/security.spec.ts` authz matrix; `e2e/platform.spec.ts` |

### Replay store ("Test on past actions")

**What is stored.** `ReplayCall`: for each guarded call that reached the rules, the validated tool arguments (which can include personal data, email bodies or bank details) plus org, agent, tool, time, receipt `seq` and the original decision and rule. Receipts stay minimal (invariant 7); this table is the only place full arguments are kept after a decision.
**Encryption.** AES-256-GCM (`authTagLength` 16) with `GATE_MASTER_KEY`, which only the gate service holds; the AAD is `replay-args:<org>:<seq>`, so a ciphertext moved to another org or row does not decrypt. The web app can count and delete rows but cannot read them.
**Retention.** 30 days, deleted by the hourly `replay-purge` job. Per-org switch `replayStore` (on by default, Owner/Admin in Settings); switching it off deletes every row at once, and the purge job also removes any row an in-flight call wrote after that.
**Use.** Only the gate's signed internal replay route reads it, decrypting in memory to run `decide()`. Its answer carries counts, decisions, rule ids and a description built from the receipt's minimal summary, never the stored arguments. Arguments are never logged; a failed write logs only an error code.

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | Someone without rulebook rights runs a replay | `rulebooks:publish` (Owner, Admin) on the web route; the gate route needs the HMAC-signed internal call | `web/replay.test.ts` (Viewer, Approver, Auditor refused); `e2e/security.spec.ts` authz matrix; `gate/replay.test.ts` (unsigned call refused) |
| **T** | A stored row is altered or swapped to change a replay | GCM authentication with AAD bound to org and receipt; an unreadable row counts as "could not be judged", never as a guess | `gate/replay.test.ts` "org A cannot replay over org B's calls" |
| **R** | A replay changes what happened | It is a simulation: nothing runs, nothing is signed or published, no receipt or rulebook is written | `gate/replay.test.ts` (rulebook count unchanged) |
| **I** | Full arguments leak from the database, logs or the replay answer | Encrypted at rest with a key the web app does not have; only the receipt summary is returned; arguments never logged; 30-day retention; the store can be switched off and emptied | `gate/replay.test.ts` "stores each guarded call's arguments encrypted…" (ciphertext and logs do not contain the value), "purges rows older than 30 days…"; `web/replay.test.ts` "switching it off deletes…" |
| **I** | Org A replays over org B's calls | `ReplayCall` is a tenant model read only through `forOrg`; the agent must belong to the org in the path | `db/isolation.test.ts`; `gate/replay.test.ts` "org A cannot replay over org B's calls" |
| **D** | Replays used to load the service (each decrypts up to a month of calls) | Per-IP and per-org limits in the web app (10/min), 6/min per org in the gate, at most 50,000 calls per run | `web/replay.test.ts` "limits runs per organisation"; `gate/replay.test.ts` (429) |
| **E** | The store changes live decisions | It is written after the decision and receipt, never read by the guard; a failed write is ignored | `gate/replay.test.ts` "a write failure never changes the answer" |

### Background jobs

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **T** | Several Elan1 Govern instances double-run a sweep or skip one | pg-boss stores cron schedules in Postgres and sends one job per tick; the `stately` policy allows one queued and one running job per cron queue; jobs are idempotent (expiry and delivery claim rows atomically) | `gate/jobs.test.ts` |
| **R** | A job silently stops | Each run logs `{ job, ms, counts }` (no personal data); failures log at warn and stay in pg-boss's tables | `gate/jobs.test.ts` "logs without personal data" |
| **D** | A crash loses due work | Jobs are durable rows; overdue approvals are also expired on access, and `webhook-sweep` re-sends any delivery whose job was lost | `gate/jobs.test.ts` "the sweep picks up deliveries whose job was lost" |
| **E** | The job queue becomes a way into tenant data | Job payloads carry only ids; handlers re-read rows through `forOrg(orgId)`; tables live in a separate `pgboss` schema | `db/isolation.test.ts` (tenant scan) |

## Configuration safety

- All secrets come from the environment. `.env` is git-ignored; `.env.example` holds **dev-only** sample values so a fresh clone runs.
- Both services refuse to start if a secret is missing, not 32 random bytes, or obviously weak. With `APP_ENV=production` they also refuse the sample values from `.env.example` (`gate/env.test.ts`).
- Behind a reverse proxy set `TRUST_PROXY=true` so rate limits key on the client IP; without it, forwarded headers are ignored (they could be spoofed) and callers share one bucket.

## Scanner results

Run them all with `pnpm security` and `pnpm security:zap`.

| Scanner | Command | Result |
|---|---|---|
| Dependency audit | `pnpm audit --audit-level high` | **No known vulnerabilities** (any severity) |
| Static analysis | `semgrep scan --config auto` (257 rules) | **0 findings** |
| Secret scan | `gitleaks detect` | **No leaks** |
| DAST | OWASP ZAP baseline, against the production build | **0 High, 0 Critical** |

### Findings fixed

| Scanner | Finding | Fix |
|---|---|---|
| pnpm audit | tinypool (critical), via Vitest 3 | Upgraded to Vitest 4.1, which no longer uses it |
| pnpm audit | zod < 4.6.6 (high) | Migrated to zod 4.6.7 |
| pnpm audit | nodemailer < 10.0.6 (high) | Upgraded to nodemailer 10.2.1 |
| pnpm audit | postcss < 8.5.18, deepmerge-ts < 8 (high), transitive | pnpm overrides to patched versions |
| semgrep | AES-GCM decipher without explicit tag length | `authTagLength: 16` on cipher and decipher, tag length checked |
| semgrep | CI actions pinned by mutable tag | Pinned to commit SHAs |
| semgrep | `RegExp` built from variables | Replaced with plain string parsing |
| semgrep | No minimum release age / trust policy / exotic sub-deps | pnpm 10: `minimumReleaseAge` 7 days, `trustPolicy: no-downgrade`, `blockExoticSubdeps`, `onlyBuiltDependencies`; npm `min-release-age=7` |

### Accepted findings and false positives

| Scanner | Finding | Why it is accepted |
|---|---|---|
| gitleaks, semgrep | "Generic secret" in `.env.example` | Deliberate dev-only sample values so `cp .env.example .env` works. Refused at startup when `APP_ENV=production`. The file is excluded in `.gitleaks.toml` and `.semgrepignore`, with this reason. |
| gitleaks | "Generic API key" in README examples | It matched a public signing-key fingerprint in sample `govern verify` output. Fingerprints identify public keys and are meant to be shared with auditors. Only that exact pattern is allowlisted in `.gitleaks.toml`. |
| ZAP 10055 (Medium) | CSP `style-src 'unsafe-inline'` | React and Next.js set inline styles. Scripts, the real XSS vector, are locked to per-request nonces with `strict-dynamic`. |
| ZAP 10010 (Low) | Cookie without HttpOnly | That is `gate_csrf`, a double-submit CSRF token that same-origin JavaScript must read. The session cookie is HttpOnly. |
| ZAP 10024 (Info) | Sensitive information in URL | Emailed approval links carry a signed, single-use, expiring token. |
| ZAP 10111, 10112 (Info) | Authentication / session management identified | Informational. |

## Known limits

- **Upstream MCP servers** authenticate with one `Authorization` header value; OAuth to upstreams is not supported yet. Tool descriptions from an upstream are passed to agents as they are.
- **Allowed actions run before their receipt is written**, as the brief specifies. If that write then fails, the agent is refused and a health alert names the action and its connector reference (DECISIONS.md #15).
- **Rate limits are per process.** Several instances need a shared store (planned).
- **Daily limits are checked outside the chain lock**, so two simultaneous payments can both pass a limit they jointly exceed. Approvals are unaffected.
- **Key management:** org signing keys can be rotated (owner only; retired keys are kept for verification). They are wrapped through a `KeyProvider`; the shipped one uses a single master key from the environment. A cloud KMS provider plugs into the same interface (DECISIONS.md #36); signing inside an HSM is not done yet.
- **Webhook events between commit and enqueue:** if Elan1 Govern crashes in that instant, that event is not sent. The receipt itself is safe on the chain. An outbox table would close the gap (DECISIONS.md #29).
