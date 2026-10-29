/**
 * Reproducible sampling and the auditor's working papers, one set per auditor per client organisation.
 *
 * The working papers sit behind an API-shaped store (get, save, export, import). The mock backend keeps
 * every organisation's state in this browser's storage, so the papers do too — under a key outside the
 * demo-data namespace, so "Reset demo data" and a regenerated chain do not wipe an auditor's notes. To hand
 * the papers to a colleague, export them as JSON; importing checks they belong to the same client.
 */
import { mulberry32 } from '@/lib/prng';
import { canonical, sha256Hex } from '@/lib/crypto';
import type { Receipt, SectionState, VerifyCode } from '@/types';
import type { LineState, Verdict } from '@/features/activity/verify';

export type Population = 'all' | 'decision' | 'refuse' | 'approval' | 'admin';

export const POPULATIONS: { value: Population; label: string; test: (r: Receipt) => boolean }[] = [
  { value: 'all', label: 'All receipts', test: () => true },
  { value: 'decision', label: 'Decisions only', test: (r) => r.kind === 'decision' },
  { value: 'refuse', label: 'Refusals only', test: (r) => r.decision === 'refuse' },
  { value: 'approval', label: 'Approvals only', test: (r) => r.kind === 'approval' },
  { value: 'admin', label: 'Admin changes only', test: (r) => r.kind === 'admin' },
];

export interface SampleConfig { from: number; to: number; size: number; seed: string; population: Population }

/** The L2 lines of one sampled receipt, summarised for the papers. */
export interface L2Summary { seal: LineState; timestamps: LineState; within15: LineState; inclusion: LineState }

export interface ProfileRunPaper {
  at: string;
  profileId: string;
  profileName: string;
  code: VerifyCode;
  exitCode: number;
  label: string;
  headline: string;
  range: { from: number; to: number };
  sections: { number: number; title: string; state: SectionState; detail: string }[];
  failingSampled: number[];
  bundleDigest: string;
}

export interface CrossOrgPaper { at: string; issuer: string; seq: number; state: 'verified' | 'failed'; steps: { label: string; state: string; detail: string }[] }

export interface WorkingPapers {
  version: 2;
  auditorId: string;
  orgId: string;
  config?: SampleConfig;
  drawnAt?: string;
  sample: { seq: number; hash: string }[];
  population?: number;
  reviews: Record<number, { reviewed: boolean; note: string; at?: string }>;
  results: Record<number, Verdict>;
  l2: Record<number, L2Summary>;
  profileRuns: ProfileRunPaper[];
  crossOrg: Record<string, CrossOrgPaper>;
  updatedAt?: string;
  digest?: string;
}

export const emptyPapers = (auditorId: string, orgId: string): WorkingPapers => ({ version: 2, auditorId, orgId, sample: [], reviews: {}, results: {}, l2: {}, profileRuns: [], crossOrg: {} });

const KEY = (auditorId: string, orgId: string) => `elan1-govern:auditor-papers:v2:${auditorId}:${orgId}`;
const V1 = (orgId: string) => `elan1-govern:auditor-papers:${orgId}`;

const paperDigest = (p: WorkingPapers) => sha256Hex(canonical({ ...p, digest: undefined, updatedAt: undefined })).slice(0, 16);
const later = <T,>(v: T) => new Promise<T>((res) => window.setTimeout(() => res(v), 60));

/** Working papers: per auditor, per client. API-shaped so a server can replace the storage without touching the screen. */
export const papersApi = {
  async get(auditorId: string, orgId: string): Promise<WorkingPapers> {
    try {
      const raw = localStorage.getItem(KEY(auditorId, orgId));
      if (raw) return later({ ...emptyPapers(auditorId, orgId), ...JSON.parse(raw) });
      const old = localStorage.getItem(V1(orgId));
      if (old) {
        const v1 = JSON.parse(old);
        const migrated: WorkingPapers = { ...emptyPapers(auditorId, orgId), config: v1.config, drawnAt: v1.drawnAt, sample: v1.sample ?? [], population: v1.population, reviews: v1.reviews ?? {}, results: v1.results ?? {} };
        localStorage.setItem(KEY(auditorId, orgId), JSON.stringify(migrated));
        return later(migrated);
      }
    } catch { /* storage unavailable: start empty */ }
    return later(emptyPapers(auditorId, orgId));
  },
  /** Synchronous save used on every tick or note; returns the stored copy. */
  save(p: WorkingPapers): WorkingPapers {
    const v = { ...p, updatedAt: new Date().toISOString() };
    v.digest = paperDigest(v);
    try { localStorage.setItem(KEY(p.auditorId, p.orgId), JSON.stringify(v)); } catch { /* storage full: the session keeps them in memory */ }
    return v;
  },
  exportJson(p: WorkingPapers, meta: { auditorName: string; clientName: string }) {
    return JSON.stringify({ format: 'elan1.working-papers.v2', auditor: meta.auditorName, client: meta.clientName, exported_at: new Date().toISOString(), papers: { ...p, digest: paperDigest(p) } }, null, 2);
  },
  /** Import papers a colleague exported. They must be for the same client; they become this auditor's copy. */
  importJson(text: string, auditorId: string, orgId: string): WorkingPapers {
    let parsed: { format?: string; papers?: WorkingPapers };
    try { parsed = JSON.parse(text); } catch { throw new Error('This file is not JSON.'); }
    if (parsed.format !== 'elan1.working-papers.v2' || !parsed.papers) throw new Error('This file is not a set of Elan1 Govern working papers.');
    if (parsed.papers.orgId !== orgId) throw new Error('These working papers are for a different client organisation. Open that client first.');
    if (parsed.papers.digest && parsed.papers.digest !== paperDigest(parsed.papers)) throw new Error('The working papers were changed after they were exported (their digest does not match).');
    return papersApi.save({ ...emptyPapers(auditorId, orgId), ...parsed.papers, auditorId, orgId });
  },
};

export function seedNumber(seed: string) {
  return parseInt(sha256Hex(seed.trim()).slice(0, 8), 16);
}

/** Seeded partial Fisher–Yates: the same seed, range and population always give the same sample. */
export function drawSample(receipts: Receipt[], cfg: SampleConfig) {
  const test = POPULATIONS.find((p) => p.value === cfg.population)?.test ?? (() => true);
  const pool = receipts.filter((r) => r.seq >= cfg.from && r.seq <= cfg.to && test(r)).map((r) => r);
  const rand = mulberry32(seedNumber(cfg.seed));
  const k = Math.min(cfg.size, pool.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return { picked: pool.slice(0, k).sort((a, b) => a.seq - b.seq), population: pool.length };
}
