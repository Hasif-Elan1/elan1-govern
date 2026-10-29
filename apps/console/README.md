# Elan1 Govern — front end

The complete front end for Elan1 Govern (ELAN1 AGENTIC TECHNOLOGIES PRIVATE LIMITED): the governance console, the public receipt verifier and the developer portal. Front end only — every backend call is served by a typed mock API in `src/api` that a real backend replaces later without touching any screen.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5190. Production build: `npm run build` (type-checks, then bundles to `dist/`).

## Demo accounts

One demo organisation per assurance level, each with its own people. The sign-in page lists every account under **Demo accounts**, grouped by level — one click fills the form. Accounts with two-step sign-in then ask for a 6-digit code: the code step shows a demo authenticator panel with the account's current code (RFC 6238, changing every 30 seconds) and a **Use this code** button, so no phone is needed. Any other 6 digits are refused, and a wrong code counts towards the same lock as a wrong password. The values live in `src/mock/users.ts` (`DEMO_ACCOUNTS`) and `src/features/auth/registry.ts` (second approvers, data protection officers and portal logins). Sign-in is simulated in the browser; these are not real credentials.

| Level | Organisation | Accounts | Walk this journey |
|---|---|---|---|
| L1 Guarded | Demo Traders Pvt Ltd | Ananya Rao (owner), Rahul Menon (admin), Venkat Iyer, Tom Whitfield, Arjun Nair (approvers), Fatima Sheikh (admin, DPO), Meera Shah (viewer) | Today, agents, emergency stop; write → test → review → publish a rulebook; approve a held payment (also by single-use link at `/approve/<token>`); try deciding outside your group (Arjun); a regulatory pack as a dry run; DPDP erasure (Fatima); the free auditor pack; the meter; upgrade to L2 |
| L2 Attested | Northbank Industrial Ltd | Rohan Kapoor (owner), Neha Bhatia (admin), Gaurav Sethi, Imran Qureshi (approvers; Imran is in Procurement, whose backup is Finance), Shalini Rao (admin, DPO), Pooja Malhotra (viewer), Deepak Jain (viewer, seeded as suspended: his sign-in is refused and recorded) | Signed and sealed records, two timestamp authorities and Merkle batches, AWS KMS custody, the L1→L2 boundary, dual-control publish, regulatory packs live, DPDP erasure, the 8-member evidence bundle and six-code verifier |
| L3 Proven | Kaveri Health Network | Dr Lakshmi Pillai (owner), Arvind Swamy (admin), Revathi Natarajan, Mohammed Rafi (approvers), Dr Sneha Varghese (admin, DPO), Nandini Hegde (viewer) | Earned autonomy: propose and approve a two-person graduation to A3 (≥90 days, ≥200 records, ≥100 approvals for the action class), the 30-day supervised period sampling 1 in 10 calls, one-press revoke (A4 and A5 not yet available); counterparties and receipts across organisations, selective disclosure, customer-held keys with a 3-of-5 ceremony |
| Sovereign | Deccan Cooperative Bank Ltd | Suresh Nambiar (owner), Anjali Kulkarni (admin), Prakash Deshpande, Farhan Siddiqui (approvers), Meenakshi Sundaram (admin, DPO), Sunita Joshi (viewer) | Deployment console: cluster, the bank's own HSM, local timestamp authorities, deny-all egress, air-gapped signed update bundles |
| All four | Desai & Co. | Kavita Desai (auditor) | Switch between the 4 clients, sample receipts, export a bundle and verify it with the six result codes |
| Portals | — | Nisha Menon (counterparty, Star Health), R. Venkataraman (regulator, RBI), Vikram Desai (partner, Northbank) | Open a disclosed receipt: only the revealed fields, the rest committed and checkable |

Actions you take are saved in this browser. **Account menu → Reset demo data** returns everything to the seeded state, and also clears sign-in locks, used two-step codes and demo passwords changed in this browser. An owner or admin can also unlock one person under People and roles (member menu) or Sessions (Locked sign-ins). SAML is on but not required at first; switching on **Require SAML for everyone** (Single sign-on › SAML 2.0) refuses passwords for the organisation's own addresses, except owners with two-step sign-in (break-glass).

## What is real in the demo

- Every receipt is sealed with a real Ed25519 key and hash-linked (SHA-256 over canonical JSON). `/verify` and the chain explorer verify it in the browser, and the tampered sample fails at the exact receipt changed. Wording follows the level: an L1 chain is "sealed in a hash chain by Elan1 Govern · not yet externally timestamped" — never "signed" or "independently verifiable" until DR-017 is decided — while L2, L3 and Sovereign records are described as signed.
- Rulebook "Try an action" and "Test on past actions" re-run a real rule evaluator (strictest wins, default refuse) over past decisions.
- New agent traffic arrives live every few seconds (toggle **Live** in the top bar).
- From L2 the Seal v6 record, Merkle batches, the two timestamp tokens and the six-code verifier (PASS with its variants PASS_UNANCHORED_TAIL and PASS_KEY_FROM_BUNDLE, FAIL_INTEGRITY, FAIL_PROFILE, INCOMPLETE, UNSUPPORTED, USAGE) run in the browser over the same chain; the 64 Seal v6 test vectors agree. A batch timestamped by only one authority is reported as degraded, not failed. Timestamp authorities, KMS and HSMs are simulated — the front end shows the target product, the backend for L2, L3 and Sovereign comes later.
- The meter counts actions from the chain for every plan, including Sovereign. A refused action costs 40% of the per-action rate; inside the allowance a refusal uses 0.4 of an included action. Supplier GSTIN and address on invoices are sample values.
- Other prices and rules the build follows: the L1 auditor pack is free and each L2+ evidence bundle is ₹2,500; a verifier profile is billed separately at ₹3,00,000 a year per regime (not included with a regulatory pack); packs install from L1 as a dry run ("no regulatory claim until L2") and run live from L2; DPDP erasure is available from L1; the counterparty register is listed from L1 and issuing receipts needs L3; an approval expires after 24 hours and can be extended once with a declared reason. Agent keys start `gk_` (production) or `sk_sbx_` (sandbox); the SDK is `@elan1/govern`.

## The four doors

The console has one grammar (Technology Memorandum §8.1): **every module presents the four doors and nothing else.** There is no fifth door and no Settings tab outside the grammar. The sidebar lists the doors; the shell draws a door bar above every page (number, name, question and the door's screens as tabs); each page's header kicker names its door.

| Door | Question | Shape | Screens |
|---|---|---|---|
| 01 Work | What needs me now? | Queues | Today `/` (`/work` redirects here), Approvals `/approvals` and one approval at `/approvals/:id` (rules at `/approvals/settings`), Reviews `/work/reviews`, Approvers `/work/approvers` (owners and admins), Not done `/work/not-done`, Alerts `/alerts` and `/alerts/:id`, Incidents `/incidents` and `/incidents/:id`, Channels `/work/channels` |
| 02 Records | What is the state of things? | Lists, forms, pinned fields | Records `/records` and `/records/:key`, Activity `/activity` (receipts at `/activity/:seq`), Rulebooks `/rulebooks`, one rulebook at `/rulebooks/:slug` and suggested rules at `/rulebooks/suggestions`, Connectors `/connectors` and `/connectors/:id`, AI inventory `/inventory` and one AI system at `/inventory/:id`, Assessments `/assessments` and `/assessments/:id`, Regulatory packs `/records/packs` (dry run at L1, live from L2) with one pack at `/records/packs/:id` and the pack portfolio at `/records/packs/portfolio`, Erasure `/records/erasure`, Consent `/records/consent`, Declarations `/records/declarations` |
| 03 Agents | Who and what is acting here? | Agents, people, keys, autonomy | Agents `/agents`, Add an agent `/agents/new` (needs the right to manage agents), one agent at `/agents/:slug`, Agent map `/agents/map`, Autonomy `/agents/autonomy` (L3+), Keys `/agents/keys`, People and roles `/agents/people`, Organisation `/agents/organisation`, Deployment `/agents/deployment`, Path to production `/agents/production`, Notices from Elan1 `/agents/notices` |
| 04 Assurance | Can I show someone this was done properly? | Chain standing, refusals, coverage, meter, exports | Auditor workspace `/auditor` (auditors), Overview `/assurance`, Proof `/evidence`, Chain `/activity/chain`, Timestamps `/assurance/anchors` (L2+), Refusals `/assurance/refusals`, Coverage `/compliance`, Verifier profiles `/assurance/profiles` (L2+), Counterparties `/assurance/counterparties` (register read-only from L1, issuing at L3+), Disclosure `/assurance/disclosure` (L3+), Coverage by framework `/compliance/:framework`, Meter `/billing` (owners and admins), Exports `/assurance/exports`, Evidence requests `/assurance/evidence-requests`, Assurance levels `/assurance/levels` with the upgrade wizard at `/assurance/upgrade` and the L1→L2 close-out at `/assurance/upgrade/closeout` |

Screens above an organisation's level still open: they show what the level adds and an upgrade path (owners only; no downgrade; every change of level is a recorded boundary).

Organisation settings live inside the doors: members and roles under Agents → People and roles, API and signing keys under Agents → Keys, SSO and sessions under Agents → Organisation, notifications under Work → Channels, webhooks and data retention under Assurance → Exports. Personal preferences are not a door: they live at `/you`, from the account menu. Old `/settings` and `/settings/<section>` links redirect to their new home (`SETTINGS_REDIRECTS` in `src/shell/nav.ts`).

Inside the console shell but not a door: `/403`, shown when a role cannot open a page.

Outside the doors: sign-in and account pages `/login`, `/signup`, `/forgot`, `/reset/:token` and `/invite/:token`, and first-run setup `/onboarding` (signed in); the single-use approval link page `/approve/:token`; the developer portal `/developers` (sections at `/developers/<section>`, one page per refusal code at `/developers/refusals/<code>`); the public receipt verifier `/verify`; the counterparty, regulator and partner portal `/counterparty/:token` (a real portal session, signed in from `/login`); the service status page `/status`; legal pages `/legal/:doc` (`privacy`, `cookies`, `sub-processors`), where `/legal` redirects to `/legal/privacy`; the printable key fingerprint page `/fingerprint/:org`; and the maintenance and offline pages `/maintenance` and `/offline`. Any other address shows a 404: inside the console when signed in, and a public 404 when signed out. The console installs on a phone (web manifest and a service worker that caches only the shell, never records).

## Built from the 28 Oct completeness check

Every item the check marked Missing or Partial is built, across L1, L2, L3 and Sovereign. In short:

- **Sign-in:** viewer accounts at every level; approval links use the same checks as `/login`; sign-out ends the session record and writes `auth.signed_out` on the sign-in org's chain; suspension is per organisation; portal password reset and portal sessions; **Require SAML for everyone** enforced with a break-glass owner; admin unlock; a seeded suspended account.
- **Approvals and Work:** before → after diff, same-person rule (flag at L1, forbid from L2), step-up for large or irreversible calls, blast radius, delegation, reversal within 30 days, an outage drill; emergency stop lifted by a second person from L2; two-person break-glass; CERT-In 6-hour clock on security incidents; approver telemetry with rubber-stamp sampling; maintenance windows.
- **Keys and evidence:** the key-compromise flow (declare, unsigned interval, 24-hour notice, rotate, close); planned successors; sign-call reconciliation; DNS TXT and printable fingerprints; evidence requests from auditors; bundle splitting, pre-flight checks and nightly integrity runs; the sealed L1 manifest.
- **Upgrade, records and packs:** the L1→L2 close-out (bind key, notices, switch, first-ten check, first bundle, closing record, rollback before closing); declaration withdrawal, retention mapping, consent ledger, hosting profiles; the pack factory, portfolio register, profile orders and issuing.
- **L3 and Sovereign:** precedent score (information only), 30-day re-proposal cooldown, autonomy breach revoke; receipt replay refusal, dual-control acceptance, disputes and revocation; Sovereign internal allow-list, egress log, update rollback, signed usage and chain-head statements, tenant notices.
- **Billing and developers:** discounts, held invoices, disputes and credit notes, the pilot (₹0, hard stop at 2,000 actions); sandbox calls metered at ₹0; path to production with conformance tests C1–C14; refusal register; MCP tool list; deprecation notices.

Choices the builders made where the documents were silent are listed in `../analysis/10-build-report.html`.

## Fixed from the 28 Oct night check

The 45 findings in `../analysis/superseded/11-completeness-check` were fixed that night. An independent check (`../analysis/superseded/15-fix-verification`) later found that five items across both checks still had a piece left; those were closed by the 17 changes in `../analysis/superseded/16-remaining-changes` (see below). The main fixes:
- **Emergency stop:** STOP and RESUME are accepted in any case, and the banner names a stop on selected agents.
- **Sovereign egress:** approval links go by internal email only, and single sign-on accepts only identity providers inside the network.
- **Approvers:** they can acknowledge and resolve alerts, and draft assessments. Held calls notify them in the demo outbox, where Slack and WhatsApp messages carry Approve and Reject buttons.
- **Packs:** they install and admit agents at L1 as a dry run. Installed packs' checks now decide live calls from L2; at L1 they record what they would have refused.
- **Autonomy:** below L3 the page shows no autonomy level.
- **Tokens:** control tokens (`gctl_`) and read-only operations tokens (`gops_`) are issued under Agents › Keys.
- **Key rotation:** rotating a `gk_` key needs the production review, and KMS rotations and key ceremonies publish a successor with the 30-day overlap.
- **Evidence and auditors:**
  - an L2+ export needs a completed integrity run over its range;
  - bundles carry a `lexicon.json` member;
  - the console report uses the specification's nine sections;
  - auditors can no longer write to a client's chain.
- **Billing:** the invoice builders share one source, and a demo Elan1 billing desk on `/billing` settles disputes and decides discount and reopen requests.
- **Ask Govern:** it explains assessments, incidents and rules.
- **Public 404:** a mistyped public address shows a 404 to signed-out visitors.
- **Retention:** it is never below 8 years.

A second check that night (`../analysis/superseded/13-completeness-check`) found 42 follow-on gaps (`../analysis/14-fix-report`):
- **Packs:** a pack that needs a named person now holds the call instead of refusing it, and the live check uses the configured pack values.
- **Exports:** "Everything" exports pin their range, so the integrity check clears them.
- **Seals:** records below L3 carry autonomy level A0 ("no grant").
- **Keys:** at L2 a successor key needs a second person to confirm the switch.
- **Sovereign:** SAML, connectors and Elan1's maintenance banner no longer reach outside the network, and phone links use the bank's own console.
- **Seats:** counterparty seats are billed pro rata and never rewrite past invoices.
- **Auditors:** they write only the three pilot steps journey J9 gives them.
- **Stop:** an engaged stop can be widened.
- **Notices:** escalations and re-routes notify the new group.
- **Developer portal:** it documents the `gctl_` and `gops_` tokens and lists all 17 system refusal ids.

The independent check (`../analysis/superseded/15-fix-verification`) confirmed 82 of the 87 items fixed. The 17 changes in `../analysis/superseded/16-remaining-changes` then closed the remaining pieces and the side effects of the fixes:
- **Not done and Activity:** the empty "Erased data" and "Counterparty not verified" classes are gone.
- **Receipt page and Refusals:** they recognise every refusal the guard writes.
- **Onboarding:** at L3 and Sovereign, the first key signs at once; no 30-day lock.
- **Keys, tokens and approvals:**
  - Agents › Keys and Proof › Keys agree;
  - only the requester can withdraw a token request;
  - the first close-out bundle must match its export;
  - billing-desk credits come from the invoice;
  - a pack's named-person hold can never be released by autonomy.
- **Wording:** developer docs, legal pages and the rulebook help no longer call the rulebook "signed" at L1, and they describe chat Approve and Reject on WhatsApp correctly.
- **Bundle file names:** they stay as they are, mapped to the specification's names in the developer docs.

Every item is listed with its status in `../analysis/17-closing-report`.

## Map

| Path | What |
|---|---|
| `src/types.ts` | Domain model (22-field receipt, rulebook, approval, AI system, controls…) |
| `src/api/index.ts` | The API contract the screens use — replace with real calls |
| `src/mock/` | Seed data and the receipt-chain generator |
| `src/lib/` | Formatting (INR, IST), crypto and verifier, rule evaluator, pricing, permissions |
| `src/components/` | Brand design system (no rounded corners, Schibsted Grotesk + IBM Plex, ink / paper / clay) |
| `src/shell/` | The four doors (`nav.ts`), sidebar, door bar, top bar, command palette (Ctrl K), emergency stop, Ask Govern |
| `src/features/` | One folder per console area — door homes and new screens in `work/`, `records/`, `agentsdoor/`, `assurancedoor/`, personal preferences in `you/` — plus `verify` and `developers` |
| `BUILD-GUIDE.md` | Brand, wording and accessibility rules every screen follows |

Research and the platform plan behind this build are in `../analysis/`.
