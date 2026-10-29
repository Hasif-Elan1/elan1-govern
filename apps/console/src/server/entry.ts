/**
 * The console's domain for the server: the same operations the browser runs on its mock, bundled for Node by
 * scripts/build-server.mjs into dist-server/domain.mjs and imported by apps/web as `@gate/console/server`.
 * The browser globals the domain touches come from ./shims (injected by the bundler, never put on globalThis).
 * Operations take the caller as an argument; the server fills it in (see dist-server/ops.json).
 */
export { settle, cancelPending, holdTimers } from './shims';
export { api } from '@/api';
export * as db from '@/mock/db';
export * as orgApi from '@/features/settings/orgApi';
export * as work from '@/features/work/backend';
export * as agents from '@/features/agents/backend';
export * as assessments from '@/features/assessments/backend';
export * as sovereign from '@/features/deployment/sovereignApi';
export * as deployment from '@/features/deployment/deploymentApi';
// modules screens call directly (plans/console-app.md, 1.3 refined): every write a screen makes is one of these
export * as connectors from '@/features/connectors/ops';
export * as tokens from '@/features/keys/tokenStore';
export * as inventory from '@/features/inventory/ops';
export * as packs from '@/features/packs/config';
export * as keys from '@/mock/keys';
export * as devpath from '@/mock/devpath';
export * as recordsDecl from '@/mock/recordsDecl';
export * as records from '@/mock/records';
export * as billing from '@/mock/billing';
export * as approvalsExt from '@/mock/approvalsExt';
export * as maintenance from '@/mock/opsMaintenance';
export * as ops from '@/mock/ops';
export * as notices from '@/mock/tenantNotices';
export * as consoleOps from '@/features/console/ops';
export type { OrgDB } from '@/mock/db';
// the browser's own chain verifier, so the server's tests check the real chain with the code the console runs
export * as chainVerifier from '@/lib/crypto';
// how the server makes the organisation's signatures Elan1 Govern's (not operations)
export * as serverSigning from './signing';
// the browser's Seal v6 verifier, so the server's tests check real bundles with the code the console runs
export * as bundleVerifier from '@/lib/verify6';
