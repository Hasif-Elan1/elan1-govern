import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookmarkPlus, Pencil, Trash2 } from 'lucide-react';
import { api } from '@/api';
import { useMutation } from '@/hooks/useQuery';
import { useOrgId, useRole, useUser } from '@/store/session';
import { DISCLOSABLE_FIELDS, FIELD_LABELS, PURPOSE_LABEL, type DisclosableField, type DisclosureProfile, type DisclosurePurpose } from '@/lib/disclosure';
import { date, plural } from '@/lib/format';
import { userName } from '@/mock/users';
import { Badge, Banner, Button, Dialog, EmptyState, Field, Input, Panel, Select, Skeleton, Textarea, toast } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { FieldPicker, TOTAL_FIELDS, canManage } from '@/features/counterparties/shared';

/**
 * Saved disclosure profiles: a name, a purpose (auditor, lender …), the fields to reveal and an expiry, saved by an
 * owner or admin and offered beside the presets wherever fields are chosen (packages, bundles, issuing a receipt).
 * Saving and removing each write a receipt.
 */
export function ProfilesView({ profiles, loading, error }: { profiles?: DisclosureProfile[]; loading: boolean; error?: Error }) {
  const role = useRole();
  const nav = useNavigate();
  const [editing, setEditing] = useState<DisclosureProfile | 'new'>();
  const [removing, setRemoving] = useState<DisclosureProfile>();
  const manage = canManage(role);
  return (
    <div className="space-y-6">
      <Panel flush title="Saved disclosure profiles" kicker="Reused for packages, bundles and receipts you issue"
        actions={manage ? <Button size="sm" variant="primary" icon={<BookmarkPlus className="h-3.5 w-3.5" aria-hidden />} onClick={() => setEditing('new')}>New profile</Button> : undefined}
        footer={manage ? 'A profile fills the fields and the expiry; you can still change them before signing. Removing a profile leaves what was made from it unchanged.' : undefined}>
        {error ? <div className="p-5"><Banner tone="bad" title="Profiles did not load">{error.message}</Banner></div>
          : loading && !profiles ? <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
            : !profiles?.length ? (
              <EmptyState title="No saved profiles" disc="registration" compact action={manage ? <Button variant="primary" icon={<BookmarkPlus className="h-4 w-4" aria-hidden />} onClick={() => setEditing('new')}>Save the first profile</Button> : undefined}>
                Save the fields an auditor, lender or insurer usually needs, so each disclosure to them reveals the same thing.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {profiles.map((p) => (
                  <li key={p.id} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{p.name}</span><Badge>{PURPOSE_LABEL[p.purpose]}</Badge><span className="text-xs text-muted num">{p.fields.length} of {TOTAL_FIELDS} fields · {plural(p.expiresDays, 'day')} · used {plural(p.used ?? 0, 'time')}</span></p>
                      {p.description && <p className="mt-1 text-sm text-muted leading-relaxed">{p.description}</p>}
                      <p className="mt-1.5 flex flex-wrap gap-1">{DISCLOSABLE_FIELDS.filter((f) => p.fields.includes(f)).map((f) => <span key={f} className="border border-line bg-sunken/50 px-1.5 py-0.5 text-[11.5px]">{FIELD_LABELS[f as DisclosableField]}</span>)}</p>
                      <p className="mt-1.5 text-xs text-subtle">{p.updatedAt ? `Updated ${date(p.updatedAt)} by ${userName(p.updatedBy)}` : `Saved ${date(p.createdAt)} by ${userName(p.createdBy)}`}{p.seq ? <> · <ReceiptLink seq={p.seq} /></> : null}</p>
                    </div>
                    {/* using, editing and removing a profile are owners' and admins' (they make packages and bundles) */}
                    {manage && (
                      <div className="flex flex-wrap items-start gap-2 md:justify-end">
                        <Button size="sm" variant="secondary" onClick={() => nav(`/assurance/disclosure?profile=${p.id}`)}>Use for a package</Button>
                        <Button size="sm" variant="secondary" onClick={() => nav(`/assurance/disclosure?view=bundles&profile=${p.id}`)}>Use for a bundle</Button>
                        <Button size="sm" variant="ghost" className="border-line" icon={<Pencil className="h-3.5 w-3.5" aria-hidden />} onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>Edit</Button>
                        <Button size="sm" variant="quiet-danger" icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />} onClick={() => setRemoving(p)} aria-label={`Remove ${p.name}`}>Remove</Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
      </Panel>
      {editing && <ProfileDialog profile={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} />}
      {removing && <RemoveDialog profile={removing} onClose={() => setRemoving(undefined)} />}
    </div>
  );
}

const PURPOSES = Object.keys(PURPOSE_LABEL) as DisclosurePurpose[];

function ProfileDialog({ profile, onClose }: { profile?: DisclosureProfile; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [name, setName] = useState(profile?.name ?? '');
  const [purpose, setPurpose] = useState<DisclosurePurpose>(profile?.purpose ?? 'auditor');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [fields, setFields] = useState<string[]>(profile?.fields ?? ['seq', 'ts', 'decision', 'rule_id', 'approval']);
  const [days, setDays] = useState(profile?.expiresDays ?? 30);
  const m = useMutation((o: string, input: Parameters<typeof api.saveDisclosureProfile>[1], u: string) => api.saveDisclosureProfile(o, input, u));
  const save = async () => {
    try {
      const p = await m.mutate(orgId, { id: profile?.id, name, purpose, description, fields, expiresDays: days }, user!.id);
      toast.ok(profile ? 'Profile updated' : 'Profile saved', `“${p.name}” reveals ${p.fields.length} of ${TOTAL_FIELDS} fields for ${plural(p.expiresDays, 'day')}. Receipt #${p.seq}.`);
      onClose();
    } catch { /* shown below */ }
  };
  return (
    <Dialog open onClose={onClose} size="lg" title={profile ? `Edit “${profile.name}”` : 'New disclosure profile'} description="The fields to reveal and how long a disclosure lasts, for one kind of recipient."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.pending} disabled={!fields.length || name.trim().length < 3} onClick={save}>{profile ? 'Save changes' : 'Save profile'}</Button></>}>
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="pf-name" required><Input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Statutory auditor" data-autofocus /></Field>
          <Field label="Purpose" htmlFor="pf-purpose">
            <Select id="pf-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value as DisclosurePurpose)}>
              {PURPOSES.map((p) => <option key={p} value={p}>{PURPOSE_LABEL[p]}</option>)}
            </Select>
          </Field>
          <Field label="What it is for" htmlFor="pf-desc" className="sm:col-span-2"><Textarea id="pf-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who receives it and why these fields" /></Field>
          <Field label="Expires after (days)" htmlFor="pf-days" hint="1 to 365 days."><Input id="pf-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value) || 0)} className="w-28 num" /></Field>
        </div>
        <FieldPicker value={fields} onChange={setFields} />
        {m.error && <Banner tone="bad">{m.error.message}</Banner>}
      </div>
    </Dialog>
  );
}

function RemoveDialog({ profile, onClose }: { profile: DisclosureProfile; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const m = useMutation((o: string, id: string, u: string) => api.removeDisclosureProfile(o, id, u));
  const go = async () => {
    try {
      const r = await m.mutate(orgId, profile.id, user!.id);
      toast.ok('Profile removed', `Receipt #${r.seq}. Packages and bundles made from it are unchanged.`);
      onClose();
    } catch { /* shown below */ }
  };
  return (
    <Dialog open onClose={onClose} tone="danger" size="sm" title={`Remove “${profile.name}”?`} description="It is no longer offered when you choose fields. Anything already shared with it stays as it is."
      footer={<><Button variant="ghost" onClick={onClose}>Keep it</Button><Button variant="danger" loading={m.pending} onClick={go}>Remove</Button></>}>
      {m.error ? <Banner tone="bad">{m.error.message}</Banner> : <p className="text-sm text-muted">A receipt records who removed it and when.</p>}
    </Dialog>
  );
}
