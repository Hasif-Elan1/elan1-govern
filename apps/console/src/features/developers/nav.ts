/** The developer portal's sections, in reading order. Ids are the URL segment: /developers/<id>. */
export interface DocEntry { id: string; title: string; keywords: string; level?: 'L2' | 'L3' | 'SOV'; children?: { anchor: string; title: string }[] }
export interface DocGroup { group: string; items: DocEntry[] }

export const DOC_NAV: DocGroup[] = [
  {
    group: 'Get started',
    items: [
      { id: 'overview', title: 'Overview', keywords: 'how a call is governed path steps governed run check and record mcp rest' },
      { id: 'quickstart', title: 'Quickstart', keywords: 'first call five minutes add agent key claude code cursor receipt' },
      { id: 'path-to-production', title: 'Path to production', keywords: 'sandbox tenant sk_sbx_ fixtures production key request review gk_ two working days promotion advisory enforced bypass proof who we do not onboard refused applicants' },
      { id: 'conformance', title: 'Conformance', keywords: 'conformance suite c1 c14 tests result file cl-1 cl-2 cl-3 cl-4 cl-d structural attested anchored addressed disclosing sample' },
    ],
  },
  {
    group: 'Connect',
    items: [
      { id: 'mcp', title: 'MCP', keywords: 'model context protocol streamable http stateless tools approval_status refusal tool result' },
      { id: 'mcp-tools', title: 'Built-in MCP tools', keywords: 'catalogue read stage act scopes govern:read govern:stage govern:act stage.write act.write act.escalate read.records read.meter 34 tools' },
      {
        id: 'api', title: 'REST API', keywords: 'check record approvals openapi healthz endpoint reference try it receipts proof exports verify status tokens control token gctl_ operations token gops_ read-only define scope revoke dual control',
        children: [
          { anchor: 'tokens', title: 'Tokens: gk_, gctl_, gops_' },
          { anchor: 'post-check', title: 'POST /v1/check' },
          { anchor: 'post-record', title: 'POST /v1/record' },
          { anchor: 'get-approval', title: 'GET /v1/approvals/{id}' },
          { anchor: 'evidence-paths', title: 'Receipts, proofs and exports' },
          { anchor: 'get-openapi', title: 'GET /v1/openapi.json' },
          { anchor: 'get-healthz', title: 'GET /healthz' },
        ],
      },
      { id: 'sdks', title: 'SDKs', keywords: 'typescript python guarded decorator npm pip waitForApproval verifyWebhook' },
      { id: 'examples', title: 'Examples', keywords: 'claude cursor langchain openai agents sdk config snippets' },
    ],
  },
  {
    group: 'Rules',
    items: [
      { id: 'rulebooks', title: 'Rulebook YAML', keywords: 'yaml fields operators eq lt lte gt gte in to_domain_in fields_include quotas strictest default refuse approve_in_chat unless dual control declaration' },
      { id: 'risk-tags', title: 'Risk tags', keywords: 'tags reads_data writes_data moves_money sends_external personal_data deletes changes_access changes_production high impact' },
      { id: 'autonomy', title: 'Earned autonomy', level: 'L3', keywords: 'autonomy a0 a1 a2 a3 a4 a5 observe draft propose act graduation two-person supervised sampling revoke precedent' },
    ],
  },
  {
    group: 'Events and evidence',
    items: [
      { id: 'webhooks', title: 'Webhooks', keywords: 'events receipt.created approval.pending approval.resolved alert.created hmac signature retries timestamp.anchored counterparty erasure level upgraded' },
      { id: 'receipts', title: 'Receipts and verification', keywords: 'receipt fields canonical json sha-256 ed25519 prev_hash chain checkpoints auditor pack verify exit codes' },
      { id: 'seal', title: 'Seal v6 and the bundle', level: 'L2', keywords: 'seal v6 sixteen fields f01 f16 preimage length-prefixed digest test vectors python typescript evidence bundle 8 members lexicon lexicon.json manifest boundary' },
      { id: 'anchors', title: 'Anchors and timestamps', level: 'L2', keywords: 'merkle rfc 6962 rfc 3161 timestamp authority emudhra digicert inclusion proof batch unanchored tail degraded one authority' },
      { id: 'verifier', title: 'Verifier and profiles', keywords: 'six codes pass fail_integrity fail_profile incomplete unsupported usage nine sections report profiles mca gst rbi eu ai act dpdp iso 42001 nist' },
      { id: 'cli', title: 'CLI', keywords: 'govern verify sign keygen command line offline fingerprint profile' },
      { id: 'verifier-release', title: 'Verifier releases', keywords: 'release sha256sums signature openssl test vectors tampered bundle reference bundle download superseded build from source' },
    ],
  },
  {
    group: 'Between organisations',
    items: [
      { id: 'cross-org', title: 'Action Receipts and disclosure', level: 'L3', keywords: 'action receipt counterparty cross organisation selective disclosure sd-jwt rfc 9901 portal well-known keys seats regulator partner' },
      { id: 'standard', title: 'Action Receipt standard', keywords: 'standard members licences cc by 4.0 apache-2.0 cc0 governance editors public comment errata certification listing defect report suite registry' },
    ],
  },
  {
    group: 'Regulation',
    items: [
      { id: 'packs', title: 'Regulatory packs and erasure', keywords: 'ledger1 invoice1 collect1 mca gst rbi gates g-a g-e declaration dry run l1 dpdp erasure salt destruction' },
    ],
  },
  {
    group: 'Operate',
    items: [
      { id: 'identity', title: 'SAML, OIDC and SCIM', keywords: 'sso saml oidc scim provisioning groups roles jit just in time okta entra keycloak' },
      { id: 'sovereign', title: 'Sovereign installation', level: 'SOV', keywords: 'sovereign on premises kubernetes postgresql 16 rls openbao ceph seaweedfs garage hsm air-gapped update bundle egress' },
      { id: 'status', title: 'Status page', keywords: 'status uptime incidents chain integrity component' },
      { id: 'support', title: 'Support', keywords: 'support tiers community standard business premier sovereign severity s1 s2 response time security contact' },
    ],
  },
  {
    group: 'Reference',
    items: [
      { id: 'errors', title: 'Errors and refusal ids', keywords: 'errors 401 429 retry-after 409 refusal ids agent-paused sandbox-limit no-rulebook rulebook-invalid default tool-disabled invalid-arguments gate-error g1_no_consent g1_channel g1_withdrawn g1_expired consent pack-gate pack-declaration autonomy-a0 receipt_write_failed tenant_stopped' },
      { id: 'refusal-codes', title: 'Refusal codes', keywords: 'refusal codes register 47 policy gate platform define ref-01 precondition_failed tenant_stopped billed retry pages' },
      { id: 'glossary', title: 'Glossary', keywords: 'glossary terms definitions vocabulary' },
      { id: 'changelog', title: 'Versioning and changelog', keywords: 'versioning breaking changes notice changelog deprecation sunset headers rfc 9745 rfc 8594' },
      { id: 'legal', title: 'Terms and DPA', keywords: 'terms of service data processing agreement dpa legal dpdp gdpr' },
    ],
  },
];

export const DOC_FLAT: DocEntry[] = DOC_NAV.flatMap((g) => g.items);
