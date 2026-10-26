# Gate — build plan

Each phase ends with lint, typecheck and tests green, then a commit.

- [x] **1. Scaffold** — pnpm workspace, strict TypeScript, ESLint, Vitest, Prisma schema, docker-compose (postgres, mailpit, web, gate), `.env.example`, CI workflow.
- [x] **2. Core** — canonical JSON, Ed25519/SHA-256/AES-GCM helpers, rulebook schema + signing, rule engine (strictest wins, default refuse, limits), receipts, chain + bundle verifier. Unit and property tests, ≥95% coverage.
- [x] **3. Gate service** — Fastify, MCP server (streamable HTTP), REST Event API, agent auth, approvals with long-poll and expiry, serialized receipt chain, checkpoints, mock connectors, fail-closed paths. Integration tests.
- [x] **4. Web app** — auth (argon2, TOTP, sessions), onboarding, Today, Approvals, Activity, Agents + wizard, Rulebooks (visual builder, YAML, test panel, history, publish), Connectors, Evidence (bundle, PDF, compliance map), Settings, roles and client switcher.
- [ ] **5. Demo, seed, live connectors** — `pnpm demo`, seeded demo org, real Gmail and Zoho Books (zoho.in) connectors behind env, SDK and CLI.
- [ ] **6. Security** — headers, CSRF, rate limits, lockout, tenant-isolation guard, authz matrix, cross-tenant, approval-link, injection tests, scanners (pnpm audit, semgrep, gitleaks, ZAP), `SECURITY.md`.
- [ ] **7. Polish** — UI review, empty states, dark mode, Playwright end-to-end, screenshots, README.
