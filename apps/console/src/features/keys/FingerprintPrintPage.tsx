import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { atLeast, LEVEL_INFO } from '@/lib/levels';
import { date, dateTime } from '@/lib/format';
import { LEGAL_ENTITY } from '@/lib/company';
import { publicFingerprint } from '@/mock/keys';
import { Button, CopyButton, ProductMark } from '@/components/ui';
import { QrCode } from '@/features/you/qr';
import { PublicHeader } from '@/features/verify/PublicChrome';

const group = (fp: string) => fp.replace(/(.{4})/g, '$1 ').trim();

/**
 * The organisation's signing-key fingerprint as a printable page (public: public keys only, no account). Printed
 * and signed, it is the out-of-band copy an auditor checks a bundle against.
 */
export default function FingerprintPrintPage() {
  const { org: ref = '' } = useParams();
  const p = useMemo(() => publicFingerprint(ref), [ref]);
  useEffect(() => { document.title = p ? `Signing key fingerprint · ${p.org.name}` : 'Fingerprint · Elan1 Govern'; }, [p]);

  if (!p) {
    return (
      <div className="min-h-screen bg-canvas">
        <PublicHeader />
        <main id="main" className="mx-auto max-w-[760px] px-4 py-16">
          <h1 className="text-2xl font-semibold">No published key here</h1>
          <p className="mt-2 text-muted">There is no organisation called “{ref}”. Check the address you were given.</p>
          <Link to="/verify" className="mt-4 inline-block link">Verify a bundle</Link>
        </main>
      </div>
    );
  }
  const signed = atLeast(p.org.level, 'l2');
  const k = p.current;
  const qrText = k ? `elan1-govern:org=${p.org.domain ?? p.org.slug};kid=${k.kid};fp=${k.fingerprint}` : '';
  const past = p.windows.filter((w) => !k || w.kid !== k.kid).slice().reverse();

  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <div className="print:hidden"><PublicHeader /></div>
      <main id="main" className="mx-auto max-w-[820px] px-4 py-8 print:p-0 print:max-w-none">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
          <p className="text-sm text-muted">Print this page, sign it and hand it to your auditor, or keep it with your records.</p>
          <Button variant="primary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>Print</Button>
        </div>

        <article className="border border-line bg-surface p-6 sm:p-10 print:border-black print:p-8 text-fg">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
            <div>
              <p className="label">{signed ? 'Signing key' : 'Sealing key'} · published fingerprint</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{p.org.name}</h1>
              <p className="text-sm text-muted">{p.org.domain ?? p.org.slug} · {LEVEL_INFO[p.org.level].label}</p>
            </div>
            <ProductMark />
          </header>

          {p.signingOff || !k ? (
            <section className="mt-6 border border-bad/50 bg-bad-bg p-4 text-sm">
              <p className="font-semibold">Signing is off.</p>
              <p className="mt-1">The organisation declared its signing key compromised. Do not accept anything signed by a revoked key after its revocation. The replacement key’s fingerprint will be published here once it signs.</p>
              {p.bound.map((b) => <p key={b.kid} className="mt-2">Key bound · signing off: <span className="font-mono">{b.kid}</span> · <span className="font-mono">{group(b.fingerprint)}</span></p>)}
            </section>
          ) : (
            <section className="mt-6 grid gap-6 sm:grid-cols-[1fr_auto] sm:items-start">
              <div className="min-w-0">
                <p className="label">Fingerprint (first 16 hex of SHA-256 over the public key)</p>
                <p className="mt-2 font-mono text-3xl sm:text-4xl font-semibold tracking-wider break-all">{group(k.fingerprint)}</p>
                <span className="print:hidden"><CopyButton text={k.fingerprint} label="Copy fingerprint" /></span>
                <dl className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
                  <div><dt className="label">Key id</dt><dd className="mt-0.5 font-mono break-all">{k.kid}</dd></div>
                  <div><dt className="label">Algorithm</dt><dd className="mt-0.5">Ed25519</dd></div>
                  <div><dt className="label">{signed ? 'Signing' : 'Sealing'} since</dt><dd className="mt-0.5">{dateTime(k.createdAt)}</dd></div>
                  <div><dt className="label">Published</dt><dd className="mt-0.5">{dateTime(k.publishedAt ?? k.createdAt)}</dd></div>
                  <div className="sm:col-span-2"><dt className="label">Public key (hex)</dt><dd className="mt-0.5 font-mono text-[12px] break-all">{k.publicKeyHex}</dd></div>
                </dl>
              </div>
              <div className="justify-self-start sm:justify-self-end"><QrCode text={qrText} size={152} label={`QR code for ${k.kid}`} /></div>
            </section>
          )}

          {p.dns && (
            <section className="mt-6">
              <p className="label">DNS TXT record</p>
              <p className="mt-1 font-mono text-[12.5px] break-all">{p.dns.name} TXT "{p.dns.value}"</p>
            </section>
          )}

          {past.length > 0 && (
            <section className="mt-6">
              <p className="label mb-2">Earlier and pending keys (keep verifying the receipts they {signed ? 'signed' : 'sealed'})</p>
              <table className="w-full text-sm border-collapse">
                <thead><tr className="border-b border-line text-left"><th className="py-1.5 pr-3 font-semibold">Key id</th><th className="py-1.5 pr-3 font-semibold">Fingerprint</th><th className="py-1.5 pr-3 font-semibold">Window</th><th className="py-1.5 font-semibold">Status</th></tr></thead>
                <tbody>
                  {past.map((w) => (
                    <tr key={w.kid} className="border-b border-line align-top">
                      <td className="py-1.5 pr-3 font-mono text-[12px] break-all">{w.kid}</td>
                      <td className="py-1.5 pr-3 font-mono text-[12px]">{group(w.fingerprint)}</td>
                      <td className="py-1.5 pr-3 text-xs">{w.signingFrom ? `${date(w.signingFrom)} – ${w.signingUntil ? date(w.signingUntil) : 'now'}` : `published ${date(w.publishedAt)}`}</td>
                      <td className="py-1.5 text-xs">{w.status === 'revoked' ? `Revoked ${w.revokedAt ? date(w.revokedAt) : ''}` : w.status === 'bound' ? 'Key bound · signing off' : w.interim ? 'Interim · hash chain only' : w.status === 'active' ? 'Active' : 'Retired · verifies'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="mt-6 text-sm">
            <p className="label">How to check a bundle against this page</p>
            <p className="mt-1 font-mono text-[12.5px]">govern verify bundle.json --fingerprint {k?.fingerprint ?? '<fingerprint>'}</p>
            <p className="mt-1 text-muted">The verifier prints the fingerprint of the key that {signed ? 'signed' : 'sealed'} the bundle. If it differs from the one on this page, do not rely on the bundle.</p>
          </section>

          <section className="mt-10 grid gap-8 sm:grid-cols-2 text-sm">
            <div><div className="h-10 border-b border-fg" /><p className="mt-1 text-muted">Confirmed by (name and role)</p></div>
            <div><div className="h-10 border-b border-fg" /><p className="mt-1 text-muted">Date</p></div>
          </section>

          <footer className="mt-8 border-t border-line pt-3 text-xs text-muted">
            Printed {dateTime(new Date().toISOString())} from Elan1 Govern · {LEGAL_ENTITY}. This page carries public keys only.
          </footer>
        </article>
      </main>
    </div>
  );
}
