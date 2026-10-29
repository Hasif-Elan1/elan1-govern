import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgLevel } from '@/store/session';
import { useCanDo } from '../permissions';
import type { LevelId, SigningKey } from '@/types';
import { atLeast } from '@/lib/levels';
import { date, n, relative } from '@/lib/format';
import { Banner, Button, CopyButton, DataTable, Panel, Skeleton, StatusChip, type Column } from '@/components/ui';
import { ChainStatus } from '@/components/domain';
import { SectionHeader, UpgradePath } from '../shared';
import { KeyStatusChip } from '@/features/keys/KeyWindows';
import { useScreenAccess } from '@/shell/access';

/** What a signature on this organisation's receipts proves, by level (BUILD-GUIDE: the evidence claim depends on the level). */
export function evidenceClaim(level: LevelId): { title: string; body: string } {
  switch (level) {
    case 'l2': return { title: 'Sealed, signed in AWS KMS and timestamped by two authorities', body: 'Each receipt is sealed (Seal v6, 16 frozen fields) and signed with a key that never leaves AWS KMS in ap-south-1. Every 15 minutes the receipts are batched into an RFC 6962 Merkle tree and the root is timestamped (RFC 3161) by eMudhra in India and one global authority. An auditor checks it offline with the public key and the timestamps.' };
    case 'l3': return { title: 'Signed with a key you hold in your HSM and timestamped by two authorities', body: 'Everything in L2, but the signing key was created in a key ceremony inside your HSM and never leaves it: neither elan1 nor its operators can sign for you. Counterparties verify your receipts against the same public key.' };
    case 'sovereign': return { title: 'Signed in your own HSM and timestamped by your own two authorities', body: 'The whole platform runs on your infrastructure. The key lives in your on-premises HSM, the two timestamp authorities are inside your network, and nothing is sent to elan1.' };
    // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
    default: return { title: 'Sealed in a hash chain by Elan1 Govern · not yet externally timestamped', body: 'Elan1 Govern seals each receipt and checkpoint with its own Ed25519 key and links it to the one before, so a receipt that changed after it was sealed shows up; an auditor checks the chain offline with the public key.' };
  }
}

export function SigningKeysSection() {
  const nav = useNavigate();
  const level = useOrgLevel();
  // the same gate as Custody and the backend: owners and admins rotate (keys.custody)
  const canRotate = useCanDo('keys.custody');
  const access = useScreenAccess();
  const { data, loading, error, refetch } = useQuery((o) => api.evidence(o), [], { kinds: ['key', 'checkpoint'] });
  const { data: custody } = useQuery((o) => api.custody(o), [], { kinds: ['key'] });
  const active = data?.signingKeys.find((k) => k.status === 'active');
  const bound = data?.signingKeys.find((k) => k.status === 'bound');
  const claim = evidenceClaim(level);
  const l1 = !atLeast(level, 'l2');
  const verb = l1 ? 'sealed' : 'signed';

  const columns: Column<SigningKey>[] = [
    { key: 'kid', header: 'Key id', cell: (k) => <span className="font-mono text-[12.5px]">{k.kid}</span> },
    { key: 'fp', header: 'Fingerprint', hideBelow: 'md', cell: (k) => <span className="inline-flex items-center gap-1 font-mono text-[12px] text-muted">{k.fingerprint}<CopyButton text={k.fingerprint} compact label="Copy fingerprint" /></span> },
    { key: 'status', header: 'Status', cell: (k) => k.status === 'active' && !k.interim ? <StatusChip tone="ok" size="sm" icon={<KeyRound className="h-3 w-3" />}>Active</StatusChip> : <KeyStatusChip w={{ status: k.status, interim: !!k.interim }} /> },
    { key: 'from', header: 'In use', hideBelow: 'sm', cell: (k) => <span className="text-sm">{k.status === 'bound' ? `Bound ${date(k.publishedAt ?? k.createdAt)} · not signing` : <>{date(k.createdAt)} – {k.retiredAt ? date(k.retiredAt) : 'now'}</>}</span> },
    { key: 'signed', header: `Receipts ${verb}`, align: 'right', sort: (k) => k.receiptsSigned, cell: (k) => n(k.receiptsSigned) },
  ];

  return (
    <div>
      <SectionHeader
        title="Signing keys"
        description={l1
          ? 'The Ed25519 key with which Elan1 Govern seals every receipt and checkpoint in this organisation’s hash chain. Rotation retires the old key; receipts it sealed still check out with its public key.'
          : 'The Ed25519 key that signs every receipt and checkpoint for this organisation. A rotation publishes the new key as a successor; the old key keeps signing until the switch after the 30-day overlap, then is retired and stays published, so receipts it signed still check out with its public key.'}
        actions={<>
          {access.canSee('/agents/keys') && <Button variant="secondary" iconRight={<ArrowUpRight className="h-4 w-4" />} onClick={() => nav('/agents/keys?tab=custody')}>{atLeast(level, 'l2') ? 'Custody and ceremonies' : 'Custody'}</Button>}
          {access.canSee('/evidence') && <Button variant="secondary" iconRight={<ArrowUpRight className="h-4 w-4" />} onClick={() => nav('/evidence')}>Open Proof</Button>}
        </>}
      />
      {error && <Banner tone="bad" className="mb-6" title="Keys could not be loaded" actions={<Button size="sm" onClick={refetch}>Try again</Button>}>{error.message}</Banner>}

      <Panel tone="inverse" className="mb-6">
        {loading && !data ? <Skeleton className="h-16 opacity-20" /> : data && (
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0">
              <p className="label !text-ink-300">{active?.interim ? 'Signing off · hash chain only' : 'Active key'}</p>
              <p className="mt-1 font-mono text-lg text-paper break-all">{active?.kid ?? '—'}</p>
              {bound && <p className="mt-1 text-sm text-held">Key bound · signing off: <span className="font-mono">{bound.kid}</span> · {bound.fingerprint}</p>}
              <p className="mt-1 font-mono text-[12.5px] text-ink-200 break-all">{data.org.keyFingerprint}</p>
              {custody && (active?.interim || custody.signingOff
                ? <p className="mt-2 text-sm text-ink-200">Not signed with your key: Elan1 Govern’s interim chain key links each record into the hash chain until signing is turned on with a key in {custody.provider}.</p>
                : <p className="mt-2 text-sm text-ink-200">{custody.provider} · {custody.residencyDomain} · held by {custody.heldBy === 'customer' ? 'you' : 'elan1'}</p>)}
            </div>
            <div className="grid grid-cols-2 gap-6 text-sm">
              <div><p className="label !text-ink-300">Receipts {verb}</p><p className="mt-1 font-display text-2xl font-semibold text-paper num">{n(active?.receiptsSigned ?? 0)}</p></div>
              <div><p className="label !text-ink-300">In use since</p><p className="mt-1 text-paper">{active ? relative(active.createdAt) : '—'}</p></div>
            </div>
            <ChainStatus inverse head={data.head} total={data.total} lastCheckpointAt={data.checkpoints[0]?.ts} className="w-full" />
          </div>
        )}
      </Panel>

      <DataTable caption="Signing keys" columns={columns} rows={data?.signingKeys.slice().reverse()} loading={loading} rowKey={(k) => k.kid} />

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Banner tone="neutral" title={`${l1 ? 'What the seal shows' : 'What the signature proves'}: ${claim.title.charAt(0).toLowerCase()}${claim.title.slice(1)}`}>
          {claim.body}
          {atLeast(level, 'l2') && access.canSee('/assurance/anchors') && <> <Link to="/assurance/anchors" className="link">See the timestamps</Link>.</>}
        </Banner>
        <Banner tone="neutral" title={<span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4" aria-hidden />Who can rotate</span>}>
          {atLeast(level, 'l3') ? 'Owners and admins rotate the key in a key ceremony with 3 of 5 key holders present, from Custody.' : atLeast(level, 'l2') ? 'A rotation in AWS KMS needs 2 people: one owner or admin requests it from Custody, a different owner or admin approves it, and KMS creates a new key id.' : 'Owners and admins rotate the key from Custody. At L1 it rotates at once.'}
          {atLeast(level, 'l2')
            ? ' The new key is published as a successor and the old key keeps signing until the switch after the 30-day overlap. Each step is written to the chain as an admin receipt naming the old and new key ids.'
            : ' The rotation is written to the chain as an admin receipt naming the old and new key ids.'}{!canRotate && ' Your role can read keys but not rotate them.'}
        </Banner>
      </div>
      {!atLeast(level, 'l2') && <UpgradePath to="l2" className="mt-4">Keys in AWS KMS (ap-south-1), Seal v6 and timestamps from two authorities start at L2.</UpgradePath>}
    </div>
  );
}
