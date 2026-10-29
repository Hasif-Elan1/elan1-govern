/**
 * The lexicon member of an L2+ evidence bundle (spec 02 §4.9): the rule and refusal vocabulary the bundle's receipts
 * use, so that a verifier can read their ids without the console. It is built from the receipts in range, the rulebook
 * versions they name and the refusal register. It is an extra member: the eight members keep their names.
 */
import type { Receipt } from '@/types';
import type { BundleLexicon } from '@/lib/verify6';
import { REFUSAL_CODES } from './devpathData';
import type { OrgDB } from './db';

const DECISIONS: Record<string, string> = {
  allow: 'Allowed: the call was permitted and, on a governed run, carried out.',
  refuse: 'Refused: the call was not permitted. On a governed run nothing ran.',
  ask: 'Held: the call waits for a person to approve or decline it.',
};

export function buildLexicon(db: OrgDB, receipts: Receipt[]): BundleLexicon {
  const rules = new Map<string, { id: string; decision?: string; text?: string; rulebooks: Set<string> }>();
  const wires = new Set<string>();
  for (const r of receipts) {
    if (r.reason) {
      const m = /^((?:POLICY|GATE|PLATFORM)\.[A-Z_]+)/.exec(r.reason);
      if (m) wires.add(m[1]);
    }
    if (!r.rule_id) continue;
    const row = rules.get(r.rule_id) ?? { id: r.rule_id, rulebooks: new Set<string>() };
    if (r.agent && r.rulebook) {
      row.rulebooks.add(`${r.agent} v${r.rulebook.version}`);
      if (!row.text) {
        const rule = db.rulebooks.find((b) => b.slug === r.agent)?.versions.find((v) => v.version === r.rulebook!.version)?.rules.find((x) => x.id === r.rule_id);
        if (rule) { row.decision = rule.decide; row.text = rule.reason; }
      }
    }
    rules.set(r.rule_id, row);
  }
  const ruleIds = new Set(rules.keys());
  const codes = REFUSAL_CODES.filter((c) => wires.has(c.wire) || (c.builtId !== undefined && ruleIds.has(c.builtId)));
  return {
    format: 'elan1.lexicon.v1',
    decisions: DECISIONS,
    rules: Array.from(rules.values()).sort((a, b) => a.id.localeCompare(b.id)).map((x) => ({
      id: x.id, ...(x.decision ? { decision: x.decision } : {}), ...(x.text ? { text: x.text } : {}), ...(x.rulebooks.size ? { rulebooks: Array.from(x.rulebooks).sort() } : {}),
    })),
    refusal_codes: codes.map((c) => ({ code: c.wire, ref: c.ref, family: c.family, title: c.title, ...(c.builtId ? { rule_ids: [c.builtId] } : {}) })),
  };
}
