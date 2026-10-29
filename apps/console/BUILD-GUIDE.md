# Elan1 Govern front end — build guide for every screen

Read this before writing a screen. The foundation is done; you build pages on top of it. Do **not** edit files outside the folder you own (listed in your brief). If you need something from a shared file, build it locally inside your folder instead.

## Stack
React 18 · TypeScript strict · Vite · React Router 6 (history routes) · Tailwind 3 (brand tokens, zero radius) · Recharts · CodeMirror 6 (`@uiw/react-codemirror`, `@codemirror/lang-yaml`, `@codemirror/merge`) · cmdk · lucide-react icons · zustand. Path alias `@/` = `src/`.
Run `npx tsc -b --pretty false` from `elan1-govern-web` to type-check. It must pass with zero errors before you finish.

## Files you use (read them, don't change them)
- `src/types.ts` — every domain type (Agent, Rulebook, Rule, Receipt (22 fields), Approval, Connector, AiSystem, Assessment, Framework, Control, Alert, Incident, Plan, Invoice…).
- `src/api/index.ts` — **the only way screens get or change data.** e.g. `api.today(orgId)`, `api.receipts(orgId, query)`, `api.receipt(orgId, seq)`, `api.approvals`, `api.decide`, `api.agents`, `api.agent`, `api.createAgent`, `api.rulebooks`, `api.rulebook`, `api.tryAction`, `api.testOnPast`, `api.saveDraft`, `api.publish`, `api.connectors`, `api.evidence`, `api.exportPack`, `api.signCheckpoint`, `api.rotateKey`, `api.inventory`, `api.aiSystem`, `api.assessments`, `api.reviewAssessment`, `api.compliance`, `api.alerts`, `api.incidents`, `api.engageStop`, `api.liftStop`, `api.billing`, `api.members`, `api.webhooks`, `api.chainSlice`. Read the file for the full list and return shapes.
- `src/hooks/useQuery.ts` — `const { data, loading, error, refetch } = useQuery((orgId) => api.x(orgId), [deps])`. It re-loads automatically when the organisation's records change (live). `useMutation(fn)` gives `{ mutate, pending, error }`. `useNow(ms)` re-renders for countdowns.
- `src/store/session.ts` — `useUser()`, `useOrgId()`, `useRole()`, `useCan('approvals.decide')`, `needsReauth()`, `markReauth()`.
- `src/lib/permissions.ts` — permission ids and `can(role, perm)`. Hide or disable actions the role cannot take, and say why ("Approvers can decide; viewers can only read.").
- `src/lib/format.ts` — `rupees`, `rupeesShort`, `n`, `pct`, `date`, `dateTime`, `time`, `relative`, `countdown`, `seqLabel`, `plural`, `tagLabel`, `decisionLabel`, `channelLabel`, `HIGH_IMPACT_TAGS`. Always format money with these (Indian grouping ₹1,80,000) and times in IST.
- `src/lib/pricing.ts` — `PLANS`, `ADD_ONS`, `REFUSAL_FACTOR` (0.4), `monthlyInvoice`, `allowanceUsed`.
- `src/lib/crypto.ts` — `verifyChain(receipts, publicKeys, checkpoints)` returns a three-valued report (verified / failed / cannot_verify) with per-check results; `canonical`, `sha256Hex`, `receiptHash`, `signText`, `verifySig`.
- `src/lib/levels.ts` (levels and capabilities), `src/lib/seal.ts` (Seal v6, 16 fields, test vectors), `src/lib/merkle.ts` (RFC 6962), `src/lib/verify6.ts` (six-code verifier, nine sections, `BUNDLE_MEMBERS`, `CODE_LABELS`, `EXIT_CODES`, `VERIFY_LIMITS`), `src/lib/profiles.ts` (`PROFILES`), `src/lib/packs.ts` (`PACKS`, gates G-A…G-E), `src/lib/disclosure.ts` (`DISCLOSABLE_FIELDS`, `FIELD_LABELS`, `verifyDisclosure`), `src/lib/autonomy.ts` (`AUTONOMY_LEVELS`, `NO_GRANT_LABEL`, `applyAutonomy`).
- `src/lib/evaluate.ts` — `evaluate(rules, tool, args)`, `replay(receipts, rules)`, `semanticDiff(before, after)`.
- `src/mock/users.ts` — `USERS`, `DEMO_ACCOUNTS` (each with `level` and `orgId` so the sign-in page can group by level), `ORGS` (with `levelHistory`, `deployment`, `residency`, `domain`), `userById`, `userName`, `APPROVER_GROUPS` (Demo Traders), `approverGroupsFor(orgId)` and `groupFor(orgId, nameOrId)` for any organisation. `src/mock/catalog.ts` — `TOOLS`, `toolByName`, `rulebookYaml`.
- `src/components/ui` (import from `@/components/ui`): `Button` (variants primary | secondary | ghost | danger | quiet-danger | inverse; sizes sm | md | lg; `icon`, `loading`), `IconButton`, `Badge`, `StatusChip`, `DecisionChip`, `ApprovalChip`, `SeverityChip`, `BuildMark` (built | partial | planned | specified), `PlannedBadge`, `LegalDraft`, `Kbd`, `Avatar`, `Spinner`, `Skeleton`, `Dot`, `Meter`, `Help`, `PageHeader` (kicker, title, description, actions, crumbs, meta), `Panel` (title, kicker, actions, footer, flush, tone), `Stat`, `KeyValue`, `EmptyState` (with disc), `Banner` (info | held | bad | ok | neutral), `SectionTitle`, `Timeline`, `Rule`, `Field`, `Input`, `SearchInput`, `Textarea`, `Select`, `Checkbox`, `Switch`, `RadioCards`, `Segmented`, `Dialog`, `Drawer`, `Menu`, `toast.ok/bad/info/held`, `Tooltip`, `DataTable` (columns with `cell`, `sort`, `align`, `hideBelow`; `onRowClick`; keyboard ↑↓ Enter), `CopyButton`, `Hash`, `CodeBlock`, `JsonView`, `InlineCode`, `Tabs`, `Disc` (kinds: mark, gate, aperture, orbit, trail, eclipse, progress, control-plane, registration), `ProgressArc`, `Logo`, `ProductMark`.
- `src/components/domain.tsx`: `AgentLink`, `Person`, `ReceiptLink`, `TagList`, `RouteMode` (governed run vs check and record), `AgentStatus`, `ChainStatus`, `When` (relative time with full time on hover), `Money`, `ArgsTable`, `Section`.
- `src/components/charts.tsx`: `DecisionBars`, `Sparkline`, `TrendLines`, `StackedColumns`, `Legend`, `SERIES` colours.
- `src/store/ui.ts`: `useUi().openAsk({ kind: 'receipt' | 'approval' | 'general', title, payload })` opens the Ask Govern explainer.

## The four doors — the console's grammar
"Every module presents the Four Doors and nothing else. There is no fifth door and no Settings tab floating outside the grammar." Each door answers one question and admits one shape of content. The doors and their screens are defined once in `src/shell/nav.ts` (`DOORS`).

| Door | Question | Shape of content | Screens |
|---|---|---|---|
| 01 Work | What needs me now? | Queues | Today, Approvals, Reviews, Not done, Alerts, Incidents, Channels |
| 02 Records | What is the state of things? | Lists, forms, pinned fields | Records, Activity (and receipts), Rulebooks, Connectors, AI inventory, Assessments, Regulatory packs (L2), Erasure (L2) |
| 03 Agents | Who and what is acting here? | Agents, people, keys, autonomy, deployment | Agents, Agent map, Autonomy (L3), Keys, People and roles, Organisation, Deployment |
| 04 Assurance | Can I show someone this was done properly? | Chain standing, timestamps, refusals, coverage, profiles, counterparties, meter, exports | Auditor workspace (auditors), Overview, Proof, Chain, Timestamps (L2), Refusals, Coverage, Verifier profiles (L2), Counterparties (L3), Disclosure (L3), Meter, Exports, Assurance levels (and Upgrade at `/assurance/upgrade`) |

Public pages outside the shell (no sign-in): `/verify`, `/developers`, `/approve/:token`, `/counterparty/:token` (counterparty portal), `/status` (public status page).

- **No fifth door.** Never add a Settings page, a "More" group or a top-level screen outside the doors. A new screen belongs to the door whose question it answers, and its shape must match that door (a queue goes in Work, a list or form in Records, an actor in Agents, proof in Assurance).
- **Where settings live.** Members and roles → Agents › People and roles (`/agents/people`). API and signing keys → Agents › Keys (`/agents/keys`). Organisation profile, SSO and sessions → Agents › Organisation (`/agents/organisation`). Notifications → Work › Channels (`/work/channels`). Webhooks and data retention → Assurance › Exports (`/assurance/exports?tab=webhooks|data`). Personal preferences are not a door: `/you`, from the account menu. Never link to `/settings…`; those URLs only exist as redirects (`SETTINGS_REDIRECTS`).
- **Copy.** Name a place by its door: "in the Agents door, under People and roles", not "in Settings". The old group names (Govern, Prove, Respond, Build, Account) are retired.

## Page anatomy
The shell (`AppShell`) draws the sidebar (the four doors), the top bar and the **door bar** above every page: door number, door name, its question and the door's screens as tabs. Pages must **not** repeat the door's tab list or its question.
Every console page: `PageHeader` (kicker = **the page's door**: "Work", "Records", "Agents" or "Assurance", optionally with the object type, e.g. "Records · Receipt", "Work · Alert"; title in sentence case; one-line description of what the page is for; actions on the right) → content in a 12-column feel using `grid gap-6 lg:grid-cols-12` → panels. Use `Panel` for grouped content; `DataTable` for lists. Pages render inside the shell, which already provides sidebar, door bar, top bar, padding and max width — do not add your own outer padding or page background.
States: every data view needs a loading state (Skeleton or `DataTable loading`), an empty state (`EmptyState` with a plain sentence and the next action), and an error state (`Banner tone="bad"`).

## Brand rules (elan1 Brand Book v1.0) — non-negotiable
- **No rounded corners anywhere** (Tailwind radius is already 0; never add `rounded-*` except `rounded-full` for the brand disc). Square avatars, square checkboxes, square switches.
- Colours only via tokens: `bg-canvas`, `bg-surface`, `bg-sunken`, `border-line`, `border-line-strong`, `text-fg`, `text-muted`, `text-subtle`, `text-accent-fg` (kiln, accent text), `bg-accent` (clay — marks only), functional `ok / held / bad / info` with `-fg` (text) and `-bg` (tint) variants. Never hard-code hex except via `clay-*`/`ink-*` ramps.
- **Clay is the one accent per surface** and never means status. Primary buttons are ink (`variant="primary"`), not clay.
- Status colour (verdigris approved / amber held / crimson refused / cobalt info) **always with an icon and a label** — use the chips.
- **One brand disc per surface at most**, and our status markers are squares, not dots.
- Type: headings use `font-display` (Schibsted Grotesk) — already applied to h1–h4; body IBM Plex Sans; hashes, YAML, keys, ids in `font-mono` (IBM Plex Mono). Labels: `className="label"` (uppercase, letter-spaced). Tables use tabular figures (already global).
- Sentence case for headings and buttons. Numerals for all quantities ("3 agents", not "three agents"). British English (organisation, authorise, colour, licence).

## Voice and wording rules (compliance matters here)
- Plain, specific, answerable. Say what the agent did and who approved it. "The agent drafts it. You commit it."
- **Banned words**: revolutionary, game-changing, seamless, cutting-edge, unlock, supercharge, turnkey, frictionless, next-generation, leverage, robust, enterprise-grade, best-in-class, powered by, tamper-proof, immutable, court-ready, legally admissible, certified, compliant (as a claim), "independently verifiable", "without trusting us", "approved by a regulator".
- Allowed integrity words: "signed", "hash-chained", "tamper-evident". When you show the evidence claim, say it is "signed with a key Elan1 Govern holds and not yet externally timestamped".
- "Blocks", "prevents", "cannot run" — **only** for the MCP governed run. For REST/SDK ("check and record") say "advises and records; the agent runs the call".
- Never call anything automatic if a person signs it. Auto-pause is "off by default"; rule suggestions never publish themselves.
- Compliance screens: always show `<LegalDraft />` ("Draft — needs legal review"); coverage is "a count of receipts, not a test that a control works".
- **Never show "Built on Claude"** (or "Build on Claude") anywhere in the interface — founder's instruction. Claude may still appear only as one of the agent frameworks people connect (Claude, Cursor, LangChain…).
- The legal entity is **ELAN1 AGENTIC TECHNOLOGIES PRIVATE LIMITED** (import `LEGAL_ENTITY` from `@/lib/company`) — use it in footers, invoices, manifests and legal text; never "elan1 Private Limited".
- The product name is written **Elan1 Govern**; the company/master brand is **elan1** (always lowercase). Never call the internal codename "gate" in copy; agent keys are shown with the `eg_` prefix.
- **Nothing is "Planned" any more.** Billing and the meter, assurance levels L2/L3/Sovereign, regulatory packs (ledger1/invoice1/collect1), dual control, SAML/SCIM, earned autonomy, erasure, discovery and the status page are built against the API below. Do not use `<PlannedBadge />` for anything in scope, do not ship a disabled button without a reason in its tooltip, and never a button that only shows a toast. A feature the current organisation's level does not include is shown working, with its upgrade path (see Levels).
- The evidence claim depends on the level: L1 "signed with a key Elan1 Govern holds and not yet externally timestamped"; L2 "sealed, signed with a key in AWS KMS and timestamped by two authorities"; L3 "signed with a key you hold in your HSM and timestamped by two authorities"; Sovereign "signed in your own HSM and timestamped by your own two authorities". Use `api.level(orgId)` — never hard-code the L1 sentence on a screen any organisation can open.
- **Pricing correction from the founder (overrides the documents):** a refused action costs **40% of the per-action rate** (L1 ₹0.64, L2 ₹0.48, L3 ₹0.36, Sovereign ₹0.22). Inside the yearly allowance a refusal uses 0.4 of an included action. Never write "refusals are free".

## Levels — L1 Guarded → L2 Attested → L3 Proven → Sovereign

Every organisation is on one assurance level. Each level includes everything below it; Sovereign is L3 on the customer's own infrastructure. A level's capabilities start at the moment the organisation reaches it (the **boundary**): records before it keep the lower level and keep verifying.

| Organisation | Level | Since | Sign in as (demo) |
|---|---|---|---|
| Demo Traders Pvt Ltd (`org_demo`) | L1 Guarded | always | Ananya Rao (owner), Rahul Menon (admin), Venkat Iyer (approver), Meera Shah (viewer) |
| Northbank Industrial Ltd (`org_northbank`) | L2 Attested | ~45 days ago (L1 before) | Rohan Kapoor (owner) |
| Kaveri Health Network (`org_kaveri`) | L3 Proven | L2 ~120 days ago, L3 ~30 days ago | Dr Lakshmi Pillai (owner) |
| Deccan Cooperative Bank Ltd (`org_deccan`) | Sovereign (own infrastructure, Mumbai) | since go-live ~95 days ago | Suresh Nambiar (owner), Anjali Kulkarni (admin) |

Kavita Desai (auditor) holds all four. Every organisation has the full seeded catalogue (7 agents, rulebooks, connectors, pending approvals, alerts, incidents, inventory, assessments, members, webhooks).

**How to read the level**
- In a component: `useOrgLevel()` (re-renders on upgrade) and `useHasCapability('rfc3161_anchors')` from `@/store/session`.
- Sync anywhere: `api.levelOf(orgId)` → `'l1' | 'l2' | 'l3' | 'sovereign'`; `api.can(orgId, capabilityId)`.
- Full state: `api.level(orgId)` → `LevelState` (plan, deployment, residency, history, boundaries with record counts each side, every capability with `enabled` and `since`, `next`).
- Helpers in `@/lib/levels`: `LEVELS`, `LEVEL_INFO` (`label` e.g. "Attested · L2", `tag` "L2"/"L3"/"SOV"), `CAPABILITIES` (id, label, level, door, route, description), `levelRank`, `atLeast`, `hasCapability(plan, cap)`, `capabilitiesFor(plan)`, `capabilitiesAdded(from, to)`, `nextLevel(plan)`, `levelAt(history, t)`.
- `NavItem.level` in `src/shell/nav.ts` marks level-specific screens; the sidebar and door bar show a small square tag (L2, L3, SOV) when the organisation is below it.

**The rule: never a dead end.** A level-specific screen opened by an organisation below its level still renders: say in one line what the capability does and what it would show here, show a real preview where the API offers one (for example `api.upgradePlan(orgId, to)` lists what is added and the price difference), and give a working button to `/assurance/upgrade?to=<level>` (owners can upgrade; others see who can). Never disable the whole page, never show "not built", and never an empty grey box. Records from before a boundary are shown as what they are ("L1 — signed and chained, not sealed"), not as failures.

**What changes at each level (and the API that shows it)**
- L2: Seal v6 (`api.seal`), test vectors (`api.testVectors`), Merkle batches and two RFC 3161 timestamps (`api.anchors`, `api.inclusionProof`), KMS custody (`api.custody`), the 8-member evidence bundle (`api.exportPack` returns it automatically from L2), the six-code verifier (`api.verifyBundle` / `verifyBundle` in `@/lib/verify6`), verifier profiles (`api.profiles`, `api.runProfile`), dual control **enforced** on publish (`api.requestReview` → `api.approveReview` → `api.publish`; at L1 the reviewer is recorded, not enforced), regulatory packs, DPDP erasure.
- L3: counterparties and seats, cross-organisation receipts (Kaveri receives real receipts from Northbank and Deccan), selective disclosure and the public portal, earned autonomy that **changes decisions** in the guard (A0 refuses writes; A1/A2 hold allowed writes; A3 leaves the rulebook alone; A4 runs held calls inside the bound; A5 runs held calls; a refusal is never relaxed), customer-held keys with key ceremonies.
- Sovereign: everything in L3 on the customer's cluster (`api.deployment`), signed air-gapped update bundles (`api.stageUpdate` verifies the Ed25519 signature for real, then `api.applyUpdate`), deny-all egress, local TSAs, customer HSM, residency proof (`api.residency`).

**New API functions** (all in `src/api/index.ts`, JSDoc on each gives the return shape)
- Levels: `levelOf`, `can`, `level`, `capabilities`, `upgradePlan`, `upgradeLevel`.
- L2: `seal`, `testVectors`, `anchors`, `inclusionProof`, `custody`, `runKeyCeremony`, `verifyBundle`, `profiles`, `runProfile`; `exportPack(orgId, userId, from?, to?, profileId?)`.
- L3: `counterparties`, `addCounterparty`, `crossOrgReceipts`, `issueToCounterparty`, `verifyReceived`, `disclosures`, `createDisclosure`, `revokeDisclosure`, `disclosureByToken` (public); `grants`, `setGrant`, `revokeGrant`, `graduationProposals`, `decideGraduation`.
- Packs: `packs`, `pack`, `installPack`, `packExport`. Erasure: `erasures`, `createErasure`, `approveErasure`, `executeErasure`.
- Approvals: `escalation`, `setEscalation` (applied automatically on the live tick), `approverGroups`, `allowedApprovers` (membership is enforced in `decide`; an owner may decide outside the group and that is recorded), `approvalLink`, `resolveApprovalLink`, `decideByLink` (single use; `api.approval` also accepts a link token).
- Reviews (dual control): `reviewsQueue`, `reviewsCount`, `reviews`, `requestReview`, `approveReview`.
- Meter: `meter` (events from the chain, refusals at 0.4, modelled months labelled, invoices per plan, reconciliation).
- Deployment: `deployment`, `stageUpdate`, `applyUpdate`, `residency`. Identity: `identityConfig`, `setIdentityConfig`, `rotateScimToken`. Discovery: `discover`, `runDiscovery`, `registerFinding`, `dismissFinding`. Public: `status`.
- Errors are thrown as `Error` with a sentence written for the person (e.g. "Dual control: a different person must approve a review of this version before it is published."). Show `error.message` in a `Banner`.

## Accessibility (WCAG 2.2 AA)
Keyboard-complete; visible focus (global ring already set); labels on every input (`Field`); `aria-label` on icon buttons; dialogs trap focus (built in); never colour alone; tables with real headers; 44px minimum target for Approve/Reject on touch; reject needs a reason; no default focus on Approve; live regions for changing counts where useful.

## Quality bar
This must look and feel like the best enterprise console in the world — calm, dense where it should be, generous where it matters, precise typography, consistent spacing (4px scale: gap-2/3/4/6/8), crisp hairlines, no clutter. Every number comes from the API (no hard-coded figures that contradict the data). Every object links to the related objects (agent ↔ rulebook ↔ receipt ↔ approval ↔ AI system ↔ assessment ↔ control). Make it responsive down to 360px.
