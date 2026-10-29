import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, BadgeCheck, Download, Fingerprint, PackageOpen, ShieldCheck, Stamp, Waypoints } from 'lucide-react';
import { api, db } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import type { LevelId, Receipt } from '@/types';
import { LEVEL_INFO, atLeast } from '@/lib/levels';
import { BUNDLE_MEMBERS, CODE_LABELS, EXIT_CODES, LEXICON_MEMBER, REPORT_SECTION_TITLES } from '@/lib/verify6';
import { date, n, plural, relative, rupees, seqLabel } from '@/lib/format';
import { Banner, Button, CodeBlock, CopyButton, DataTable, EmptyState, Hash, LegalDraft, PageHeader, Panel, Skeleton, StatusChip, Tabs, toast, type Column } from '@/components/ui';
import { Person, ReceiptLink, When } from '@/components/domain';
import { downloadText } from '@/features/activity/shared';
import { ExportPackDialog, packFilename } from '@/features/evidence/ExportPackDialog';
import { WebhooksSection } from '@/features/settings/sections/Webhooks';
import { DataSection } from '@/features/settings/sections/Data';
import { chainStanding, publicKeyPem } from './model';
import { ENFORCEMENT_LABEL } from '@/mock/evidence';
import { cn } from '@/lib/cn';
import { PlanUpsell, SmartLink, useScreenAccess } from '@/shell/access';

type TabId = 'packs' | 'webhooks' | 'data';
const TABS: TabId[] = ['packs', 'webhooks', 'data'];

interface PackRow {
  id: string; ts: string; by: string; firstSeq: number; lastSeq: number; receipts: number; checkpoints: number; sizeKb: number; format?: string; profileId?: string;
  fromTs?: string; toTs?: string; seq?: number; beforeWindow?: boolean;
  /** absent on exports made before these were recorded */
  enforcement?: string; digest?: string; container?: string; part?: string;
}

const isBundle = (f?: string) => f === 'elan1.evidence.bundle.v1';

/**
 * Door 04 · Assurance — Exports. Everything that leaves the console: auditor packs (L1) or 8-member evidence
 * bundles (L2 and above) for offline verification, receipts streamed to your SIEM by webhook, and the full
 * export with retention. Every export is itself a receipt.
 */
export default function ExportsPage() {
  const [sp, setSp] = useSearchParams();
  const access = useScreenAccess();
  // webhooks and data retention are administration: auditors see the evidence that left, not the settings
  const tabs = TABS.filter((t) => t === 'packs' || (t === 'webhooks' ? access.can('settings.integrations') : access.isStaff));
  const tab = (tabs.includes(sp.get('tab') as TabId) ? sp.get('tab') : 'packs') as TabId;
  const setTab = (t: TabId) => { const next = new URLSearchParams(sp); if (t === 'packs') next.delete('tab'); else next.set('tab', t); setSp(next, { replace: true }); };
  const canExport = useCan('evidence.export');
  const level = useOrgLevel();
  const [exportOpen, setExportOpen] = useState(false);
  const word = atLeast(level, 'l2') ? 'Evidence bundles' : 'Auditor packs';

  // ?from=&to= (sequence numbers, from Activity's export dialog): open the export on that range, on the packs tab.
  const seqParam = (k: string) => { const v = Number((sp.get(k) ?? '').replace(/[#,\s]/g, '')); return Number.isFinite(v) && v > 0 ? v : undefined; };
  const linkedFrom = seqParam('from');
  const linkedTo = seqParam('to');
  const linked = linkedFrom !== undefined || linkedTo !== undefined;
  const [range, setRange] = useState<{ from?: number; to?: number }>();
  useEffect(() => {
    if (!linked) return;
    setRange({ from: linkedFrom, to: linkedTo });
    if (canExport) setExportOpen(true);
    const next = new URLSearchParams(sp); next.delete('from'); next.delete('to'); next.delete('tab');
    setSp(next, { replace: true });
  }, [linked, linkedFrom, linkedTo, canExport]);
  const openExport = () => { setRange(undefined); setExportOpen(true); };

  const counts = useQuery(async (o) => {
    const [ev, hooks] = await Promise.all([api.evidence(o), api.webhooks(o)]);
    return { packs: ev.exports.length, webhooks: hooks.length };
  }, []);

  return (
    <div>
      <PageHeader
        kicker="Assurance"
        title="Exports"
        description={`Everything that leaves the console: ${atLeast(level, 'l2') ? 'evidence bundles' : 'auditor packs'} an outsider can verify offline, receipts streamed to your SIEM, and a full export of your data. Every export is itself a receipt.`}
        meta={<StatusChip tone="neutral" size="sm">{LEVEL_INFO[level].label}</StatusChip>}
        actions={canExport && (
          <Button variant="primary" icon={<PackageOpen className="h-4 w-4" />} onClick={openExport}>{atLeast(level, 'l2') ? 'Export evidence bundle' : 'Export auditor pack'}</Button>
        )}
      />

      {tabs.length > 1 && (
        <Tabs<TabId>
          label="Export kinds"
          className="mb-6"
          value={tab}
          onChange={setTab}
          items={([
            { value: 'packs', label: word, count: counts.data?.packs },
            { value: 'webhooks', label: 'Webhooks', count: counts.data?.webhooks },
            { value: 'data', label: 'Data and retention' },
          ] as { value: TabId; label: string; count?: number }[]).filter((x) => tabs.includes(x.value))}
        />
      )}

      <div role="tabpanel" className="min-w-0 [&_.grid>*]:min-w-0" aria-label={tab === 'packs' ? word : tab === 'webhooks' ? 'Webhooks' : 'Data and retention'}>
        {tab === 'packs' && <PacksTab level={level} onExport={openExport} staffTabs={tabs} />}
        {tab === 'webhooks' && (
          <>
            <Banner tone="neutral" className="mb-6" title="Stream receipts to your SIEM">
              Subscribe an endpoint to <span className="font-mono">receipt.created</span> and every decision, approval, outcome and admin change arrives as it is written, each delivery signed with the endpoint’s secret. For an auditor, an <button type="button" className="link" onClick={() => setTab('packs')}>{atLeast(level, 'l2') ? 'evidence bundle' : 'auditor pack'}</button> is still the evidence: a webhook stream is a copy, not the chain.
            </Banner>
            <WebhooksSection />
          </>
        )}
        {tab === 'data' && <DataSection />}
      </div>

      <ExportPackDialog open={exportOpen} onClose={() => setExportOpen(false)} initialFrom={range?.from} initialTo={range?.to} />
    </div>
  );
}

/** The evidence.exported receipt for an export: written right after it, with the same receipt count. */
function receiptFor(exported: Receipt[], x: { ts: string; receipts: number }) {
  const t = new Date(x.ts).getTime();
  return exported
    .filter((r) => { const d = new Date(r.ts).getTime() - t; return d >= -2_000 && d < 120_000 && Number(r.details?.receipts) === x.receipts; })
    .sort((a, b) => a.seq - b.seq)[0]
    ?? exported.find((r) => Math.abs(new Date(r.ts).getTime() - t) < 120_000);
}

/* ── Packs and bundles ────────────────────────────────────── */

function PacksTab({ level, onExport, staffTabs }: { level: LevelId; onExport: () => void; staffTabs: TabId[] }) {
  const nav = useNavigate();
  const orgId = useOrgId();
  const canExport = useCan('evidence.export');
  const canCheckpoint = useCan('evidence.checkpoint');
  const user = useUser();
  const sign = useMutation(() => api.signCheckpoint(orgId, user?.id ?? ''));
  const l2 = atLeast(level, 'l2');

  const { data, loading, error, refetch } = useQuery(async (o) => {
    const [ev, anchors] = await Promise.all([api.evidence(o), api.anchors(o, 1)]);
    const d = db.getDB(o);
    const tsOf = (seq: number) => {
      const i = seq - (d.receipts[0]?.seq ?? 0);
      const r = d.receipts[i]?.seq === seq ? d.receipts[i] : d.receipts.find((x) => x.seq === seq);
      return r?.ts;
    };
    const exported = d.receipts.filter((r) => r.action === 'evidence.exported');
    const firstTs = d.receipts[0]?.ts;
    const rows: PackRow[] = ev.exports.slice().sort((a, b) => b.ts.localeCompare(a.ts)).map((x) => ({
      ...x,
      fromTs: tsOf(x.firstSeq),
      toTs: tsOf(x.lastSeq),
      seq: x.seq ?? receiptFor(exported, x)?.seq,
      beforeWindow: !!firstTs && x.ts < firstTs,
    }));
    return { ev, anchors, rows, standing: chainStanding(d) };
  }, []);

  const s = data?.standing;
  const empty = !!data && (!data.ev.head || data.ev.total === 0);
  const sampleFile = data && !empty ? packFilename(data.ev.org.slug, data.ev.first?.seq, data.ev.head?.seq, level, 'zip') : l2 ? 'bundle.zip' : 'auditor-pack.zip';

  const signNow = async () => {
    try {
      const c = await sign.mutate();
      // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
      toast.ok(`Checkpoint ${l2 ? 'signed' : 'sealed'} at ${seqLabel(c.seq)}`, `The head of the chain is now covered by a ${l2 ? 'signed' : 'sealed'} checkpoint.`);
    } catch (e) { toast.bad(`The checkpoint could not be ${l2 ? 'signed' : 'sealed'}`, (e as Error).message); }
  };

  const downloadKey = () => {
    if (!s?.activePublicKey) return;
    downloadText('org-public-key.pem', publicKeyPem(s.activePublicKey), 'application/x-pem-file');
    toast.ok('Public key downloaded', 'org-public-key.pem — send it, or its fingerprint, by a separate channel from the evidence.');
  };

  const cols: Column<PackRow>[] = [
    { key: 'ts', header: 'Exported', sort: (x) => x.ts, cell: (x) => <When iso={x.ts} className="text-sm" /> },
    { key: 'by', header: 'By', cell: (x) => <Person id={x.by} size={20} /> },
    { key: 'format', header: 'Kind', hideBelow: 'md', cell: (x) => (
      <span className="text-sm">
        {isBundle(x.format) ? 'Evidence bundle' : 'Auditor pack'}{x.part ? <span className="text-muted"> · part {x.part}</span> : null}
        {x.profileId ? <span className="block text-xs text-muted font-mono">{x.profileId}</span> : null}
        <span className="block text-xs text-muted">{x.container ? x.container.toUpperCase() : 'JSON'}{x.enforcement ? ` · ${ENFORCEMENT_LABEL[x.enforcement as keyof typeof ENFORCEMENT_LABEL] ?? x.enforcement}` : ''}{isBundle(x.format) ? ` · ${rupees(2500)}` : ' · free'}</span>
        {x.digest ? <span className="block text-xs text-muted">Digest <Hash value={x.digest} len={10} /></span> : null}
      </span>
    ) },
    { key: 'range', header: 'Range', cell: (x) => (
      <span className="block min-w-0">
        <span className="block font-mono text-[12px] whitespace-nowrap">{seqLabel(x.firstSeq)}–{seqLabel(x.lastSeq)}</span>
        {x.fromTs && x.toTs && <span className="block text-xs text-muted whitespace-nowrap">{date(x.fromTs)} to {date(x.toTs)}</span>}
      </span>
    ), hideBelow: 'sm' },
    { key: 'receipts', header: 'Receipts', align: 'right', sort: (x) => x.receipts, cell: (x) => n(x.receipts) },
    { key: 'size', header: 'Size', align: 'right', hideBelow: 'md', sort: (x) => x.sizeKb, cell: (x) => `${n(x.sizeKb)} KB` },
    { key: 'receipt', header: 'Recorded as', hideBelow: 'lg', cell: (x) => (x.seq ? <ReceiptLink seq={x.seq} /> : <span className="text-xs text-subtle">{x.beforeWindow ? 'Before this window' : 'Not in this window'}</span>) },
  ];

  const cli = data && !empty ? (l2 ? [
    '# On the auditor’s own machine — offline, no account',
    `$ govern verify ${sampleFile} --fingerprint ${data.ev.org.keyFingerprint} --profile in-mca-audit-trail`,
    `${data.anchors.totals.unanchoredTail ? 'PASS_UNANCHORED_TAIL' : 'PASS'}  ${n(data.ev.total)} receipts ${seqLabel(data.ev.first.seq)}–${seqLabel(data.ev.head.seq)}`,
    `  9 sections: ${REPORT_SECTION_TITLES.join(', ').toLowerCase()}`,
    `  key fingerprint: ${data.ev.org.keyFingerprint} (supplied)`,
    '$ echo $?',
    '0',
    '',
    '# Exit codes: 0 PASS · ' + (Object.keys(EXIT_CODES) as (keyof typeof EXIT_CODES)[]).filter((c) => !c.startsWith('PASS')).map((c) => `${EXIT_CODES[c]} ${c}`).join(' · '),
  ] : [
    '# On the auditor’s own machine — offline, no account',
    `$ govern verify ${sampleFile} --fingerprint ${data.ev.org.keyFingerprint}`,
    `PASS_L1_INTERNAL  ${n(data.ev.total)} receipts ${seqLabel(data.ev.first.seq)}–${seqLabel(data.ev.head.seq)}`,
    `  sealed manifest: 7 files, counts and last hash match; ${n(data.ev.checkpoints.length)} sealed checkpoints`,
    '  L1: internal evidence only — sealed in a hash chain, not externally timestamped',
    `  key fingerprint: ${data.ev.org.keyFingerprint} (supplied)`,
    '$ echo $?',
    '0',
  ]).join('\n') : '';

  return (
    <div>
      {error && <Banner tone="bad" title="Exports could not be loaded" className="mb-6" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      {empty ? (
        <EmptyState disc="trail" title="Nothing to export yet">This organisation has no receipts. The first governed call writes the first one; then it can be exported and verified offline.</EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-line border border-line mb-6">
            <Fig label="Exported" loading={!data} value={data ? n(data.rows.length) : '—'} sub={data?.rows[0] ? <>Last {relative(data.rows[0].ts)}</> : 'None yet'} />
            <Fig label="Receipts available" loading={!data} value={data ? n(data.ev.total) : '—'} sub={data?.ev.first && <span className="font-mono">{seqLabel(data.ev.first.seq)}–{seqLabel(data.ev.head.seq)}</span>} />
            <Fig label={l2 ? 'Signed checkpoints' : 'Sealed checkpoints'} loading={!data} value={data ? n(data.ev.checkpoints.length) : '—'} sub={data?.ev.checkpoints[0] ? `Last ${relative(data.ev.checkpoints[0].ts)}` : 'None yet'} />
            {l2 ? (
              <Fig label="Unanchored tail" loading={!data} value={data ? n(data.anchors.totals.unanchoredTail) : '—'} sub={data ? (data.anchors.totals.unanchoredTail ? 'Not yet timestamped; the verifier says so' : 'Every sealed record is timestamped') : undefined} />
            ) : (
              <Fig label="After the last checkpoint" loading={!data} value={s ? n(s.unanchored) : '—'} sub={s ? (s.unanchored ? 'The sealed manifest still names the last hash' : 'Head is covered') : undefined} />
            )}
          </div>

          {s && s.unanchored > 0 && !l2 && (
            <Banner tone="neutral" className="mb-6" title={`${plural(s.unanchored, 'receipt')} after the last sealed checkpoint`}
              actions={canCheckpoint ? <Button size="sm" icon={<Stamp className="h-3.5 w-3.5" />} loading={sign.pending} onClick={signNow}>Seal a checkpoint now</Button> : undefined}>
              An auditor pack’s sealed manifest names its last record and that record’s hash, so a pack with its newest records cut off fails verification even past the last checkpoint. A checkpoint also fixes the head for anyone who holds only the receipts, without the manifest — seal one if you share receipts that way.
            </Banner>
          )}

          <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
            <div className="lg:col-span-8 space-y-6">
              <Panel title="Export history" kicker="Everything that left the console" flush
                actions={canExport ? <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={onExport}>New export</Button> : undefined}
                footer="Each export writes an evidence.exported admin receipt, so the organisation can see everything that left — and who took it.">
                <DataTable
                  caption="Evidence exports"
                  className="border-0"
                  columns={cols}
                  rows={data?.rows}
                  loading={loading}
                  rowKey={(x) => x.id}
                  onRowClick={(x) => (x.seq ? nav(`/activity/${x.seq}`) : undefined)}
                  empty={<EmptyState compact title="Nothing exported yet" disc="trail" action={canExport ? <Button size="sm" onClick={onExport}>Export the first one</Button> : undefined}>An export bundles receipts, {l2 ? 'signed' : 'sealed'} checkpoints and public keys{l2 ? ', seals and timestamps' : ''} so an outsider can verify the chain offline.</EmptyState>}
                />
              </Panel>

              <Panel title="What leaves, by kind" kicker={l2 ? 'elan1.evidence.bundle.v1 at this level' : 'auditor-pack/1 at this level'}>
                {/* only the kinds this plan includes; owners get one line for the next level */}
                <div className={cn('grid gap-px bg-line border border-line', l2 && 'sm:grid-cols-2')}>
                  <Kind title="Auditor pack" tag="L1" on={!l2} note={l2 ? 'Records before your L2 boundary appear in the bundle as L1 records.' : 'What this organisation exports today.'}>
                    A ZIP (or one JSON file): receipts, sealed checkpoints and every public key in the range, a PDF summary, a compliance map and a README, under a manifest sealed over the last hash, the counts and every file’s digest. Sealed in a hash chain by Elan1 Govern; not externally timestamped. Free.
                  </Kind>
                  {l2 && (
                    <Kind title="Evidence bundle" tag="L2" on note="What this organisation exports today.">
                      8 members: {BUNDLE_MEMBERS.join(', ')}, and the lexicon ({LEXICON_MEMBER}) naming every rule and refusal id used, as a ZIP or one JSON file. A verifier profile, when claimed, travels with it. Redaction profile: none — fields are redacted per receipt with selective disclosure. {rupees(2500)} a bundle; a range over the size limit is split into parts.
                    </Kind>
                  )}
                  {atLeast(level, 'l3') && (
                    <>
                      <Kind title="Selective disclosure (SD-JWT)" tag="L3" on to="/assurance/disclosure" note="Reveal 3 of 11 committed fields, for example; the rest stay as salted digests the recipient can check.">
                        One receipt, with only the fields a counterparty needs revealed, signed and checkable in the counterparty portal.
                      </Kind>
                      <Kind title="Counterparty receipt" tag="L3" on to="/assurance/counterparties" note="Issued to a named audience (ar-org:domain) with an expiry and a nonce.">
                        A receipt issued to another organisation, which verifies it with your published key and binds it into its own chain.
                      </Kind>
                    </>
                  )}
                </div>
                {!l2 && <PlanUpsell to="l2" what="From L2 an export is the 8-member evidence bundle with seals and timestamps." className="mt-3" />}
                {l2 && <PlanUpsell to="l3" what="From L3 single receipts go out with selective disclosure, and counterparties get receipts of their own." className="mt-3" />}
                <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted">
                  <span>Arguments appear as a summary and a hash{l2 ? '; the sealed payload hash is salted so a salt can be destroyed for erasure' : ''}. Held-action arguments are wiped once decided.</span>
                  <LegalDraft />
                </div>
              </Panel>
            </div>

            <div className="lg:col-span-4 space-y-6">
              <Panel title="Verify offline" kicker="What the auditor does">
                {error && !data ? <p className="text-sm text-muted">The verification steps need the chain, which could not be loaded.</p> : !data || !s ? <Skeleton className="h-48" /> : (
                  <>
                    <ol className="list-decimal pl-5 space-y-2 text-sm text-muted leading-relaxed">
                      <li>Send the {l2 ? 'bundle' : 'pack'} to the auditor.</li>
                      <li>Send the {l2 ? 'key fingerprint' : 'public key, or its fingerprint,'} by a <span className="text-fg font-medium">separate channel</span> — so they do not have to trust the key inside the file.</li>
                      {l2 ? (
                        <li>They run <span className="font-mono text-fg">govern verify --fingerprint</span>, optionally with <span className="font-mono text-fg">--profile</span>. Exit 0 is a pass (PASS, PASS_UNANCHORED_TAIL, PASS_KEY_FROM_BUNDLE, PASS_L1_INTERNAL or PASS_PAYLOAD_UNBOUND; {CODE_LABELS.PASS_UNANCHORED_TAIL.toLowerCase()} is still 0); 1 integrity, 2 profile, 3 incomplete, 4 unsupported, 5 usage.</li>
                      ) : (
                        <li>They run <span className="font-mono text-fg">govern verify</span>. Exit 0 is PASS_L1_INTERNAL: intact, and internal evidence only. Exit 1 names the first broken receipt, an edited manifest or a cut-off tail. Exit 3 INCOMPLETE means something needed to check is missing: a file, a seal or a key. Exit 5 USAGE means the input is not a pack, or an option is wrong.</li>
                      )}
                    </ol>
                    <CodeBlock className="mt-4" code={cli} language="shell" wrap />
                    <div className="mt-4 flex items-center gap-2 border border-line bg-sunken/60 px-3 py-2">
                      <Fingerprint className="h-4 w-4 text-muted shrink-0" aria-hidden />
                      <span className="font-mono text-sm tracking-wide break-all flex-1">{s.fingerprint}</span>
                      <CopyButton text={s.fingerprint} label="Copy" />
                    </div>
                    {s.activeKid && <p className="mt-1.5 text-xs text-subtle">Active key <span className="font-mono">{s.activeKid}</span> · {plural(s.keys, 'key')} in this window</p>}
                    <div className="mt-4 grid gap-2">
                      <Button variant="secondary" block icon={<Download className="h-4 w-4" />} onClick={downloadKey} disabled={!s.activePublicKey} title={!s.activePublicKey ? 'No active signing key in this window.' : undefined}>Download public key (.pem)</Button>
                      <Button variant="secondary" block icon={<BadgeCheck className="h-4 w-4" />} onClick={() => nav('/verify')}>Open the web verifier</Button>
                      <Button variant="ghost" block icon={<Waypoints className="h-4 w-4" />} onClick={() => nav('/activity/chain')}>Check the chain in this browser</Button>
                    </div>
                  </>
                )}
              </Panel>

              <Panel title="Related" kicker="Assurance">
                <ul className="space-y-2 text-sm">
                  <li><Link to="/evidence" className="link inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4" aria-hidden />Proof — checkpoints and signing keys</Link></li>
                  {l2 && <li><Link to="/assurance/anchors" className="link">Timestamps and inclusion proofs</Link></li>}
                  {l2 && <li><Link to="/assurance/profiles" className="link">Verifier profiles</Link></li>}
                  <li><Link to="/compliance" className="link">Coverage reports by framework</Link></li>
                  {staffTabs.includes('webhooks') && <li><Link to="/assurance/exports?tab=webhooks" className="link">Stream receipts to your SIEM</Link></li>}
                  {staffTabs.includes('data') && <li><Link to="/assurance/exports?tab=data" className="link">Export everything and retention</Link></li>}
                </ul>
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Fig({ label, value, sub, loading }: { label: string; value: ReactNode; sub?: ReactNode; loading?: boolean }) {
  return (
    <div className="bg-surface p-4 sm:p-5 min-w-0">
      <p className="label">{label}</p>
      {loading ? <Skeleton className="mt-3 h-8 w-20" /> : <p className="mt-2 font-display text-3xl font-semibold tracking-tighter2 num leading-none">{value}</p>}
      {sub && !loading && <p className="mt-2 text-xs sm:text-sm text-muted truncate">{sub}</p>}
    </div>
  );
}

function Kind({ title, tag, on, to, note, children }: { title: string; tag: string; on: boolean; to?: string; note: string; children: ReactNode }) {
  return (
    <div className="bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        {/* only kinds the plan includes are rendered: "off" is a lower-level kind folded into the current one */}
        <StatusChip size="sm" tone={on ? 'ok' : 'neutral'}>{on ? 'On here' : `Included · ${tag}`}</StatusChip>
      </div>
      <p className="mt-1 text-sm text-muted leading-relaxed">{children}</p>
      <p className="mt-2 text-xs text-subtle">{note}</p>
      {to && <SmartLink to={to} hideWhenBlocked className="mt-2 inline-flex items-center gap-1 text-sm link">Open<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></SmartLink>}
    </div>
  );
}
