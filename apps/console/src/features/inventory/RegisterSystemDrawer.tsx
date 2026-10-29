import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, X, ShieldQuestion } from 'lucide-react';
import { api } from '@/api';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import type { Agent, AiSystem, Framework, Lifecycle } from '@/types';
import { Banner, Button, Checkbox, Drawer, Field, Input, RadioCards, Select, Textarea, toast } from '@/components/ui';
import { evidenceClaim } from '@/features/records/level';
import { KIND_LABEL, LIFECYCLE_META, LIFECYCLE_ORDER, TIER_HELP } from './governance';
import { PRINCIPALS, RESIDENCIES, extraOf, setExtraQuietly, updateAiSystem } from './ops';

export interface RegisterPrefill {
  name?: string;
  kind?: AiSystem['kind'];
  vendor?: string;
  purpose?: string;
  ownerId?: string;
  linkedAgentId?: string;
  lifecycle?: Lifecycle;
  businessUnit?: string;
  dataCategories?: string[];
  affectedPeople?: string[];
  decisionImpact?: AiSystem['decisionImpact'];
  frameworks?: string[];
  residency?: string;
  personalData?: boolean;
  principals?: string[];
  modelName?: string;
  modelVersion?: string;
}

/** A person who can own an AI system: from the organisation's members (invited and SCIM-provisioned included). */
export interface OwnerOption { id: string; name: string; title: string; status?: string }

const DATA_SUGGESTIONS = ['Customer contact details', 'Employee data', 'Financial identifiers', 'Bank details', 'Health data', 'CVs', 'Business documents', 'Source code', 'Order data', 'Sales history'];
const PEOPLE_SUGGESTIONS = ['Customers', 'Employees', 'Vendors', 'Job applicants', 'Patients', 'Borrowers', 'Company'];

/** Free-text chips with suggestions. Enter or comma adds; Backspace on empty removes the last. */
function TokenField({ id, value, onChange, suggestions, placeholder }: { id: string; value: string[]; onChange: (v: string[]) => void; suggestions: string[]; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const add = (t: string) => {
    const v = t.trim().replace(/,$/, '');
    if (v && !value.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...value, v]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft); }
    if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  const open = suggestions.filter((s) => !value.includes(s));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 border border-line-strong/70 bg-surface px-2 py-1.5 min-h-10 focus-within:border-fg">
        {value.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 text-xs bg-sunken border border-line">
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))} className="text-muted hover:text-fg"><X className="h-3 w-3" /></button>
          </span>
        ))}
        <input id={id} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={() => draft && add(draft)} placeholder={value.length ? '' : placeholder} className="flex-1 min-w-[120px] h-7 bg-transparent text-sm outline-none placeholder:text-subtle" />
      </div>
      {open.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {open.slice(0, 7).map((s) => (
            <button key={s} type="button" onClick={() => add(s)} className="inline-flex items-center gap-1 h-6 px-1.5 text-xs text-muted border border-dashed border-line-strong/70 hover:text-fg hover:border-fg">
              <Plus className="h-3 w-3" aria-hidden />{s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Register, edit, or register-from-discovery an AI system.
 * - register: api.addAiSystem (inventory.added receipt)
 * - finding:  api.registerFinding, then the details here (inventory.added + inventory.updated)
 * - edit:     updateAiSystem (inventory.updated)
 */
export function RegisterSystemDrawer({ open, onClose, prefill, agents, frameworks, people, units, linkedAgentIds, edit, findingId, onDone }: {
  open: boolean; onClose: () => void; prefill?: RegisterPrefill; agents: Agent[]; frameworks: Framework[]; people: OwnerOption[]; units: string[]; linkedAgentIds: string[];
  edit?: AiSystem; findingId?: string; onDone?: (s: AiSystem) => void;
}) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const mode: 'edit' | 'finding' | 'register' = edit ? 'edit' : findingId ? 'finding' : 'register';

  const blank = useMemo(() => ({
    name: '', kind: 'agent' as AiSystem['kind'], vendor: '', purpose: '', ownerId: user?.id ?? '', businessUnit: '', lifecycle: 'proposed' as Lifecycle,
    dataCategories: [] as string[], affectedPeople: [] as string[], decisionImpact: 'informs' as AiSystem['decisionImpact'], linkedAgentId: '', frameworks: [] as string[],
    residency: RESIDENCIES[0], personalData: false, principals: [] as string[], modelName: '', modelVersion: '',
  }), [user?.id]);
  const [f, setF] = useState(blank);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTried(false);
    setErr(undefined);
    if (edit) {
      const x = extraOf(orgId, edit.id);
      setF({
        name: edit.name, kind: edit.kind, vendor: edit.vendor, purpose: edit.purpose, ownerId: edit.ownerId, businessUnit: edit.businessUnit, lifecycle: edit.lifecycle,
        dataCategories: edit.dataCategories, affectedPeople: edit.affectedPeople, decisionImpact: edit.decisionImpact, linkedAgentId: edit.linkedAgentId ?? '', frameworks: edit.frameworks,
        residency: x?.residency ?? RESIDENCIES[0], personalData: x?.personalData ?? edit.dataCategories.some((d) => /contact|personal|health|cv|employee|bank|identifier/i.test(d)), principals: x?.principals ?? [],
        modelName: edit.modelName ?? '', modelVersion: edit.modelVersion ?? '',
      });
      return;
    }
    setF({
      ...blank,
      name: prefill?.name ?? '', kind: prefill?.kind ?? blank.kind, vendor: prefill?.vendor ?? '', purpose: prefill?.purpose ?? '',
      ownerId: prefill?.ownerId ?? blank.ownerId, linkedAgentId: prefill?.linkedAgentId ?? '', lifecycle: prefill?.lifecycle ?? blank.lifecycle,
      businessUnit: prefill?.businessUnit ?? '', dataCategories: prefill?.dataCategories ?? [], affectedPeople: prefill?.affectedPeople ?? [], decisionImpact: prefill?.decisionImpact ?? blank.decisionImpact,
      frameworks: prefill?.frameworks ?? [], residency: prefill?.residency ?? blank.residency, personalData: prefill?.personalData ?? false, principals: prefill?.principals ?? [],
      modelName: prefill?.modelName ?? '', modelVersion: prefill?.modelVersion ?? '',
    });
  }, [open, prefill, blank, edit, orgId]);

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const errors = {
    name: !f.name.trim() ? 'Give the system a name people will recognise.' : undefined,
    purpose: f.purpose.trim().length < 8 ? 'Say in one sentence what it is for.' : undefined,
    ownerId: !f.ownerId ? 'Every AI system has a named owner.' : undefined,
    businessUnit: !f.businessUnit.trim() || f.businessUnit.trim() === 'To be confirmed' ? 'Which part of the business uses it?' : undefined,
    vendor: !f.vendor.trim() ? 'Who builds or supplies it? “In-house” is fine.' : undefined,
    principals: f.personalData && !f.principals.length ? 'Whose personal data is it? Choose at least one group of data principals.' : undefined,
    modelVersion: f.modelName.trim() && !f.modelVersion.trim() ? 'Give the version or snapshot. “Not disclosed by the vendor” is an answer too.' : undefined,
  };
  const valid = Object.values(errors).every((e) => !e);
  const availableAgents = agents.filter((a) => !linkedAgentIds.includes(a.id) || a.id === prefill?.linkedAgentId || a.id === edit?.linkedAgentId);

  const submit = async () => {
    setTried(true);
    if (!valid || !user) return;
    setBusy(true);
    setErr(undefined);
    const details = {
      name: f.name.trim(), kind: f.kind, vendor: f.vendor.trim(), purpose: f.purpose.trim(), ownerId: f.ownerId, businessUnit: f.businessUnit.trim(),
      dataCategories: f.dataCategories, affectedPeople: f.affectedPeople, decisionImpact: f.decisionImpact, linkedAgentId: f.linkedAgentId || undefined, frameworks: f.frameworks,
      modelName: f.modelName.trim() || undefined, modelVersion: f.modelName.trim() ? f.modelVersion.trim() : undefined,
    };
    const extra = { residency: f.residency, personalData: f.personalData, principals: f.personalData ? f.principals : [] };
    try {
      let s: AiSystem;
      if (mode === 'edit') {
        s = await updateAiSystem(orgId, edit!.id, details, extra, user.id);
        toast.ok('Details saved', 'The change is a receipt on the chain.');
      } else if (mode === 'finding') {
        const r = await api.registerFinding(orgId, findingId!, user.id);
        s = await updateAiSystem(orgId, r.system.id, details, extra, user.id);
        toast.ok(`${s.name} registered from discovery`, 'Risk tier: Unassessed until a different person approves an assessment.', { label: 'Open the system', onClick: () => nav(`/inventory/${s.id}`) });
      } else {
        s = await api.addAiSystem(orgId, { ...details, lifecycle: f.lifecycle }, user.id);
        setExtraQuietly(orgId, s.id, extra);
        toast.ok(`${s.name} registered`, 'Risk tier: Unassessed until a different person approves an assessment. The registration is a receipt on the chain.', { label: 'Open the system', onClick: () => nav(`/inventory/${s.id}`) });
      }
      onDone?.(s);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      kicker={mode === 'finding' ? 'AI inventory · from discovery' : 'AI inventory'}
      title={mode === 'edit' ? `Edit ${edit?.name ?? 'AI system'}` : 'Register an AI system'}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy}>{mode === 'edit' ? 'Save details' : 'Register system'}</Button>
        </>
      }
    >
      <div className="space-y-6">
        {err && <Banner tone="bad" title="Could not save">{err}</Banner>}
        {mode !== 'edit' && <Banner tone="neutral" title="Risk tier starts as Unassessed">{TIER_HELP}</Banner>}
        {mode === 'edit' && <Banner tone="neutral" title="The risk tier and lifecycle are not edited here">{TIER_HELP} Move the lifecycle from the system page.</Banner>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required htmlFor="reg-name" error={tried && errors.name} className="sm:col-span-2">
            <Input id="reg-name" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="For example: Claims triage assistant" invalid={tried && !!errors.name} data-autofocus />
          </Field>
          <Field label="Kind" htmlFor="reg-kind">
            <Select id="reg-kind" value={f.kind} onChange={(e) => set('kind', e.target.value as AiSystem['kind'])}>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Vendor" required htmlFor="reg-vendor" error={tried && errors.vendor}>
            <Input id="reg-vendor" value={f.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="In-house, Microsoft, Anthropic…" invalid={tried && !!errors.vendor} />
          </Field>
          <Field label="Model name" htmlFor="reg-model" hint="The model it runs on. Goes into the RBI model documentation.">
            <Input id="reg-model" value={f.modelName} onChange={(e) => set('modelName', e.target.value)} placeholder="Claude Sonnet 4.5, GPT-4o…" />
          </Field>
          <Field label="Model version" htmlFor="reg-model-v" error={tried && errors.modelVersion} hint="Version or snapshot id.">
            <Input id="reg-model-v" mono value={f.modelVersion} onChange={(e) => set('modelVersion', e.target.value)} placeholder="2025-09-29" invalid={tried && !!errors.modelVersion} />
          </Field>
          <Field label="Purpose" required htmlFor="reg-purpose" error={tried && errors.purpose} hint="One or two plain sentences: what it does and for whom." className="sm:col-span-2">
            <Textarea id="reg-purpose" rows={2} value={f.purpose} onChange={(e) => set('purpose', e.target.value)} invalid={tried && !!errors.purpose} />
          </Field>
          <Field label="Owner" required htmlFor="reg-owner" error={tried && errors.ownerId} hint="The person accountable for it.">
            <Select id="reg-owner" value={f.ownerId} onChange={(e) => set('ownerId', e.target.value)}>
              <option value="">Choose a person</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.title}{p.status && p.status !== 'active' ? ` (${p.status})` : ''}</option>)}
            </Select>
          </Field>
          <Field label="Business unit" required htmlFor="reg-unit" error={tried && errors.businessUnit}>
            <Input id="reg-unit" list="reg-units" value={f.businessUnit} onChange={(e) => set('businessUnit', e.target.value)} placeholder="Finance" invalid={tried && !!errors.businessUnit} />
            <datalist id="reg-units">{units.map((u) => <option key={u} value={u} />)}</datalist>
          </Field>
        </div>

        {mode === 'register' && (
          <Field label="Lifecycle stage" hint="Proposed → In review → Approved → Live → Retired. Approved and Live need an approved assessment, so new systems start as Proposed or In review.">
            <RadioCards name="lifecycle" cols={2} value={f.lifecycle} onChange={(v) => set('lifecycle', v)}
              options={LIFECYCLE_ORDER.filter((s) => s === 'proposed' || s === 'in_review').map((s) => ({ value: s, label: LIFECYCLE_META[s].label, description: LIFECYCLE_META[s].help }))} />
          </Field>
        )}

        <Field label="Decision impact" hint="Whether it makes decisions on its own. Assessments weigh this heavily.">
          <RadioCards name="impact" cols={3} value={f.decisionImpact} onChange={(v) => set('decisionImpact', v)}
            options={[
              { value: 'none', label: 'No decisions', description: 'Produces content a person uses.' },
              { value: 'informs', label: 'Informs decisions', description: 'A person reads its output and decides.' },
              { value: 'decides', label: 'Makes decisions', description: 'Commits the business without a person.' },
            ]} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Data categories" htmlFor="reg-data" hint="What data it reads or writes.">
            <TokenField id="reg-data" value={f.dataCategories} onChange={(v) => set('dataCategories', v)} suggestions={DATA_SUGGESTIONS} placeholder="Type and press Enter" />
          </Field>
          <Field label="Affected people" htmlFor="reg-people" hint="Who is affected if it gets something wrong.">
            <TokenField id="reg-people" value={f.affectedPeople} onChange={(v) => set('affectedPeople', v)} suggestions={PEOPLE_SUGGESTIONS} placeholder="Type and press Enter" />
          </Field>
        </div>

        <fieldset className="border border-line p-4 space-y-4">
          <legend className="label px-1">Residency and personal data (DPDP)</legend>
          <Field label="Data residency" htmlFor="reg-res" hint="Where the system processes and stores data.">
            <Select id="reg-res" value={f.residency} onChange={(e) => set('residency', e.target.value)}>
              {RESIDENCIES.map((r) => <option key={r}>{r}</option>)}
            </Select>
          </Field>
          <Checkbox checked={f.personalData} onChange={(v) => set('personalData', v)} label="Processes personal data of data principals" description="Feeds DPDP erasure (Records › Erasure) and suggests a data-protection check as its next assessment." />
          {f.personalData && (
            <Field label="Data principals" error={tried ? errors.principals : undefined}>
              <div className="grid gap-2 sm:grid-cols-2">
                {PRINCIPALS.map((p) => <Checkbox key={p} checked={f.principals.includes(p)} onChange={(v) => set('principals', v ? [...f.principals, p] : f.principals.filter((x) => x !== p))} label={p} />)}
              </div>
            </Field>
          )}
        </fieldset>

        <Field label="Linked agent" htmlFor="reg-agent" hint="Link the Elan1 Govern agent that runs this system, so its rulebook and receipts show up as evidence.">
          <Select id="reg-agent" value={f.linkedAgentId} onChange={(e) => set('linkedAgentId', e.target.value)}>
            <option value="">No agent — not governed at runtime</option>
            {availableAgents.map((a) => <option key={a.id} value={a.id}>{a.slug} — {a.name}</option>)}
          </Select>
        </Field>

        <Field label="Frameworks that apply" hint="Turned-off frameworks can still be chosen; they count once enabled in Compliance.">
          <div className="grid gap-2 sm:grid-cols-2 border border-line p-3">
            {frameworks.map((fw) => (
              <Checkbox key={fw.id} checked={f.frameworks.includes(fw.id)} onChange={(v) => set('frameworks', v ? [...f.frameworks, fw.id] : f.frameworks.filter((x) => x !== fw.id))}
                label={fw.short} description={`${fw.jurisdiction}${fw.enabled ? '' : ' · turned off'}`} />
            ))}
          </div>
        </Field>

        <p className="flex items-start gap-2 text-xs text-muted"><ShieldQuestion className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
          {mode === 'edit' ? <>Saving writes an <span className="font-mono">inventory.updated</span> receipt to the chain.</> : <>Registration writes an <span className="font-mono">inventory.added</span> receipt to the chain.</>} {evidenceClaim(level)}
        </p>
      </div>
    </Drawer>
  );
}
