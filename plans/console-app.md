# Put the approved console-app front end on the real Elan1 Govern backend

## Context
The approved front end is `elan1-govern-web/` on the **console-app** branch of github.com/Ashoke-elan1/elan1-govern (commit 90bc969). It is React 18, Vite and Tailwind 3.
Today it runs entirely on a mock in the browser: about 400 operations in `src/api`, `src/mock` and `features/*/backend.ts`, kept in localStorage.
Our repo (github.com/Hasif-Elan1/elan1-govern, public) has the real product: the Fastify guard (`apps/gate`), the Next.js console with its API routes (`apps/web`), Postgres and Prisma (`packages/db`), and the engine, receipts and verifier (`packages/core`).
Our backend covers only about half of what console-app shows.

**Goal:** console-app becomes our only UI, every screen runs on a real backend (L1, L2, L3 and Sovereign included), and the whole product runs end to end on this machine.
The work goes on a new branch, **`console-app`**, in our repo, pushed after every phase.

## Decision log (answered by the user)
| Decision | Chosen | Why |
|---|---|---|
| Screens with no backend yet | **Build all their backends now** | User's call |
| Where the code lives | Copy `elan1-govern-web/` into our repo as **`apps/console`**, branch `console-app`, pushed to Hasif-Elan1/elan1-govern | One monorepo, shared types |
| Business docs (`analysis/`, PDFs, xlsx, brand book) | **Not copied** | Our repo is public |
| TSA, KMS, HSM | Interfaces with **local implementations** (software TSA, env-key KMS, software HSM) plus **real adapters switched on by config** (FreeTSA and DigiCert RFC 3161, AWS KMS) | No cloud account here |
| Billing | **Internal ledger only**: meter, GST invoices as PDFs, disputes, credit notes, billing desk; no payment collection | Matches the screens |
| New libraries | Allowed: `@node-saml/node-saml`, `pkijs`, `asn1js`, `@aws-sdk/client-kms`, exact pins at least 7 days old; Shamir written in-house | User approved |
| Old Next.js pages | **Deleted at cutover**. Next.js stays as the API server and hosts the console's built files on the same address | One UI |

## Technical decisions (mine; correct me if any is wrong)
1. **Same origin.**
   - Next.js serves the built SPA: assets under `public/console/`, and a catch-all route returns `index.html` with the CSP nonce.
   - In dev, Vite (port 5190) proxies `/api` to `:3000`.
   - This keeps the existing cookies, CSRF and Origin checks, CSP and HSTS exactly as they are. No CORS is added.
2. **The UI keeps its function signatures.** `src/api` gains an HTTP client (`src/api/http.ts`: CSRF header from the `gate_csrf` cookie, `{reauth:true}` → re-auth dialog, `{error}` → typed error). Each `api.*` body becomes a `fetch`, so screens change only where they bypass `api`.
3. **Mock bypasses removed.** These are the 124 files importing `@/mock/*` and about 65 calling `db.*`.
   - `mock/users` (80 files) is replaced by a session store fed by `GET /api/me`, plus a directory API.
   - `db.subscribe` is replaced by **SSE** at `/api/stream`: org-scoped, with Postgres `LISTEN/NOTIFY` fired by the chain writer and by admin writes.
   - The mock stays only for unit tests and Storybook-style fixtures, never in the production bundle (a build check fails if `src/mock` is reachable from `main.tsx` in live mode).
4. **Logic that belongs on the server moves there**, reusing existing code:
   - rule evaluation: `packages/core/src/engine.ts` and `replay.ts`, via `/api/rulebooks/:slug/replay` and a new `try` route;
   - signing and chain: `packages/core/src/receipt.ts` and `apps/gate/src/chain.ts`;
   - TOTP and lockout: `apps/web/src/server/session.ts` and the auth routes;
   - pricing: a new `packages/core/src/billing.ts`, ported from console `src/lib/pricing.ts` and `features/billing/chainMeter.ts`.
   - The UI keeps only **offline verification**. It imports `@gate/core`'s browser build (`packages/core/src/browser.ts`), and `verify6` / `seal.ts` / `merkle.ts` move into `packages/core` so the CLI, the server and the browser share one implementation.
5. **Receipt formats.**
   - The L1 receipt chain stays our current format (console's `Receipt` type already matches: seq, prev_hash, kid, hash, sig).
   - Seal v6 (16 fields, length-prefixed preimage, salted payload hash) is added for L2 and above as a parallel seal chain.
   - The 64 test vectors in console-app become core tests.
   - `govern verify` gains Seal v6 and the six result codes; old bundles still verify.
6. **Every new endpoint goes through `route()`** in `apps/web/src/server/api.ts`: rate limit, origin, CSRF, session, permission, fresh sign-in, zod body.
   - Tenant reads go through `forOrg`.
   - Writes that change evidence go through gate `/internal/orgs/:org/...`, signed with `INTERNAL_API_SECRET`.
   - Every admin action writes a receipt.
7. **Roles and levels.**
   - Console `src/lib/permissions.ts` (22 permissions, 5 roles) becomes the source of truth. It is merged with `apps/web/src/server/policy.ts` into `packages/core/src/permissions.ts`, and the same code is used by the UI and the API.
   - A new **platform staff** role (Elan1 billing desk, notices) lives outside orgs.
   - The org level (`l1|l2|l3|sovereign`) is a column on `Org`; level changes are receipts.
8. **Demo data.** console-app's four demo orgs and their people become `pnpm db:seed` data, with real argon2 passwords from `.env`. The "Demo accounts" panel and the demo authenticator show only when `APP_ENV !== production`.
9. **Execution.** I orchestrate with sub-agents in git worktrees, one vertical slice each, with `?connection_limit=3` on their test databases. I merge each slice into `console-app` only when it is green.

## Decisions made during execution
| # | Decision | Why |
|---|---|---|
| E1 | The console's `@vitejs/plugin-react` is dropped. JSX is compiled by Vite's built-in esbuild, so dev does a full reload instead of Fast Refresh | plugin-react pulls in Babel, whose `semver@6.3.1` fails the workspace `trustPolicy: no-downgrade` |
| E2 | The console uses the repo's Vite (7.3.7) instead of 5.4.21. TypeScript stays 5.6.3 for the console only | vite 5.4.21 fails the trust policy. TS 5.9 rejects 9 typed-array uses in the approved code; those are fixed when that code is touched |
| E3 | Override `c12>chokidar` to 4.0.1 (it has provenance), keeping the trust policy unchanged | Adding a workspace package re-resolves prisma's `c12`, and `chokidar@4.0.3` has no provenance while 4.0.1 does |
| E4 | `@codemirror/view`, `@codemirror/language`, `@codemirror/lint` and `@lezer/highlight` become direct dependencies | The console imports them, and npm hoisting had hidden that |
| E5 | Live mode keeps the console's synchronous `db` accessors by turning `mock/db.ts` into a **server-synced cache**: `getDB(org)` returns the last server snapshot (`GET /api/console/orgs/:org/state`); writes call the API; SSE events trigger a re-fetch and `touch()`. Features with no backend have their mock domain logic **ported to the server** (state in Postgres), so behaviour matches the approved UI exactly. Receipts are always written by the real gate chain, never by the client | The screens read the store synchronously in about 65 files. Rewriting each one would change the approved UI and multiply risk |

## Phases
Each step: lint, typecheck, unit tests and the step's e2e spec are green, then commit. Each phase ends with a push to `origin/console-app` after `gitleaks detect` over the branch history (the repo is public).

### Phase 0: Bring the code in (S)
Verified when: `pnpm --filter @gate/console build` passes and the console runs on mock at :5190 from our repo.
- 0.1 Create branch `console-app` from `main`. Copy `elan1-govern-web/` at 90bc969 → `apps/console` (exclude `.claude/`). The commit message credits Ashoke-elan1/elan1-govern@90bc969.
- 0.2 Make it a pnpm workspace package `@gate/console`: remove `package-lock.json`, pin every dependency exactly at a version at least 7 days old, add it to ESLint, typecheck and CI (`.github/workflows/ci.yml`), and add `pnpm dev:console`.
- 0.3 Push. Blocked by: none.

### Phase 1: The seam (risk first)
Verified when: the seeded owner signs in on the new console against the real API, Today shows real counts, and a receipt written by `pnpm demo` appears live through SSE.
- 1.1 Same origin: Next.js serves the SPA (catch-all plus static), the middleware stops redirecting SPA paths (the SPA's `RequireAuth` handles it; `/api` stays protected), and the Vite proxy is set up. `security.spec` header tests still pass. (S)
- 1.2 `src/api/http.ts` and a `VITE_DATA=mock|live` switch, with live as the default in builds. (S)
- 1.3 Real auth: `GET /api/me`, login, TOTP, re-auth, logout, OIDC SSO, invites, forgot and reset (new: email token through nodemailer). `features/auth/registry.ts` is removed from the live path, and `mock/users` consumers are replaced by the session store and directory API. (L → split per folder: shell, approvals, activity, rest)
- 1.4 SSE `/api/stream` with LISTEN/NOTIFY replaces `db.subscribe`. (M)
- 1.5 Seed the four demo orgs at their levels, plus the auditor and portal users. (M)

### Phase 1 design (refined at pickup, 29 Oct)
A probe showed that the console's domain code (`src/api`, `src/mock`, `src/lib` and the `features/*/backend.ts`-style modules) runs under Node with small browser shims. All four demo orgs build in about 300 ms, each 0.5–1 MB of JSON, mostly receipts. So:
- **Domain on the server (1.1).**
  - `apps/console/src/server/entry.ts` exports the domain: `api`, `db`, `orgApi`, `work`, `agents`, `assessments`, `sovereign` and `deployment` backends.
  - esbuild bundles it to `apps/console/dist-server/domain.mjs` (Node, with an in-memory `window`/`localStorage` shim), exported as `@gate/console/server`.
  - `mock/db.ts` gains a persistence adapter (`setPersistence({ load, save })`). The browser keeps localStorage in mock mode; the server stores each org's document in Postgres (`ConsoleState { orgId, doc Json, version, updatedAt }`).
  - Each operation runs under a per-org lock (an in-process mutex plus `pg_advisory_xact_lock`): load if the version changed, run, save, `NOTIFY console_events`.
- **One RPC door (1.2).**
  - `GET /api/console/state?org=` returns the org document. `POST /api/console/rpc { op, args }` runs a whitelisted operation. `GET /api/console/stream` is SSE.
  - An op manifest is generated at build time with the TypeScript compiler API. It lists each exported operation and the positions of its `orgId` and actor parameters (`userId`, `by`, `actorId` …).
  - The server **overwrites every actor argument with the session user** and refuses any `orgId` the user isn't an active member of. The domain's own permission checks then run as that user.
  - All of it goes through `route()` (origin, CSRF, rate limit, session).
- **Client live mode (1.3).**
  - `VITE_DATA=live` wraps every operation as RPC. The `db` cache holds the last snapshot and re-fetches on SSE, so screens keep their synchronous reads unchanged.
  - Writes screens make directly (`db.touch`, `db.logAdmin`, mutate-then-persist) are inventoried and turned into RPCs.
- **1.3 refined after the write inventory.** Screens write in about 150 places across 45 files: about 64 direct `db.*` calls, about 20 in-place mutations, and about 67 calls to mutators in `@/mock/*`. Six UI files are hidden op modules: `connectors/ops.ts`, `keys/tokenStore.ts`, `inventory/ops.ts`, `packs/config.ts`, `records/ext.ts` and `auth/registry.ts`. So the client works like this:
  - **Async ops are pure RPC.** The result comes from the server.
  - **Sync mutators run locally and are also forwarded.** In live builds a Vite transform rewrites each exported function of a listed op module as `export function f(...a) { return __live.call('mod.f', f__impl, a) }`. Function declarations stay hoisted, which the mock's import cycles need. The outermost call that caused an `emit` locally is sent to the server, and the server re-runs it as the session user. When the server answers, the snapshot is re-synced; if the server refuses, local changes are discarded and the error is shown.
  - **The server persists and notifies only when the document actually changed** (hash before and after). Idempotent writes made during reads (lazy seeds, `sweepPilot`) therefore don't loop.
  - **In-place UI mutations become named ops** in op modules. That is the A1 list: YouPage Slack link, InvitePage, onboarding state and complete, compliance, records and evidence export logs, redaction, levelModel, session sign-out.
  - **Domain localStorage moves into the document:** export seqs, auditor papers, the defect-report counter, the global maintenance window. So does module-level domain state such as the `stepUps` map.
  - **Live mode stops** `startLive` (real traffic comes from the gate), the mock session timers, `resetDemo` and the demo outbox.
- **Real identity (1.4–1.5).**
  - Demo users, orgs and memberships are seeded into the real `User`/`Org`/`Membership` tables, with the console's ids (`u_ananya`, `org_demo` …) and argon2 passwords from `.env`.
  - Sign-in uses `/api/auth/login`. `/api/me` feeds the session store. The directory (`mock/users`) is served from the database in the snapshot.
- **Truth moves to real tables domain by domain in Phase 2**, receipts first (the real gate chain replaces the document's generated chain). This branch carries mixed sources only until Phase 8; the final build has no document-held receipts.

### Phase 2: Vertical slices on the existing backend
Each slice:
- adds read endpoints that wrap `apps/web/src/server/queries.ts`, `alerts.ts`, `inventory.ts` and `suggestions.ts`;
- adapts write routes to console's shapes;
- rewires the screens and deletes their mock use;
- ports or writes its Playwright spec.

| Slice | Covers |
|---|---|
| 2.1 | Today, Approvals list and detail, `/approve/:token`, approval outbox (email, Slack, WhatsApp) |
| 2.2 | Activity, receipt page, chain explorer, `/verify` (core browser verifier) |
| 2.3 | Rulebooks: list, detail, draft, try, test on past actions, publish, suggestions |
| 2.4 | Agents, add agent, keys, kill switch, auto-pause, agent map |
| 2.5 | Alerts, detectors, emergency stop (engage, widen, lift) |
| 2.6 | Connectors and MCP upstreams (sync, tool enable and tags) |
| 2.7 | AI inventory (plus discovery), assessments (create, answer, submit, review, reopen) |
| 2.8 | Compliance coverage, framework pages, reports (PDF) |
| 2.9 | Organisation: people and roles, invites, suspension, sessions, OIDC SSO, channels, webhooks (test, resend, dead-letter, roll secret), retention, `/you` |
| 2.10 | Evidence, exports, auditor workspace and client switcher |

Blocked by: 1.x. Slices 2.1–2.10 can then run in parallel.

### Phase 3: L1 features new to the backend
| Slice | Covers |
|---|---|
| 3.1 | Rulebook reviews, the approver directory and groups, named lists |
| 3.2 | Approvals extended: escalation, re-route, extend once with a reason, delegation, reversal within 30 days, the same-person rule, two-person policy, step-up, blast radius |
| 3.3 | Work queues: Not done, Reviews, maintenance windows, outage drill, approver telemetry and rubber-stamp sampling |
| 3.4 | Incidents with the CERT-In 6-hour clock, two-person break-glass, write failures |
| 3.5 | Keys: platform tokens `gctl_`/`gops_`, sandbox keys `sk_sbx_`, the key-compromise flow, planned successors, DNS TXT and `/fingerprint/:org`, integrity runs, evidence requests, bundle split and pre-flight |
| 3.6 | Records: DPDP erasure (salt destruction), consent ledger, declarations, retention mapping (never below 8 years) |
| 3.7 | Public pages: developer portal content, refusal register, `/status` (real health), legal pages, maintenance and offline, onboarding by level, Ask Govern (templated, no LLM, as built) |
| 3.8 | SAML 2.0 and "Require SAML for everyone" with break-glass owner, SCIM token |

Each slice comes with Prisma migrations, gate internal routes, receipts and tests. Guard-side rules, such as the same-person rule, the stop and sandbox keys, go in `apps/gate`.

### Phase 4: Billing (internal ledger)
Verified when: the meter for each demo org equals the chain count, and an invoice PDF matches console's pricing rules.
- 4.1 `packages/core/src/billing.ts`, ported from console pricing: refusal costs 0.4, GST, seats pro rata.
- 4.2 Invoices, discounts, held invoices, disputes, credit notes, and a billing desk for platform staff.
- 4.3 Pilot at ₹0: the guard **hard-stops at 2,000 actions**, enforced in `apps/gate`. Sandbox calls are metered at ₹0.

### Phase 5: L2 Attested
- 5.1 Move Seal v6, Merkle and `verify6` into `packages/core`, with the 64 vectors as tests. The seal chain is written next to receipts once an org is at L2.
- 5.2 Timestamping: a `TimestampAuthority` interface, a local RFC 3161 signer (pkijs), and FreeTSA and DigiCert adapters switched on by env. Merkle batches go to two TSAs as a pg-boss job; one TSA = degraded.
- 5.3 Custody: an AWS KMS `KeyProvider` (`@aws-sdk/client-kms`) behind config. The existing env provider stays the default.
- 5.4 Assurance levels, the upgrade wizard and the L1→L2 close-out (bind key, notices, switch, first ten, first bundle, closing record, rollback). Dual-control publish. Successor keys confirmed by a second person.
- 5.5 Regulatory packs: dry run at L1 and live from L2 in the guard. Pack factory, portfolio, pilot steps, profiles (order, issue, withdraw). Verifier profiles.
- 5.6 The 8-member evidence bundle with `lexicon.json`. `govern verify` gains the six codes (PASS variants, FAIL_INTEGRITY, FAIL_PROFILE, INCOMPLETE, UNSUPPORTED, USAGE).

### Phase 6: L3 Proven
- 6.1 Earned autonomy, enforced in the guard:
  - grants and two-person graduation (at least 90 days, 200 records and 100 approvals);
  - a 30-day supervised period that samples 1 in 10 calls;
  - breach revoke and a re-proposal cooldown;
  - A0 recorded below L3.
- 6.2 Counterparties: register, seats, issuing receipts across orgs, accept, refuse, revoke, dispute, standing.
- 6.3 Selective disclosure (committed fields), plus portal sessions for counterparties, regulators and partners at `/counterparty/:token`.
- 6.4 Customer-held keys: in-house Shamir 3-of-5 ceremony, with the software HSM behind the `KeyProvider` interface.

### Phase 7: Sovereign
- 7.1 A deployment profile `GATE_PROFILE=sovereign`:
  - a deny-all egress allow-list enforced in every outbound helper (webhooks, upstream MCP, chat, SMTP, TSA, SSO), with an egress log;
  - an internal-only identity provider and email;
  - a local TSA.
- 7.2 Signed update bundles: import, stage, apply and rollback. Signed usage and chain-head statements, residency, tenant notices, handover.

### Phase 8: Cutover and the end-to-end run
Verified when: the full journey list below passes in one `pnpm e2e` run on a fresh database, all scanners are clean, and the branch is pushed.
- 8.1 Delete the old Next.js pages and components and keep `src/server`, `src/lib` and the API routes. Move the security authz matrix to API level plus SPA routing checks.
- 8.2 Port or replace every e2e spec: alerts, builder, chat, demo, flows, governance, platform, suggestions, security. Add journey specs per demo org: the L1, L2, L3 and Sovereign journeys from console's README, the auditor across four clients, and portals.
- 8.3 Docker compose and Dockerfile build the console into the web image. Update the README, GUIDE, ARCHITECTURE, SECURITY threat model, DECISIONS (one entry per hard-to-reverse choice above) and the screenshots.
- 8.4 Run `pnpm audit`, semgrep, gitleaks and the ZAP baseline. Fix what they find. Push.

## Verification (whole program)
- Start Postgres, Mailpit, `pnpm --filter @gate/gate start` and `@gate/web start` (see the gate-dev-environment memory).
- `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` all green.
- `pnpm demo` runs its 5 steps against the new console, and the approval is made in the new UI.
- Sign in as each demo account, walk its journey, export a bundle and check it with `govern verify` (L1 and Seal v6).
- After each phase, push `origin/console-app` and confirm the commit is there with `gh api repos/Hasif-Elan1/elan1-govern/branches/console-app`.

## Not yet specified (researched when each phase starts)
- Phase 7: what "the bank's own HSM" needs beyond the software HSM (PKCS#11?). For now it's fog; only the interface is built.
- Phase 5.5: the exact pack content for each regime comes from console's `mock/packsFactory.ts` as built; legal accuracy stays marked "Draft — needs legal review".
- Phase 3.7: developer portal copy is taken as built in console-app.

## Always / Never
- **Always:** the approved console look and copy kept as built; default refuse; tenant isolation through `forOrg`; a receipt for every admin action; exact dependency pins; a gitleaks scan before every push.
- **Never:**
  - copy `analysis/`, PDFs, xlsx, the brand book or `.claude/` into our repo;
  - push to `main` or open a PR (not asked);
  - mix mock and real data in a live build;
  - add payment collection;
  - change internal identifiers (`@gate/*`, `GATE_*`, `gate-signature`).

## Progress
| Phase | Status |
|---|---|
| 0 Import | done: 372fe48, pushed |
| 1 Seam | pending |
| 2 Existing backend slices | pending |
| 3 New L1 backends | pending |
| 4 Billing | pending |
| 5 L2 | pending |
| 6 L3 | pending |
| 7 Sovereign | pending |
| 8 Cutover and e2e | pending |

At the start of execution this plan is committed into the repo as `plans/console-app.md`, and the Progress table is kept current.
A memory note is also saved: "console-app (Ashoke) is the approved front end".
