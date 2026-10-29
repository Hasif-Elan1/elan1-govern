/**
 * Finishing set-up: everything chosen is applied to the organisation through the API and recorded on one
 * onboarding receipt. Nothing here is decorative — each line in the result names what was applied, or why
 * it was not (for example: only an owner can raise the assurance level).
 */
import type { Role, Rule } from '@/types';
import { api, db } from '@/api';
import { LEVEL_INFO, levelRank } from '@/lib/levels';
import { rulebookYaml } from '@/mock/catalog';
import { userById } from '@/mock/users';
import { orgApi } from '@/features/settings/orgApi';
import { createdOrg, pushMail, updateCreatedOrg } from '@/features/auth/registry';
import { STARTER_RULES, frameworksFor, industryById } from './industries';
import { SOVEREIGN_IDPS, type OnboardingState } from './state';
import { isInternalName } from '@/mock/sovereign';
import { firstKeyCeremonyBlock } from '@/mock/platform';

const CUSTODY_LABEL = { aws_kms: 'AWS KMS (ap-south-1)', cloudhsm: 'AWS CloudHSM (customer-held)', luna: 'Thales Luna (customer-held)', nshield: 'Entrust nShield (customer-held)' } as const;
export { CUSTODY_LABEL };

export interface CompleteResult {
  receiptSeq?: number;
  rulebookSlug?: string;
  starterYaml: string;
  invites: { email: string; link: string }[];
  applied: string[];
  skipped: string[];
}

function starter(orgId: string, s: OnboardingState, ownerId: string) {
  const slug = `starter-${s.industry}`;
  const rules: Rule[] = STARTER_RULES[s.industry];
  const groups = Array.from(new Set(rules.map((r) => r.approver).filter(Boolean))) as string[];
  const yaml = rulebookYaml(slug, 1, ownerId, rules, groups.length ? groups : ['owners']);
  return { slug, rules, yaml, groups };
}

/**
 * The person's role in this organisation: their member record when there is one (an active member only;
 * invited or suspended people have no role here), otherwise the directory role.
 */
export function roleIn(orgId: string, userId: string | undefined): Role | undefined {
  if (!userId) return undefined;
  const m = db.getDB(orgId).members.find((x) => x.userId === userId);
  if (m) return m.status === 'active' ? m.role : undefined;
  const u = userById(userId);
  return u && u.orgIds.includes(orgId) ? u.role : undefined;
}

/** Set-up changes the organisation, so only its owners and admins can run it. */
export function canRunSetup(role: Role | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** Apply set-up to the organisation. */
export async function completeOnboarding(orgId: string, s: OnboardingState, userId: string): Promise<CompleteResult> {
  const role = roleIn(orgId, userId);
  if (!canRunSetup(role)) throw new Error('Only an owner or admin of this organisation can finish set-up. Nothing was changed.');
  const applied: string[] = [];
  const skipped: string[] = [];
  const invites: { email: string; link: string }[] = [];
  const user = userById(userId);
  const isOwner = role === 'owner';
  const st = starter(orgId, s, userId);
  const fw = frameworksFor(s.industry, s.regions);

  /*
   * An organisation created in this browser keeps its directory record in the registry (name, profile) and has
   * its own empty database and receipt chain in the mock, so set-up is applied to it like any other organisation
   * below — never to the demonstration organisation. The level is raised on its chain (owner only).
   */
  const created = createdOrg(orgId);
  if (created) {
    updateCreatedOrg(orgId, {
      name: s.company.name.trim() || created.name, legalEntity: s.company.legal.trim() || undefined, industry: s.industry, regions: s.regions, currency: s.currency, timezone: s.timezone,
    });
  }

  const d = db.getDB(orgId);
  const ensure = async (label: string, fn: () => Promise<unknown> | unknown) => {
    try { await fn(); applied.push(label); } catch (e) { const m = (e as Error).message; if (m !== 'Nothing changed.') skipped.push(`${label.replace(/\.$/, '')}: ${m}`); }
  };

  // 1 Organisation profile
  await ensure(`Organisation profile updated: ${s.company.name.trim() || d.org.name}, ${industryById(s.industry).label}, ${s.regions.join(', ')}, ${s.currency}, ${s.timezone}.`,
    () => orgApi.updateOrg(orgId, { name: s.company.name.trim() || d.org.name, industry: s.industry, regions: s.regions, currency: s.currency, timezone: s.timezone }, userId));
  if (s.company.legal.trim()) { (d.org as typeof d.org & { legalEntity?: string }).legalEntity = s.company.legal.trim(); applied.push(`Legal entity recorded for invoices: ${s.company.legal.trim()}.`); }

  // 2 Frameworks
  const toEnable = d.frameworks.filter((f) => fw.includes(f.short) && !f.enabled);
  for (const f of toEnable) await ensure(`Framework enabled: ${f.short}.`, () => api.setFramework(orgId, f.id, true, userId));
  if (!toEnable.length) applied.push(`Frameworks already tracked: ${d.frameworks.filter((f) => f.enabled).map((f) => f.short).join(', ')}.`);

  // 3 Assurance level (owner only, never down)
  const current = api.levelOf(orgId);
  if (levelRank(s.level) > levelRank(current)) {
    if (!isOwner) skipped.push(`Moving to ${LEVEL_INFO[s.level].label} needs an owner; ask one to confirm it in the Assurance door, under Assurance levels.`);
    else await ensure(`Assurance level raised from ${LEVEL_INFO[current].label} to ${LEVEL_INFO[s.level].label}; the boundary is recorded and earlier records keep their level.`, () => api.upgradeLevel(orgId, s.level, userId));
  }
  const now = api.levelOf(orgId);

  // 4 Key custody (customer-held keys: a key ceremony with at least 3 named holders)
  if (levelRank(now) >= levelRank('l3') && s.custody !== 'aws_kms') {
    const holders = s.holders.map((h) => h.trim()).filter(Boolean);
    // the first ceremony at set-up creates the organisation's first customer-held key, which signs at once: there is no
    // earlier customer-held key to overlap with, so nothing is left bound and level and key changes stay open. An
    // organisation that already signs with its own key publishes a successor with the 30-day overlap instead.
    const firstKey = !firstKeyCeremonyBlock(orgId);
    if (holders.length >= 3) await ensure(firstKey
      ? `Key ceremony held in ${CUSTODY_LABEL[s.custody]} with ${holders.length} named key holders; your first customer-held key signs from now.`
      : `Key ceremony held in ${CUSTODY_LABEL[s.custody]} with ${holders.length} named key holders; the new key is published as the successor and signs after the 30-day overlap.`,
    () => api.runKeyCeremony(orgId, userId, holders, { firstKey }));
    else skipped.push('Key ceremony: name at least 3 key holders (a quorum of 3 of 5) to hold it.');
  } else if (levelRank(now) >= levelRank('l2')) applied.push('Signing key held in AWS KMS in the ap-south-1 residency domain.');

  // 5 Regulatory packs: a dry run at L1 (no regulatory claim until L2), live from L2
  for (const p of s.packs) {
    if (d.platform.packs.some((x) => x.id === p)) { applied.push(`${p} already installed.`); continue; }
    const dryRun = levelRank(now) < levelRank('l2');
    await ensure(dryRun
      ? `${p} installed as a dry run: its rules run and its reports say “dry run — no regulatory claim until L2”. It goes live when the organisation moves to L2 Attested (₹1,35,000 a year from then).`
      : `${p} installed and live (₹1,35,000 a year).`, () => api.installPack(orgId, p, userId));
  }
  if (s.profiles.length) {
    if (levelRank(now) < levelRank('l2')) skipped.push(`Verifier profiles (${s.profiles.join(', ')}): checked against your bundles from L2 Attested; each is billed as its own line, not included with a pack.`);
    else applied.push(`Verifier profiles chosen: ${s.profiles.join(', ')} — each billed as its own line (₹3,00,000 a year per regime), not included with a pack.`);
  }

  // 6 Identity (owner only)
  // Sovereign denies all egress: SAML only from an identity provider inside the network (the API refuses the rest
  // and records egress.blocked once the deployment is Sovereign; before then set-up does not save it either)
  const sovIdpProblem = s.identity.saml && (s.level === 'sovereign' || now === 'sovereign')
    ? (!SOVEREIGN_IDPS.includes(s.identity.idp) ? `${s.identity.idp} is a cloud service outside your network; a Sovereign deployment uses Keycloak or another identity provider inside it.`
      : s.identity.metadataUrl.trim() && !isInternalName(orgId, s.identity.metadataUrl) ? 'the metadata URL is outside your network; a Sovereign deployment reaches only .internal, .local, .lan, private addresses or your own domain.' : undefined)
    : undefined;
  if (s.identity.saml || s.identity.scim) {
    if (!isOwner) skipped.push('SAML and SCIM settings need an owner; ask one to apply them in the Agents door, under Organisation.');
    else if (sovIdpProblem) {
      skipped.push(`SAML with ${s.identity.idp} not saved: ${sovIdpProblem}`);
      if (s.identity.scim) await ensure('Sign-in: SCIM provisioning on.', () => api.setIdentityConfig(orgId, { scim: { enabled: true } }, userId));
    } else await ensure(`Sign-in: ${s.identity.saml ? `SAML with ${s.identity.idp}` : 'password and OIDC'}${s.identity.scim ? ', SCIM provisioning on' : ''}.`,
      () => api.setIdentityConfig(orgId, { saml: { enabled: s.identity.saml, idp: s.identity.idp, ...(s.identity.metadataUrl ? { metadataUrl: s.identity.metadataUrl } : {}) }, scim: { enabled: s.identity.scim } }, userId));
  }

  // 7 Starter rulebook as an unpublished draft, on a draft agent
  if (!d.rulebooks.some((r) => r.slug === st.slug)) {
    db.starterFromOnboarding(d, s.industry, userId);
    db.logAdmin(orgId, userId, 'rulebook.drafted', { rulebook: st.slug, version: 1, rules: st.rules.length, source: 'onboarding' }, st.slug);
    db.touch(orgId, 'rulebook');
    applied.push(`Starter rulebook ${st.slug} v1 saved as an unpublished draft with ${st.rules.length} rules.`);
  } else applied.push(`Starter rulebook ${st.slug} already exists; left as it is.`);

  // 8 Invitations (single-use links; shown in the demo outbox)
  const byRole = new Map<string, string[]>();
  for (const i of s.invites) (byRole.get(i.role) ?? byRole.set(i.role, []).get(i.role)!).push(i.email);
  for (const [role, emails] of byRole) {
    const existing = new Set(d.members.map((m) => orgApi.emailOf(orgId, m).toLowerCase()));
    const fresh = emails.filter((e) => !existing.has(e.toLowerCase()));
    if (fresh.length < emails.length) skipped.push(`Already members or invited: ${emails.filter((e) => existing.has(e.toLowerCase())).join(', ')}.`);
    if (!fresh.length) continue;
    try {
      const r = await orgApi.inviteMembers(orgId, fresh, role as 'admin' | 'approver' | 'viewer', userId);
      for (const t of r.invites) {
        invites.push({ email: t.email, link: `/invite/${t.token}` });
        pushMail({ channel: 'email', to: t.email, subject: `${user?.name ?? 'An owner'} invited you to ${d.org.name} on Elan1 Govern`, body: `You are invited as ${role}. The link works once and expires in 7 days.`, link: `/invite/${t.token}`, orgId });
      }
    } catch (e) { skipped.push(`Invitations (${role}): ${(e as Error).message}`); }
  }
  if (invites.length) applied.push(`${invites.length} invitation${invites.length === 1 ? '' : 's'} sent as single-use links (valid 7 days).`);

  // 9 The onboarding receipt
  const r = db.logAdmin(orgId, userId, 'onboarding.completed', {
    company: s.company.name.trim() || d.org.name, industry: s.industry, regions: s.regions.join(', '), currency: s.currency, timezone: s.timezone,
    level: api.levelOf(orgId), residency: s.residency, custody: levelRank(now) >= levelRank('l3') ? s.custody : levelRank(now) >= levelRank('l2') ? 'aws_kms' : 'elan1_held',
    tsa: levelRank(now) >= levelRank('l2') ? (now === 'sovereign' ? s.localTsas.join(' + ') : `eMudhra + ${s.globalTsa}`) : 'none (L1)',
    packs: s.packs.join(', ') || 'none', profiles: s.profiles.join(', ') || 'none', dual_control: levelRank(now) >= levelRank('l2') ? 'enforced' : 'recorded',
    saml: s.identity.saml, scim: s.identity.scim, invites: invites.length, slack: now !== 'sovereign' && s.slack.connected, whatsapp: now !== 'sovereign' && s.whatsapp.verified, // Sovereign: deny-all egress
    sovereign_checks: now === 'sovereign' ? Object.values(s.sovereign.checks).filter(Boolean).length : 0, starter_rulebook: st.slug,
  });
  return { receiptSeq: r.seq, rulebookSlug: st.slug, starterYaml: st.yaml, invites, applied, skipped };
}
