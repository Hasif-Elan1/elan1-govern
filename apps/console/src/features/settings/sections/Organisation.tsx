import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CheckCircle2, Download, Save, Undo2 } from 'lucide-react';
import { api, db } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useOrgId, useRole, useUser } from '@/store/session';
import { LEVEL_INFO, atLeast, levelOfOrg, nextLevel } from '@/lib/levels';
import { date, dateTime, n, seqLabel } from '@/lib/format';
import { ExportPackDialog, type ExportedSummary } from '@/features/evidence/ExportPackDialog';
import type { IndustryPack, Org, Region } from '@/types';
import { Badge, Banner, Button, Checkbox, CopyButton, Dialog, Field, Input, Panel, Select, Skeleton, StatusChip, Textarea, toast } from '@/components/ui';
import { CURRENCIES, HIGH_RISK_NOTE, INDUSTRIES, REGIONS, TIMEZONES, frameworksFor, industryById } from '@/features/onboarding/industries';
import { ReadOnlyNote, SectionHeader, SettingRow, errText, receiptNote } from '../shared';
import { orgApi } from '../orgApi';
import { useCanDo } from '../permissions';
import { SmartLink } from '@/shell/access';

type Form = Pick<Org, 'name' | 'industry' | 'regions' | 'currency' | 'timezone'>;

const pick = (o: Org): Form => ({ name: o.name, industry: o.industry, regions: [...o.regions], currency: o.currency, timezone: o.timezone });

export function OrganisationSection() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const canEdit = useCanDo('settings.org');
  const isOwner = role === 'owner';
  const { data: org, loading, error, refetch } = useQuery((o) => orgApi.org(o), [], { kinds: ['org', 'key'] });
  const { data: compliance } = useQuery((o) => api.compliance(o), [], { kinds: ['org', 'framework'] });
  const { data: residency } = useQuery((o) => api.residency(o), [], { kinds: ['org', 'deployment'] });
  const save = useMutation(orgApi.updateOrg);

  const [form, setForm] = useState<Form>();
  const [closeOpen, setCloseOpen] = useState(false);
  useEffect(() => { if (org) setForm(pick(org)); }, [org]);

  const dirtyFields = useMemo(() => {
    if (!org || !form) return [];
    const o = pick(org);
    return (Object.keys(o) as (keyof Form)[]).filter((k) => JSON.stringify(o[k]) !== JSON.stringify(form[k]));
  }, [org, form]);

  const nameErr = form && form.name.trim().length < 2 ? 'Enter the organisation’s name.' : undefined;
  const regionErr = form && form.regions.length === 0 ? 'Choose at least one region.' : undefined;

  const doSave = async () => {
    if (!form || !user || nameErr || regionErr) return;
    const patch = Object.fromEntries(dirtyFields.map((k) => [k, form[k]])) as Partial<Form>;
    try {
      const r = await save.mutate(orgId, patch, user.id);
      toast.ok('Organisation updated', receiptNote(r.seq));
    } catch { /* shown in the banner */ }
  };

  if (error) return <Banner tone="bad" title="Organisation settings could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;

  const enabled = compliance?.frameworks.filter((f) => f.enabled).map((f) => f.short) ?? [];
  const recommended = form ? frameworksFor(form.industry, form.regions) : [];
  const ind = form ? industryById(form.industry) : undefined;
  const level = org?.plan;
  const next = level ? nextLevel(level) : undefined;

  return (
    <div>
      <SectionHeader
        title="Organisation"
        description="The name on receipts and evidence, the industry configuration behind your starter rulebooks and frameworks, and how amounts and times read."
        actions={canEdit && dirtyFields.length > 0 ? (
          <>
            <Button variant="ghost" icon={<Undo2 className="h-4 w-4" />} onClick={() => org && setForm(pick(org))}>Discard</Button>
            <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={save.pending} onClick={doSave} disabled={!!nameErr || !!regionErr}>Save {dirtyFields.length} change{dirtyFields.length === 1 ? '' : 's'}</Button>
          </>
        ) : undefined}
      />
      {!canEdit && <ReadOnlyNote role={role} who="Owners and admins" />}
      {save.error && <Banner tone="bad" className="mb-6" title="Not saved">{save.error.message}</Banner>}

      <div className="grid gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-8" title="Details">
          {!form || loading || !org ? (
            <div className="space-y-4">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</div>
          ) : (
            <div>
              <SettingRow label="Name" htmlFor="org-name" help="Shown on receipts, approval messages and evidence bundles.">
                <Field error={nameErr}>
                  <Input id="org-name" value={form.name} disabled={!canEdit} onChange={(e) => setForm({ ...form, name: e.target.value })} invalid={!!nameErr} />
                </Field>
              </SettingRow>
              <SettingRow label="Slug" help="Fixed for the life of the organisation: it is inside every single-use approval link and every evidence file name already issued, so those keep resolving.">
                <div className="flex items-center gap-2">
                  <span className="h-10 flex-1 min-w-0 inline-flex items-center px-3 border border-line bg-sunken font-mono text-sm truncate">{org.slug}</span>
                  <CopyButton text={org.slug} label="Copy slug" />
                </div>
              </SettingRow>
              <SettingRow label="Industry configuration" htmlFor="org-industry" help="Chooses the starter rulebook for new agents, the recommended frameworks and the wording of risk questions. Published rulebooks do not change.">
                <Select id="org-industry" value={form.industry} disabled={!canEdit} onChange={(e) => setForm({ ...form, industry: e.target.value as IndustryPack })}>
                  {INDUSTRIES.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
                </Select>
                {ind && <p className="mt-2 text-xs text-muted leading-relaxed">{ind.starter}</p>}
                {ind?.highRisk && <p className="mt-2 text-xs text-held-fg">{HIGH_RISK_NOTE}</p>}
              </SettingRow>
              <SettingRow label="Regions" help="Each region adds the frameworks that apply there. Where records are stored is the residency domain below, not the regions.">
                <div className="grid grid-cols-2 gap-2" role="group" aria-label="Regions">
                  {REGIONS.map((r) => (
                    <Checkbox key={r.id} disabled={!canEdit} checked={form.regions.includes(r.id)} label={r.label}
                      onChange={(v) => setForm({ ...form, regions: v ? [...form.regions, r.id] : form.regions.filter((x: Region) => x !== r.id) })} />
                  ))}
                </div>
                {regionErr && <p className="mt-2 text-xs text-bad-fg" role="alert">{regionErr}</p>}
              </SettingRow>
              <SettingRow label="Currency" htmlFor="org-cur" help="Amounts in rules, approvals and the meter.">
                <Select id="org-cur" value={form.currency} disabled={!canEdit} onChange={(e) => setForm({ ...form, currency: e.target.value as Form['currency'] })}>
                  {CURRENCIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </Select>
              </SettingRow>
              <SettingRow label="Time zone" htmlFor="org-tz" help="Receipts store UTC; the console shows this time zone.">
                <Select id="org-tz" value={form.timezone} disabled={!canEdit} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                  {TIMEZONES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </Select>
              </SettingRow>
              <SettingRow label="Data residency" help="The residency domain: every store, the signing key and the backups sit inside it. It is chosen when the organisation is created or moved to Sovereign, in the upgrade wizard.">
                {!residency ? <Skeleton className="h-10" /> : (
                  <>
                    <p className="text-sm font-medium">{residency.domain}</p>
                    <p className="mt-1 text-xs text-muted">{residency.stores.length} stores in the domain · cross-border transfers in 30 days: {n(residency.crossBorder.transfers30d)}</p>
                    <Link to="/agents/organisation?tab=residency" className="mt-2 inline-flex items-center gap-1 text-sm link">Stores and the residency statement<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>
                  </>
                )}
              </SettingRow>
            </div>
          )}
        </Panel>

        <div className="xl:col-span-4 space-y-6">
          <Panel title="At a glance">
            {!org ? <Skeleton className="h-32" /> : (
              <dl className="space-y-3 text-sm">
                <div><dt className="label">Organisation id</dt><dd className="mt-0.5 font-mono text-[12.5px] flex items-center gap-1">{org.id}<CopyButton text={org.id} compact label="Copy organisation id" /></dd></div>
                <div><dt className="label">Created</dt><dd className="mt-0.5">{date(org.createdAt)}</dd></div>
                <div>
                  <dt className="label">Assurance level</dt>
                  <dd className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link to="/assurance/levels" className="link">{LEVEL_INFO[org.plan].label}</Link>
                    <SmartLink to="/billing" hideWhenBlocked className="text-muted hover:text-fg text-xs">Meter and invoices</SmartLink>
                    {/* changing the plan is the owner's: admins see the level without an upgrade link */}
                    {next && isOwner && <Link to={`/assurance/upgrade?to=${next}`} className="inline-flex items-center gap-1 text-xs font-medium link">{`Upgrade to ${LEVEL_INFO[next].short}`}<ArrowUpRight className="h-3 w-3" aria-hidden /></Link>}
                  </dd>
                </div>
                <div><dt className="label">Signing key</dt><dd className="mt-0.5 font-mono text-[12px] break-all"><Link to="/agents/keys?tab=custody" className="hover:underline">{org.keyFingerprint || '—'}</Link></dd></div>
              </dl>
            )}
          </Panel>

          <Panel title="Frameworks" actions={<Link to="/compliance" className="text-sm inline-flex items-center gap-1 text-muted hover:text-fg">Coverage<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>}>
            <p className="label mb-2">Recommended by this configuration</p>
            <div className="flex flex-wrap gap-1">
              {recommended.map((f) => <Badge key={f} tone={enabled.includes(f) ? 'info' : 'neutral'} title={enabled.includes(f) ? 'Enabled in Coverage' : 'Not enabled yet'}>{f}</Badge>)}
            </div>
            <p className="mt-3 text-xs text-muted leading-relaxed">Highlighted frameworks are enabled in Coverage. Saving here does not switch frameworks on or off — an admin does that in Coverage.</p>
          </Panel>

          <ClosePanel isOwner={isOwner} onOpen={() => setCloseOpen(true)} />
        </div>
      </div>
      {org && <CloseDialog open={closeOpen} onClose={() => setCloseOpen(false)} org={org} />}
    </div>
  );
}

/* ── Closing the organisation ─────────────────────────────────────────── */

function ClosePanel({ isOwner, onOpen }: { isOwner: boolean; onOpen: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const { data: closure } = useQuery((o) => orgApi.closure(o), [], { kinds: ['org'] });
  const cancel = useMutation(orgApi.cancelClosure);
  const scheduled = closure && !closure.cancelledAt ? closure : undefined;
  // closing is the owner's alone: other roles see the panel only while a closure is scheduled, without its button
  if (!isOwner && !scheduled) return null;
  return (
    <Panel title="Close the organisation" tone="sunken">
      {scheduled ? (
        <>
          <StatusChip tone="held" size="sm">Closure scheduled</StatusChip>
          <p className="mt-3 text-sm">Access ends {dateTime(scheduled.effectiveAt)}. Receipts are kept until {date(scheduled.retentionUntil)} and stay verifiable from the final export.</p>
          {isOwner ? (
            <Button className="mt-4" variant="secondary" loading={cancel.pending}
              onClick={async () => { if (!user) return; try { const r = await cancel.mutate(orgId, user.id); toast.ok('Closure cancelled', `Lift the emergency stop from Incidents when you are ready to resume agents. ${receiptNote(r.seq)}`); } catch (e) { toast.bad('Not cancelled', errText(e)); } }}>
              Cancel the closure
            </Button>
          ) : <p className="mt-2 text-xs text-muted">Only an owner can cancel the closure.</p>}
        </>
      ) : (
        <>
          <p className="text-sm text-muted leading-relaxed">Export the final evidence, stop every agent and end access after 7 days. Receipts are kept for the retention period and stay verifiable from the export.</p>
          <Button className="mt-4" variant="quiet-danger" onClick={onOpen}>Close organisation</Button>
        </>
      )}
    </Panel>
  );
}

function CloseDialog({ open, onClose, org }: { open: boolean; onClose: () => void; org: Org }) {
  const orgId = useOrgId();
  const user = useUser();
  const [exported, setExported] = useState<{ id: string; receipts: number; parts: number; firstSeq: number; lastSeq: number; whole: boolean }>();
  const [exportOpen, setExportOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const close = useMutation(orgApi.scheduleClosure);
  const { data: policy } = useQuery((o) => orgApi.dataPolicy(o), [open], { kinds: ['settings'] });
  useEffect(() => { if (open) { setTyped(''); setReason(''); } }, [open]);

  // the final export is the guarded export (ZIP, size split, residency and consent checks, the charge shown first);
  // it must cover the whole chain: everything after it is only the export's own receipts
  const onExported = (r: ExportedSummary) => {
    const d = db.getDB(orgId);
    const whole = r.firstSeq === d.receipts[0]?.seq && !d.receipts.some((x) => x.seq > r.lastSeq && x.action !== 'evidence.exported' && x.action !== 'evidence.addressed');
    setExported({ id: r.exportId, receipts: r.receipts, parts: r.parts, firstSeq: r.firstSeq, lastSeq: r.lastSeq, whole });
  };
  const doClose = async () => {
    if (!user) return;
    try {
      const r = await close.mutate(orgId, { typedName: typed, exportId: exported?.id, reason }, user.id);
      toast.held('Closure scheduled', `Agents are stopped. Access ends ${dateTime(r.closure.effectiveAt)}. ${receiptNote(r.seq)}`);
      onClose();
    } catch { /* shown below */ }
  };

  return (
    <Dialog open={open} onClose={onClose} tone="danger" size="lg" title="Close the organisation" description="3 steps. Nothing is deleted before the retention period ends."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={close.pending} disabled={!exported?.whole || typed.trim() !== org.name} title={exported && !exported.whole ? 'Export the whole chain first.' : undefined} onClick={doClose}>Stop agents and schedule closure</Button></>}>
      <ol className="space-y-5 text-sm">
        <li>
          <p className="font-medium">1. Export the final evidence</p>
          <p className="mt-1 text-muted">{atLeast(levelOfOrg(org), 'l2') ? 'The 8-member evidence bundle for the whole chain, as a ZIP, with the public keys to verify it offline. It passes the residency, consent and declarations checks first; a long chain is split into parts, each billed at ₹2,500, and the charge is shown before you generate it.' : 'The auditor pack for the whole chain, as a ZIP: receipts, sealed checkpoints, public keys, a PDF summary, a compliance map and a README under a sealed manifest. Free.'}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button variant="secondary" icon={exported?.whole ? <CheckCircle2 className="h-4 w-4 text-ok-fg" /> : <Download className="h-4 w-4" />} onClick={() => setExportOpen(true)}>{exported ? 'Exported — export again' : 'Export the final evidence'}</Button>
            {exported && <span className="text-xs text-muted num">{n(exported.receipts)} receipts, {seqLabel(exported.firstSeq)}–{seqLabel(exported.lastSeq)}{exported.parts > 1 ? ` in ${exported.parts} parts` : ''} · export {exported.id}</span>}
          </div>
          {exported && !exported.whole && <Banner tone="held" className="mt-2">That export covers part of the chain. The final export must cover all of it: choose “Everything”.</Banner>}
          <ExportPackDialog open={exportOpen} onClose={() => setExportOpen(false)} title="Export the final evidence" onExported={onExported} />
        </li>
        <li>
          <p className="font-medium">2. Stop every agent</p>
          <p className="mt-1 text-muted">The emergency stop is engaged when you confirm: every new agent call is refused and recorded. Access for people ends 7 days later; you can cancel until then.</p>
        </li>
        <li>
          <p className="font-medium">3. Confirm</p>
          <p className="mt-1 text-muted">Receipts are kept until {policy ? date(new Date(Date.now() + policy.retention.years * 365 * 864e5).toISOString()) : '…'} ({policy?.retention.years ?? '…'} years{policy?.lock.mode === 'compliance' ? `, under ${policy.lock.backend}` : ''}).</p>
          <Field label="Why (recorded)" htmlFor="close-why" className="mt-3"><Textarea id="close-why" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Field label={<>Type <span className="font-semibold">{org.name}</span> to confirm</>} htmlFor="close-name" className="mt-3">
            <Input id="close-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </Field>
        </li>
      </ol>
      {close.error && <Banner tone="bad" className="mt-4">{close.error.message}</Banner>}
    </Dialog>
  );
}
