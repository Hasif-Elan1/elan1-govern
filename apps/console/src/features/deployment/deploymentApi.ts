/**
 * Importing an air-gapped update bundle: the manifest is read from the media and registered as available.
 * Nothing is trusted at import — api.stageUpdate checks the digest and the Ed25519 signature against the
 * elan1 release key before a bundle can be applied.
 */
import type { UpdateBundle } from '@/types';
import { db } from '@/api';

const wait = (min = 300, max = 600) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

export interface BundleManifest { id?: string; version: string; digest: string; sig: string; kid: string; fingerprint?: string; sizeMb?: number; publishedAt?: string; notes?: string[] }

export function manifestOf(u: UpdateBundle): BundleManifest & { format: string } {
  return { format: 'elan1.update.manifest.v1', id: u.id, version: u.version, digest: u.digest, sig: u.sig, kid: u.kid, fingerprint: u.fingerprint, sizeMb: u.sizeMb, publishedAt: u.publishedAt, notes: u.notes };
}

export function parseManifest(text: string): BundleManifest {
  let j: Record<string, unknown>;
  try { j = JSON.parse(text); } catch { throw new Error('The manifest is not valid JSON.'); }
  const s = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : '');
  if (!/^\d{4}\.\d+\.\d+([-.][a-z0-9]+)?$/.test(s('version'))) throw new Error('No version like 2026.10.4 in the manifest.');
  if (!/^[0-9a-f]{64}$/.test(s('digest'))) throw new Error('The digest must be 64 hex characters (SHA-256).');
  if (!/^[0-9a-f]{128}$/.test(s('sig'))) throw new Error('The signature must be 128 hex characters (Ed25519).');
  if (!s('kid')) throw new Error('The manifest names no signing key (kid).');
  return { id: s('id') || undefined, version: s('version'), digest: s('digest'), sig: s('sig'), kid: s('kid'), fingerprint: s('fingerprint') || undefined, sizeMb: typeof j.sizeMb === 'number' ? j.sizeMb : undefined, publishedAt: s('publishedAt') || undefined, notes: Array.isArray(j.notes) ? (j.notes as unknown[]).map(String) : undefined };
}

export const deploymentApi = {
  /** Register a bundle read from removable media. Writes update.imported. Sovereign only. */
  async importBundle(orgId: string, m: BundleManifest, userId: string) {
    await wait();
    const d = db.getDB(orgId);
    if (d.org.deployment !== 'sovereign') throw new Error('elan1 applies updates to hosted organisations; bundles are imported on Sovereign deployments.');
    const member = d.members.find((x) => x.userId === userId);
    if (!member || !['owner', 'admin'].includes(member.role) || member.status !== 'active') throw new Error('Owners and admins import update bundles; your role cannot.');
    const existing = d.platform.updates.find((u) => u.digest === m.digest);
    if (existing) throw new Error(`This bundle is already here as ${existing.version} (${existing.status}).`);
    const u: UpdateBundle = {
      id: `upd_imp_${Date.now().toString(36)}`, version: m.version, publishedAt: m.publishedAt ?? new Date().toISOString(), sizeMb: m.sizeMb ?? 0, digest: m.digest, kid: m.kid, fingerprint: m.fingerprint ?? '', sig: m.sig,
      transport: 'air-gapped media', status: 'available', notes: m.notes?.length ? m.notes : ['Imported from removable media'],
    };
    d.platform.updates.unshift(u);
    const r = db.logAdmin(orgId, userId, 'update.imported', { version: u.version, digest: u.digest.slice(0, 16), kid: u.kid });
    db.touch(orgId, 'deployment');
    return { bundle: JSON.parse(JSON.stringify(u)) as UpdateBundle, seq: r.seq };
  },
};
