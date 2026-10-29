import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, ExternalLink, FileJson, FlaskConical, Layers, RefreshCw, ShieldCheck, Undo2 } from 'lucide-react';
import { api } from '@/api';
import type { Counterparty } from '@/types';
import { useMutation, useNow, useQuery } from '@/hooks/useQuery';
import { useOrgId, useRole, useUser } from '@/store/session';
import { BUNDLE_MAX, DISCLOSABLE_FIELDS, FIELD_LABELS, verifyDisclosureBundle, type BundleCheck, type DisclosableField, type DisclosureBundle, type DisclosureProfile } from '@/lib/disclosure';
import { sha256Hex } from '@/lib/crypto';
import { date, dateTime, n, plural, seqLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { Banner, Button, CopyButton, DataTable, Dialog, Drawer, EmptyState, Field, Hash, Input, Panel, Segmented, Select, Skeleton, toast, type Column } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { downloadText } from '@/features/activity/shared';
import { FieldPicker, FirstIssueWarning, KIND_LABEL, LIMITS_LINE, PackageChip, TOTAL_FIELDS, VerifySteps, canManage, portalUrl, useFirstIssue } from '@/features/counterparties/shared';

type BundleRow = Awaited<ReturnType<typeof api.disclosureBundles>>[number];
type Kinds = 'decisions' | 'all';
type Expiry = '7' | '30' | '90';
const DAY = 864e5;

/**
 * Selective-disclosure bundles: one signed file over a range of receipts. Every receipt's 11 fields are committed as
 * salted digests, the same chosen fields are revealed for each, and one Ed25519 signature covers the manifest. The
 * recipient opens a portal link or receives the file; both verify without Elan1 Govern.
 */
export function BundlesView({ counterparties, profiles, bundles, loading, error }: { counterparties: Counterparty[]; profiles: DisclosureProfile[]; bundles?: BundleRow[]; loading: boolean; error?: Error }) {
  const role = useRole();
  const [sp, setSp] = useSearchParams();
  const bundleId = sp.get('bundle') ?? undefined;
  const setBundle = (id?: string) => { const next = new URLSearchParams(sp); if (id) next.set('bundle', id); else next.delete('bundle'); setSp(next, { replace: true }); };
  const now = useNow(60_000);
  const cpName = (id?: string) => counterparties.find((c) => c.id === id)?.name;

  const cols: Column<BundleRow>[] = [
    { key: 'created', header: 'Signed', sort: (b) => b.createdAt, cell: (b) => <When iso={b.createdAt} className="text-sm" /> },
    { key: 'range', header: 'Range', sort: (b) => b.range.fromSeq, cell: (b) => <span className="font-mono text-[12.5px] whitespace-nowrap">{seqLabel(b.range.fromSeq)}–{seqLabel(b.range.toSeq)}</span> },
    { key: 'count', header: 'Receipts', align: 'right', sort: (b) => b.range.count, cell: (b) => <span className="num">{n(b.range.count)}</span> },
    { key: 'aud', header: 'Audience', cell: (b) => (
      <span className="block min-w-0">
        {cpName(b.counterpartyId) && <span className="block max-w-[24ch] truncate text-sm font-medium">{cpName(b.counterpartyId)}</span>}
        <span className="block max-w-[28ch] truncate font-mono text-[11.5px] text-muted" title={b.audience}>{b.audience}</span>
      </span>
    ) },
    { key: 'rev', header: 'Revealed', align: 'right', hideBelow: 'md', cell: (b) => <span className="num">{b.fields.length} of {TOTAL_FIELDS}{b.profileName ? <span className="block text-[11px] text-muted">{b.profileName}</span> : null}</span> },
    { key: 'status', header: 'Status', cell: (b) => <PackageChip status={b.status === 'active' && new Date(b.expiresAt).getTime() < now ? 'expired' : b.status} /> },
    { key: 'views', header: 'Opened', align: 'right', hideBelow: 'sm', cell: (b) => <span className="num text-sm">{n(b.views)} · {n(b.downloads ?? 0)} files</span> },
  ];

  return (
    <div className="space-y-6">
      {/* only owners and admins sign bundles: other roles see the list */}
      {canManage(role) && <BundleComposer counterparties={counterparties} profiles={profiles} onCreated={(id) => setBundle(id)} />}
      <Panel flush title="Bundles" kicker="One signed file per range">
        {error ? <div className="p-5"><Banner tone="bad" title="Bundles did not load">{error.message}</Banner></div> : (
          <DataTable caption="Disclosure bundles" columns={cols} rows={bundles} loading={loading} rowKey={(b) => b.id} onRowClick={(b) => setBundle(b.id)} selectedKey={bundleId} initialSort={{ key: 'created', dir: 'desc' }}
            empty={<EmptyState title="No bundles yet" disc="eclipse" compact>{canManage(role) ? 'Sign a bundle above: choose a range of receipts, the fields to reveal and who it is for.' : 'No bundle has been signed for this organisation yet.'}</EmptyState>} />
        )}
      </Panel>
      {bundleId && <BundleDrawer id={bundleId} cpName={cpName} onClose={() => setBundle(undefined)} />}
    </div>
  );
}

/* ── Composer ──────────────────────────────────────────────── */

function BundleComposer({ counterparties, profiles, onCreated }: { counterparties: Counterparty[]; profiles: DisclosureProfile[]; onCreated: (id: string) => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [sp] = useSearchParams();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kinds, setKinds] = useState<Kinds>('decisions');
  const [fields, setFields] = useState<string[]>(['ts', 'tool', 'decision', 'approval']);
  const [profile, setProfile] = useState<DisclosureProfile>();
  const [cpId, setCpId] = useState('');
  const [domain, setDomain] = useState('');
  const [expiry, setExpiry] = useState<Expiry>('30');
  const [ack, setAck] = useState(false);
  const [quick, setQuick] = useState<string>();

  // a profile named in the link (?profile=) is applied once
  const linked = sp.get('profile');
  useEffect(() => {
    const p = profiles.find((x) => x.id === linked);
    if (p && !profile) { setProfile(p); setFields(DISCLOSABLE_FIELDS.filter((f) => p.fields.includes(f))); }
  }, [profiles, linked]);

  // start with the last 50 decisions
  const recent = useQuery((o) => api.receipts(o, { kind: 'decision', limit: 50 }), [], { live: false });
  useEffect(() => {
    const items = recent.data?.items;
    if (!items?.length || from || to) return;
    setFrom(String(items[items.length - 1].seq));
    setTo(String(items[0].seq));
  }, [recent.data]);

  const fromN = Number(from);
  const toN = Number(to);
  const rangeOk = from !== '' && to !== '' && Number.isFinite(fromN) && Number.isFinite(toN) && fromN > 0 && toN > 0;
  const preview = useQuery((o) => (rangeOk ? api.bundleRangePreview(o, { fromSeq: fromN, toSeq: toN, kinds }) : Promise.resolve(undefined)), [fromN, toN, kinds, rangeOk], { live: false });
  const count = preview.data?.count ?? 0;

  const cp = counterparties.find((c) => c.id === cpId);
  const dom = domain.trim().toLowerCase().replace(/^ar-org:/, '');
  const domErr = !cp && dom && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dom) ? 'A domain such as auditor.example.in.' : undefined;
  const audience = cp ? `ar-org:${cp.domain}` : dom && !domErr ? `ar-org:${dom}` : '';
  const first = useFirstIssue(audience || undefined);
  useEffect(() => { setAck(false); }, [audience]);
  const expiresDays = profile ? profile.expiresDays : Number(expiry);

  const setLast = async (label: string, q: Parameters<typeof api.receipts>[1]) => {
    setQuick(label);
    try {
      const r = await api.receipts(orgId, q);
      if (!r.items.length) { toast.bad('No receipts there', 'Nothing in that period.'); return; }
      const seqs = r.items.slice(0, BUNDLE_MAX).map((x) => x.seq);
      setFrom(String(Math.min(...seqs)));
      setTo(String(Math.max(...seqs)));
    } finally { setQuick(undefined); }
  };

  const m = useMutation((o: string, input: Parameters<typeof api.createDisclosureBundle>[1], u: string) => api.createDisclosureBundle(o, input, u));
  const submit = async () => {
    try {
      const b = await m.mutate(orgId, { fromSeq: fromN, toSeq: toN, kinds, fields, profileId: profile?.id, audience, counterpartyId: cp?.id, expiresDays, acknowledgeFirstIssue: ack }, user!.id);
      toast.ok('Bundle signed', `${plural(b.range.count, 'receipt')} (${seqLabel(b.range.fromSeq)}–${seqLabel(b.range.toSeq)}) for ${b.audience}, one signature. Receipt #${b.seqCreated}.`);
      onCreated(b.id);
    } catch { /* shown below */ }
  };

  const tooMany = count > BUNDLE_MAX;
  const disabled = !rangeOk || !count || tooMany || !fields.length || !audience || (!!first.info?.first && !ack) || first.loading;

  return (
    <Panel title={<span className="inline-flex items-center gap-2"><Layers className="h-4 w-4" aria-hidden />Sign a bundle over a range</span>} kicker="Range · fields · audience · one file">
      <div className="space-y-6">
        <section aria-labelledby="b-range" className="space-y-3">
          <h3 id="b-range" className="text-md font-semibold"><span className="num mr-2 text-subtle">1</span>Choose the range</h3>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From receipt" htmlFor="b-from"><Input id="b-from" inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value.replace(/[^0-9]/g, ''))} className="w-32 num" mono /></Field>
            <Field label="To receipt" htmlFor="b-to"><Input id="b-to" inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value.replace(/[^0-9]/g, ''))} className="w-32 num" mono /></Field>
            <div>
              <p className="label mb-1.5">Receipts</p>
              <Segmented<Kinds> label="Which receipts" value={kinds} onChange={setKinds} options={[{ value: 'decisions', label: 'Decisions' }, { value: 'all', label: 'All kinds' }]} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="label mr-1">Quick</span>
            <Button size="sm" variant="ghost" className="border-line" loading={quick === '24h'} onClick={() => setLast('24h', { kind: kinds === 'all' ? 'all' : 'decision', from: Date.now() - DAY })}>Last 24 hours</Button>
            <Button size="sm" variant="ghost" className="border-line" loading={quick === '7d'} onClick={() => setLast('7d', { kind: kinds === 'all' ? 'all' : 'decision', from: Date.now() - 7 * DAY })}>Last 7 days</Button>
            <Button size="sm" variant="ghost" className="border-line" loading={quick === '50'} onClick={() => setLast('50', { kind: kinds === 'all' ? 'all' : 'decision', limit: 50 })}>Last 50</Button>
          </div>
          <p className="text-sm" aria-live="polite">
            {!rangeOk ? <span className="text-muted">Give the first and last receipt number.</span>
              : preview.loading && !preview.data ? <span className="text-muted">Counting…</span>
                : <><span className="num font-semibold">{n(count)}</span> {kinds === 'decisions' ? 'decisions' : 'receipts'} in {seqLabel(Math.min(fromN, toN))}–{seqLabel(Math.max(fromN, toN))}{preview.data?.from ? <span className="text-muted"> · {dateTime(preview.data.from)} to {dateTime(preview.data.to!)}</span> : null}{preview.data ? <span className="text-muted"> · {n(preview.data.refused)} refused</span> : null}.{' '}
                  {tooMany ? <span className="text-bad-fg">One bundle holds at most {BUNDLE_MAX}; narrow the range.</span> : !count ? <span className="text-bad-fg">Nothing in that range.</span> : <span className="text-muted">One file, one signature.</span>}</>}
          </p>
        </section>

        <section aria-labelledby="b-fields">
          <h3 id="b-fields" className="mb-1 text-md font-semibold"><span className="num mr-2 text-subtle">2</span>Choose the fields to reveal for every receipt</h3>
          <p className="mb-3 text-xs text-muted">The rest stay committed as salted digests under the same signature.</p>
          <FieldPicker value={fields} onChange={setFields} profiles={profiles} profileId={profile?.id} onProfile={setProfile} />
        </section>

        <section aria-labelledby="b-aud" className="space-y-3">
          <h3 id="b-aud" className="text-md font-semibold"><span className="num mr-2 text-subtle">3</span>Address it</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Audience" htmlFor="b-cp">
              <Select id="b-cp" value={cpId} onChange={(e) => setCpId(e.target.value)}>
                <option value="">Someone not in the register</option>
                {counterparties.map((c) => <option key={c.id} value={c.id}>{c.name} · {KIND_LABEL[c.kind]}</option>)}
              </Select>
            </Field>
            {cp ? (
              <Field label="Identity" hint="From the counterparty register."><p className="flex h-10 items-center border border-line bg-sunken/50 px-3 font-mono text-sm">ar-org:{cp.domain}</p></Field>
            ) : (
              <Field label="Their domain" htmlFor="b-dom" error={domErr} hint={!domErr ? (audience ? <span className="font-mono">{audience}</span> : 'Addressed to ar-org:<domain>.') : undefined}>
                <Input id="b-dom" value={domain} onChange={(e) => setDomain(e.target.value.toLowerCase())} placeholder="auditor.example.in" mono invalid={!!domErr} spellCheck={false} autoCapitalize="none" />
              </Field>
            )}
          </div>
          <div>
            <p className="label mb-1.5">Expires after</p>
            <Segmented<Expiry> label="Expires after" value={expiry} onChange={(v) => { setExpiry(v); setProfile(undefined); }} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
            <p className="mt-1.5 text-xs text-muted">{profile ? <>{expiresDays} days, from the profile “{profile.name}”. </> : null}Until {date(new Date(Date.now() + expiresDays * DAY).toISOString())}. You can withdraw it earlier.</p>
          </div>
        </section>

        <FirstIssueWarning info={first.info} acknowledged={ack} onChange={setAck} what="bundle" />
        {m.error && <Banner tone="bad">{m.error.message}</Banner>}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="text-sm text-muted">{count && audience && !tooMany ? <>Signs one bundle of {plural(count, 'receipt')} for <span className="font-mono">{audience}</span>, revealing {fields.length} of {TOTAL_FIELDS} fields each.</> : 'Choose a range and an audience.'}</p>
          <Button variant="primary" icon={<ShieldCheck className="h-4 w-4" aria-hidden />} loading={m.pending} disabled={disabled} onClick={submit}>Sign the bundle</Button>
        </div>
      </div>
    </Panel>
  );
}

/* ── Drawer ────────────────────────────────────────────────── */

function BundleDrawer({ id, cpName, onClose }: { id: string; cpName: (id?: string) => string | undefined; onClose: () => void }) {
  const orgId = useOrgId();
  const role = useRole();
  const user = useUser();
  const now = useNow(60_000);
  const { data: b, loading, error } = useQuery((o) => api.disclosureBundle(o, id), [id], { kinds: ['disclosure'] });
  const [check, setCheck] = useState<{ result: BundleCheck; ms: number; tampered: boolean }>();
  const [confirm, setConfirm] = useState(false);
  const exp = useMutation((o: string, bid: string, u: string) => api.exportDisclosureBundle(o, bid, u));
  const revoke = useMutation((o: string, bid: string, u: string) => api.revokeDisclosureBundle(o, bid, u));
  useEffect(() => { setCheck(undefined); setConfirm(false); }, [id]);
  const status = b ? (b.status === 'active' && new Date(b.expiresAt).getTime() < now ? 'expired' : b.status) : 'active';
  const fp = b ? sha256Hex(b.publicKey).slice(0, 16) : '';

  const run = (tamper: boolean) => {
    if (!b) return;
    const t0 = performance.now();
    const target: DisclosureBundle = tamper && b.items.length ? { ...b, items: b.items.map((it, i) => (i === Math.floor(b.items.length / 2) && it.revealed.length ? { ...it, revealed: it.revealed.map((f, j) => (j === 0 ? { ...f, value: `${f.value} (edited)` } : f)) } : it)) } : b;
    // pin this organisation's own published key for the bundle's kid, never the key inside the file
    let published: string | undefined;
    try { published = api.chainSlice(orgId, b.range.fromSeq, b.range.fromSeq).publicKeys[b.kid]; } catch { published = undefined; }
    const pinned = published ? sha256Hex(published).slice(0, 16) : 'none';
    setCheck({ result: verifyDisclosureBundle(target, { pinnedFingerprint: pinned }), ms: Math.max(1, Math.round(performance.now() - t0)), tampered: tamper });
  };

  const download = async () => {
    if (!b) return;
    try {
      const f = await exp.mutate(orgId, b.id, user!.id);
      downloadText(f.filename, f.text);
      toast.ok('Bundle downloaded', `${f.filename} · receipt #${f.seq} records the download.`);
    } catch (e) { toast.bad('Not downloaded', (e as Error).message); }
  };

  const doRevoke = async () => {
    if (!b) return;
    try {
      await revoke.mutate(orgId, b.id, user!.id);
      toast.ok('Bundle withdrawn', 'Its portal link stops working now. A receipt records it.');
      setConfirm(false);
    } catch { /* shown in dialog */ }
  };

  const fieldsShown = useMemo(() => (b ? DISCLOSABLE_FIELDS.filter((f) => b.fields.includes(f)) : []), [b]);

  return (
    <>
      <Drawer open onClose={onClose} width={720} kicker="Assurance · Disclosure bundle" title={b ? `${seqLabel(b.range.fromSeq)}–${seqLabel(b.range.toSeq)} · ${plural(b.range.count, 'receipt')}` : 'Bundle'}
        footer={b && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {status === 'active' && <><CopyButton text={portalUrl(b.token)} label="Copy share link" /><a href={`/counterparty/${b.token}`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 border border-line-strong/70 bg-surface px-4 hover:border-fg"><ExternalLink className="h-4 w-4" aria-hidden />Open portal</a></>}
            {status !== 'revoked' && (role === 'owner' || role === 'admin' || role === 'auditor') && <Button variant="secondary" icon={<Download className="h-4 w-4" aria-hidden />} loading={exp.pending} onClick={download}>Download the file</Button>}
            {status !== 'revoked' && canManage(role) && <Button variant="quiet-danger" icon={<Undo2 className="h-4 w-4" aria-hidden />} onClick={() => setConfirm(true)}>Withdraw</Button>}
          </div>
        )}>
        {error ? <Banner tone="bad" title="The bundle did not load">{error.message}</Banner> : loading && !b ? <Skeleton className="h-64 w-full" /> : b && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-3"><PackageChip status={status} /><span className="text-sm text-muted">{plural(b.views, 'view')} of the share link · {plural(b.downloads ?? 0, 'file')} downloaded</span></div>
            {b.status === 'revoked' && b.revokedAt && <Banner tone="bad" title={`Withdrawn ${dateTime(b.revokedAt)}${b.revokedBy ? ` by ${userName(b.revokedBy)}` : ''}`}>The portal link no longer opens. A file already handed over still verifies: withdrawing does not unsign it.</Banner>}
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="label">Audience</dt><dd className="mt-1">{cpName(b.counterpartyId) && <span className="block font-medium">{cpName(b.counterpartyId)}</span>}<span className="font-mono text-xs break-all">{b.audience}</span></dd></div>
              <div><dt className="label">Range</dt><dd className="mt-1"><ReceiptLink seq={b.range.fromSeq} /> to <ReceiptLink seq={b.range.toSeq} /> · {b.range.kinds === 'decisions' ? 'decisions only' : 'every kind'}</dd></div>
              <div><dt className="label">Revealed</dt><dd className="mt-1">{b.fields.length} of {TOTAL_FIELDS} fields{b.profileName ? ` · profile “${b.profileName}”` : ''}</dd></div>
              <div><dt className="label">Expires</dt><dd className="mt-1 num">{dateTime(b.expiresAt)}</dd></div>
              <div><dt className="label">Signed with</dt><dd className="mt-1 font-mono text-xs">{b.kid} · {fp}</dd></div>
              <div><dt className="label">Recorded as</dt><dd className="mt-1">{b.seqCreated ? <ReceiptLink seq={b.seqCreated} /> : <span className="text-muted">Before this chain sample</span>} · signed {date(b.createdAt)} by {userName(b.createdBy)}</dd></div>
            </dl>

            <section aria-labelledby="b-check">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 id="b-check" className="text-md font-semibold">Check it as they will</h3>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden />} onClick={() => run(false)}>Run the check</Button>
                  <Button size="sm" variant="ghost" className="border-line" icon={<FlaskConical className="h-3.5 w-3.5" aria-hidden />} onClick={() => run(true)}>Try a changed value</Button>
                </div>
              </div>
              {check ? (
                <div className="space-y-2" aria-live="polite">
                  <Banner tone={check.result.valid ? 'ok' : 'bad'} title={check.result.valid ? 'Verifies' : check.tampered ? 'The changed value fails, as it should' : 'Does not verify'}>
                    {check.result.valid ? `One signature over ${b.items.length} receipts; ${check.result.revealedCount} revealed values each match a signed digest.` : 'At least one check failed.'} {check.ms} ms in this browser.
                  </Banner>
                  <VerifySteps steps={check.result.steps} />
                </div>
              ) : <p className="text-sm text-muted">Runs what the recipient runs: audience, expiry, your key’s fingerprint, the signature over the manifest, and every revealed field of every receipt.</p>}
            </section>

            <section aria-labelledby="b-items">
              <h3 id="b-items" className="mb-2 flex items-center gap-2 text-md font-semibold"><FileJson className="h-4 w-4 text-muted" aria-hidden />What they see</h3>
              <div className="max-h-[360px] overflow-auto border border-line">
                <table className="w-full text-sm">
                  <caption className="sr-only">Revealed fields for each receipt in the bundle</caption>
                  <thead className="sticky top-0 bg-sunken text-left"><tr><th scope="col" className="label px-3 py-2">Receipt</th>{fieldsShown.map((f) => <th key={f} scope="col" className="label px-3 py-2 whitespace-nowrap">{FIELD_LABELS[f as DisclosableField]}</th>)}<th scope="col" className="label px-3 py-2">Hash</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {b.items.map((it) => {
                      const v = new Map(it.revealed.map((f) => [f.name, f.value]));
                      const bad = check?.result.items.find((x) => x.seq === it.seq && !x.ok);
                      return (
                        <tr key={it.seq} className={bad ? 'bg-bad-bg/40' : undefined}>
                          <td className="px-3 py-1.5 whitespace-nowrap"><ReceiptLink seq={it.seq} /></td>
                          {fieldsShown.map((f) => <td key={f} className="px-3 py-1.5 font-mono text-[11.5px] max-w-[22ch] truncate" title={v.get(f)}>{v.get(f) || '—'}</td>)}
                          <td className="px-3 py-1.5"><Hash value={it.receiptHash} len={8} copy={false} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted">{TOTAL_FIELDS - b.fields.length} withheld fields per receipt travel as salted digests. Withheld is not missing, and missing is not altered.</p>
            </section>
            <p className="text-xs text-muted leading-relaxed">{LIMITS_LINE}</p>
          </div>
        )}
      </Drawer>
      <Dialog open={confirm} onClose={() => setConfirm(false)} tone="danger" size="sm" title="Withdraw this bundle?"
        description={b ? `The share link stops working for ${cpName(b.counterpartyId) ?? b.audience}. A file they already hold still verifies; withdrawing does not unsign it.` : undefined}
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button><Button variant="danger" loading={revoke.pending} onClick={doRevoke}>Withdraw</Button></>}>
        {revoke.error ? <Banner tone="bad">{revoke.error.message}</Banner> : <p className="text-sm text-muted">A receipt records who withdrew it and when.</p>}
      </Dialog>
    </>
  );
}
