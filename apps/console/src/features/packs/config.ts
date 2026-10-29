/**
 * What each regulatory pack's declaration sets in the decision pipeline: the nine pre-gates G1–G9 run in
 * declared order before every governed write (G1 consent, G2 residency, G3 retention, G4 dual control,
 * G5 rate, G6 budget, G7 counterparty, G8 schedule, G9 precondition). Six are never skippable; only rate,
 * budget and schedule may be declared off. A pack's parameters are configurable; each change is a new
 * declaration version and a signed receipt.
 */
import type { PackId } from '@/types';
import { rupees } from '@/lib/format';
import { doorState, pause, recordChange, requireManager } from '@/features/records/ext';
import { api } from '@/api';
import { PACK_DEFAULTS } from './defaults';

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9';

export const PRE_GATES: { id: GateId; name: string; skippable: boolean }[] = [
  { id: 'G1', name: 'Consent', skippable: false },
  { id: 'G2', name: 'Residency', skippable: false },
  { id: 'G3', name: 'Retention', skippable: false },
  { id: 'G4', name: 'Dual control', skippable: false },
  { id: 'G5', name: 'Rate', skippable: true },
  { id: 'G6', name: 'Budget', skippable: true },
  { id: 'G7', name: 'Counterparty', skippable: false },
  { id: 'G8', name: 'Schedule', skippable: true },
  { id: 'G9', name: 'Precondition', skippable: false },
];

export interface PackParam { id: string; label: string; unit: string; min: number; max: number; step: number; help: string }

export const PACK_PARAMS: Record<PackId, PackParam[]> = {
  ledger1: [
    { id: 'dualControlAbove', label: 'Second person above', unit: '₹', min: 10000, max: 10000000, step: 10000, help: 'Postings above this amount wait for a second named person (G4).' },
    { id: 'retentionYears', label: 'Retention', unit: 'years', min: 8, max: 12, step: 1, help: 'Books of account are kept for 8 years at least (Companies Act, Section 128(5)).' },
  ],
  invoice1: [
    { id: 'ratePerMinute', label: 'IRP calls a minute', unit: 'calls', min: 1, max: 600, step: 1, help: 'A cap on invoice registrations a minute (G5), below the GSP limit.' },
    { id: 'cancelWindowHours', label: 'Cancellation window', unit: 'hours', min: 1, max: 24, step: 1, help: 'An IRN can be cancelled only within 24 hours of issue (G8).' },
  ],
  collect1: [
    { id: 'windowFrom', label: 'Contacts from', unit: 'hour (IST)', min: 8, max: 12, step: 1, help: 'No borrower contact before this hour (G8).' },
    { id: 'windowTo', label: 'Contacts until', unit: 'hour (IST)', min: 14, max: 19, step: 1, help: 'No borrower contact at or after this hour (G8). The RBI direction sets 19:00 as the latest.' },
    { id: 'dailyCap', label: 'Contacts a day per borrower', unit: 'contacts', min: 1, max: 5, step: 1, help: 'At most this many contacts a day across every channel (G5).' },
  ],
};

// kept in ./defaults.ts so the guard's pack check (mock/packChecks.ts) reads the same values without an import cycle
export { PACK_DEFAULTS };

/** What each pre-gate checks for this pack, with the current parameters. `off` = declared off (only G5, G6, G8). */
export function preGatesFor(pack: PackId, v: Record<string, number>, residency: string): { id: GateId; name: string; skippable: boolean; rule: string; off?: boolean }[] {
  const rules: Record<PackId, Record<GateId, { rule: string; off?: boolean }>> = {
    ledger1: {
      G1: { rule: 'The agent’s rulebook names each ledger write type it may post; any other write type is refused.' },
      G2: { rule: `Books and receipts stay in ${residency}.` },
      G3: { rule: `Kept for ${v.retentionYears} years; the trail cannot be switched off.` },
      G4: { rule: `Postings above ${rupees(v.dualControlAbove)} wait for a second named person.` },
      G5: { rule: 'Declared off — postings follow the books, not a rate.', off: true },
      G6: { rule: 'Declared off.', off: true },
      G7: { rule: 'The party must already exist in the customer or vendor master.' },
      G8: { rule: 'Declared off — the period lock in G9 applies instead.', off: true },
      G9: { rule: 'The accounting period is open and the voucher number is unique. Deletes are refused; cancellation is a reversal.' },
    },
    invoice1: {
      G1: { rule: 'The seller GSTIN is authorised for e-invoicing with the GSP.' },
      G2: { rule: `IRP calls and the register stay in ${residency}.` },
      G3: { rule: 'Kept for 72 months from the annual return due date (CGST Act, Section 36).' },
      G4: { rule: 'Cancelling an IRN waits for a second named person.' },
      G5: { rule: `At most ${v.ratePerMinute} registrations a minute.` },
      G6: { rule: 'Declared off.', off: true },
      G7: { rule: 'The buyer GSTIN is checked against the GST register before the IRN is requested.' },
      G8: { rule: `Cancellation only within ${v.cancelWindowHours} hours of the IRN.` },
      G9: { rule: 'An IRN is obtained before the invoice is sent; agents never delete an invoice.' },
    },
    collect1: {
      G1: { rule: 'The borrower’s contact consent for the channel is on file.' },
      G2: { rule: `Borrower contact data stays in ${residency}.` },
      G3: { rule: 'Contact logs and recordings are kept for the period the lender’s policy sets under the RBI directions.' },
      G4: { rule: 'Final notices wait for a named person.' },
      G5: { rule: `At most ${v.dailyCap} contacts a day per borrower, across channels.` },
      G6: { rule: 'Declared off.', off: true },
      G7: { rule: 'Only the borrower or a named co-borrower is contacted.' },
      G8: { rule: `Contacts only between ${String(v.windowFrom).padStart(2, '0')}:00 and ${String(v.windowTo).padStart(2, '0')}:00 IST.` },
      G9: { rule: 'The account is overdue and has no open dispute; templates are DLT-registered.' },
    },
  };
  return PRE_GATES.map((g) => ({ ...g, ...rules[pack][g.id] }));
}

/** The pack's current parameters and declaration version (version 1 until someone configures it). */
export function packConfig(orgId: string, pack: PackId) {
  const c = doorState(orgId).packConfig[pack];
  return { values: { ...PACK_DEFAULTS[pack], ...(c?.values ?? {}) }, version: c?.version ?? 1, updatedAt: c?.updatedAt, updatedBy: c?.updatedBy };
}

/** Save new parameters: a new declaration version and a pack.configured receipt. */
export async function configurePack(orgId: string, pack: PackId, values: Record<string, number>, userId: string) {
  await pause(300, 600);
  requireManager(orgId, userId);
  const installed = (await api.packs(orgId)).find((p) => p.id === pack)?.installed;
  if (!installed) throw new Error(`Install ${pack} before configuring it.`);
  for (const p of PACK_PARAMS[pack]) {
    const x = values[p.id];
    if (typeof x !== 'number' || Number.isNaN(x) || x < p.min || x > p.max) throw new Error(`${p.label} must be between ${p.min} and ${p.max}.`);
  }
  if (pack === 'collect1' && values.windowFrom >= values.windowTo) throw new Error('The contact window must start before it ends.');
  const st = doorState(orgId);
  const prev = packConfig(orgId, pack);
  // a withdrawn version keeps its number (mock/recordsDecl.ts): the next version comes after the highest ever used
  const kept = st.packConfig[pack];
  const version = Math.max(prev.version, kept?.highest ?? 0) + 1;
  st.packConfig[pack] = { ...kept, values: { ...values }, version, highest: version, updatedAt: new Date().toISOString(), updatedBy: userId };
  const changed = Object.keys(values).filter((k) => values[k] !== prev.values[k]);
  recordChange(orgId, userId, 'pack.configured', { pack, declaration: `decl.${pack}`, version, changed: changed.join(',') || 'none', ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v])) });
  return packConfig(orgId, pack);
}
