import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Building2, CheckCircle2, Clock3, Fingerprint, KeyRound, KeySquare, Lock, RotateCw, ShieldCheck, Users, XCircle } from 'lucide-react';
import { api, db } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import type { KeyCeremony, KeyCustody } from '@/types';
import { atLeast, LEVEL_INFO } from '@/lib/levels';
import { sha256Hex } from '@/lib/crypto';
import { date, dateTime, n, plural, relative, seqLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { keyState } from '@/features/agents/backend';
import { Badge, Banner, Button, Checkbox, CopyButton, DataTable, Dialog, EmptyState, Field, PageHeader, Panel, Skeleton, StatusChip, Tabs, Textarea, toast, type Column } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { ApiKeysSection } from '@/features/settings/sections/ApiKeys';
import { SigningKeysSection } from '@/features/settings/sections/SigningKeys';
import { UpgradePath, errText, receiptNote } from '@/features/settings/shared';
import { useCanDo } from '@/features/settings/permissions';
import { keysApi } from '@/mock/keys';
import { pendingRotationRequest } from '@/mock/platform';
import { KeyCompromisePanel, KeyContactPanel, SigningStateBadge } from '@/features/keys/Compromise';
import { KeyWindowsPanel } from '@/features/keys/KeyWindows';
import { SignReconciliationPanel } from '@/features/keys/SignReconciliation';
import { FingerprintPublishPanel } from '@/features/keys/FingerprintPublish';
import { useKeysState } from '@/features/keys/useKeys';
import { KeyChangeRefusalNote } from '@/features/keys/RefusalNote';
import { PlatformTokensPanel } from '@/features/keys/PlatformTokens';
import { TabPanel, usePageTitle, useTabParam } from './shared';

type TabId = 'agent' | 'signing' | 'custody' | 'counterparty';
const TABS = ['agent', 'signing', 'custody', 'counterparty'] as const;

const MODE_LABEL: Record<KeyCustody['mode'], string> = {
  env_master: 'Held by Elan1 Govern',
  aws_kms: 'AWS KMS',
  customer_hsm_cloud: 'Your HSM (cloud)',
  customer_hsm_onprem: 'Your HSM (on premises)',
};

/**
 * Keys — who an agent is (agent keys), how the record proves itself (signing keys), where that signing
 * key lives (custody) and the keys counterparties sign with (L3).
 */
export default function KeysPage() {
  usePageTitle('Keys');
  const level = useOrgLevel();
  // counterparty keys are part of L3: below it the tab is left out
  const l3 = atLeast(level, 'l3');
  const [tabParam, setTab] = useTabParam<TabId>(TABS);
  const tab: TabId = tabParam === 'counterparty' && !l3 ? 'agent' : tabParam;
  const { data: agents } = useQuery((o) => api.agents(o), [], { kinds: ['agent', 'key'] });
  const { data: evidence } = useQuery((o) => api.evidence(o), [], { kinds: ['key', 'checkpoint'] });
  const { data: custody } = useQuery((o) => api.custody(o), [], { kinds: ['key'] });
  // live: active or rotating; expired and revoked keys no longer identify the agent (as on the agent page)
  const liveKeys = agents?.flatMap((a) => a.keys).filter((k) => { const s = keyState(k); return s === 'active' || s === 'rotating'; }).length;
  const signingKeys = evidence?.signingKeys.length;

  return (
    <div className="overflow-x-clip">
      <PageHeader kicker="Agents" title="Keys" description="Agent keys are who an agent is to Elan1 Govern. The signing key is how the record proves itself, and custody is where that key lives and who can use it." />
      <div className="grid gap-4 md:grid-cols-3 mb-6">
        <Tile on={tab === 'agent'} icon={<KeySquare className="h-5 w-5 shrink-0 mt-0.5" aria-hidden />} title={<>Agent keys <span className="font-normal text-muted num">{liveKeys !== undefined && `· ${n(liveKeys)} live`}</span></>}>
          Prefixed <span className="font-mono text-[12.5px]">gk_</span> (production) or <span className="font-mono text-[12.5px]">sk_sbx_</span> (sandbox), shown in full once, then only the prefix. Revoking one stops the agent being recognised.
        </Tile>
        <Tile on={tab === 'signing'} icon={<Fingerprint className="h-5 w-5 shrink-0 mt-0.5" aria-hidden />} title={<>Signing keys <span className="font-normal text-muted num">{signingKeys !== undefined && `· ${n(signingKeys)} in the chain`}</span> <SigningStateBadge /></>}>
          {/* L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided. */}
          One active Ed25519 key {atLeast(level, 'l2') ? 'signs' : 'seals'} receipts and checkpoints. Retired keys stay published so older receipts still verify.
        </Tile>
        <Tile on={tab === 'custody'} icon={<Lock className="h-5 w-5 shrink-0 mt-0.5" aria-hidden />} title={<>Custody <span className="font-normal text-muted">{custody && `· ${MODE_LABEL[custody.mode]}`}</span></>}>
          {custody ? <>{custody.provider}, {custody.residencyDomain}. Held by {custody.heldBy === 'customer' ? 'you' : 'elan1'}.</> : 'Where the signing key lives and who can use it.'}
        </Tile>
      </div>

      <Tabs<TabId>
        label="Kinds of key"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'agent', label: 'Agent keys', count: liveKeys },
          { value: 'signing', label: 'Signing keys', count: signingKeys },
          { value: 'custody', label: 'Custody' },
          ...(l3 ? [{ value: 'counterparty' as const, label: 'Counterparty keys' }] : []),
        ]}
      />

      {tab === 'agent' && <TabPanel label="Agent keys"><ApiKeysSection /><PlatformTokensPanel /></TabPanel>}
      {tab === 'signing' && (
        <TabPanel label="Signing keys">
          <SigningKeysSection />
          <div className="mt-6 grid gap-6 xl:grid-cols-12 [&>*]:min-w-0">
            <div className="xl:col-span-7"><KeyWindowsPanel /></div>
            <div className="xl:col-span-5"><FingerprintPublishPanel /></div>
          </div>
          <Banner tone="info" className="mt-6" title={<span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4" aria-hidden />Check the record with these keys</span>}
            actions={<Link to="/evidence" className="inline-flex items-center gap-1 text-sm font-medium link whitespace-nowrap">Open Proof <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>}>
            Proof, behind the Assurance door, verifies the chain against these public keys and exports {atLeast(level, 'l2') ? 'the evidence bundle' : 'an auditor pack'} that carries them.
          </Banner>
        </TabPanel>
      )}
      {tab === 'custody' && <TabPanel label="Custody"><CustodyTab /></TabPanel>}
      {tab === 'counterparty' && <TabPanel label="Counterparty keys"><CounterpartyKeys /></TabPanel>}
    </div>
  );
}

function Tile({ on, icon, title, children }: { on: boolean; icon: ReactNode; title: ReactNode; children: ReactNode }) {
  return (
    <div className={['flex items-start gap-3 p-4 text-left border transition-colors', on ? 'border-fg bg-surface shadow-[inset_0_-2px_0_rgb(var(--fg))]' : 'border-line bg-surface'].join(' ')}>
      {icon}
      <span className="min-w-0"><span className="block text-sm font-semibold">{title}</span><span className="block mt-0.5 text-sm text-muted">{children}</span></span>
    </div>
  );
}

/* ── Custody ────────────────────────────────────────────────────────────── */

function CustodyTab() {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const canCustody = useCanDo('keys.custody');
  const { data: c, loading, error, refetch } = useQuery((o) => api.custody(o), [], { kinds: ['key'] });
  const { data: dep } = useQuery((o) => api.deployment(o), [], { kinds: ['deployment', 'key'] });
  const l3 = atLeast(level, 'l3');
  // At L2 a KMS rotation is dual control: one owner or admin requests, a different one approves.
  const kms = atLeast(level, 'l2') && !l3;
  // the open L2 rotation request (dual control), read from the chain by the same shared check as Proof › Keys
  const { data: pending } = useQuery(async (o) => (kms ? pendingRotationRequest(db.getDB(o)) ?? null : null), [kms], { kinds: ['receipt', 'key'] });
  const { data: ks } = useKeysState();
  // a planned successor bound and waiting to sign (after an approved KMS rotation or "Publish a successor"): no new request until it signs
  const successor = ks?.bound?.purpose === 'planned' && !ks.compromise ? ks.bound : undefined;
  // no key change while a chain incident (or a key compromise) is open: the reason, shown on every rotation control
  const block = ks?.block;
  const [wizard, setWizard] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [open, setOpen] = useState<string>();

  if (error) return <Banner tone="bad" title="Custody could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>;
  if (loading || !c) return <Skeleton className="h-96" />;

  const approveRotation = async () => {
    if (!user || !pending) return;
    if (pending.actor === user.id) { toast.bad('A different person approves', 'You asked for this rotation. Another owner or admin approves it.'); return; }
    setApproving(true);
    try {
      // the approval receipt is written only after KMS has rotated the key: a failed rotation leaves no approval behind
      const { ceremony: r, approvalSeq } = await keysApi.approveKmsRotation(orgId, user.id);
      toast.ok('Successor created in AWS KMS', `${r.kidAfter} is bound, signing off; ${r.kidBefore} keeps signing until the switch${r.switchAt ? ` on ${dateTime(r.switchAt)}` : ''}. Requested by ${userName(pending.actor)}, approved by you. ${receiptNote(approvalSeq)}`);
    } catch (e) { toast.bad('The key was not rotated', errText(e)); }
    finally { setApproving(false); }
  };
  const withdraw = async () => {
    if (!user || !pending) return;
    // checked in the backend: only a request still waiting can be withdrawn, and only by the person who asked
    try {
      const r = await keysApi.withdrawKmsRotation(orgId, user.id);
      toast.info('Rotation request withdrawn', receiptNote(r.seq));
    } catch (e) { toast.bad('The request was not withdrawn', errText(e)); }
  };
  // roles without key custody (auditors) read custody without a rotation control
  const rotationAction = !canCustody
    ? undefined
    : kms
      ? (pending ? <Badge tone="held">Waiting for a second person</Badge>
        : successor ? <Badge tone="held" title={`Successor ${successor.kid} is bound and signs after the overlap${successor.switchAt ? `, on ${dateTime(successor.switchAt)}` : ''}. A new rotation can be asked for once it signs.`}>Successor bound · signs {successor.switchAt ? date(successor.switchAt) : 'after the overlap'}</Badge>
        : <Button variant="primary" size="sm" icon={<RotateCw className="h-4 w-4" />} title={block ? `${block} Asking now is refused and recorded.` : undefined} onClick={() => setRequestOpen(true)}>Request a KMS rotation</Button>)
      : <Button variant="primary" size="sm" icon={l3 ? <Users className="h-4 w-4" /> : <RotateCw className="h-4 w-4" />} title={block ? `${block} Trying now is refused and recorded.` : undefined} onClick={() => setWizard(true)}>{l3 ? 'Run a key ceremony' : 'Rotate the key'}</Button>;
  const ceremonies = c.ceremonies.slice().sort((a, b) => b.at.localeCompare(a.at));
  const lastCer = ceremonies[0];
  const lastRotated = c.rotation.lastRotatedAt ?? lastCer?.at;
  const nextDue = c.rotation.nextDueAt ?? (lastRotated && /yearly/i.test(c.rotation.policy) ? new Date(new Date(lastRotated).getTime() + 365 * 864e5).toISOString() : undefined);

  const ceremonyCols: Column<KeyCeremony>[] = [
    { key: 'at', header: 'When', sort: (x) => x.at, cell: (x) => <span className="text-sm">{dateTime(x.at)}</span> },
    { key: 'kind', header: 'Kind', cell: (x) => <span className="capitalize text-sm">{x.kind.replace('_', ' ')}</span> },
    { key: 'quorum', header: 'Quorum', hideBelow: 'md', cell: (x) => <span className="text-sm">{x.quorum}</span> },
    { key: 'people', header: 'Present', hideBelow: 'lg', cell: (x) => <span className="text-xs">{x.participants.map((p) => p.name).join(', ')}</span> },
    { key: 'kids', header: 'Key', hideBelow: 'sm', cell: (x) => <span className="font-mono text-[12px]">{x.kidBefore ? `${x.kidBefore} → ` : ''}{x.kidAfter ?? '—'}</span> },
    { key: 'outcome', header: 'Outcome', cell: (x) => x.outcome === 'completed' ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Completed</StatusChip> : <StatusChip tone="bad" size="sm" icon={<XCircle className="h-3 w-3" />}>Aborted</StatusChip> },
    { key: 'seq', header: 'Receipt', align: 'right', cell: (x) => x.seq ? <ReceiptLink seq={x.seq} /> : <span className="text-subtle">—</span> },
  ];

  return (
    <div className="space-y-6">
      <Panel tone="inverse">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="label !text-ink-300">{MODE_LABEL[c.mode]}{c.signingOff ? ' · signing off' : ''}</p>
            <p className="mt-1 font-display text-2xl font-semibold text-paper">{c.provider}</p>
            <p className="mt-1 text-sm text-ink-200">{c.location}</p>
            <p className="mt-3 font-mono text-[12px] text-ink-200 break-all">{c.keyRef}</p>
            {c.alias && <p className="font-mono text-[12px] text-ink-300 break-all">{c.alias}</p>}
          </div>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
            <div><dt className="label !text-ink-300">Held by</dt><dd className="mt-0.5 text-paper">{c.heldBy === 'customer' ? 'You' : 'elan1'}</dd></div>
            <div><dt className="label !text-ink-300">Residency domain</dt><dd className="mt-0.5 text-paper">{c.residencyDomain}</dd></div>
            <div><dt className="label !text-ink-300">{c.signingOff ? (c.signingOff.ownKeyStatus === 'bound' ? 'Your key · bound, signing off' : 'Your key · revoked') : 'Key id'}</dt><dd className="mt-0.5 font-mono text-[12.5px] text-paper break-all">{c.kid}</dd></div>
            <div><dt className="label !text-ink-300">Fingerprint</dt><dd className="mt-0.5 font-mono text-[12.5px] text-paper">{c.fingerprint}</dd></div>
            {c.signingOff && <div className="col-span-2"><dt className="label !text-ink-300">Sealing now · not your key</dt><dd className="mt-0.5 text-paper text-[13px]">Elan1 Govern’s interim chain key <span className="font-mono">{c.signingOff.interimKid}</span> since {dateTime(c.signingOff.since)}: records are hash-chained only, not signed with a key in {c.provider}.</dd></div>}
            {c.quorum && <div><dt className="label !text-ink-300">Quorum</dt><dd className="mt-0.5 text-paper">{c.quorum.required} of {c.quorum.of} key holders</dd></div>}
            <div><dt className="label !text-ink-300">Algorithm</dt><dd className="mt-0.5 text-paper">{c.algorithm}</dd></div>
          </dl>
        </div>
      </Panel>

      <KeyCompromisePanel />

      <div className="grid gap-6 xl:grid-cols-12">
        <div className="xl:col-span-8 space-y-6 min-w-0">
          {kms && pending && (
            <Banner tone="held" title={`Rotation requested by ${userName(pending.actor)} · waiting for a second person`}
              actions={!canCustody ? undefined : user?.id === pending.actor
                ? <Button size="sm" variant="ghost" onClick={withdraw}>Withdraw</Button>
                : <Button size="sm" variant="primary" loading={approving} title={block ? `${block} Approving now is refused and recorded.` : undefined} onClick={approveRotation}>Approve and rotate</Button>}>
              {String(pending.details?.reason ?? '')} Requested {dateTime(pending.ts)} (<ReceiptLink seq={pending.seq} />). Dual control: an owner or admin other than the requester approves, then AWS KMS creates the new key.
            </Banner>
          )}
          <Panel title="Rotation" actions={rotationAction}>
            <dl className="grid gap-4 sm:grid-cols-3 text-sm">
              <div><dt className="label">Policy</dt><dd className="mt-1">{c.rotation.policy}</dd></div>
              <div><dt className="label">Last rotated</dt><dd className="mt-1">{lastRotated ? <>{date(lastRotated)} <span className="text-muted">({relative(lastRotated)})</span></> : 'Not since the organisation started'}</dd></div>
              <div><dt className="label">Next due</dt><dd className="mt-1">{nextDue ? date(nextDue) : 'On request'}</dd></div>
            </dl>
            <p className="mt-4 text-xs text-muted">{c.note} {atLeast(level, 'l2')
              ? 'A rotation publishes the new key as a successor (Key bound · signing off) and the current key keeps signing for the 30-day overlap, so verifiers can pin the new key first. At the switch the old key is retired for signing and stays published, so every receipt it signed still verifies.'
              // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
              : 'A rotation retires the old key and keeps it published, so every receipt it sealed still verifies.'}{kms && ' Rotation in AWS KMS needs 2 people: one requests, a different owner or admin approves. Each step is a receipt.'}</p>
          </Panel>

          <Panel title={l3 ? 'Key ceremonies' : 'Key events'} flush>
            <DataTable caption="Key ceremonies and rotations" columns={ceremonyCols} rows={ceremonies} rowKey={(x) => x.id} className="border-0" onRowClick={(x) => setOpen(open === x.id ? undefined : x.id)}
              empty={<EmptyState compact title="No ceremonies recorded" disc="trail">{l3 ? 'Run the first ceremony with 3 of 5 key holders present.' : 'Rotations appear here with their receipts.'}</EmptyState>} />
            {open && (() => { const x = c.ceremonies.find((y) => y.id === open); return x && (
              <div className="border-t border-line px-5 py-4">
                <p className="label mb-2">Minutes · {dateTime(x.at)}</p>
                <ol className="space-y-1.5 text-sm">{x.log.map((l, i) => <li key={i} className="flex gap-3"><span className="text-xs text-muted whitespace-nowrap num">{dateTime(l.at).slice(-14)}</span><span>{l.text}</span></li>)}</ol>
                {x.hsmSerial && <p className="mt-3 text-xs text-muted">HSM: {x.hsmSerial}</p>}
              </div>
            ); })()}
          </Panel>

          <SignReconciliationPanel />
        </div>

        <div className="xl:col-span-4 space-y-6 min-w-0">
          <KeyContactPanel />
          {dep && (
            <Panel title={l3 ? 'HSM attestation' : 'Key store'}>
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-muted">Model</dt><dd className="text-right">{dep.hsm.model}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted">Validation</dt><dd className="text-right">{dep.hsm.fips}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted">Location</dt><dd className="text-right">{dep.hsm.location}</dd></div>
                {lastCer?.hsmSerial && <div className="flex justify-between gap-3"><dt className="text-muted">Serials</dt><dd className="text-right text-xs">{lastCer.hsmSerial}</dd></div>}
                <div className="flex justify-between gap-3"><dt className="text-muted">Key exportable</dt><dd className="text-right">{c.mode === 'env_master' ? 'Sealed by the environment master key' : 'No'}</dd></div>
              </dl>
              {l3 && lastCer && <p className="mt-3 text-xs text-muted">The public key fingerprint {c.fingerprint} was read aloud and recorded by each holder at the last ceremony ({date(lastCer.at)}).</p>}
            </Panel>
          )}
          {c.holders && (
            <Panel title="Key holders" actions={<Badge>{c.quorum?.required} of {c.quorum?.of}</Badge>}>
              <ul className="space-y-2 text-sm">{c.holders.map((h) => <li key={h.name} className="flex justify-between gap-3"><span className="font-medium">{h.name}</span><span className="text-xs text-muted text-right">{h.role}</span></li>)}</ul>
            </Panel>
          )}
          {/* one line for the next plan only (owners); nothing for other roles */}
          {!atLeast(level, 'l2') && <UpgradePath to="l2">At L2 the signing key moves into AWS KMS in ap-south-1: key material never leaves KMS, and every use is in CloudTrail.</UpgradePath>}
          {atLeast(level, 'l2') && !l3 && <UpgradePath to="l3">At L3 the key is created in your own HSM (AWS CloudHSM, Thales Luna or Entrust nShield) in a ceremony with 3 of 5 named holders; elan1 can no longer sign for you.</UpgradePath>}
          {level === 'l3' && <UpgradePath to="sovereign">Sovereign runs the HSM, the timestamp authorities and the whole platform in your data centre.</UpgradePath>}
        </div>
      </div>

      {wizard && !kms && <CeremonyWizard custody={c} onClose={() => setWizard(false)} />}
      {kms && <RequestRotationDialog open={requestOpen} onClose={() => setRequestOpen(false)} alias={c.alias} />}
    </div>
  );
}

function RequestRotationDialog({ open, onClose, alias }: { open: boolean; onClose: () => void; alias?: string }) {
  const orgId = useOrgId();
  const user = useUser();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string>();
  const short = reason.trim().length < 8;
  const close = () => { setReason(''); setErr(undefined); onClose(); };
  const go = async () => {
    if (!user || short) return;
    try {
      const r = await keysApi.requestKmsRotation(orgId, user.id, reason, alias);
      toast.held('Rotation requested', `Recorded as ${seqLabel(r.seq)}. An owner or admin other than you approves it.`);
      close();
    } catch (e) { setErr(errText(e)); }
  };
  return (
    <Dialog open={open} onClose={close} title="Request a KMS rotation"
      description="AWS KMS creates a new Ed25519 key when a second owner or admin approves. It is published as the successor and signs after the 30-day overlap; until then the current key keeps signing, and afterwards it stays published for verification."
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" disabled={short} title={short ? 'Give a reason of a few words.' : undefined} onClick={go}>Request rotation</Button></>}>
      <div className="space-y-4">
        <Field label="Reason" htmlFor="kp-rot-reason" required hint="Recorded on the chain with the request, for example “Yearly rotation” or “Operator change”.">
          <Textarea id="kp-rot-reason" value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
        </Field>
        <KeyChangeRefusalNote />
        {err && <Banner tone="bad">{err}</Banner>}
      </div>
    </Dialog>
  );
}

const CHECKS = [
  'Each holder’s identity checked against the key-holder register',
  'HSM serial numbers match the attestation on record',
  'The room is secured and the session is recorded',
];

function CeremonyWizard({ custody, onClose }: { custody: KeyCustody; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const l3 = atLeast(level, 'l3');
  const holders = custody.holders ?? [];
  const need = custody.quorum?.required ?? 1;
  const [step, setStep] = useState(l3 ? 0 : 2);
  const [present, setPresent] = useState<string[]>([]);
  const [checks, setChecks] = useState<boolean[]>(CHECKS.map(() => false));
  const run = useMutation(api.runKeyCeremony);
  const [result, setResult] = useState<KeyCeremony & { switchAt?: string }>();

  const go = async () => {
    if (!user) return;
    try {
      const r = await run.mutate(orgId, user.id, l3 ? present : undefined);
      setResult(r);
      toast.ok(l3 ? 'Key ceremony completed' : 'Key rotated', l3 ? `${r.kidAfter} is published as the successor: key bound, signing off. ${r.seq ? receiptNote(r.seq) : ''}` : `${r.kidBefore} → ${r.kidAfter}. ${r.seq ? receiptNote(r.seq) : ''}`);
    } catch { /* shown below */ }
  };

  const steps = l3 ? ['Holders present', 'Checks', 'Generate'] : ['Rotate'];
  return (
    <Dialog open onClose={onClose} size="lg" title={l3 ? 'Key ceremony' : atLeast(level, 'l2') ? 'Rotate the KMS key' : 'Rotate the signing key'}
      description={l3 ? `${custody.provider}. A new Ed25519 key is generated inside the HSM and published as the successor; ${need} of ${holders.length} holders must be present.` : `${custody.provider}. A new key id is created; the old key is retired and stays published.`}
      footer={result ? <Button variant="primary" onClick={onClose}>Done</Button> : (
        <>
          <Button variant="ghost" onClick={step > 0 && l3 ? () => setStep(step - 1) : onClose}>{step > 0 && l3 ? 'Back' : 'Cancel'}</Button>
          {l3 && step < 2
            ? <Button variant="primary" disabled={step === 0 ? present.length < need : !checks.every(Boolean)} onClick={() => setStep(step + 1)}>Continue</Button>
            : <Button variant="primary" loading={run.pending} onClick={go}>{l3 ? 'Generate the new key' : 'Rotate now'}</Button>}
        </>
      )}>
      {l3 && !result && (
        <ol className="mb-5 flex flex-wrap gap-2 text-xs" aria-label="Steps">
          {steps.map((s, i) => <li key={s} className={`border px-2 py-1 ${i === step ? 'border-fg font-semibold' : i < step ? 'border-line text-muted' : 'border-line text-subtle'}`} aria-current={i === step ? 'step' : undefined}>{i + 1}. {s}</li>)}
        </ol>
      )}
      {result ? (
        <div className="space-y-3 text-sm">
          <StatusChip tone="ok" icon={<CheckCircle2 className="h-3.5 w-3.5" />}>Completed</StatusChip>
          {l3
            ? <p>New key <span className="font-mono">{result.kidAfter}</span> is published as the successor: <span className="font-medium">Key bound · signing off</span>. <span className="font-mono">{result.kidBefore}</span> keeps signing until the switch{result.switchAt ? <> on {dateTime(result.switchAt)}</> : null} (30-day overlap), so verifiers can pin the new key first. An owner or admin can turn signing on sooner under <Link to="/agents/keys?tab=signing" className="link">Signing keys › Key windows</Link>.</p>
            : <p>New key <span className="font-mono">{result.kidAfter}</span> seals from now. <span className="font-mono">{result.kidBefore}</span> is retired and stays published.</p>}
          <ol className="space-y-1 text-muted">{result.log.map((l, i) => <li key={i}>{l.text}</li>)}</ol>
          {result.seq && <p>Ceremony receipt <ReceiptLink seq={result.seq} /> · {l3 ? 'the key.bound receipt follows it; key.rotated is written at the switch.' : 'the rotation is the receipt after it.'}</p>}
        </div>
      ) : step === 0 ? (
        <fieldset>
          <legend className="text-sm font-medium mb-2">Who is present? <span className="font-normal text-muted">({present.length} of {need} needed)</span></legend>
          <div className="border border-line divide-y divide-line">
            {holders.map((h) => (
              <div key={h.name} className="px-3 py-2.5">
                <Checkbox checked={present.includes(h.name)} onChange={(v) => setPresent((p) => (v ? [...p, h.name] : p.filter((x) => x !== h.name)))} label={h.name} description={h.role} />
              </div>
            ))}
          </div>
        </fieldset>
      ) : step === 1 ? (
        <fieldset>
          <legend className="text-sm font-medium mb-2">Before the key is generated</legend>
          <div className="space-y-2">{CHECKS.map((c, i) => <Checkbox key={c} checked={checks[i]} onChange={(v) => setChecks((x) => x.map((y, j) => (j === i ? v : y)))} label={c} />)}</div>
        </fieldset>
      ) : (
        <div className="space-y-3 text-sm">
          {l3 && <p><span className="font-medium">{plural(present.length, 'holder')} present:</span> {present.join(', ')}.</p>}
          <ul className="list-[square] pl-5 space-y-1 text-muted">
            <li>{l3 ? 'A key.ceremony receipt and a key.bound receipt are written now, naming you and the new key id; key.rotated is written at the switch.' : 'A key.ceremony receipt and a key.rotated receipt are written, naming you and the old and new key ids.'}</li>
            {l3 && <li>The new key is published as the successor (Key bound · signing off) for the 30-day overlap; the current key keeps signing until the switch. Other key changes wait until then.</li>}
            <li>Receipts {atLeast(level, 'l2') ? 'signed' : 'sealed'} by the current key ({custody.kid}) keep verifying with its published public key.</li>
            {atLeast(level, 'l2') && <li>Timestamps and seals carry on unchanged; the next batch is signed with the new key.</li>}
            {l3 && <li>Counterparties are told the new fingerprint through your published key; pinned verifiers need it updated.</li>}
          </ul>
        </div>
      )}
      {!result && <KeyChangeRefusalNote className="mt-4" />}
      {run.error && <Banner tone="bad" className="mt-4">{errText(run.error)}</Banner>}
    </Dialog>
  );
}

/* ── Counterparty keys (L3) ─────────────────────────────────────────────── */

function CounterpartyKeys() {
  const level = useOrgLevel();
  const canAdd = useCanDo('counterparty.manage');
  const l3 = atLeast(level, 'l3');
  const { data: cp, loading } = useQuery((o) => api.counterparties(o), [], { kinds: ['counterparty', 'receipt'] });
  const { data: received } = useQuery(async (o) => (await api.crossOrgReceipts(o)).filter((r) => r.direction === 'received'), [], { kinds: ['counterparty', 'receipt'] });
  const keys = useMemo(() => {
    const m = new Map<string, { issuer: string; kid: string; fingerprint: string; count: number; verified: number; last: string }>();
    for (const r of received ?? []) {
      const k = `${r.issuerName}|${r.kid}`;
      const e = m.get(k) ?? { issuer: r.issuerName, kid: r.kid, fingerprint: sha256Hex(r.publicKey).slice(0, 16), count: 0, verified: 0, last: r.issuedAt };
      e.count++;
      if (r.verification.state === 'verified') e.verified++;
      if (r.issuedAt > e.last) e.last = r.issuedAt;
      m.set(k, e);
    }
    return [...m.values()];
  }, [received]);

  if (!l3) {
    return (
      <div className="space-y-4">
        <p className="max-w-[72ch] text-sm text-muted">At L3 each counterparty that sends you receipts is registered with its public key — pinned, read from its well-known address, or vouched for by a trust anchor — and every receipt it sends is verified against that key before it is bound into your chain.</p>
        <UpgradePath to="l3">Counterparties, their verification keys and receipts issued between organisations start at {LEVEL_INFO.l3.label}.</UpgradePath>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <Panel title="Registered counterparties" flush actions={<Link to="/assurance/counterparties" className="text-sm inline-flex items-center gap-1 link">Counterparties<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>}>
        {loading && !cp ? <div className="p-5"><Skeleton className="h-32" /></div> : !cp?.counterparties.length ? (
          <EmptyState compact title="No counterparties yet" action={canAdd ? <Link to="/assurance/counterparties" className="link">Add a counterparty</Link> : undefined}>The organisations this one exchanges receipts with appear here once registered.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <caption className="sr-only">Counterparty verification keys</caption>
              <thead className="bg-sunken/80"><tr className="border-b border-line">
                {['Counterparty', 'Key fingerprint', 'How the key is known', 'Verification', 'Received'].map((h) => <th key={h} scope="col" className="h-10 px-4 text-left label font-semibold">{h}</th>)}
              </tr></thead>
              <tbody>
                {cp.counterparties.map((x) => (
                  <tr key={x.id} className="border-b border-line last:border-b-0">
                    <th scope="row" className="px-4 py-2.5 text-left font-normal"><span className="inline-flex items-center gap-2 font-medium"><Building2 className="h-4 w-4 text-muted" aria-hidden />{x.name}</span><span className="block text-xs text-muted">{x.domain} · {x.kind}</span></th>
                    <td className="px-4 py-2.5">{x.keyFingerprint ? <span className="inline-flex items-center gap-1 font-mono text-[12px]">{x.keyFingerprint}<CopyButton text={x.keyFingerprint} compact label="Copy fingerprint" /></span> : <span className="text-subtle">Not yet received</span>}</td>
                    <td className="px-4 py-2.5 text-xs">{x.keyRoute === 'pinned' ? 'Pinned by you' : x.keyRoute === 'well_known' ? 'Published at its well-known address' : 'Vouched for by a trust anchor'}</td>
                    <td className="px-4 py-2.5">{x.verification === 'verified' ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Verified</StatusChip> : x.verification === 'failed' ? <StatusChip tone="bad" size="sm" icon={<XCircle className="h-3 w-3" />}>Failed</StatusChip> : <StatusChip tone="held" size="sm" icon={<Clock3 className="h-3 w-3" />}>{x.verification === 'pending' ? 'Pending' : 'Not started'}</StatusChip>}</td>
                    <td className="px-4 py-2.5 num">{n(x.received)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title={<span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4" aria-hidden />Keys seen on received receipts</span>} flush footer="The fingerprint is the first 16 hex of SHA-256 over the public key. A receipt that does not verify against its issuer’s key is not bound into your chain.">
        {!keys.length ? <EmptyState compact title="No receipts received yet" disc="trail">Receipts other organisations issue to you appear here with the key that signed them.</EmptyState> : (
          <ul className="divide-y divide-line">
            {keys.map((k) => (
              <li key={`${k.issuer}${k.kid}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm">
                <span className="font-medium">{k.issuer}</span>
                <span className="font-mono text-[12px]">{k.kid}</span>
                <span className="font-mono text-[12px] text-muted">{k.fingerprint}</span>
                <span className="ml-auto text-xs text-muted">{n(k.verified)} of {n(k.count)} verified · last {relative(k.last)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
