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
| **S** | Forged SAML assertion (no signature, another key, edited after signing, signature wrapping) | The assertion itself must be signed by a certificate the owner saved (a signed response is not enough); node-saml/xml-crypto read only the signed content, refuse more than one assertion and more than two transforms; issuer must be the IdP's entity id | `web/saml.test.ts` "refuses unsigned assertions…", "…edited afterwards", "…wrong issuer" |
| **T** | SAML assertion replayed, sent unsolicited, or meant for another service | SP-initiated only: `InResponseTo` must equal the request id in an AES-GCM-encrypted, httpOnly cookie (10 min, one use); the assertion id and request id are stored until expiry and refused a second time; audience must be our SP entity id; `NotBefore`/`NotOnOrAfter` with at most 2 min skew, and 10 min after `IssueInstant` | `web/saml.test.ts` "refuses replays…", "refuses unsolicited answers…", "…wrong audience", "checks NotBefore and NotOnOrAfter…" |
| **T** | Login CSRF through the SAML ACS, which must accept a cross-site POST | Only the ACS skips the same-origin and CSRF-token checks (`crossSitePost: "saml-acs"`, public, no JSON body); it is authenticated by the signed answer to the request id in this browser's flow cookie, so an attacker's own valid assertion cannot be planted in a victim's browser. The flow cookie alone is `SameSite=None; Secure` (Lax on plain-http dev); the session cookie stays Lax | `web/saml.test.ts` "the ACS takes the IdP's cross-site form POST…" |
| **S** | SAML or SCIM used to take over accounts outside the org | The email must be in a DNS-verified domain of that org (OIDC and SAML proofs are shared, and a domain belongs to one org); SCIM cannot create users outside them either | `web/saml.test.ts` "refuses emails outside…"; `web/scim.test.ts` "refuses emails outside…", "one org's token never reaches…" |
| **E** | SAML or SCIM grants too much, or an admin escalates through them | JIT and SCIM users get a default role that is never Owner (SCIM: never Auditor); SCIM never deactivates or removes owners; only owners (fresh sign-in) can change the IdP or issue a SCIM token, since either can sign anyone in the domains in or out | `web/saml.test.ts` "…JIT never makes an owner"; `web/scim.test.ts` "links existing owners…", "owners save…; admins cannot" |
| **S** | Passwords used where the org requires SAML | "Require SAML for everyone" refuses passwords for its verified domains before the password is checked, and writes an `auth.refused` receipt each time (refused even if the receipt fails). Break-glass: owners with two-step sign-in may still use password + code, recorded as `auth.break_glass`; requiring SAML needs at least one. Known trade-off: an immediate refusal versus a password prompt tells a caller whether an address is a break-glass owner | `web/saml.test.ts` "Require SAML for everyone" |
| **S** | SCIM token stolen or guessed | 256-bit `scim_` token shown once, stored as a SHA-256 hash, compared in constant time, replaced at once on rotation; the receipt holds only its prefix. 300 requests/min per address (before the token is checked) and 600/min per org | `web/scim.test.ts` "SCIM bearer token" |
| **T** | SCIM requests forged from a browser | SCIM endpoints read no cookies or session at all, only the `Authorization: Bearer` token, so a browser cannot be made to send one | `apps/web/src/server/scim.ts` |
| **R** | Directory changes leave no record | Each SCIM create, deactivate, reactivate and remove is a receipt by `scim@directory.invalid`; if it cannot be written the change is undone | `web/scim.test.ts` "undoes the change…" |
| **E** | A person the directory deactivated signs back in through SSO | `active=false` removes the membership at once; SAML and OIDC just-in-time sign-in refuse to add it back while the SCIM row is inactive | `web/scim.test.ts` "active=false removes the membership…" |
| **D** | Flooding the SAML ACS or `auth.refused` receipts | The ACS and SAML start share the sign-in limits (10/min per address), and password attempts are limited per account (10 per 15 min), which bounds refusal receipts; SAML bodies over 512 KB and SCIM bodies over 64 KB are refused | `apps/web/src/app/api/auth/saml/acs/route.ts` |
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

### Approvals in Slack and WhatsApp

Chat is a doorbell: rules, decisions and receipts stay in Elan1 Govern. Both channels end in the same `resolveApproval` as the web app.

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **S** | A forged Slack click or WhatsApp reply approves an action | Slack: `X-Slack-Signature` v0 HMAC-SHA256 over `v0:{timestamp}:{raw body}` with the org's own signing secret, compared in constant time. WhatsApp: `X-Hub-Signature-256` HMAC-SHA256 of the raw body with the org's Meta app secret. Each org has its own interactivity / webhook URL, so the right secret is known before anything is parsed. Bad signature → 401, nothing runs | `gate/chat.test.ts` "refuses a bad signature…", "refuses bad signatures, old messages…" |
| **S** | Someone in the Slack channel, or with the business number, approves who shouldn't | The Slack user is mapped to a member only by an email Slack has **confirmed** (`users.info`, `is_email_confirmed`); bots and deactivated users never match. WhatsApp senders must match a number the member verified with a 6-digit code. Then the usual checks: member of this org, an approver role, named in the rule's group. Clicks from another Slack workspace are ignored | `gate/chat.test.ts` "refuses non-approvers, unconfirmed emails, bots and strangers…", "refuses a member of another organisation…" |
| **T** | A captured request is replayed | Slack timestamps more than 5 minutes off are refused; WhatsApp messages whose signed timestamp is more than 5 minutes old are ignored. A replay inside the window hits the single-use claim on the approval row, so it can never decide twice | `gate/chat.test.ts` "a double click (and a replay inside the window) resolves once", "…old messages…" |
| **E** | A high-impact action is approved from a phone with no second look | Chat buttons appear only for ask rules with `approve_in_chat: true`, and publishing refuses that for any rule reaching a tool tagged `deletes`, `changes_access`, `changes_production` or `personal_data`, or `moves_money` without an upper amount. The guard re-checks against today's tags when it holds the action, and `resolveApproval` refuses a chat decision on any approval not marked chat-approvable. Quota asks are never chat-approvable | `core/chat.test.ts`; `gate/chat.test.ts` "refuses … chat approval for an app-only rule" |
| **R** | An approver denies deciding from chat | The approval receipt carries `details.channel` (`web`, `email`, `slack`, `whatsapp`) and the chat user id (Slack `team/user`, or `wa:` + a keyed hash of the number) next to the approver's email | `gate/chat.test.ts` "a signed Approve…", "sends reply buttons only when allowed…" |
| **I** | Bot tokens, app secrets or phone numbers leak | Secrets are AES-256-GCM encrypted under the gate master key (AAD bound to org and channel), write-only in the console. Numbers are stored encrypted plus a keyed hash and last four digits; receipts, logs and API errors never contain them (Meta error text, which can repeat a number, is reduced to its numeric code). Verification codes are stored as an HMAC | `gate/chat.test.ts` "connect stores the secrets encrypted…", "number verification…", "connect validates input and the token" |
| **I** | SSRF through the chat clients | Outbound calls go only to `SLACK_API_URL` and `WHATSAPP_API_URL`, which must be `https://slack.com/…` and `https://graph.facebook.com/…` in production (checked at start-up); a path that would leave the base is refused; redirects are never followed; 10 s timeout. Nothing is fetched from a URL inside an inbound payload | `gate/chat.test.ts` "chatFetch never leaves the configured API", "production only accepts slack.com and graph.facebook.com" |
| **D** | Slack or Meta is slow or down, or the endpoints are flooded | Messages are queued after the approval is written and sent by pg-boss jobs with their own retry state (6 attempts with backoff); the guard never waits, and email still goes out. Inbound endpoints are rate limited (300/min) and answer Slack within its 3-second window, deciding in the background. Codes: 3 per 15 minutes, 5 tries each, 10-minute expiry | `gate/chat.test.ts` "retries Slack failures with backoff…", "number verification…" |
| **E** | A viewer connects a chat channel to watch or approve | `notifications:manage` is owner/admin only, with a sign-in within 10 minutes; each change writes a `chat.connected` / `chat.disconnected` receipt. Approvers manage only their own number | `web/policy.test.ts`; `e2e/security.spec.ts` authz matrix |

### Behaviour alerts and the emergency stop

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **D** | An attacker (or a careless insider) triggers the emergency stop to halt every agent: a denial of service | `emergency:stop` is owner/admin only, needs a sign-in within 10 minutes and the word `STOP` typed; the stop is one `emergency.stop` receipt naming who did it, every owner and admin is emailed at once, and resume restores exactly the agents it paused | `web/policy.test.ts`; `e2e/security.spec.ts` authz matrix; `e2e/alerts.spec.ts`; `gate/behaviour.test.ts` "emergency stop" |
| **D** | Behaviour checks slow the guard down or make calls fail | Checks run after the receipt commits, in the background; a slow or throwing check never delays or fails the call and becomes a health alert. Alerting fails open; the decision path stays fail-closed | `gate/behaviour.test.ts` "stays fast and fail-closed" |
| **D** | An agent floods alerts (or emails) | One open alert per agent, detector and key (a unique index); repeats update it; low alerts send no email | `gate/behaviour.test.ts` "does not raise it twice", "stored once" |
| **E** | A viewer silences alerts, or turns auto-pause off | Acknowledge/resolve need `alerts:acknowledge` (owner, admin, approver); thresholds `alerts:configure` and auto-pause `agents:manage` (owner, admin); each change is a receipt | `web/policy.test.ts`; `e2e/security.spec.ts` |
| **R** | An alert or automatic pause leaves no trace | `alert.created`, `alert.acknowledged`, `alert.resolved`, `agent.paused` (naming the alert), `emergency.stop` and `emergency.resumed` are signed receipts written in the same transaction as the change | `gate/behaviour.test.ts` |
| **I** | Alerts leak personal data | Detectors read only the minimised receipts (display identifiers such as a vendor name or a domain); nothing new is stored in receipts | `core/behaviour.test.ts` "summaries" |
| **I** | One tenant sees another's alerts or incidents | `BehaviourAlert` and `Incident` are tenant models behind `forOrg` | `db/isolation.test.ts`; `gate/behaviour.test.ts` "alerts stay inside their organisation"; `web/alerts.test.ts` |

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

### Rule suggestions

Suggestions are learned from approvals, so they are a way for history to change policy. Two properties keep that safe: a suggestion can never weaken a refuse rule, and it can never publish itself.

- **It cannot weaken a refuse rule.** The miner only edits ask rules that name one tool, and only to turn a subset of them into allow. Refuse rules are copied unchanged, and the engine's strictest-wins rule means a refuse that matches still wins over any added allow. Exceptions (`unless`) are rejected by the rulebook schema on anything but an ask rule. Caps stay at or below the largest approved amount and below any refuse threshold. Tools tagged `deletes`, `changes_access` or `changes_production` are never suggested, and counterparty-only drafts are never made for tools that move money.
- **It is checked against history.** Before a draft is stored, every past approval of the agent is replayed against it: a draft that would allow anything a person rejected or left to expire, or change any other decision, is thrown away. Property tests check this, and that `decide()` never allows what a refuse rule refused, over random histories and rulebooks.
- **It cannot publish itself.** Applying a suggestion only marks it applied (with a receipt) and opens its drafted rulebook in the builder. Publishing is the existing signed step, needs `rulebooks:publish`, and runs the same validation and high-risk checks as any other rulebook. A draft made from an older rulebook version is refused.
- **It adds no personal data.** The miner reads only the argument summaries already stored on approvals (amounts, ids, a domain, a vendor display name). Display names are shown to people as context and never used in a rule.

| | Threat | Mitigation | Tested in |
|---|---|---|---|
| **T** | A suggestion loosens policy past what people approved | Only ask to allow for always-approved subsets; replay check; refuse rules untouched; schema rejects `unless` outside ask rules | `core/suggest.test.ts` (unit and property) |
| **E** | Someone without publish rights changes a rulebook through a suggestion | Applying creates a draft only; `suggestions:manage` (owners, admins) to open or dismiss; publishing still needs `rulebooks:publish` | `gate/suggestions.test.ts`; `web/policy.test.ts`; `e2e/security.spec.ts`; `e2e/suggestions.spec.ts` |
| **I** | One org sees another's suggestions | `RuleSuggestion` is a tenant model read and written through `forOrg` | `gate/suggestions.test.ts` "keeps each org's suggestions to itself"; `db/isolation.test.ts` |
| **R** | Nobody can tell who opened or dismissed a suggestion | `suggestion.applied` and `suggestion.dismissed` admin receipts on the chain | `gate/suggestions.test.ts` |

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
| gitleaks, semgrep | Slack and WhatsApp credentials in `apps/gate/test/chat.test.ts` and `apps/web/test/notifications.test.ts` | Made-up values for signature and form tests. Current files build them at runtime or carry an inline `gitleaks:allow` / `nosemgrep` note with the reason; the one older commit that had them as plain literals (`d7ae6b1`) is allowlisted by hash in `.gitleaks.toml`. |
| gitleaks | Sample keys in `apps/console/src/features/developers/` and `key_spec: 'ECC_NIST_EDWARDS25519'` in the console's upgrade data | The keys are made-up examples printed in the developer docs (inline `gitleaks:allow`). `ECC_NIST_EDWARDS25519` is the public name of an AWS KMS key type, allowlisted by regex in `.gitleaks.toml`. |
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
