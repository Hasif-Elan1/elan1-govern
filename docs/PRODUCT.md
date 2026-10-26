# Gate: product overview

## The problem

Companies are giving AI agents real permissions: sending email, paying invoices, issuing refunds, changing customer records, deploying code. Two things are missing.

1. **Control at the moment of action.** Most AI governance today happens on paper: inventories, questionnaires and policies reviewed before launch. Once an agent is live, nothing stops it from doing something the policy forbids, and nobody finds out until later.
2. **Proof that holds up.** When an auditor, a regulator or a customer asks "what did your AI do, and who allowed it?", teams reconstruct the answer from scattered logs that anyone with database access could have changed.

Regulation is making both mandatory. The EU AI Act requires record-keeping and human oversight for high-risk systems. India's DPDP Act and the RBI's FREE-AI framework push regulated entities toward accountable AI. US state laws such as Colorado's AI Act add impact assessments.

## What Gate does

**One rulebook both blocks actions and produces the compliance proof.**

| | |
|---|---|
| **Guard** | Agents call their tools through Gate (MCP or a small SDK). Before anything runs, Gate checks a signed rulebook and answers *allow*, *ask a person* or *refuse*. Anything not allowed is refused, and if Gate fails it refuses. |
| **Approvals** | High-impact actions wait for a named person, by email or on a phone, with the evidence they need (the invoice, the vendor, the amount). |
| **Proof** | Every decision becomes a signed, hash-chained receipt. Auditors verify an exported bundle offline with one command, with no account and no trust in Gate. |
| **Governance** | A registry of AI systems and owners, risk and impact assessments with sign-off, and a framework library (EU AI Act, NIST AI RMF, ISO/IEC 42001, DPDP, RBI FREE-AI, GDPR, HIPAA, SOC 2, Colorado AI Act, NYC LL 144) whose evidence is counted from real receipts. |

Rules work by **risk tag** as well as by tool: "anything that moves money over ₹50,000 needs finance", "never delete", "at most 50 external emails an hour". So one rulebook governs tools Gate has never seen, from any MCP server, in any industry.

## Why it is different

- **Enforcement and evidence in one place.** Governance platforms such as Credo AI focus on the program side: registries, assessments, policy packs and reports. Agent security tools focus on blocking. Gate does both from the same rulebook, so the evidence is a by-product of control rather than a separate reporting exercise.
- **Proof anyone can check.** Receipts are signed and chained; the verifier is open and offline. That is a stronger claim than "our logs say so".
- **Works with any agent.** MCP-native, plus a REST/SDK path. No model or framework lock-in, and an upstream MCP proxy so existing tools can be governed in minutes.
- **Self-serve.** Sign up, add an agent, copy an address and a key. The demo agent shows allow, ask and refuse in under two minutes.
- **India-first, global by design.** Rupee amounts, GST invoices, Zoho Books, and the CA as approver or auditor (with a client switcher for CAs serving many companies). Per-organisation currency and time zone, and frameworks for the EU, US and UK.

## Who it is for

| Industry | Example agent | What Gate enforces |
|---|---|---|
| Finance and accounting | Accounts payable: invoices to bills to payments | Payments over a threshold need finance; bank-detail changes are refused; daily limits |
| Customer support | Refunds and account changes | Refunds over a limit need a lead; deletions refused; external messages rate-limited |
| Healthcare | Patient scheduling and messages | Personal health data access logged and minimised; outbound messages approved |
| HR and recruiting | Screening and outreach | Automated rejections need a person (NYC LL 144, Colorado AI Act) |
| Sales and marketing | Outreach | Volume limits, approved domains only |
| Engineering and DevOps | Deploys and access changes | Production changes and permission grants need an owner |

Buyers: the owner of the AI program (CTO, head of AI, COO), with compliance, finance and internal audit as approvers and auditors. CA firms and auditors are a distribution channel, as one auditor seat spans many client organisations.

## Built to enterprise standards

- Fail-closed guard; Ed25519 signatures; SHA-256 hash chain with signed checkpoints; AES-256-GCM for keys and tokens.
- Strict tenant isolation enforced by a single helper and a build-breaking test.
- argon2id passwords, TOTP two-step sign-in, re-authentication before approving, single-use signed approval links.
- CSRF protection, strict CSP with nonces, HSTS, rate limits and account lockout.
- STRIDE threat model ([SECURITY.md](../SECURITY.md)); clean `pnpm audit`, semgrep, gitleaks and OWASP ZAP baseline; supply-chain policy (7-day release age, install-script allowlist, pinned CI actions).
- Hundreds of automated tests across unit, integration, property-based and end-to-end, including an authorisation matrix of every role against every route.

## Roadmap

| Next | Why |
|---|---|
| SSO (OIDC and SAML) and SCIM | Enterprise sign-in and user provisioning |
| Cloud KMS and HSM key providers | Customer-managed keys |
| Shared rate limiting and a multi-region deployment guide | Scale and availability |
| More first-party connectors (Slack, Salesforce, Jira, Tally, Razorpay) | Faster time to value in key industries |
| Policy-as-code in CI (`gate sign` in pull requests) | Rulebooks reviewed like code |
| SOC 2 Type I for Gate itself | Procurement |

## Honest status

This is a working product, not a mock-up: the guard, approvals, receipts, verifier, console, demo and governance modules run end to end and are tested. It is not yet certified (no SOC 2 yet), the compliance mappings are drafts that need legal review, and real Gmail and Zoho Books use requires the customer's own OAuth apps.
