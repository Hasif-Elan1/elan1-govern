/**
 * The console's domain for the server: the same operations the browser runs on its mock, bundled for Node by
 * scripts/build-server.mjs into dist-server/domain.mjs and imported by apps/web as `@gate/console/server`.
 * The browser globals the domain touches come from ./shims (injected by the bundler, never put on globalThis).
 * Operations take the caller as an argument; the server fills it in (see dist-server/ops.json).
 */
export { settle, cancelPending } from './shims';
export { api } from '@/api';
export * as db from '@/mock/db';
export * as orgApi from '@/features/settings/orgApi';
export * as work from '@/features/work/backend';
export * as agents from '@/features/agents/backend';
export * as assessments from '@/features/assessments/backend';
export * as sovereign from '@/features/deployment/sovereignApi';
export * as deployment from '@/features/deployment/deploymentApi';
export type { OrgDB } from '@/mock/db';
