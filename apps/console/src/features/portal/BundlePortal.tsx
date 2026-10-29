import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleSlash, Download, FlaskConical, KeyRound, Layers, RefreshCw, Undo2 } from 'lucide-react';
import { api } from '@/api';
import { DISCLOSABLE_FIELDS, FIELD_LABELS, verifyDisclosureBundle, type BundleCheck, type DisclosableField, type DisclosureBundle } from '@/lib/disclosure';
import { sha256Hex } from '@/lib/crypto';
import { LEGAL_ENTITY } from '@/lib/company';
import { dateTime, seqLabel } from '@/lib/format';
import { Banner, Button, CopyButton, Field, Hash, Input, ProductMark, Spinner } from '@/components/ui';
import { KIND_LABEL, VerifySteps } from '@/features/counterparties/shared';
import { usePortalSession } from '@/features/auth/PortalSession';
import { levelOfOrg } from '@/lib/levels';
import { ORGS } from '@/mock/users';
import { RegimeProfile } from './RegimeProfile';

type Loaded = Awaited<ReturnType<typeof api.disclosureBundleByToken>>;

/**
 * Public portal for a disclosure bundle (/counterparty/<org>.rb.<id>). No sign-in. Shows the range, the fields
 * revealed for every receipt, and verifies the one signature and every revealed field in the visitor's browser.
 * The whole bundle downloads as one file.
 */
export function BundlePortalPage({ token }: { token: string }) {
  const [data, setData] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const asked = useRef<string>();
  useEffect(() => { document.title = 'Shared records · Elan1 Govern'; }, []);
  useEffect(() => {
    if (asked.current === token) return; // one view per open
    asked.current = token;
    setLoading(true);
    api.disclosureBundleByToken(token).then((d) => { setData(d); setError(undefined); }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [token]);

  return (
    <div className="min-h-screen bg-canvas text-fg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-[1040px] items-center justify-between gap-3 px-4">
          <ProductMark />
          <span className="text-xs text-muted">Counterparty portal · no sign-in</span>
        </div>
      </header>
      <main className="mx-auto max-w-[1040px] px-4 py-8">
        {loading && !data ? <div className="flex justify-center py-24"><Spinner className="h-6 w-6" /></div> : error || !data ? <Unavailable message={error ?? 'This link is not valid.'} /> : <Shared data={data} />}
      </main>
      <footer className="mx-auto max-w-[1040px] space-y-2 px-4 pb-10 text-xs leading-relaxed text-muted">
        <p>The checks on this page run in your browser. The fingerprint you paste is not sent anywhere.</p>
        <p>Draft — needs legal review. Elan1 Govern · {LEGAL_ENTITY}.</p>
      </footer>
    </div>
  );
}

function Unavailable({ message }: { message: string }) {
  const withdrawn = /withdrew/i.test(message);
  return (
    <div className="mx-auto max-w-[520px] border border-line bg-surface p-6">
      <span className="inline-flex h-10 w-10 items-center justify-center bg-sunken text-muted">{withdrawn ? <Undo2 className="h-5 w-5" aria-hidden /> : <CircleSlash className="h-5 w-5" aria-hidden />}</span>
      <h1 className="mt-4 text-xl font-semibold">{withdrawn ? 'This bundle was withdrawn' : 'This link is not valid'}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">{message} {withdrawn ? 'A file you saved earlier still verifies; withdrawing stops this link, it does not unsign the records.' : 'Ask the organisation that sent it for a new link.'}</p>
      <p className="mt-4 text-sm"><Link to="/verify" className="link">Verify a receipt or bundle you hold</Link></p>
    </div>
  );
}

function Shared({ data }: { data: Loaded }) {
  const b = data.bundle;
  const expired = new Date(b.expiresAt).getTime() < Date.now();
  const [pinned, setPinned] = useState('');
  const [audience, setAudience] = useState('');
  const [check, setCheck] = useState<{ result: BundleCheck; ms: number; tampered: boolean; pinned?: string }>();
  const [busy, setBusy] = useState(false);
  const fields = useMemo(() => DISCLOSABLE_FIELDS.filter((f) => b.fields.includes(f)), [b]);
  const fp = sha256Hex(b.publicKey).slice(0, 16);

  const run = (tamper = false) => {
    setBusy(true);
    window.setTimeout(() => {
      const t0 = performance.now();
      const target: DisclosureBundle = tamper && b.items.length ? { ...b, items: b.items.map((it, i) => (i === 0 && it.revealed.length ? { ...it, revealed: it.revealed.map((f, j) => (j === 0 ? { ...f, value: `${f.value} (edited)` } : f)) } : it)) } : b;
      const pin = pinned.trim().toLowerCase() || undefined;
      const aud = audience.trim() ? (audience.trim().startsWith('ar-org:') ? audience.trim() : `ar-org:${audience.trim()}`) : undefined;
      setCheck({ result: verifyDisclosureBundle(target, { pinnedFingerprint: pin, audience: aud }), ms: Math.max(1, Math.round(performance.now() - t0)), tampered: tamper, pinned: pin });
      setBusy(false);
    }, 20);
  };
  useEffect(() => { run(false); }, [b.id]);

  // a download is counted and recorded on the issuer's chain, with the portal sign-in's name when there is one
  const portal = usePortalSession();
  const signedIn = portal && portal.account.issuerOrgId === b.orgId && portal.account.counterpartyId === b.counterpartyId ? `${portal.account.name}, ${portal.account.employer}` : undefined;
  // a regulator this bundle was shared with runs the profile for their regime on it
  const regulator = signedIn && portal?.account.kind === 'regulator' ? portal.account : undefined;
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState<{ seq: number; downloads: number }>();
  const [downloadError, setDownloadError] = useState<string>();
  const download = async () => {
    setDownloading(true);
    setDownloadError(undefined);
    try {
      const f = await api.downloadDisclosureBundleByToken(b.token, signedIn);
      const blob = new Blob([f.text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloaded({ seq: f.seq, downloads: f.downloads });
    } catch (e) { setDownloadError((e as Error).message); } finally { setDownloading(false); }
  };

  return (
    <div className="space-y-8">
      <section aria-labelledby="bundle-title" className="space-y-4">
        <p className="label text-accent-fg">Shared with you by {data.issuer.name}</p>
        <h1 id="bundle-title" className="text-[26px] font-semibold leading-[34px] tracking-tighter2 sm:text-[32px] sm:leading-[40px]">
          {b.range.count} receipts, {seqLabel(b.range.fromSeq)} to {seqLabel(b.range.toSeq)}: {b.fields.length} of {DISCLOSABLE_FIELDS.length} fields revealed
        </h1>
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="label">Addressed to</dt><dd className="mt-1">{data.counterparty && <span className="block font-medium">{data.counterparty.name} · {KIND_LABEL[data.counterparty.kind as keyof typeof KIND_LABEL] ?? data.counterparty.kind}</span>}<span className="font-mono text-xs break-all">{b.audience}</span></dd></div>
          <div><dt className="label">Issuer</dt><dd className="mt-1"><span className="block font-medium">{data.issuer.name}</span><span className="text-xs text-muted">{data.issuer.level}</span></dd></div>
          <div><dt className="label">Shared</dt><dd className="mt-1 num">{dateTime(b.createdAt)}</dd></div>
          <div><dt className="label">{expired ? 'Expired' : 'Valid until'}</dt><dd className="mt-1 num">{dateTime(b.expiresAt)}</dd></div>
        </dl>
        {expired && <Banner tone="held" title="This bundle has expired">{data.issuer.name} set it to expire on {dateTime(b.expiresAt)}. The records below are shown for reference; the expiry check fails, as it should.</Banner>}
      </section>

      <div className="grid gap-8 lg:grid-cols-12">
        <section aria-labelledby="bundle-check" className="min-w-0 lg:col-span-5 space-y-4 lg:order-2">
          <h2 id="bundle-check" className="text-lg font-semibold">Check it in this browser</h2>
          <form className="space-y-3 border border-line bg-surface p-4" onSubmit={(e) => { e.preventDefault(); run(false); }}>
            <Field label={`${data.issuer.name}’s key fingerprint`} htmlFor="b-pin" hint={`Paste the 16 characters you obtained from ${data.issuer.name} directly, not from this page.`}>
              <Input id="b-pin" mono value={pinned} onChange={(e) => setPinned(e.target.value)} placeholder="16 hex characters" spellCheck={false} autoCapitalize="none" leading={<KeyRound className="h-4 w-4" aria-hidden />} />
            </Field>
            <Field label="Your organisation (optional)" htmlFor="b-aud" hint="Checks the bundle is addressed to you.">
              <Input id="b-aud" mono value={audience} onChange={(e) => setAudience(e.target.value)} placeholder={b.audience} spellCheck={false} autoCapitalize="none" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" icon={<RefreshCw className="h-4 w-4" aria-hidden />} loading={busy}>Verify</Button>
              <Button type="button" variant="ghost" className="border-line" icon={<FlaskConical className="h-4 w-4" aria-hidden />} disabled={busy} onClick={() => run(true)}>Try a changed value</Button>
            </div>
          </form>
          {check && (
            <div className="space-y-2" aria-live="polite">
              <Banner tone={check.result.valid ? (check.pinned ? 'ok' : 'info') : 'bad'} title={check.result.valid ? (check.pinned ? 'Verified' : 'Signature verifies — key not yet pinned') : check.tampered ? 'The changed value fails, as it should' : 'Does not verify'}>
                {check.result.valid ? (check.pinned ? `One signature by the key you pinned for ${data.issuer.name} covers all ${b.items.length} receipts; every revealed value matches a signed digest.` : `The signature and every revealed value check out against the key in this bundle. Paste the fingerprint ${data.issuer.name} gave you to confirm the key is theirs.`) : 'At least one check failed; see the steps.'} {check.ms} ms.
              </Banner>
              <VerifySteps steps={check.result.steps} />
            </div>
          )}
          <div className="border border-line bg-sunken/50 p-4 text-sm">
            <p className="label">What this shows</p>
            <p className="mt-1 leading-relaxed">{data.limits}</p>
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2"><dt className="text-muted">Format</dt><dd className="font-mono text-xs">{b.format}</dd></div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2"><dt className="text-muted">Key id</dt><dd className="font-mono text-xs">{b.kid}</dd></div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2"><dt className="text-muted">Fingerprint</dt><dd className="inline-flex items-center gap-1"><span className="font-mono text-xs">{fp}</span><CopyButton text={fp} label="Copy fingerprint" compact /></dd></div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2"><dt className="text-muted">Signature</dt><dd><Hash value={b.sig} len={16} /></dd></div>
          </dl>
          <Button variant="secondary" icon={<Download className="h-4 w-4" aria-hidden />} loading={downloading} onClick={download}>Download the bundle (one file)</Button>
          {downloaded && <p className="text-xs text-muted" aria-live="polite">Saved. {data.issuer.name} records each download (receipt #{downloaded.seq}; {downloaded.downloads} so far). Check the file offline, or open it in the <Link to="/verify" className="link">public verifier</Link>.</p>}
          {downloadError && <Banner tone="bad">{downloadError}</Banner>}
        </section>

        <section aria-labelledby="bundle-records" className="min-w-0 lg:col-span-7 space-y-3 lg:order-1">
          <h2 id="bundle-records" className="flex items-center gap-2 text-lg font-semibold"><Layers className="h-4 w-4 text-muted" aria-hidden />The records</h2>
          <div className="max-h-[560px] overflow-auto border border-line bg-surface">
            <table className="w-full text-sm">
              <caption className="sr-only">Revealed fields of each receipt</caption>
              <thead className="sticky top-0 bg-sunken text-left"><tr><th scope="col" className="label px-3 py-2">Receipt</th>{fields.map((f) => <th key={f} scope="col" className="label px-3 py-2 whitespace-nowrap">{FIELD_LABELS[f as DisclosableField]}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {b.items.map((it) => {
                  const v = new Map(it.revealed.map((f) => [f.name, f.value]));
                  const bad = check?.result.items.find((x) => x.seq === it.seq && !x.ok);
                  return (
                    <tr key={it.seq} className={bad ? 'bg-bad-bg/40' : undefined}>
                      <th scope="row" className="px-3 py-1.5 text-left font-mono text-[12px] whitespace-nowrap">{seqLabel(it.seq)}</th>
                      {fields.map((f) => <td key={f} className="px-3 py-1.5 font-mono text-[11.5px] max-w-[24ch] truncate" title={v.get(f)}>{v.get(f) || '—'}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {regulator && (
            <RegimeProfile employer={regulator.employer} issuer={data.issuer.name} level={levelOfOrg(ORGS.find((o) => o.id === b.orgId))} items={b.items} fields={b.fields} claimedProfileId={b.profileId} verified={check ? check.tampered || check.result.valid : undefined} />
          )}
          <p className="text-xs leading-relaxed text-muted">Withheld is not missing, and missing is not altered. The {DISCLOSABLE_FIELDS.length - b.fields.length} withheld fields of each receipt are still among the digests {data.issuer.name} signed; you see that they exist and have not changed, not what they say. This link has been opened {b.views} {b.views === 1 ? 'time' : 'times'}.</p>
        </section>
      </div>
    </div>
  );
}
