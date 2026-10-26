# Decisions

Where the brief was ambiguous, the simpler option was picked and noted here.

1. **`pnpm run setup`, not `pnpm setup`.** `pnpm setup` is a built-in pnpm command (it edits your shell profile) and cannot be overridden by a script. The one-command start is `pnpm run setup && pnpm dev`.
2. **A shared `packages/db`.** Both the web app and the gate service read the same tables, so the Prisma schema, the tenant helper `forOrg()` and the chain writer live in one package.
3. **One writer for the chain.** Only the gate service holds `GATE_MASTER_KEY`, which decrypts each org's Ed25519 key. The web app never signs anything: approvals, admin actions, rulebook publishing and org creation go through the gate service's internal API (HMAC-authenticated).
4. **One key per org.** The org's Gate key signs receipts, checkpoints, evidence manifests and rulebooks. `gate sign` and `gate keygen` work with any key file, for teams that sign rulebooks offline and for tests.
5. **Receipt kinds.** Receipts carry a `kind`: `decision` (the guard's answer), `approval` (the second receipt of an ask), `outcome` (an SDK agent reporting what happened after `gate.check()`), `admin` (rulebook signed, connector added, role changed and so on).
6. **Privacy in summaries.** A receipt keeps display identifiers (bill id, vendor id, amount) and the values the rules inspected. For `to_domain_in` only the recipient's domain is kept, and for `fields_include` only the names of changed fields, never their values.
7. **Limits.** `daily_payments_inr` counts successful `zoho.record_bill_payment` calls since midnight IST. When a limit turns an allow into an ask, the first approver group in the rulebook approves it, with a 24h expiry. With no approver group it is refused.
8. **"Today" is India time** (Asia/Kolkata) for every org.
9. **Tenant isolation is enforced in code and in a test.** `forOrg(orgId)` is a Prisma client extension that ANDs `orgId` into every filter and sets it on every create. A test fails if any file outside `packages/db` touches a tenant model on the raw client.
10. **Versions.** Latest patches of majors with stable, well-known APIs: Next.js 15, React 19, Prisma 6, Zod 3, Vitest 3, ESLint 9, TypeScript 5.
11. **`APP_ENV`, not `NODE_ENV`, decides "production".** `next start` always sets `NODE_ENV=production`, so the check that refuses the `.env.example` sample secrets keys off `APP_ENV=production`.
12. **MCP refusals are tool results with `isError: true`**, carrying `structuredContent.gate = { decision, rule_id, reason }`. Agents (and LLMs) see tool errors; a JSON-RPC protocol error would hide the reason from the model.
13. **`gate.approval_status` is Gate's own MCP tool**, not a connector tool. It only reads the calling agent's own approvals, so it is not governed by the rulebook. It long-polls up to 30 s.
14. **Approved MCP calls run on approval.** When an approver says yes, Gate runs the held call immediately and writes the second receipt; the agent sees the result next time it asks. SDK checks are run by the agent, which then calls `record()`.
15. **Allowed actions run before their receipt is written** (as the brief orders it). If that write fails, the agent is refused and a health alert names the tool and the connector's reference, so a person can reconcile it. Every other path writes its receipt before anything runs.
16. **Mock connectors keep state in memory per org.** Restarting Gate resets the demo mailbox and ledger. `pnpm demo` also resets them first (dev only), so it can be run again and again.
17. **Seed data.** `pnpm db:seed` creates `owner@demo.test` (owner) and `ca@demo.test` (approver) in Demo Traders, plus a second org, Patel Agro Foods, where the CA is an auditor, to show the client switcher. Both passwords are `DEMO_OWNER_PASSWORD`.
18. **The gate service runs with `tsx`** in dev and in Docker. That avoids a separate build step for a small service.
19. **Rate limits are in memory, per process.** Fine for one instance; several instances would need a shared store.
