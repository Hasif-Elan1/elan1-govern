import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PORTAL_INFO } from '@/features/auth/registry';
import { PortalSessionBanner, usePortalSession } from '@/features/auth/PortalSession';
import { CircleSlash, Clock3, Download, EyeOff, FileJson, FlaskConical, KeyRound, RefreshCw, ShieldCheck, Undo2 } from 'lucide-react';
import { api } from '@/api';
import type { DisclosurePackage, LevelId } from '@/types';
import { DISCLOSABLE_FIELDS, FIELD_LABELS, disclosureDigest, verifyDisclosure, type DisclosableField } from '@/lib/disclosure';
import { sha256Hex } from '@/lib/crypto';
import { atLeast, levelOfOrg } from '@/lib/levels';
import { LEGAL_ENTITY } from '@/lib/company';
import { dateTime, seqLabel } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ORGS } from '@/mock/users';
import { Banner, Button, CopyButton, Field, Hash, Input, JsonView, ProductMark, Spinner } from '@/components/ui';
import { KIND_LABEL, RevealSummary, VerifySteps, packageStatus } from '@/features/counterparties/shared';
import { BundlePortalPage } from './BundlePortal';
import { PortalStanding, type Standing } from './PortalStanding';
import { RegimeProfile } from './RegimeProfile';

/** The evidence claim, said about the issuer rather than to it. */
const ISSUER_CLAIM: Record<LevelId, string> = {
  l1: 'sealed in a hash chain by Elan1 Govern and not yet externally timestamped',
  l2: 'sealed, signed with a key in AWS KMS and timestamped by two authorities',
  l3: 'signed with a key it holds in its own HSM and timestamped by two authorities',
  sovereign: 'signed in its own HSM and timestamped by its own two authorities',
};

type Loaded =Awaited<ReturnType<typeof api.disclosureByToken>>;
type Check = { result: ReturnType<typeof verifyDisclosure>; ms: number; tampered: boolean; pinned?: string; audience?: string };

/**
 * Public counterparty portal (/counterparty/:token). A bundle token (<org>.rb.<id>) opens a bundle over a range;
 * any other token opens one disclosure package.
 */
export default function CounterpartyPortalPage() {
  const { token = '' } = useParams();
  return api.isBundleToken(token) ? <BundlePortalPage key={token} token={token} /> : <PackagePortalPage key={token} />;
}

/**
 * One disclosure package. No sign-in. Shows who shared the record, what is revealed, the withheld fields as digests,
 * and verifies the revealed fields and the issuer's signature in the visitor's browser.
 */
function PackagePortalPage() {
  const { token = '' } = useParams();
  const [data, setData] = useState<Loaded>();
  // a portal sign-in (counterparty verifier, regulator or partner) is a session held in this browser and recorded
  // on the issuer's chain; it applies only when this record was shared with that person. A plain link has none.
  const portal = usePortalSession();
  const kind = portal && data && portal.account.issuerOrgId === data.package.orgId && portal.account.counterpartyId === data.package.counterpartyId ? portal.account.kind : undefined;
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const asked = useRef<string>();

  useEffect(() => { document.title = 'Shared record · Elan1 Govern'; }, []);

  useEffect(() => {
    if (asked.current === token) return; // one view per open, even when effects run twice
    asked.current = token;
    setLoading(true);
    // the receipt's standing first: a revocation the issuer recorded withdraws this link before it is opened
    api.standingByToken(token).catch(() => undefined)
      .then(() => api.disclosureByToken(token))
      .then((d) => { setData(d); setError(undefined); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  // the issued receipt's standing is shown even when the link no longer opens it: revoking a receipt withdraws its link
  const [standing, setStanding] = useState<Standing>();
  const issuerName = data?.issuer.name ?? ORGS.find((o) => o.slug === token.split('.')[0])?.name;

  let body: React.ReactNode;
  if (loading && !data) body = <div className="flex justify-center py-24"><Spinner className="h-6 w-6" /></div>;
  else if (error || !data) body = <Unavailable message={error ?? 'This link is not valid.'} revoked={standing?.revoked ? issuerName ?? 'The issuer' : undefined} />;
  else body = <Shared data={data} />;

  return (
    <div className="min-h-screen bg-canvas text-fg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-[1040px] items-center justify-between gap-3 px-4">
          <ProductMark />
          <span className="text-xs text-muted">{kind ? `${PORTAL_INFO[kind].label} portal · signed in` : 'Counterparty portal · no sign-in'}</span>
        </div>
      </header>
      <main className="mx-auto max-w-[1040px] px-4 py-8">
        {data && <PortalSessionBanner issuerOrgId={data.package.orgId} counterpartyId={data.package.counterpartyId} token={token} />}
        {(data || error) && issuerName && <PortalStanding token={token} issuer={issuerName} onStanding={setStanding} signedInAs={kind && portal ? `${portal.account.name}, ${portal.account.employer}` : undefined} />}
        {body}
      </main>
      <footer className="mx-auto max-w-[1040px] space-y-2 px-4 pb-10 text-xs leading-relaxed text-muted">
        <p>The checks on this page run in your browser. The fingerprint you paste is not sent anywhere.</p>
        <p>Draft — needs legal review. Elan1 Govern · {LEGAL_ENTITY}.</p>
      </footer>
    </div>
  );
}

function Unavailable({ message, revoked }: { message: string; revoked?: string }) {
  const withdrawn = !!revoked || /withdrew/i.test(message);
  return (
    <div className="mx-auto max-w-[520px] border border-line bg-surface p-6">
      <span className="inline-flex h-10 w-10 items-center justify-center bg-sunken text-muted">{withdrawn ? <Undo2 className="h-5 w-5" aria-hidden /> : <CircleSlash className="h-5 w-5" aria-hidden />}</span>
      <h1 className="mt-4 text-xl font-semibold">{revoked ? 'This receipt was revoked' : withdrawn ? 'This disclosure was withdrawn' : 'This link is not valid'}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        {revoked
          ? `${revoked} revoked the receipt behind this link, so the link no longer opens it. The reason is above. A copy you saved earlier still verifies as signed, but the issuer no longer stands behind it.`
          : <>{message} {withdrawn ? 'A copy you saved earlier still verifies; withdrawing stops this link, it does not unsign the record.' : 'Ask the organisation that sent it for a new link.'}</>}
      </p>
      <p className="mt-4 text-sm"><Link to="/verify" className="link">Verify a receipt or bundle you hold</Link></p>
    </div>
  );
}

function Shared({ data }: { data: Loaded }) {
  const pkg = data.package;
  const issuerOrg = ORGS.find((o) => o.id === pkg.orgId);
  const issuerLevel: LevelId = levelOfOrg(issuerOrg);
  const status = packageStatus(pkg);
  const revealed = useMemo(() => new Map(pkg.revealed.map((f) => [f.name, f])), [pkg]);
  const [pinned, setPinned] = useState('');
  const [audience, setAudience] = useState('');
  const [check, setCheck] = useState<Check>();
  const [busy, setBusy] = useState(false);
  // a regulator's portal sign-in, when this record was shared with them
  const portal = usePortalSession();
  const regulator = portal && portal.account.kind === 'regulator' && portal.account.issuerOrgId === pkg.orgId && portal.account.counterpartyId === pkg.counterpartyId ? portal.account : undefined;

  const run = (tamper = false) => {
    setBusy(true);
    window.setTimeout(() => {
      const t0 = performance.now();
      const p: DisclosurePackage = tamper && pkg.revealed.length ? { ...pkg, revealed: pkg.revealed.map((f, i) => (i === 0 ? { ...f, value: `${f.value} (edited)` } : f)) } : pkg;
      const pin = pinned.trim().toLowerCase() || undefined;
      const aud = audience.trim() ? (audience.trim().startsWith('ar-org:') ? audience.trim() : `ar-org:${audience.trim()}`) : undefined;
      const result = verifyDisclosure(p, { pinnedFingerprint: pin, audience: aud });
      setCheck({ result, ms: Math.max(1, Math.round(performance.now() - t0)), tampered: tamper, pinned: pin, audience: aud });
      setBusy(false);
    }, 20);
  };

  // check once on arrival, in this browser
  useEffect(() => { run(false); }, [pkg.id]);

  const actionReceipt = useMemo(() => ({
    format: 'action-receipt/v1',
    seal_suite: atLeast(issuerLevel, 'l2') ? 'elan1-seal-v6' : 'none (Guarded · L1: sealed in a hash chain, not yet externally timestamped)',
    sealed_fields: pkg.committed.map((c) => c.name),
    digest: pkg.receiptHash,
    issuer: `ar-org:${issuerOrg?.domain ?? data.issuer.name}`,
    limits: data.limits,
    signature: pkg.sig,
    key_id: pkg.kid,
    public_key: pkg.publicKey,
    audience: pkg.audience,
    expires_at: pkg.expiresAt,
    disclosure_suite: 'elan1-sd-v1',
    committed: pkg.committed,
    disclosures: pkg.revealed.map((f) => [f.salt, f.name, f.value]),
  }), [pkg, issuerLevel, issuerOrg, data]);

  const download = () => {
    const blob = new Blob([JSON.stringify(actionReceipt, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `action-receipt-${issuerOrg?.slug ?? 'issuer'}-${pkg.seq}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-8">
      {/* who and what */}
      <section aria-labelledby="shared-title" className="space-y-4">
        <p className="label text-accent-fg">Shared with you by {data.issuer.name}</p>
        <h1 id="shared-title" className="text-[26px] font-semibold leading-[34px] tracking-tighter2 sm:text-[32px] sm:leading-[40px]">
          Receipt {seqLabel(pkg.seq)}: {pkg.revealed.length} of {pkg.committed.length} fields revealed
        </h1>
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="label">Addressed to</dt><dd className="mt-1">{data.counterparty && <span className="block font-medium">{data.counterparty.name} · {KIND_LABEL[data.counterparty.kind as keyof typeof KIND_LABEL] ?? data.counterparty.kind}</span>}<span className="font-mono text-xs break-all">{pkg.audience}</span></dd></div>
          <div><dt className="label">Issuer</dt><dd className="mt-1"><span className="block font-medium">{data.issuer.name}</span><span className="text-xs text-muted">{data.issuer.level}</span></dd></div>
          <div><dt className="label">Shared</dt><dd className="mt-1 num">{dateTime(pkg.createdAt)}</dd></div>
          <div><dt className="label">{status === 'expired' ? 'Expired' : 'Valid until'}</dt><dd className="mt-1 num">{dateTime(pkg.expiresAt)}</dd></div>
        </dl>
        {status === 'expired' && (
          <Banner tone="held" title="This disclosure has expired">
            {data.issuer.name} set it to expire on {dateTime(pkg.expiresAt)}. The fields below are shown for reference; the expiry check fails, as it should. Ask them for a new link if you still need it.
          </Banner>
        )}
        <RevealSummary who={data.issuer.name} revealed={pkg.revealed.length} total={pkg.committed.length} />
      </section>

      <div className="grid gap-8 lg:grid-cols-12">
        {/* fields */}
        <section aria-labelledby="fields-title" className="min-w-0 lg:col-span-7 space-y-3">
          <h2 id="fields-title" className="text-lg font-semibold">The record</h2>
          <div className="overflow-x-auto border border-line bg-surface">
            <table className="w-full text-sm">
              <caption className="sr-only">Revealed and withheld fields</caption>
              <thead className="bg-sunken/60 text-left">
                <tr><th scope="col" className="label px-3 py-2">Field</th><th scope="col" className="label px-3 py-2">Value</th><th scope="col" className="label px-3 py-2">Digest</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {orderedCommitted(pkg).map((c) => {
                  const r = revealed.get(c.name);
                  const ok = r ? disclosureDigest(r.salt, r.name, r.value) === c.digest : undefined;
                  return (
                    <tr key={c.name} className={cn('align-top', !r && 'bg-sunken/30')}>
                      <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium">{FIELD_LABELS[c.name as DisclosableField] ?? c.name}</th>
                      <td className="px-3 py-2">
                        {r ? (
                          <>
                            <span className="font-mono text-[12.5px] break-all">{r.value || 'empty'}</span>
                            <span className="mt-0.5 block font-mono text-[10.5px] text-subtle" title={r.salt}>salt {r.salt.slice(0, 12)}…</span>
                          </>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted"><EyeOff className="h-3.5 w-3.5" aria-hidden />Withheld</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <Hash value={c.digest} len={10} />
                          {r && (ok
                            ? <span className="inline-flex items-center gap-1 text-xs font-medium text-ok-fg"><ShieldCheck className="h-3.5 w-3.5" aria-hidden />Matches</span>
                            : <span className="text-xs font-medium text-bad-fg">No match</span>)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs leading-relaxed text-muted">
            Withheld is not missing, and missing is not altered. Each withheld field is still one of the digests {data.issuer.name} signed; you see that it exists and that it has not changed, not what it says.
          </p>
        </section>

        {/* check */}
        <section aria-labelledby="check-title" className="min-w-0 lg:col-span-5 space-y-4">
          <h2 id="check-title" className="text-lg font-semibold">Check it in this browser</h2>
          <form className="space-y-3 border border-line bg-surface p-4" onSubmit={(e) => { e.preventDefault(); run(false); }}>
            <Field label={`${data.issuer.name}’s key fingerprint`} htmlFor="pin" hint={`Paste the 16 characters you obtained from ${data.issuer.name} directly, not from this page.`}>
              <Input id="pin" mono value={pinned} onChange={(e) => setPinned(e.target.value)} placeholder="16 hex characters" spellCheck={false} autoCapitalize="none" leading={<KeyRound className="h-4 w-4" aria-hidden />} />
            </Field>
            <Field label="Your organisation (optional)" htmlFor="aud" hint="Checks the package is addressed to you, e.g. ar-org:yourdomain.in">
              <Input id="aud" mono value={audience} onChange={(e) => setAudience(e.target.value)} placeholder={pkg.audience} spellCheck={false} autoCapitalize="none" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" icon={<RefreshCw className="h-4 w-4" aria-hidden />} loading={busy}>Verify</Button>
              <Button type="button" variant="ghost" className="border-line" icon={<FlaskConical className="h-4 w-4" aria-hidden />} disabled={busy} onClick={() => run(true)}>Try a changed value</Button>
            </div>
          </form>
          {check && (
            <div className="space-y-2" aria-live="polite">
              <Banner tone={check.result.valid ? (check.pinned ? 'ok' : 'info') : 'bad'}
                title={check.result.valid ? (check.pinned ? 'Verified' : 'Signature verifies — key not yet pinned') : check.tampered ? 'The changed value fails, as it should' : 'Does not verify'}>
                {check.result.valid
                  ? check.pinned
                    ? `Signed by the key you pinned for ${data.issuer.name}; every revealed field matches a signed digest.`
                    : `The signature and every revealed field check out against the key in this package. Paste the fingerprint ${data.issuer.name} gave you to confirm the key is theirs.`
                  : 'At least one check failed; see the steps.'} {check.ms} ms.
              </Banner>
              <VerifySteps steps={check.result.steps} />
            </div>
          )}
          <div className="border border-line bg-sunken/50 p-4 text-sm">
            <p className="label">What this shows</p>
            <p className="mt-1 leading-relaxed">{data.limits}</p>
            <p className="mt-2 text-xs leading-relaxed text-muted">{data.issuer.name} is on {data.issuer.level}: its records are {ISSUER_CLAIM[issuerLevel]}.</p>
          </div>
        </section>
      </div>

      {/* a regulator signed in to the portal runs the profile for their regime on this receipt */}
      {regulator && (
        <RegimeProfile employer={regulator.employer} issuer={data.issuer.name} level={issuerLevel} items={[{ seq: pkg.seq, revealed: pkg.revealed }]} fields={pkg.revealed.map((f) => f.name)} verified={check ? check.tampered || check.result.valid : undefined} />
      )}

      {/* signature and format */}
      <section aria-labelledby="format-title" className="grid gap-8 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-5 space-y-3">
          <h2 id="format-title" className="text-lg font-semibold">The Action Receipt format</h2>
          <p className="text-sm leading-relaxed text-muted">
            This package follows the published Action Receipt format, so you can check it without Elan1 Govern. Each committed field is SHA-256 over the canonical JSON of <span className="font-mono text-xs">[salt, name, value]</span>; the issuer signs, with Ed25519, the sorted digests together with the issuer, receipt hash, audience and expiry.
          </p>
          <dl className="space-y-2 text-sm">
            <Row k="Format" v={<span className="font-mono text-xs">action-receipt/v1 · disclosure suite elan1-sd-v1</span>} />
            <Row k="Key id" v={<span className="font-mono text-xs">{pkg.kid}</span>} />
            <Row k="Fingerprint" v={<span className="inline-flex items-center gap-1"><span className="font-mono text-xs">{sha256Hex(pkg.publicKey).slice(0, 16)}</span><CopyButton text={sha256Hex(pkg.publicKey).slice(0, 16)} label="Copy fingerprint" compact /></span>} />
            <Row k="Receipt hash" v={<Hash value={pkg.receiptHash} len={16} />} />
            <Row k="Signature" v={<Hash value={pkg.sig} len={16} />} />
          </dl>
          <p className="text-xs text-muted">Conformance shown here: structural, attested (signature and key id), addressed (audience and expiry) and disclosing. Timestamp tokens travel in the issuer’s evidence bundle, not in this package.</p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="secondary" icon={<Download className="h-4 w-4" aria-hidden />} onClick={download}>Download as JSON</Button>
            <Link to="/developers/cross-org#action-receipt"className="inline-flex h-10 items-center border border-line-strong/70 bg-surface px-4 hover:border-fg">Read the format</Link>
          </div>
        </div>
        <div className="min-w-0 lg:col-span-7">
          <details className="border border-line bg-surface" open={false}>
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm font-medium"><FileJson className="h-4 w-4 text-muted" aria-hidden />The package as JSON</summary>
            <div className="border-t border-line p-3"><JsonView value={actionReceipt} maxHeight={420} /></div>
          </details>
          <p className="mt-3 flex items-start gap-2 text-xs text-muted"><Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />This link has been opened {pkg.views} {pkg.views === 1 ? 'time' : 'times'}.</p>
        </div>
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 border-b border-line pb-2"><dt className="text-muted">{k}</dt><dd className="min-w-0">{v}</dd></div>;
}

/** Committed fields in the order a receipt reads (seq, time, agent, tool …), not alphabetical. */
function orderedCommitted(p: DisclosurePackage) {
  const order = new Map<string, number>(DISCLOSABLE_FIELDS.map((f, i) => [f, i]));
  return [...p.committed].sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99));
}
