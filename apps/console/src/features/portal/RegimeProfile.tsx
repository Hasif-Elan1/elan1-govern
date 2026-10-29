import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, Scale } from 'lucide-react';
import type { LevelId, ProfileRuleResult, Receipt, RevealedField } from '@/types';
import { PROFILES, PROFILE_STATUS_LABEL, RULE_STATE_LABEL, profileById, runProfileRules } from '@/lib/profiles';
import { FIELD_LABELS, type DisclosableField } from '@/lib/disclosure';
import { seqLabel } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Banner, Button, Field, Select } from '@/components/ui';

/**
 * A regulator signed in to the portal runs the verifier profile for their regime on what was disclosed to them
 * (a receipt or a bundle), in their browser, with the same rule runner the console and the offline verifier use
 * (lib/profiles runProfileRules). A disclosure carries only the revealed fields, so a rule is run only when every
 * field it reads was revealed; a rule that needs a withheld field, the links between receipts or the issuer's own
 * records (checkpoints, retention, timestamps, erasures, inventory) reads "Not measurable" and says why, never a
 * silent pass. Nothing is sent: the run is not recorded on the issuer's chain.
 */

/** The regime a regulator supervises, by employer. Anyone else picks a profile. */
const REGIME_BY_EMPLOYER: Record<string, string> = { 'Reserve Bank of India': 'in-rbi-collections' };

/** Rules that can be measured from disclosed fields, and the fields each reads. */
const NEEDS: Record<string, DisclosableField[]> = {
  'in-mca-audit-trail:C02': ['tool', 'agent', 'rulebook_version'],
  'in-gst-einvoice:C03': ['tool', 'decision'],
  'in-rbi-collections:C04': ['ts', 'rule_id', 'decision'],
  'eu-ai-act-art12:C02': ['ts', 'decision', 'rulebook_version'],
  'eu-ai-act-art12:C03': ['approval'],
  'iso42001-nist:C03': ['decision', 'reason', 'rule_id'],
};

/** What a rule reads that a disclosure never carries. */
function outsideDisclosure(profileId: string, ruleId: string, kind: string): string {
  if (ruleId === 'C01') return 'the links between receipts (each one’s previous hash), which travel in the issuer’s evidence bundle, not in a disclosure. The issuer’s signature over each disclosed receipt is checked above instead';
  const key = `${profileId}:${ruleId}`;
  const what: Record<string, string> = {
    'in-mca-audit-trail:C03': 'the approval records and the decisions they point to, by sequence',
    'in-mca-audit-trail:C04': 'the issuer’s daily checkpoints',
    'in-mca-audit-trail:C06': 'the issuer’s rulebook publishes',
    'in-gst-einvoice:C02': 'each call’s counterparty, which is not a disclosable field',
    'in-gst-einvoice:C05': 'the issuer’s timestamp batches',
    'in-rbi-collections:C02': 'each contact’s template, which is not a disclosable field',
    'in-rbi-collections:C03': 'each contact’s template (to find the final notices), which is not a disclosable field',
    'in-dpdp:C02': 'the call arguments, which are never disclosed',
    'in-dpdp:C03': 'the issuer’s erasure requests',
    'in-dpdp:C04': 'the risk tags on each call',
    'iso42001-nist:C02': 'the issuer’s AI inventory',
    'iso42001-nist:C04': 'the issuer’s assessments',
  };
  if (what[key]) return what[key];
  if (kind === 'temporal') return 'the issuer’s write-once storage settings';
  return 'parts of the issuer’s records that a disclosure does not carry';
}

/** One disclosed receipt as the rule runner reads it: only the revealed values are present. */
function toReceipts(items: { seq: number; revealed: RevealedField[] }[]): Receipt[] {
  const out: Receipt[] = [];
  for (const it of items) {
    const v = new Map(it.revealed.map((f) => [f.name, f.value]));
    const [held, final] = (v.get('decision') ?? '').split('→').map((s) => s.trim());
    const rbv = /^v(\d+)/.exec(v.get('rulebook_version') ?? '');
    const amount = v.get('amount');
    const r = {
      seq: it.seq, kind: 'decision', ts: v.get('ts') ?? '',
      agent: v.get('agent') || undefined, tool: v.get('tool') || undefined,
      decision: held || undefined, rule_id: v.get('rule_id') || undefined, reason: v.get('reason') || undefined,
      rulebook: rbv ? { version: Number(rbv[1]), hash: '' } : undefined,
      args_summary: amount ? { amount: Number(amount) } : {},
    } as unknown as Receipt;
    out.push(r);
    // a held call's approval travels inside the same disclosed receipt: "approved by u_x via web"
    const ap = v.get('approval');
    if (ap && ap !== 'none') {
      const m = /^(\w+)(?: by (\S+))?(?: via (\w+))?/.exec(ap);
      // only a decided approval is a human decision; one still waiting has no approver yet
      if (!m || !['approved', 'rejected', 'expired'].includes(m[1])) continue;
      out.push({ seq: it.seq, kind: 'approval', ts: v.get('ts') ?? '', ref_seq: it.seq, decision: final || undefined, approval: { status: m?.[1] ?? ap, approver: m?.[2], channel: m?.[3] } } as unknown as Receipt);
    }
  }
  return out;
}

export function RegimeProfile({ employer, issuer, level, items, fields, claimedProfileId, verified }: {
  employer: string; issuer: string; level: LevelId;
  items: { seq: number; revealed: RevealedField[] }[];
  /** the fields revealed for every item */
  fields: string[];
  /** a profile the issuer claimed for a bundle, if any */
  claimedProfileId?: string;
  /** false when the disclosure did not verify: the run still works but says so */
  verified?: boolean;
}) {
  const [profileId, setProfileId] = useState(claimedProfileId && profileById(claimedProfileId) ? claimedProfileId : REGIME_BY_EMPLOYER[employer] ?? PROFILES[0].id);
  const [run, setRun] = useState<{ profileId: string; rules: ProfileRuleResult[] }>();
  const profile = profileById(profileId)!;
  const receipts = useMemo(() => toReceipts(items), [items]);

  const go = () => {
    const shown = new Set(fields);
    const raw = runProfileRules(profile, { receipts, checkpoints: [], level, wormRetentionYears: 0, erasures: [], agents: [], aiSystems: [], assessments: [] });
    const rules = raw.map((r): ProfileRuleResult => {
      if (r.state === 'not_measurable' || r.state === 'out_of_scope') return r; // the profile's own disposition
      const needs = NEEDS[`${profile.id}:${r.id}`];
      if (!needs) return { ...r, state: 'not_measurable', detail: `Not measurable from what was shared: this rule reads ${outsideDisclosure(profile.id, r.id, r.kind)}.`, failingSeqs: [] };
      const missing = needs.filter((f) => !shown.has(f));
      if (missing.length) return { ...r, state: 'not_measurable', detail: `Not measurable from what was shared: it needs ${missing.map((f) => FIELD_LABELS[f].toLowerCase()).join(', ')}, which ${issuer} withheld.`, failingSeqs: [] };
      return r;
    });
    setRun({ profileId: profile.id, rules });
  };

  const shownRun = run?.profileId === profile.id ? run : undefined;
  const count = (s: ProfileRuleResult['state']) => shownRun?.rules.filter((r) => r.state === s).length ?? 0;

  return (
    <section aria-labelledby="regime-title" className="space-y-4 border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="regime-title" className="flex items-center gap-2 text-lg font-semibold"><Scale className="h-4 w-4 text-muted" aria-hidden />Run the profile for your regime</h2>
          <p className="mt-1 max-w-[72ch] text-sm leading-relaxed text-muted">The same rules the offline verifier runs, applied in this browser to the {items.length === 1 ? 'receipt' : `${items.length} receipts`} {issuer} disclosed. A rule runs only when every field it reads was revealed; anything else reads “Not measurable” with the reason. Nothing is sent or recorded.</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Field label="Verifier profile" htmlFor="regime-profile" hint={`${profile.regime} · ${PROFILE_STATUS_LABEL[profile.status]} · v${profile.version}`}>
          <Select id="regime-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {PROFILES.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === REGIME_BY_EMPLOYER[employer] ? ' (your regime)' : p.id === claimedProfileId ? ' (claimed by the issuer)' : ''}</option>)}
          </Select>
        </Field>
        <Button variant="primary" icon={<Play className="h-4 w-4" aria-hidden />} onClick={go}>Run the profile</Button>
      </div>
      {verified === false && <Banner tone="bad" title="The disclosure did not verify">The profile still runs on the values shown, but they are not proven to be what {issuer} signed.</Banner>}
      {shownRun && (
        <div className="space-y-3" aria-live="polite">
          <Banner tone={count('fail') ? 'bad' : count('pass') ? 'ok' : 'neutral'} title={count('fail') ? `${count('fail')} of ${shownRun.rules.length} rules fail` : count('pass') ? `${count('pass')} measurable ${count('pass') === 1 ? 'rule passes' : 'rules pass'}` : 'No rule could be measured from what was shared'}>
            {count('pass')} pass · {count('fail')} fail · {count('not_applicable')} not applicable · {count('not_measurable')} not measurable from what was shared · {count('out_of_scope')} out of scope. A pass is evidence for a reviewer, not a finding.
          </Banner>
          <ul className="divide-y divide-line border border-line">
            {shownRun.rules.map((r) => (
              <li key={r.id} className="grid gap-1 px-3 py-2.5 text-sm sm:grid-cols-[5.5rem_minmax(0,1fr)_8rem] sm:gap-3">
                <span className="font-mono text-xs text-muted">{r.id} · {r.clause}</span>
                <span className="min-w-0">
                  <span className="block">{r.text}</span>
                  <span className="mt-0.5 block text-xs text-muted leading-relaxed">{r.detail}{r.failingSeqs.length ? ` Failing: ${r.failingSeqs.slice(0, 8).map((s) => seqLabel(s)).join(', ')}${r.failingSeqs.length > 8 ? ' …' : ''}.` : ''}</span>
                </span>
                <span className={cn('self-start justify-self-start border px-2 py-0.5 text-xs font-medium sm:justify-self-end',
                  r.state === 'pass' ? 'border-ok/50 bg-ok-bg text-ok-fg' : r.state === 'fail' ? 'border-bad/50 bg-bad-bg text-bad-fg' : 'border-line bg-sunken text-muted')}>{RULE_STATE_LABEL[r.state]}</span>
              </li>
            ))}
          </ul>
          <div className="border border-line bg-sunken/50 p-3 text-xs leading-relaxed">
            <p className="label">What this profile does not show</p>
            <p className="mt-1">{profile.limits}</p>
          </div>
          <p className="text-xs text-muted">To measure every rule, ask {issuer} for its evidence bundle and open it in the <Link to="/verify" className="link">public verifier</Link> with the same profile.</p>
        </div>
      )}
    </section>
  );
}
