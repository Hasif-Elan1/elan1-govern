import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Calculator, ExternalLink, FlaskConical, Plus, RefreshCw, ShieldCheck, Undo2 } from 'lucide-react';
import { api } from '@/api';
import type { DisclosureField, DisclosurePackage, Receipt } from '@/types';
import { useMutation, useNow, useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { LEVEL_INFO } from '@/lib/levels';
import { DISCLOSABLE_FIELDS, FIELD_LABELS, commitFields, verifyDisclosure, type DisclosableField, type DisclosureProfile } from '@/lib/disclosure';
import { sha256Hex } from '@/lib/crypto';
import { date, dateTime, n, plural, seqLabel } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ORGS } from '@/mock/users';
import {
  Banner, Button, Checkbox, CopyButton, DataTable, Dialog, Drawer, EmptyState, Field, Hash, Input, PageHeader, Panel, SearchInput, Segmented, Select, Skeleton, Tabs, toast, type Column,
} from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import {
  FieldPicker, Figure, FirstIssueWarning, KIND_LABEL, LIMITS_LINE, PackageChip, RevealSummary, TOTAL_FIELDS, UpgradePath, VerifySteps, canManage, evidenceClaim,
  packageStatus, portalUrl, receiptLabel, useDisclosureProfiles, useFirstIssue, useIsL3, useReceiptValues,
} from '@/features/counterparties/shared';
import { BundlesView } from './BundlesView';
import { ProfilesView } from './ProfilesView';

type ViewId = 'packages' | 'bundles' | 'profiles';
const VIEWS: ViewId[] = ['packages', 'bundles', 'profiles'];

type StatusFilter = 'active' | 'revoked' | 'expired' | 'all';
type Expiry = '1' | '7' | '30' | '90';
const MAX_PICK = 10;

/**
 * Door 04 · Assurance — Selective disclosure (L3). Pick receipts, choose which of the 11 committed fields to
 * reveal, address it to an audience with an expiry, and share a link to the public counterparty portal.
 * Every field is committed as SHA-256 over canonical([salt, name, value]); the issuer signs the sorted digests.
 */
export default function DisclosurePage() {
  const l3 = useIsL3();
  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Selective disclosure"
        description="Reveal only the fields a counterparty needs. The rest stay committed as salted digests, bound by your signature, so they can check what they see without seeing everything."
      />
      {l3 ? <Disclosure /> : <Preview />}
    </div>
  );
}

/* ── L3 and Sovereign ──────────────────────────────────────── */

function Disclosure() {
  const _orgId = useOrgId();
  const role = useRole();
  const level = useOrgLevel();
  const [sp, setSp] = useSearchParams();
  const now = useNow(60_000);
  const [filter, setFilter] = useState<StatusFilter>('active');
  const pkgId = sp.get('pkg') ?? undefined;
  const setPkg = (id?: string) => { const next = new URLSearchParams(sp); if (id) next.set('pkg', id); else next.delete('pkg'); setSp(next, { replace: true }); };
  const view = (VIEWS.includes(sp.get('view') as ViewId) ? sp.get('view') : 'packages') as ViewId;
  const setView = (v: ViewId) => { const next = new URLSearchParams(sp); if (v === 'packages') next.delete('view'); else next.set('view', v); next.delete('pkg'); next.delete('bundle'); setSp(next, { replace: true }); };
  const profilesQ = useDisclosureProfiles();
  const bundlesQ = useQuery((o) => api.disclosureBundles(o), [], { kinds: ['disclosure'] });

  const { data, loading, error, refetch } = useQuery(async (o) => {
    const [ds, reg] = await Promise.all([api.disclosures(o), api.counterparties(o)]);
    return { ds, reg };
  });

  const ds = data?.ds ?? [];
  const counts = useMemo(() => {
    const c = { active: 0, revoked: 0, expired: 0, all: ds.length };
    ds.forEach((p) => { c[packageStatus(p, now)]++; });
    return c;
  }, [ds, now]);
  const rows = ds.filter((p) => filter === 'all' || packageStatus(p, now) === filter);
  const views = ds.reduce((s, p) => s + p.views, 0);
  const avgRevealed = ds.length ? ds.reduce((s, p) => s + p.revealed.length, 0) / ds.length : 0;
  const cpName = (id?: string) => data?.reg.counterparties.find((c) => c.id === id)?.name;

  const cols: Column<DisclosurePackage>[] = [
    { key: 'created', header: 'Created', sort: (p) => p.createdAt, cell: (p) => <When iso={p.createdAt} className="text-sm" /> },
    { key: 'seq', header: 'Receipt', sort: (p) => p.seq, cell: (p) => <ReceiptLink seq={p.seq} /> },
    { key: 'aud', header: 'Audience', cell: (p) => (
      <span className="block min-w-0">
        {cpName(p.counterpartyId) && <span className="block max-w-[24ch] truncate text-sm font-medium">{cpName(p.counterpartyId)}</span>}
        <span className="block max-w-[28ch] truncate font-mono text-[11.5px] text-muted" title={p.audience}>{p.audience}</span>
      </span>
    ) },
    { key: 'rev', header: 'Revealed', align: 'right', sort: (p) => p.revealed.length, cell: (p) => <span className="num">{p.revealed.length} of {p.committed.length}</span> },
    { key: 'status', header: 'Status', cell: (p) => <PackageChip status={packageStatus(p, now)} /> },
    { key: 'views', header: 'Views', align: 'right', sort: (p) => p.views, hideBelow: 'sm', cell: (p) => <span className="num">{n(p.views)}</span> },
    { key: 'exp', header: 'Expires', align: 'right', sort: (p) => p.expiresAt, hideBelow: 'md', cell: (p) => <span className="num text-sm text-muted">{date(p.expiresAt)}</span> },
    { key: 'link', header: <span className="sr-only">Link</span>, align: 'right', hideBelow: 'sm', cell: (p) => (packageStatus(p, now) === 'active'
      ? <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}><CopyButton text={portalUrl(p.token)} label="Copy share link" compact /><a className="link text-xs" href={`/counterparty/${p.token}`} target="_blank" rel="noreferrer">Open</a></span>
      : <span className="text-xs text-subtle">Link stopped</span>) },
  ];

  return (
    <div className="space-y-6">
      {error && <Banner tone="bad" title="Disclosure packages could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      <div className="grid grid-cols-2 gap-px border border-line bg-line lg:grid-cols-4" aria-live="polite">
        <Figure label="Active packages" loading={loading} value={n(counts.active)} sub={`${n(counts.all)} created in all`} />
        <Figure label="Portal views" loading={loading} value={n(views)} sub="Each open of a share link" />
        <Figure label="Fields revealed" loading={loading} value={ds.length ? `${avgRevealed.toFixed(1)} of ${TOTAL_FIELDS}` : '—'} sub="Average per package" />
        <Figure label="Withdrawn" loading={loading} value={n(counts.revoked)} sub={`${n(counts.expired)} expired`} />
      </div>

      <Tabs<ViewId>
        label="Disclosure views"
        value={view}
        onChange={setView}
        items={[
          { value: 'packages', label: 'Packages', count: ds.length },
          { value: 'bundles', label: 'Bundles over a range', count: bundlesQ.data?.length },
          { value: 'profiles', label: 'Saved profiles', count: profilesQ.data?.length },
        ]}
      />

      {view === 'bundles' && <BundlesView counterparties={data?.reg.counterparties ?? []} profiles={profilesQ.data ?? []} bundles={bundlesQ.data} loading={bundlesQ.loading} error={bundlesQ.error} />}
      {view === 'profiles' && <ProfilesView profiles={profilesQ.data} loading={profilesQ.loading} error={profilesQ.error} />}

      {view === 'packages' && <>
      <div className="grid gap-6 lg:grid-cols-12">
        {/* only owners and admins create packages: viewers and auditors see the explanation and the packages below */}
        {canManage(role) && (
          <div className="min-w-0 lg:col-span-8">
            <Composer counterparties={data?.reg.counterparties ?? []} onCreated={(p) => setPkg(p.id)} />
          </div>
        )}
        <div className={canManage(role) ? 'min-w-0 lg:col-span-4 space-y-6' : 'min-w-0 lg:col-span-12 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0'}>
          <Panel title="How a counterparty checks it" kicker="In their browser, no sign-in">
            <ol className="space-y-3 text-sm">
              {[
                ['Audience and expiry', 'The package names who it is for and when it stops being valid.'],
                ['Your key', `They compare your key’s fingerprint with one they obtained from you directly.`],
                ['Your signature', 'Ed25519 over the sorted list of all 11 field digests.'],
                ['Each revealed field', 'SHA-256 over [salt, name, value] must be one of the signed digests.'],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-3"><span className="num w-4 shrink-0 text-subtle">{i + 1}</span><span><span className="block font-medium">{t}</span><span className="block text-muted">{d}</span></span></li>
              ))}
            </ol>
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted leading-relaxed">Withheld is not missing, and missing is not altered: a hidden field is still bound by the signature, and changing any revealed value breaks its digest.</p>
          </Panel>
          <Panel title="Evidence behind each package" kicker={LEVEL_INFO[level].label}>
            <p className="text-sm leading-relaxed">{evidenceClaim(level)}</p>
            <p className="mt-2 text-xs text-muted leading-relaxed">{LIMITS_LINE}</p>
            <Link to="/assurance/counterparties?tab=portals" className="link mt-3 inline-block text-sm">Regulator and partner portals</Link>
          </Panel>
        </div>
      </div>

      <Panel
        flush
        title="Packages"
        actions={<Segmented<StatusFilter> size="sm" label="Status" value={filter} onChange={setFilter} options={[
          { value: 'active', label: 'Active', count: counts.active },
          { value: 'revoked', label: 'Withdrawn', count: counts.revoked },
          { value: 'expired', label: 'Expired', count: counts.expired },
          { value: 'all', label: 'All', count: counts.all },
        ]} />}
      >
        <DataTable
          caption="Disclosure packages"
          columns={cols}
          rows={rows}
          loading={loading}
          rowKey={(p) => p.id}
          onRowClick={(p) => setPkg(p.id)}
          selectedKey={pkgId}
          initialSort={{ key: 'created', dir: 'desc' }}
          empty={
            <EmptyState title={filter === 'active' ? 'No active packages' : 'Nothing here'} disc="eclipse" compact>
              {ds.length ? 'Change the filter to see the others.' : 'Create a package above: pick a receipt, choose the fields, and share the link.'}
            </EmptyState>
          }
        />
      </Panel>
      </>}

      <PackageDrawer pkg={ds.find((p) => p.id === pkgId)} cpName={cpName} onClose={() => setPkg(undefined)} />
    </div>
  );
}

/* ── Composer ──────────────────────────────────────────────── */

function Composer({ counterparties, onCreated }: { counterparties: { id: string; name: string; domain: string; kind: keyof typeof KIND_LABEL }[]; onCreated: (p: DisclosurePackage) => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [sp] = useSearchParams();
  const [picked, setPicked] = useState<number[]>(() => { const s = Number(sp.get('seq')); return Number.isFinite(s) && s > 0 ? [s] : []; });
  const [fields, setFields] = useState<string[]>(['tool', 'decision', 'approval']);
  const [cpId, setCpId] = useState<string>(sp.get('cp') ?? '');
  const [audience, setAudience] = useState('');
  const [expiry, setExpiry] = useState<Expiry>('30');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'decision' | 'all'>('decision');
  const [created, setCreated] = useState<DisclosurePackage[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const profiles = useDisclosureProfiles();
  const [profile, setProfile] = useState<DisclosureProfile>();
  const [ack, setAck] = useState(false);

  useEffect(() => { const c = sp.get('cp'); if (c) setCpId(c); }, [sp]);
  // a profile named in the link (?profile=) is applied once the profiles load
  const linkedProfile = sp.get('profile');
  useEffect(() => {
    const p = profiles.data?.find((x) => x.id === linkedProfile);
    if (p && !profile) { setProfile(p); setFields(DISCLOSABLE_FIELDS.filter((f) => p.fields.includes(f))); }
  }, [profiles.data, linkedProfile]);
  const expiresDays = profile ? profile.expiresDays : Number(expiry);

  const { data: recent, loading } = useQuery((o) => api.receipts(o, { kind: kind === 'all' ? 'all' : 'decision', limit: 80 }), [kind], { live: false });
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase().replace('#', '').replace(/,/g, '');
    return (recent?.items ?? []).filter((r) => !needle || String(r.seq) === needle || `${receiptLabel(r)} ${r.agent ?? ''} ${r.decision ?? ''}`.toLowerCase().includes(needle)).slice(0, 40);
  }, [recent, q]);
  const focus = picked[0];
  const vals = useReceiptValues(orgId, focus);
  const cp = counterparties.find((c) => c.id === cpId);
  const aud = cp ? `ar-org:${cp.domain}` : audience.trim() ? (audience.trim().startsWith('ar-org:') ? audience.trim() : `ar-org:${audience.trim()}`) : '';
  const audErr = !cp && audience.trim() && !/^(ar-org:)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(audience.trim().toLowerCase()) ? 'A domain such as acmetextiles.in.' : undefined;
  const first = useFirstIssue(aud && !audErr ? aud : undefined, focus);
  useEffect(() => { setAck(false); }, [aud]);
  const needsAck = !!first.info?.first && !ack;

  const m = useMutation(async (a: { orgId: string; userId: string; seqs: number[]; fields: string[]; audience: string; counterpartyId?: string; expiresDays: number; ack: boolean; profileId?: string }) => {
    const out: DisclosurePackage[] = [];
    setProgress({ done: 0, total: a.seqs.length });
    for (const seq of a.seqs) {
      out.push(await api.createDisclosureChecked(a.orgId, { seq, fields: a.fields, audience: a.audience, counterpartyId: a.counterpartyId, expiresDays: a.expiresDays }, a.userId, { acknowledgeFirstIssue: a.ack, profileId: a.profileId }));
      setProgress({ done: out.length, total: a.seqs.length });
    }
    return out;
  });

  const toggle = (seq: number, on: boolean) => setPicked((p) => (on ? (p.length >= MAX_PICK ? p : [...p, seq]) : p.filter((x) => x !== seq)));

  const submit = async () => {
    try {
      const out = await m.mutate({ orgId, userId: user!.id, seqs: picked, fields, audience: aud, counterpartyId: cp?.id, expiresDays, ack, profileId: profile?.id });
      setCreated(out);
      setPicked([]);
      toast.ok(out.length === 1 ? 'Disclosure package created' : `${out.length} disclosure packages created`, `Revealing ${fields.length} of ${TOTAL_FIELDS} committed fields to ${aud}.`);
      if (out.length === 1) onCreated(out[0]);
    } catch { /* shown below */ } finally { setProgress(undefined); }
  };

  return (
    <Panel title="Create a disclosure package" kicker="Pick · choose · address · share">
      <div className="space-y-6">
        {/* 1. receipts */}
        <section aria-labelledby="step-receipts">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 id="step-receipts" className="text-md font-semibold"><span className="num mr-2 text-subtle">1</span>Pick receipts</h3>
            <span className="text-xs text-muted" aria-live="polite">{picked.length ? `${plural(picked.length, 'receipt')} picked · one package each` : `Up to ${MAX_PICK}`}</span>
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Receipt number, tool or agent" aria-label="Search receipts" className="w-full sm:w-64" />
            <Segmented<'decision' | 'all'> size="sm" label="Receipt kind" value={kind} onChange={setKind} options={[{ value: 'decision', label: 'Decisions' }, { value: 'all', label: 'All' }]} />
          </div>
          <div className="max-h-64 overflow-y-auto border border-line">
            {loading ? <div className="space-y-2 p-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div> : !list.length ? (
              <p className="p-4 text-sm text-muted">No receipts match.</p>
            ) : (
              <ul className="divide-y divide-line">
                {list.map((r) => (
                  <li key={r.seq} className={cn('px-3 py-2', picked.includes(r.seq) && 'bg-sunken/60')}>
                    <Checkbox
                      checked={picked.includes(r.seq)}
                      disabled={!picked.includes(r.seq) && picked.length >= MAX_PICK}
                      onChange={(on) => toggle(r.seq, on)}
                      label={<span className="flex flex-wrap items-center gap-x-2"><span className="font-mono text-[12.5px]">{seqLabel(r.seq)}</span><span className="font-mono text-[12px] text-muted">{receiptLabel(r)}</span></span>}
                      description={<>{r.decision ?? r.kind}{r.agent ? ` · ${r.agent}` : ''} · {dateTime(r.ts)}</>}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 2. fields */}
        <section aria-labelledby="step-fields">
          <h3 id="step-fields" className="mb-1 text-md font-semibold"><span className="num mr-2 text-subtle">2</span>Choose the fields to reveal</h3>
          <p className="mb-3 text-xs text-muted">{focus ? <>Values shown for {seqLabel(focus)}{picked.length > 1 ? `; the same fields are revealed for all ${picked.length}` : ''}.</> : 'Pick a receipt to see its values.'}</p>
          <FieldPicker value={fields} onChange={setFields} values={vals.values} loadingValues={vals.loading} profiles={profiles.data} profileId={profile?.id} onProfile={setProfile} />
          {vals.values && <RevealTable values={vals.values} fields={fields} />}
        </section>

        {/* 3. audience and expiry */}
        <section aria-labelledby="step-aud" className="space-y-3">
          <h3 id="step-aud" className="text-md font-semibold"><span className="num mr-2 text-subtle">3</span>Address it</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Audience" htmlFor="ds-cp">
              <Select id="ds-cp" value={cpId} onChange={(e) => setCpId(e.target.value)}>
                <option value="">Someone not in the register</option>
                {counterparties.map((c) => <option key={c.id} value={c.id}>{c.name} · {KIND_LABEL[c.kind]}</option>)}
              </Select>
            </Field>
            {cp ? (
              <Field label="Identity" hint="From the counterparty register.">
                <p className="flex h-10 items-center border border-line bg-sunken/50 px-3 font-mono text-sm">ar-org:{cp.domain}</p>
              </Field>
            ) : (
              <Field label="Their domain" htmlFor="ds-aud" error={audErr} hint={!audErr ? (aud ? <span className="font-mono">{aud}</span> : 'The package is addressed to ar-org:<domain>.') : undefined}>
                <Input id="ds-aud" value={audience} onChange={(e) => setAudience(e.target.value.toLowerCase())} placeholder="auditor.example.in" mono invalid={!!audErr} spellCheck={false} autoCapitalize="none" />
              </Field>
            )}
          </div>
          <div>
            <p className="label mb-1.5">Expires after</p>
            <Segmented<Expiry> label="Expires after" value={expiry} onChange={(v) => { setExpiry(v); setProfile(undefined); }} options={[{ value: '1', label: '1 day' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
            <p className="mt-1.5 text-xs text-muted">{profile ? <>{expiresDays} days, from the profile “{profile.name}”. </> : null}Until {date(new Date(Date.now() + expiresDays * 864e5).toISOString())}. You can withdraw it earlier; the link then stops working.</p>
          </div>
        </section>

        <FirstIssueWarning info={first.info} acknowledged={ack} onChange={setAck} what="disclosure" />
        {m.error && <Banner tone="bad">{m.error.message}</Banner>}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="text-sm text-muted">{picked.length && fields.length && aud ? <>Creates {plural(picked.length, 'package')} for <span className="font-mono">{aud}</span>, revealing {fields.length} of {TOTAL_FIELDS} fields.</> : !picked.length ? 'Pick at least one receipt.' : !fields.length ? 'Choose at least one field.' : 'Choose an audience.'}</p>
          <Button variant="primary" icon={<Plus className="h-4 w-4" aria-hidden />} loading={m.pending} disabled={!picked.length || !fields.length || !aud || !!audErr || needsAck || first.loading} onClick={submit}>
            {progress ? `Signing ${progress.done + 1 > progress.total ? progress.total : progress.done + 1} of ${progress.total}` : picked.length > 1 ? `Create ${picked.length} packages` : 'Create package'}
          </Button>
        </div>

        {created.length > 0 && (
          <div className="border border-ok/40 bg-ok-bg/40 p-4" aria-live="polite">
            <p className="flex items-center gap-2 font-medium text-ok-fg"><ShieldCheck className="h-4 w-4" aria-hidden />{created.length === 1 ? 'Package signed. Share this link.' : `${created.length} packages signed. Share these links.`}</p>
            <ul className="mt-3 space-y-2">
              {created.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <ReceiptLink seq={p.seq} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={portalUrl(p.token)}>{portalUrl(p.token)}</span>
                  <CopyButton text={portalUrl(p.token)} label="Copy share link" />
                  <a href={`/counterparty/${p.token}`} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1 text-xs"><ExternalLink className="h-3.5 w-3.5" aria-hidden />Open</a>
                </li>
              ))}
            </ul>
            {created.length > 1 && <CopyButton className="mt-3" text={created.map((p) => portalUrl(p.token)).join('\n')} label="Copy all links" />}
          </div>
        )}
      </div>
    </Panel>
  );
}

function RevealTable({ values, fields }: { values: Record<string, string>; fields: string[] }) {
  return (
    <div className="mt-4 overflow-x-auto border border-line">
      <table className="w-full text-sm">
        <caption className="sr-only">What the counterparty will see</caption>
        <thead className="bg-sunken/60 text-left"><tr><th scope="col" className="px-3 py-2 label">Field</th><th scope="col" className="px-3 py-2 label">They see</th></tr></thead>
        <tbody className="divide-y divide-line">
          {DISCLOSABLE_FIELDS.map((f) => {
            const on = fields.includes(f);
            return (
              <tr key={f}>
                <td className="whitespace-nowrap px-3 py-1.5">{FIELD_LABELS[f]}</td>
                <td className="px-3 py-1.5">{on ? <span className="font-mono text-[12px] break-all">{values[f] || 'empty'}</span> : <span className="text-xs text-muted">Withheld — committed as a salted digest</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Package drawer ────────────────────────────────────────── */

function PackageDrawer({ pkg, cpName, onClose }: { pkg?: DisclosurePackage; cpName: (id?: string) => string | undefined; onClose: () => void }) {
  const role = useRole();
  const user = useUser();
  const orgId = useOrgId();
  const now = useNow(60_000);
  const [check, setCheck] = useState<{ result: ReturnType<typeof verifyDisclosure>; ms: number; tampered: boolean }>();
  const [confirm, setConfirm] = useState(false);
  const revoke = useMutation((o: string, id: string, u: string) => api.revokeDisclosure(o, id, u));
  useEffect(() => { setCheck(undefined); setConfirm(false); }, [pkg?.id]);
  if (!pkg) return null;
  const status = packageStatus(pkg, now);
  const revealed = new Map(pkg.revealed.map((f) => [f.name, f]));
  const fp = sha256Hex(pkg.publicKey).slice(0, 16);

  const run = (tamper: boolean) => {
    const t0 = performance.now();
    const p = tamper && pkg.revealed.length ? { ...pkg, revealed: pkg.revealed.map((f, i) => (i === 0 ? { ...f, value: `${f.value} (edited)` } : f)) } : pkg;
    // Pin the organisation's own published key for this kid (what the counterparty obtains from you directly),
    // never the key the package carries — otherwise the key check could not fail.
    let published: string | undefined;
    try { published = api.chainSlice(orgId, pkg.seq, pkg.seq).publicKeys[pkg.kid]; } catch { published = undefined; }
    const pinned = published ? sha256Hex(published).slice(0, 16) : undefined;
    let result = verifyDisclosure(p, { pinnedFingerprint: pinned });
    if (!pinned) {
      result = { ...result, valid: false, steps: result.steps.map((s) => (s.label === 'Issuer key' ? { ...s, state: 'fail' as const, detail: `This organisation publishes no key ${pkg.kid}, so the package’s key ${fp} cannot be matched to it.` } : s)) };
    }
    setCheck({ result, ms: Math.max(1, Math.round(performance.now() - t0)), tampered: tamper });
  };

  const doRevoke = async () => {
    try {
      await revoke.mutate(orgId, pkg.id, user!.id);
      toast.ok('Disclosure withdrawn', 'The share link stops working now. A receipt records it.');
      setConfirm(false);
    } catch { /* shown in dialog */ }
  };

  return (
    <>
      <Drawer open onClose={onClose} width={640} kicker="Assurance · Disclosure package" title={`${seqLabel(pkg.seq)} · ${pkg.revealed.length} of ${pkg.committed.length} fields`}
        footer={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {status === 'active' && <><CopyButton text={portalUrl(pkg.token)} label="Copy share link" /><a href={`/counterparty/${pkg.token}`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 border border-line-strong/70 bg-surface px-4 hover:border-fg"><ExternalLink className="h-4 w-4" aria-hidden />Open portal</a></>}
            {status !== 'revoked' && canManage(role) && <Button variant="quiet-danger" icon={<Undo2 className="h-4 w-4" aria-hidden />} onClick={() => setConfirm(true)}>Withdraw</Button>}
          </div>
        }>
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3"><PackageChip status={status} /><span className="text-sm text-muted">{plural(pkg.views, 'view')} of the share link</span></div>
          <RevealSummary revealed={pkg.revealed.length} total={pkg.committed.length} />
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div><dt className="label">Audience</dt><dd className="mt-1">{cpName(pkg.counterpartyId) && <span className="block font-medium">{cpName(pkg.counterpartyId)}</span>}<span className="font-mono text-xs break-all">{pkg.audience}</span></dd></div>
            <div><dt className="label">Receipt</dt><dd className="mt-1"><ReceiptLink seq={pkg.seq} /> <Hash value={pkg.receiptHash} len={12} /></dd></div>
            <div><dt className="label">Created</dt><dd className="mt-1 num">{dateTime(pkg.createdAt)}</dd></div>
            <div><dt className="label">Expires</dt><dd className="mt-1 num">{dateTime(pkg.expiresAt)}</dd></div>
            <div><dt className="label">Signed with</dt><dd className="mt-1 font-mono text-xs">{pkg.kid} · {fp}</dd></div>
            <div><dt className="label">Recorded as</dt><dd className="mt-1">{pkg.seqCreated ? <ReceiptLink seq={pkg.seqCreated} /> : <span className="text-muted">—</span>}</dd></div>
          </dl>

          <section aria-labelledby="pkg-fields">
            <h3 id="pkg-fields" className="mb-2 text-md font-semibold">Committed fields</h3>
            <FieldTable committed={pkg.committed} revealed={revealed} />
          </section>

          <section aria-labelledby="pkg-check">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 id="pkg-check" className="text-md font-semibold">Check it as they will</h3>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />} onClick={() => run(false)}>Run the check</Button>
                <Button size="sm" variant="ghost" className="border-line" icon={<FlaskConical className="h-3.5 w-3.5" aria-hidden />} onClick={() => run(true)}>Try a changed value</Button>
              </div>
            </div>
            {check ? (
              <div className="space-y-2" aria-live="polite">
                <Banner tone={check.result.valid ? 'ok' : 'bad'} title={check.result.valid ? 'Verifies' : check.tampered ? 'The changed value fails, as it should' : 'Does not verify'}>
                  {check.result.valid ? `Signature and ${check.result.revealedCount} revealed digests check out.` : 'At least one check failed.'} {check.ms} ms in this browser.
                </Banner>
                <VerifySteps steps={check.result.steps} />
              </div>
            ) : <p className="text-sm text-muted">Runs the same checks the portal runs: audience, expiry, key fingerprint, signature over all {pkg.committed.length} digests, and each revealed field.</p>}
          </section>
          <p className="text-xs text-muted leading-relaxed">{LIMITS_LINE}</p>
        </div>
      </Drawer>
      <Dialog open={confirm} onClose={() => setConfirm(false)} tone="danger" size="sm" title="Withdraw this disclosure?"
        description={`The share link stops working for ${cpName(pkg.counterpartyId) ?? pkg.audience}. Anything they already saved still verifies; withdrawing does not unsign it.`}
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button><Button variant="danger" loading={revoke.pending} onClick={doRevoke}>Withdraw</Button></>}>
        {revoke.error ? <Banner tone="bad">{revoke.error.message}</Banner> : <p className="text-sm text-muted">A receipt records who withdrew it and when.</p>}
      </Dialog>
    </>
  );
}

function FieldTable({ committed, revealed }: { committed: DisclosureField[]; revealed: Map<string, { salt: string; value: string }> }) {
  return (
    <div className="overflow-x-auto border border-line">
      <table className="w-full text-sm">
        <thead className="bg-sunken/60 text-left"><tr><th scope="col" className="px-3 py-2 label">Field</th><th scope="col" className="px-3 py-2 label">Value</th><th scope="col" className="px-3 py-2 label">Digest</th></tr></thead>
        <tbody className="divide-y divide-line">
          {[...committed].sort((a, b) => DISCLOSABLE_FIELDS.indexOf(a.name as DisclosableField) - DISCLOSABLE_FIELDS.indexOf(b.name as DisclosableField)).map((c) => {
            const r = revealed.get(c.name);
            return (
              <tr key={c.name} className={cn(!r && 'text-muted')}>
                <td className="whitespace-nowrap px-3 py-1.5 align-top">{FIELD_LABELS[c.name as DisclosableField] ?? c.name}</td>
                <td className="px-3 py-1.5 align-top">{r ? <span className="font-mono text-[12px] text-fg break-all">{r.value || 'empty'}</span> : <span className="text-xs">Withheld</span>}</td>
                <td className="px-3 py-1.5 align-top"><Hash value={c.digest} len={10} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Below L3: a real preview computed in this browser ─────── */

function Preview() {
  const orgId = useOrgId();
  const org = ORGS.find((o) => o.id === orgId);
  const { data: recent, loading } = useQuery((o) => api.receipts(o, { kind: 'decision', limit: 20 }), [], { live: false });
  const [seq, setSeq] = useState<number>();
  const [fields, setFields] = useState<string[]>(['tool', 'decision', 'approval']);
  const [digests, setDigests] = useState<{ committed: DisclosureField[]; ms: number }>();
  useEffect(() => { if (seq === undefined && recent?.items.length) setSeq(recent.items[0].seq); }, [recent, seq]);
  useEffect(() => { setDigests(undefined); }, [seq]);
  const vals = useReceiptValues(orgId, seq);

  const compute = () => {
    if (!vals.values) return;
    const t0 = performance.now();
    const { committed } = commitFields(vals.values);
    setDigests({ committed, ms: Math.max(1, Math.round(performance.now() - t0)) });
  };

  return (
    <UpgradePath
      caps={['selective_disclosure', 'regulator_portal', 'action_receipt_format']}
      what={<>At {LEVEL_INFO.l3.label} you pick receipts, choose which of their 11 committed fields to reveal, address the package to a counterparty with an expiry, and share a link they open without signing in. The fields you hold back stay checkable as salted digests.</>}
    >
      <Panel title="Try it on your own receipts" kicker="Preview · computed in this browser, nothing signed or shared">
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-7 space-y-4">
            <Field label="Receipt" htmlFor="pv-seq">
              {loading ? <Skeleton className="h-10 w-full" /> : (
                <Select id="pv-seq" value={seq ?? ''} onChange={(e) => setSeq(Number(e.target.value))}>
                  {(recent?.items ?? []).map((r: Receipt) => <option key={r.seq} value={r.seq}>{seqLabel(r.seq)} · {receiptLabel(r)} · {r.decision}</option>)}
                </Select>
              )}
            </Field>
            <FieldPicker value={fields} onChange={(f) => { setFields(f); }} values={vals.values} loadingValues={vals.loading} />
          </div>
          <div className="min-w-0 lg:col-span-5 space-y-3">
            <p className="text-sm text-muted leading-relaxed">Each field becomes SHA-256 over <span className="font-mono text-xs">[salt, name, value]</span> with a fresh 128-bit salt. The counterparty, <span className="font-mono text-xs">ar-org:…</span>, would receive the revealed values with their salts, and only the digests of the rest.</p>
            <Button variant="secondary" icon={<Calculator className="h-4 w-4" aria-hidden />} disabled={!vals.values} onClick={compute}>Compute the digests</Button>
            {digests && (
              <div className="space-y-2" aria-live="polite">
                <p className="text-xs text-muted">{digests.committed.length} digests in {digests.ms} ms. Unsigned: signing and sharing start at {LEVEL_INFO.l3.short}. Issuer would be <span className="font-mono">ar-org:{org?.domain}</span>.</p>
                <ul className="divide-y divide-line border border-line text-sm">
                  {digests.committed.map((c) => (
                    <li key={c.name} className="flex items-center gap-3 px-3 py-1.5">
                      <span className="w-36 shrink-0 truncate">{FIELD_LABELS[c.name as DisclosableField] ?? c.name}</span>
                      <span className={cn('flex-1 text-xs', fields.includes(c.name) ? 'font-medium' : 'text-muted')}>{fields.includes(c.name) ? 'Revealed' : 'Withheld'}</span>
                      <Hash value={c.digest} len={10} copy={false} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </Panel>
    </UpgradePath>
  );
}
