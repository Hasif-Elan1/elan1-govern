# Security

Gate sits between AI agents and the systems they act on, so it is built to **fail closed**: if it cannot be sure an action is allowed, the action does not happen. This document is the threat model (STRIDE), the controls, where each one is tested, and the current scanner results.

Report a vulnerability privately to **hello@elan1.ai**. Please don't open a public issue.

## Components and trust boundaries

```
 AI agent ──(API key, MCP / REST)──▶ Gate service ──(OAuth tokens, only here)──▶ Gmail · Zoho Books
                                        │   ▲
                         signed internal │   │ HMAC-signed requests
                                        ▼   │
 People ──(session cookie, CSRF)──▶ Web app ─┘          Auditor ──(zip)──▶ gate verify (offline)
                                        │
                                        ▼
                                   PostgreSQL (receipts, approvals, encrypted keys and tokens)
```

| Boundary | What crosses it | Trust |
|---|---|---|
| Agent → Gate | Tool calls with a bearer API key | Untrusted. Every call is checked against a signed rulebook. |
| Browser → Web | People using the console | Untrusted until signed in; role-checked on every request. |
| Web → Gate (internal API) | Approvals, publishing, org creation, exports | Authenticated with HMAC over method, path, body and time (±60 s). |
| Gate → Gmail/Zoho | OAuth access | Tokens exist only inside Gate, encrypted at rest. |
| Bundle → Auditor | Evidence zip | Verified offline with the org's public key. No trust in Gate needed. |

Secrets are split so no single component holds everything:

| Secret | Holder | Used for |
|---|---|---|
| `GATE_MASTER_KEY` | Gate only | AES-256-GCM encryption of each org's Ed25519 signing key and all OAuth tokens |
| `INTERNAL_API_SECRET` | Gate and web | HMAC on internal calls and OAuth `state` |
| `APPROVAL_LINK_SECRET` | Gate and web | HMAC on emailed approval links |
| `WEB_ENC_KEY` | Web only | AES-256-GCM encryption of TOTP secrets |

The web app **cannot sign receipts or rulebooks**. Only Gate can.

## STRIDE threat model

Test locations: `core` = `packages/core/test`, `db` = `packages/db/test`, `gate` = `apps/gate/test`, `web` = `apps/web/test`, `e2e` = `e2e/` (Playwright).

### Gate service (the guard)

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | An attacker calls tools as an agent | API keys are 256-bit random, shown once, stored as SHA-256, compared in constant time; revoked keys stop at once | `gate/api.test.ts` "creates agents with keys, rotates and revokes keys"; `gate/flow.test.ts` "rejects missing and bad keys" |
| **S** | Forged web→Gate internal call | HMAC over method + path + SHA-256(body) + timestamp, 60 s window | `core/canonical-crypto.test.ts` "request signing"; `gate/api.test.ts` "requires a valid signature bound to method, path and body" |
| **T** | Rulebook edited in the database to loosen rules | Rulebooks are Ed25519-signed by the org key; Gate refuses to load an unsigned or altered one and raises a health alert | `core/rulebook.test.ts` "loads only signed, valid rulebooks"; `gate/flow.test.ts` "a rulebook with a bad signature is not loaded" |
| **T** | Agent sends malformed or oversized arguments | Every tool's arguments are validated with a strict zod schema; invalid → refused with a receipt; 1 MB body limit | `gate/flow.test.ts` "invalid arguments are refused" |
| **R** | An action happens with no record | Every decision writes a receipt before returning; allowed calls write after running, and if that write fails the agent is refused and a health alert names the action (see DECISIONS.md #15) | `gate/flow.test.ts` "fail closed" |
| **I** | Agent reads OAuth tokens | Tokens never leave Gate: not in tool results, errors, approvals or health output | `gate/api.test.ts` "never shows them to the agent" |
| **I** | Receipts leak email bodies, prompts or bank details | Receipts keep only an argument hash, display identifiers and the fields a rule inspected (domain not address; field names not values) | `core/engine.test.ts` "refuses bank changes", "asks for replies"; `gate/flow.test.ts` "allow: runs the tool" |
| **D** | Agent floods Gate | Per-key rate limit (300/min) on MCP and REST; long-polls capped at 30 s | config in `apps/gate/src/app.ts` |
| **E** | Agent uses a tool no rule allows, or an unknown tool | Default is always `refuse`; strictest matching rule wins; limits only ever tighten | `core/engine.test.ts` properties; `gate/flow.test.ts` "unknown tool" |
| **E** | Gate breaks and lets things through | Any exception → refuse + receipt; if the database is down → refuse, nothing runs | `gate/flow.test.ts` "if the database fails mid-call…", "if the database is unreachable…" |
| **E** | A paused agent keeps acting | Status checked on every call | `gate/flow.test.ts` "a paused agent is refused instantly" |

### Approvals

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | Someone approves who shouldn't | Must be signed in, hold Owner/Admin/Approver, be named in the rule's approver group, and have signed in within 10 minutes (re-auth with password + TOTP) | `e2e/security.spec.ts` "approval links…"; `gate/flow.test.ts` "only listed approvers…" |
| **T** | Approval link forged or edited | Links are HMAC-signed `{org, approval, link, expiry}` | `e2e/security.spec.ts` (tampered, other approval) |
| **R** | Approver denies approving | The second receipt names the approver, time, result and (if so) that they set up the agent | `gate/flow.test.ts` "ask -> approve"; `e2e/security.spec.ts` self-approval |
| **E** | Link replay or use after expiry | Single-use DB row consumed atomically with the decision; expiry checked; expired approvals are refused with a receipt | `gate/flow.test.ts` "approval links are single-use", "ask -> expire"; `e2e/security.spec.ts` |
| **E** | Self-approval hides a conflict of interest | Allowed but warned in the UI and flagged on the receipt | `e2e/flows.spec.ts`, `e2e/security.spec.ts` |

### Web app

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | Password guessing | argon2id; lockout after 5 failures with doubling back-off (max 1 h); 10 attempts per account per 15 min; constant-time path for unknown emails; optional TOTP | `web/server.test.ts` "locks the account…"; `e2e/security.spec.ts` "login is rate limited per account" |
| **S** | Session theft | 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie, stored hashed; 7-day expiry; new token on every sign-in | `e2e/security.spec.ts` "session cookie is httpOnly and secure" |
| **T** | CSRF | Session-bound token in `x-csrf-token` (double-submit cookie when signed out) **and** same-origin check on every write | `e2e/security.spec.ts` "CSRF…" |
| **T** | SQL injection | Prisma parameterised queries only; no raw SQL with user input | `e2e/security.spec.ts` "SQL injection and XSS payloads…" |
| **T** | XSS | React escaping; strict CSP with per-request nonce and `strict-dynamic`; no `dangerouslySetInnerHTML` | `e2e/security.spec.ts` (payloads in every text field, no dialog fires) |
| **I** | One tenant reads another's data | Every tenant query goes through `forOrg(orgId)`, which ANDs the org into every filter; a test fails the build if code touches a tenant table on the raw client | `db/db.test.ts` "forOrg…"; `db/isolation.test.ts`; `e2e/security.spec.ts` "another org cannot…" |
| **I** | PII in logs | Structured JSON logs carry request ids and user ids, never emails, bodies or tokens; Gate redacts `authorization`, `cookie` and signature headers and logs paths without query strings | `apps/web/src/server/log.ts`, `apps/gate/src/app.ts` |
| **D** | Flooding sign-in or approvals | Per-IP limits (login 10/min, sign-up 5/min, approvals 30/min, writes 120/min) plus per-account limits | `web/server.test.ts` "rate limits"; `e2e/security.spec.ts` |
| **E** | A role does more than it should | One permission table (`apps/web/src/server/policy.ts`) used by every route; only owners can touch owners; the last owner can't be removed | `web/policy.test.ts`; `e2e/security.spec.ts` "authz matrix" (5 roles × every route and page) |
| **E** | Clickjacking, sniffing | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, HSTS, strict `Referrer-Policy`, `Permissions-Policy` | `e2e/security.spec.ts` "security headers are set" |

### Connectors

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | OAuth callback forged (login CSRF / account mix-up) | `state` is HMAC-signed `{org, connector, actor, expiry, nonce}`; wrong kind, expired or forged state is rejected | `gate/api.test.ts` "rejects forged, expired and mismatched OAuth state" |
| **T** | Header injection when sending email | CR/LF stripped from every header value | `connectors/live.test.ts` "refuses header injection in replies" |
| **I** | Tokens at rest | AES-256-GCM with 16-byte tags, AAD bound to org and connector | `core/canonical-crypto.test.ts` "AES-256-GCM" |
| **E** | Agent reaches beyond the allowed tools | Only 10 tools exist; no delete, forward or settings tools; Gmail scopes are `readonly` + `compose` | `gate/flow.test.ts` "lists only the allowed tools" |

### Evidence chain

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **T** | Receipt edited, deleted, reordered or inserted | SHA-256 hash chain over canonical JSON, Ed25519 signature on each hash; verifier names the first broken receipt | `core/chain.test.ts` (unit + property tests) |
| **T** | Tail of the chain cut off | Hourly signed checkpoints; signed bundle manifest records the last seq and hash | `core/chain.test.ts` "catches a truncated tail" |
| **T** | Gaps from concurrent writes | One transaction with a per-org Postgres advisory lock | `db/db.test.ts`, `gate/flow.test.ts` "concurrent calls produce a gap-free, valid chain" |
| **R** | Org disputes a bundle | Signed with the org key; the verifier prints the key fingerprint, which the Evidence page also shows | `packages/cli/test/cli.test.ts` |
| **I** | Bundle leaks personal data | Same minimised receipts as above | as above |
| **D** | Zip bomb sent to the verifier | Uncompressed size capped at 512 MB before reading | `packages/core/src/bundle.ts` |

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
| ZAP 10055 (Medium) | CSP `style-src 'unsafe-inline'` | React and Next.js set inline styles. Scripts, the real XSS vector, are locked to per-request nonces with `strict-dynamic`. |
| ZAP 10010 (Low) | Cookie without HttpOnly | That is `gate_csrf`, a double-submit CSRF token that same-origin JavaScript must read. The session cookie is HttpOnly. |
| ZAP 10024 (Info) | Sensitive information in URL | Emailed approval links carry a signed, single-use, expiring token. |
| ZAP 10111, 10112 (Info) | Authentication / session management identified | Informational. |

## Known limits

- **Allowed actions run before their receipt is written**, as the brief specifies. If that write then fails, the agent is refused and a health alert names the action and its connector reference (DECISIONS.md #15).
- **Rate limits are per process.** Several instances need a shared store (planned).
- **Daily limits are checked outside the chain lock**, so two simultaneous payments can both pass a limit they jointly exceed. Approvals are unaffected.
- **Key management:** org signing keys are encrypted with one master key from the environment. A KMS/HSM interface and key rotation are planned.
