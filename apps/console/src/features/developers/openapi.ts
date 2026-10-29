/** The OpenAPI 3.1 document served at GET /v1/openapi.json — the agent paths, the evidence and verification paths (L2, L3) and SCIM. Nothing for the console. */
export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Elan1 Govern agent API',
    version: '2026-10-27',
    description: 'Check and record: Elan1 Govern decides and records; the agent holds its own credentials and runs the call. For calls Elan1 Govern runs itself, connect over MCP at POST /mcp. Evidence paths (receipts, proofs, exports) and verification paths (Action Receipts, disclosures) follow the organisation\'s assurance level: seals and proofs from L2, counterparties and autonomy from L3.',
  },
  servers: [{ url: 'https://govern.elan1.ai' }],
  security: [{ agentKey: [] }],
  paths: {
    '/v1/check': {
      post: {
        operationId: 'check',
        summary: 'Ask for a decision before a tool call',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckRequest' } } } },
        responses: {
          '200': { description: 'A decision: allow, ask or refuse. A refusal is a 200, not an error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Decision' } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorised' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/v1/record': {
      post: {
        operationId: 'record',
        summary: 'Record the outcome of a call the agent ran',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordRequest' } } } },
        responses: {
          '201': { description: 'Outcome receipt written', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordResult' } } } },
          '401': { $ref: '#/components/responses/Unauthorised' },
          '404': { description: 'No decision receipt with that sequence number for this agent' },
          '409': { description: 'An outcome for this decision was already recorded' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/v1/approvals/{id}': {
      get: {
        operationId: 'getApproval',
        summary: 'Read an approval, optionally waiting for a decision',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'wait', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 30 }, description: 'Seconds to hold the request open while the approval is pending' },
        ],
        responses: {
          '200': { description: 'The approval', content: { 'application/json': { schema: { $ref: '#/components/schemas/Approval' } } } },
          '401': { $ref: '#/components/responses/Unauthorised' },
          '404': { description: 'No approval with that id for this agent' },
        },
      },
    },
    '/v1/receipts/{seq}': {
      get: {
        operationId: 'getReceipt', summary: 'A receipt with its seal (L2+) and anchor state', tags: ['evidence'], security: [{ agentKey: [] }, { orgKey: [] }],
        parameters: [{ name: 'seq', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'The receipt', content: { 'application/json': { schema: { $ref: '#/components/schemas/ReceiptWithSeal' } } } }, '404': { description: 'No such receipt for this organisation' } },
      },
    },
    '/v1/receipts/{seq}/proof': {
      get: {
        operationId: 'getInclusionProof', summary: 'Merkle inclusion proof and both RFC 3161 timestamp tokens (L2+)', tags: ['evidence'], security: [{ agentKey: [] }, { orgKey: [] }],
        parameters: [{ name: 'seq', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'The proof', content: { 'application/json': { schema: { $ref: '#/components/schemas/InclusionProof' } } } }, '409': { description: 'The receipt is in the open window (unanchored tail) or was made at L1' } },
      },
    },
    '/v1/receipts/{seq}/issue': {
      post: {
        operationId: 'issueActionReceipt', summary: 'Issue a receipt to a counterparty, revealing only some fields (L3)', tags: ['between organisations'], security: [{ orgKey: [] }],
        parameters: [{ name: 'seq', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['counterparty_id', 'reveal'], properties: { counterparty_id: { type: 'string' }, reveal: { type: 'array', items: { type: 'string' } }, expires_days: { type: 'integer', maximum: 90 } } } } } },
        responses: { '201': { description: 'The Action Receipt and its disclosure package, with a portal token', content: { 'application/json': { schema: { type: 'object', properties: { action_receipt: { $ref: '#/components/schemas/ActionReceipt' }, disclosure: { $ref: '#/components/schemas/DisclosurePackage' } } } } } }, '403': { description: 'Below L3, or no seat for this counterparty' } },
      },
    },
    '/v1/verify/action-receipt': {
      post: {
        operationId: 'verifyActionReceipt', summary: 'Check a receipt another organisation issued to you; only a verified one is added to your chain (L3)', tags: ['between organisations'], security: [{ orgKey: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ActionReceipt' } } } },
        responses: { '200': { description: 'The checks in order (audience, expiry, nonce, issuer key, hash, signature, timestamp), stopping at the first that fails. A failed or expired receipt is not added to your chain and cannot be accepted; the check itself is always recorded as a counterparty.receipt.verified receipt (recorded_as).', content: { 'application/json': { schema: { type: 'object', required: ['state', 'issuer', 'seq', 'steps', 'added_to_chain', 'can_accept', 'recorded_as'], properties: {
          state: { enum: ['verified', 'failed', 'expired'] },
          code: { type: 'string', description: 'The receipt code when state is failed or expired, such as POLICY.RECEIPT_EXPIRED' },
          ref: { type: 'string', description: 'The code number, such as REF-45' },
          issuer: { type: 'string', description: 'The issuing organisation, such as ar-org:northbank.co.in' },
          seq: { type: 'integer', description: 'The receipt number in the issuer’s chain' },
          steps: { type: 'array', items: { type: 'object', properties: { step: { type: 'string' }, state: { enum: ['pass', 'fail'] }, detail: { type: 'string' } } } },
          added_to_chain: { type: 'boolean', description: 'True only when state is verified' },
          can_accept: { type: 'boolean', description: 'True only when state is verified' },
          recorded_as: { type: 'object', description: 'Your receipt of the check', properties: { action: { const: 'counterparty.receipt.verified' }, seq: { type: 'integer' }, result: { enum: ['verified', 'failed', 'expired'] } } },
        } } } } } },
      },
    },
    '/v1/disclosures/{token}': {
      get: {
        operationId: 'getDisclosure', summary: 'Public: the disclosure behind a counterparty portal link', tags: ['between organisations'], security: [],
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'The package and its check ("you are revealing 3 of 11 committed fields")', content: { 'application/json': { schema: { $ref: '#/components/schemas/DisclosurePackage' } } } }, '410': { description: 'Withdrawn or expired' } },
      },
    },
    '/v1/exports': {
      post: {
        operationId: 'exportEvidence', summary: 'Export evidence: the L1 auditor pack, or the 8-member evidence bundle from L2', tags: ['evidence'], security: [{ orgKey: [] }],
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { from_seq: { type: 'integer' }, to_seq: { type: 'integer' }, profile: { type: 'string', examples: ['in-mca-audit-trail'] }, format: { enum: ['zip', 'json'] } } } } } },
        responses: { '201': { description: 'The bundle (application/zip) or its JSON; an evidence.exported receipt is written' } },
      },
    },
    '/v1/autonomy/graduations': {
      post: {
        operationId: 'proposeGraduation', summary: 'Propose graduating an agent and action class from A2 to A3 (L3). No API sets a level directly.', tags: ['autonomy'], security: [{ orgKey: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['agent', 'tool', 'reason'], properties: { agent: { type: 'string' }, tool: { type: 'string', description: 'The action class' }, reason: { type: 'string' } } } } } },
        responses: { '201': { description: 'The proposal with its record (days, records, approvals, rejections, reversals); autonomy.graduation_proposed is written' }, '422': { description: 'The record does not meet the threshold: at least 90 days, 200 records and 100 approvals for the action class' } },
      },
    },
    '/v1/autonomy/graduations/{id}/approve': {
      post: {
        operationId: 'approveGraduation', summary: 'A second, different person approves a graduation; A3 starts with a 30-day supervised period that samples 1 in 10 calls (L3)', tags: ['autonomy'], security: [{ orgKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Graduated; autonomy.graduated is written' }, '409': { description: 'The proposer cannot also approve' } },
      },
    },
    '/v1/autonomy/grants/{id}': {
      delete: {
        operationId: 'revokeAutonomy', summary: 'Revoke an agent’s autonomy for an action class — one call by one person (L3)', tags: ['autonomy'], security: [{ orgKey: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Revoked; autonomy.revoked is written' } },
      },
    },
    '/.well-known/action-receipt-keys': { get: { operationId: 'actionReceiptKeys', summary: 'Public keys an organisation signs Action Receipts with', tags: ['between organisations'], security: [], responses: { '200': { description: 'kid → Ed25519 public key, with validity dates' } } } },
    '/v1/status': { get: { operationId: 'status', summary: 'Public status: components, chain integrity per organisation, incidents', security: [], responses: { '200': { description: 'Status' } } } },
    '/scim/v2/{org}/Users': {
      get: { operationId: 'scimListUsers', summary: 'SCIM 2.0: list provisioned users', tags: ['scim'], security: [{ scimToken: [] }], parameters: [{ name: 'org', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ListResponse' } } },
      post: { operationId: 'scimCreateUser', summary: 'SCIM 2.0: provision a user; groups map to roles', tags: ['scim'], security: [{ scimToken: [] }], parameters: [{ name: 'org', in: 'path', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'User; member.provisioned is written' } } },
    },
    '/scim/v2/{org}/Groups': { get: { operationId: 'scimListGroups', summary: 'SCIM 2.0: groups and the roles they map to', tags: ['scim'], security: [{ scimToken: [] }], parameters: [{ name: 'org', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ListResponse' } } } },
    '/v1/openapi.json': { get: { operationId: 'openapi', summary: 'This document', security: [], responses: { '200': { description: 'OpenAPI 3.1' } } } },
    '/healthz': { get: { operationId: 'health', summary: 'Liveness and receipt-store health', security: [], responses: { '200': { description: 'Healthy' }, '503': { description: 'Receipts cannot be written; every check is refused until this clears' } } } },
  },
  components: {
    securitySchemes: {
      agentKey: { type: 'http', scheme: 'bearer', description: 'Agent key: gk_… (production) or sk_sbx_… (sandbox)' },
      orgKey: { type: 'http', scheme: 'bearer', description: 'Organisation API key for an owner, admin or auditor (exports, counterparties, autonomy). Separate from agent keys.' },
      scimToken: { type: 'http', scheme: 'bearer', description: 'SCIM token scim_…, shown once in Agents › Organisation.' },
    },
    schemas: {
      CheckRequest: {
        type: 'object', required: ['tool', 'args'],
        properties: {
          tool: { type: 'string', examples: ['zoho_books.record_payment'] },
          args: { type: 'object', additionalProperties: true },
          context: { type: 'object', properties: { run_id: { type: 'string' }, user: { type: 'string' } } },
        },
      },
      Decision: {
        type: 'object', required: ['decision', 'rule_id', 'reason', 'receipt'],
        properties: {
          decision: { enum: ['allow', 'ask', 'refuse'] },
          rule_id: { type: 'string' },
          reason: { type: 'string' },
          mode: { const: 'check_and_record' },
          receipt: { type: 'object', properties: { seq: { type: 'integer' }, hash: { type: 'string' }, seal: { type: 'object', description: 'L2+: Seal v6', properties: { format: { const: 'elan1.seal.v6' }, digest: { type: 'string' }, kid: { type: 'string' } } }, anchor: { type: 'object', description: 'L2+: the batch the receipt joins', properties: { status: { enum: ['pending', 'anchored'] }, batch_id: { type: 'string' }, window_end: { type: 'string', format: 'date-time' } } } } },
          autonomy: { type: 'object', description: 'L3+: the autonomy level in force (reached by graduation), applied after the rulebook decided. A4 and A5 are not yet available.', properties: { level: { enum: ['A0', 'A1', 'A2', 'A3'] }, grant_id: { type: 'string' }, changed_decision: { type: 'boolean' }, supervised: { type: 'boolean', description: 'True during the 30-day supervised period after graduation' }, sampled: { type: 'boolean', description: 'True when this call was one of the 1 in 10 sampled for review' } } },
          rulebook: { type: 'object', properties: { version: { type: 'integer' }, hash: { type: 'string' } } },
          approval: { $ref: '#/components/schemas/Approval' },
        },
      },
      RecordRequest: {
        type: 'object', required: ['receipt_seq', 'status'],
        properties: { receipt_seq: { type: 'integer' }, status: { enum: ['ok', 'error'] }, ref: { type: 'string' }, ms: { type: 'integer' }, error: { type: 'string' } },
      },
      RecordResult: { type: 'object', properties: { recorded: { const: true }, seq: { type: 'integer' }, ref_seq: { type: 'integer' } } },
      Approval: {
        type: 'object',
        properties: {
          id: { type: 'string' }, status: { enum: ['pending', 'approved', 'rejected', 'expired'] }, approver_group: { type: 'string' },
          expires_at: { type: 'string', format: 'date-time', description: 'Default 24 hours after the ask' }, extended: { type: ['object', 'null'], description: 'The one declared extension: by, reason, at', properties: { by: { type: 'string' }, reason: { type: 'string' }, at: { type: 'string', format: 'date-time' } } }, decided_at: { type: 'string', format: 'date-time' }, channel: { enum: ['web', 'email', 'slack', 'whatsapp'] },
          receipt_seq: { type: 'integer' }, result_seq: { type: 'integer' }, poll_url: { type: 'string' },
        },
      },
      Error: { type: 'object', required: ['error', 'message'], properties: { error: { type: 'string' }, message: { type: 'string' } } },
      ReceiptWithSeal: { type: 'object', properties: { receipt: { type: 'object', description: 'The 22-field receipt' }, level: { enum: ['l1', 'l2', 'l3', 'sovereign'] }, seal: { type: 'object', description: 'Seal v6: 16 fields F01–F16, preimage_bytes, digest, kid, sig. Absent before the L2 boundary.' }, anchor: { type: 'object' } } },
      InclusionProof: { type: 'object', properties: { seq: { type: 'integer' }, leaf_index: { type: 'integer' }, tree_size: { type: 'integer' }, batch_id: { type: 'string' }, root: { type: 'string' }, path: { type: 'array', items: { type: 'object', properties: { hash: { type: 'string' }, side: { enum: ['left', 'right'] } } } }, tokens: { type: 'array', items: { type: 'object', description: 'RFC 3161 token: tsa, gen_time, serial, policy, imprint, sig' } } } },
      ActionReceipt: { type: 'object', required: ['issuer', 'audience', 'seq', 'receiptHash', 'kid', 'publicKey', 'sig', 'expiresAt', 'nonce'], properties: { format: { const: 'elan1.action-receipt.v1' }, issuer: { type: 'string' }, audience: { type: 'string' }, seq: { type: 'integer' }, receiptHash: { type: 'string' }, kid: { type: 'string' }, publicKey: { type: 'string' }, sig: { type: 'string' }, issuedAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' }, nonce: { type: 'string' }, receipt: { type: 'object' } } },
      DisclosurePackage: { type: 'object', properties: { seq: { type: 'integer' }, receiptHash: { type: 'string' }, audience: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' }, committed: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, digest: { type: 'string' } } } }, revealed: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, salt: { type: 'string' }, value: { type: 'string' } } } }, kid: { type: 'string' }, publicKey: { type: 'string' }, sig: { type: 'string' } } },
    },
    responses: {
      BadRequest: { description: 'The body is not valid JSON or misses tool/args', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Unauthorised: { description: 'Missing, unknown or revoked agent key. No receipt is written.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      RateLimited: { description: '300 requests a minute per key. Read Retry-After. No receipt is written.', headers: { 'Retry-After': { schema: { type: 'integer' } } } },
    },
  },
} as const;
