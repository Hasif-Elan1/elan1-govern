import { useCallback, useEffect, useRef, useState } from 'react';
import type { IndustryPack, LevelId, PackId, Region, Role } from '@/types';
import { db } from '@/api';
import { ORGS } from '@/mock/users';
import { createdOrg, registryOnboarding, saveRegistryOnboarding } from '@/features/auth/registry';

/**
 * Set-up progress, kept per organisation with the organisation itself (so another device or another admin of
 * the same organisation sees the same step), never in one shared browser key.
 */
export type CustodyChoice = 'aws_kms' | 'cloudhsm' | 'luna' | 'nshield';

export interface OnboardingState {
  v: 2;
  step: number;
  maxStep: number;
  company: { name: string; legal: string; size: string };
  /** Who is applying (see refusals.ts). Absent in progress saved before it, which reads as eligible. */
  applicant?: import('./refusals').ApplicantCategory;
  level: LevelId;
  residency: string;
  custody: CustodyChoice;
  holders: string[];
  globalTsa: string;
  localTsas: [string, string];
  packs: PackId[];
  profiles: string[];
  sovereign: { distribution: string; storage: 'Ceph' | 'SeaweedFS' | 'Garage'; checks: Record<string, boolean> };
  industry: IndustryPack;
  regions: Region[];
  currency: 'INR' | 'USD' | 'EUR' | 'GBP';
  timezone: string;
  identity: { saml: boolean; idp: string; metadataUrl: string; scim: boolean };
  invites: { email: string; role: Extract<Role, 'admin' | 'approver' | 'viewer'> }[];
  slack: { connected: boolean; workspace?: string; channel: string };
  whatsapp: { number: string; verified: boolean };
  completedAt?: string;
  completedBy?: string;
  receiptSeq?: number;
  result?: { rulebookSlug?: string; starterYaml?: string; invites: { email: string; link: string }[]; applied: string[]; skipped: string[] };
  updatedAt?: string;
  updatedBy?: string;
}

export function defaultOnboarding(orgId: string): OnboardingState {
  const org = ORGS.find((o) => o.id === orgId);
  // a sign-up organisation starts at L1 on its chain; set-up pre-selects the level chosen at sign-up and raises it on finish
  const level = (createdOrg(orgId)?.plan ?? org?.plan ?? 'l1') as LevelId;
  return {
    v: 2, step: 0, maxStep: 0,
    company: { name: org?.name ?? '', legal: '', size: '51–250' },
    level, residency: org?.residency ?? 'ap-south-1 Mumbai',
    custody: level === 'l3' ? 'cloudhsm' : level === 'sovereign' ? 'nshield' : 'aws_kms', holders: ['', '', '', '', ''],
    globalTsa: 'DigiCert Timestamp Authority', localTsas: ['TSA 1 (primary data centre)', 'TSA 2 (disaster-recovery site)'],
    packs: [], profiles: [],
    sovereign: { distribution: 'Red Hat OpenShift 4.16', storage: 'Ceph', checks: {} },
    industry: org?.industry ?? 'finance', regions: org?.regions ?? ['India'], currency: org?.currency ?? 'INR', timezone: org?.timezone ?? 'Asia/Kolkata',
    // a Sovereign deployment denies all egress: its identity provider runs inside the bank's network
    identity: { saml: false, idp: level === 'sovereign' ? 'Keycloak' : 'Okta', metadataUrl: '', scim: false },
    invites: [], slack: { connected: false, channel: '#govern-approvals' }, whatsapp: { number: '', verified: false },
  };
}

type WithOnboarding = ReturnType<typeof db.getDB> & { onboarding?: OnboardingState };

/** Read the organisation's set-up progress (from the organisation's own records). */
export function loadOnboarding(orgId: string): OnboardingState {
  const base = defaultOnboarding(orgId);
  const saved = createdOrg(orgId) ? registryOnboarding<OnboardingState>(orgId) : (db.getDB(orgId) as WithOnboarding).onboarding;
  const s = saved?.v === 2 ? { ...base, ...saved } : base;
  // progress saved before the Sovereign rule may name a hosted identity provider; under deny-all egress it reads as Keycloak
  if (s.level === 'sovereign' && s.identity && !SOVEREIGN_IDPS.includes(s.identity.idp)) s.identity = { ...s.identity, idp: 'Keycloak' };
  return s;
}

/** Identity providers offered at set-up. Sovereign: only ones that run inside the organisation's own network. */
export const HOSTED_IDPS = ['Okta', 'Microsoft Entra ID', 'Google Workspace', 'Keycloak', 'OneLogin', 'JumpCloud'];
export const SOVEREIGN_IDPS = ['Keycloak', 'Active Directory Federation Services', 'Other internal SAML provider'];
export const idpsFor = (level: LevelId) => (level === 'sovereign' ? SOVEREIGN_IDPS : HOSTED_IDPS);

/** Save it with the organisation; another device or admin of the same organisation opens the same step. */
export function saveOnboarding(orgId: string, s: OnboardingState, userId?: string) {
  const v = { ...s, updatedAt: new Date().toISOString(), updatedBy: userId };
  if (createdOrg(orgId)) { saveRegistryOnboarding(orgId, v); return; }
  (db.getDB(orgId) as WithOnboarding).onboarding = v;
  db.touch(orgId, 'onboarding');
}

export function useOnboardingState(orgId: string, userId?: string) {
  const [state, setState] = useState<OnboardingState>(() => loadOnboarding(orgId));
  const first = useRef(true);
  useEffect(() => { setState(loadOnboarding(orgId)); first.current = true; }, [orgId]);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = window.setTimeout(() => saveOnboarding(orgId, state, userId), 300);
    return () => window.clearTimeout(t);
  }, [orgId, state, userId]);
  const patch = useCallback((p: Partial<OnboardingState>) => setState((s) => ({ ...s, ...p })), []);
  const reset = useCallback(() => setState({ ...defaultOnboarding(orgId) }), [orgId]);
  return { state, setState, patch, reset };
}
