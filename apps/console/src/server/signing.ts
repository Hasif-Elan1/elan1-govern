/**
 * What the server installs so the domain signs nothing itself (apps/web/src/server/console-signing.ts): signatures
 * with the organisation's key are asked of Elan1 Govern (setOrgSigner), and seals, timestamps and erasures come from
 * it (setServerEvidence, sealPlan, noteErased). Not an operation module: the server calls these, never the RPC door.
 */
export { setOrgSigner, type OrgSigner, type SigningKind } from '@/lib/crypto';
export { setServerEvidence, sealPlan, noteErased, type ServerEvidence } from '@/mock/platform';
export { serverKeys, type ServerKeyStep } from '@/mock/keys';
