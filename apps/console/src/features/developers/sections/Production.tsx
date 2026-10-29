import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Download, FileCheck2, Play, ShieldCheck, Upload, XCircle, MinusCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, CopyButton, Field, Input, Segmented, Select, Spinner, StatusChip, Textarea } from '@/components/ui';
import { downloadBlob, downloadJson, bytesLabel } from '@/features/verify/bundle';
import { pushMail } from '@/features/auth/registry';
import { APPLICANT_REFUSALS, ELIGIBLE_LABEL } from '@/features/onboarding/refusals';
import { CONFORMANCE_LEVELS, CONFORMANCE_TESTS, VERIFIER_RELEASES } from '@/mock/devpathData';
import { devpathApi, resultFile, PROMOTION_MIN_DAYS, REVIEW_CHECKS, REVIEW_TARGET_DAYS, SANDBOX_LIMITS, BYPASS_PATHS, type ConformanceRun, type TestStatus } from '@/mock/devpath';
import { buildRelease, checkSums, sha256OfBlob, sigBlob, type Release } from '../release';
import { DocTitle, H2, H3, P, UL, OL, C, Code, Note, DocLink, SimpleTable } from '../docs';

/* ── Shared bits ──────────────────────────────────────────── */

export function TestChip({ status }: { status: TestStatus }) {
  if (status === 'pass') return <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Pass</StatusChip>;
  if (status === 'fail') return <StatusChip tone="bad" size="sm" icon={<XCircle className="h-3 w-3" aria-hidden />}>Fail</StatusChip>;
  return <StatusChip tone="neutral" size="sm" icon={<MinusCircle className="h-3 w-3" aria-hidden />}>Not applicable</StatusChip>;
}

type RunLike = Omit<ConformanceRun, 'id' | 'at' | 'by' | 'seq'> & Partial<Pick<ConformanceRun, 'id' | 'at' | 'by' | 'seq'>>;

/** The result of a conformance run: every test, the levels reached and the result file. */
export function RunResult({ run }: { run: RunLike }) {
  return (
    <div className="border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        {run.allPassed
          ? <StatusChip tone="ok" icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}>All 14 tests pass</StatusChip>
          : <StatusChip tone="bad" icon={<XCircle className="h-3.5 w-3.5" aria-hidden />}>{run.failed} of 14 {run.failed === 1 ? 'test fails' : 'tests fail'}</StatusChip>}
        <span className="text-sm text-muted">{run.sample.label}{run.sample.from !== undefined && <> · #{run.sample.from}–#{run.sample.to}</>}</span>
        <Button size="sm" variant="secondary" className="ml-auto" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadJson(`conformance-${run.agentSlug}-${(run.at ?? new Date().toISOString()).slice(0, 10)}.json`, resultFile(run))}>Result file</Button>
      </div>
      <ul className="divide-y divide-line">
        {run.results.map((t) => (
          <li key={t.id} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[52px_minmax(0,220px)_110px_1fr] sm:items-start sm:gap-3">
            <span className="font-mono text-[12.5px] font-semibold">{t.id}</span>
            <span className="text-sm font-medium">{t.title}</span>
            <span><TestChip status={t.status} /></span>
            <span className="text-sm text-muted leading-relaxed">{t.detail}</span>
          </li>
        ))}
      </ul>
      <div className="border-t border-line px-4 py-3">
        <p className="label mb-2">Action Receipt conformance levels</p>
        <div className="flex flex-wrap gap-2">
          {run.levels.map((l) => (
            <span key={l.id} title={l.why} className={cn('inline-flex h-7 items-center gap-1.5 border px-2 text-xs', l.reached ? 'border-ok/40 bg-ok-bg text-ok-fg' : 'border-line text-muted')}>
              {l.reached ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <MinusCircle className="h-3 w-3" aria-hidden />}
              <span className="font-mono font-semibold">{l.id}</span> {l.name}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">Highest level reached: {run.highest ?? 'none'} · digest <span className="font-mono">{run.digest.slice(0, 23)}…</span></p>
      </div>
    </div>
  );
}

/* ── Conformance ──────────────────────────────────────────── */

export function Conformance() {
  const [kind, setKind] = useState<'reference' | 'broken'>('reference');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunLike>();
  const [err, setErr] = useState<string>();
  const go = async () => {
    setBusy(true); setErr(undefined);
    try { setRun(await devpathApi.sample(kind)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <DocTitle kicker="Get started" title="Conformance" lead="Two things are tested before production. The conformance suite, C1–C14, tests your integration: how your agent uses Elan1 Govern. The conformance levels, CL-1 to CL-D, grade the Action Receipts an implementation produces." />
      <H2 id="suite">The suite: C1–C14</H2>
      <P>Run it in the sandbox against your own agent from the console, in the Agents door, under <DocLink to="/agents/production?tab=conformance">Path to production</DocLink>. Every test must pass before you ask for a production key; the result file is what you attach.</P>
      <SimpleTable caption="Conformance tests" head={['Test', 'Checks', 'How']} rows={CONFORMANCE_TESTS.map((t) => [<span key={t.id}><span className="font-mono font-semibold">{t.id}</span> <span className="whitespace-normal">{t.title}</span></span>, t.checks, t.how])} />
      <Note tone="neutral" title="C14 at L1">At L1 Guarded the record is sealed in a hash chain by Elan1 Govern, so rendered copy may not call it signed. C14 fails the run on “signed”, “tamper-proof” or “independently verifiable” in L1 copy; say “sealed in a hash chain”. From L2 “signed” is accurate.</Note>

      <H2 id="levels">Conformance levels: CL-1 to CL-D</H2>
      <SimpleTable caption="Conformance levels" head={['Level', 'Adds', 'Means', 'From']} rows={CONFORMANCE_LEVELS.map((l) => [<span key={l.id}><span className="font-mono font-semibold">{l.id}</span> {l.name}</span>, <span key="m" className="font-mono text-[12px]">{l.members}</span>, l.means, l.minLevel === 'l1' ? 'L1' : l.minLevel === 'l2' ? 'L2' : 'L3'])} />
      <P>An Elan1 Govern organisation reaches CL-1 at L1, CL-3 at L2 and CL-4 with CL-D at L3. Another implementation reaches a level by passing the <DocLink to="/developers/verifier-release">test vectors and the tampered bundle</DocLink> for it.</P>

      <H2 id="run">Run it against a sample</H2>
      <P>No account needed. The reference integration is the demo organisation’s invoice agent in its sandbox. The broken sample is the same integration with faults planted: a REST client that does not fail closed, an outcome reported for a refused call, a receipt edited after it was sealed, and copy that over-claims.</P>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Segmented<'reference' | 'broken'> label="Sample" value={kind} onChange={(k) => { setKind(k); setRun(undefined); }} options={[{ value: 'reference', label: 'Reference integration' }, { value: 'broken', label: 'Broken sample' }]} />
        <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={busy} onClick={go}>Run C1–C14</Button>
      </div>
      {err && <Banner tone="bad" title="The run did not finish" className="mb-4">{err}</Banner>}
      {run && <RunResult run={run} />}
      <H2 id="result-file">The result file</H2>
      <P>One JSON file: the suite version, the organisation and agent, the sample range, each test’s result and detail, the levels reached and a SHA-256 digest over all of it. A run in the console is also recorded as a receipt (<C>conformance.run</C>), so the reviewer can match the file to your chain.</P>
    </>
  );
}

/* ── Verifier release ─────────────────────────────────────── */

export function VerifierRelease() {
  const [rel, setRel] = useState<Release>();
  const [err, setErr] = useState<string>();
  const [sigOk, setSigOk] = useState<boolean>();
  const [checked, setChecked] = useState<{ name: string; sha: string; match?: string }>();
  const [older, setOlder] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    buildRelease().then((r) => { if (live) setRel(r); }).catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, []);
  const cur = VERIFIER_RELEASES.find((r) => r.status === 'current')!;
  const onFile = async (f?: File) => {
    if (!f || !rel) return;
    const sha = await sha256OfBlob(f);
    setChecked({ name: f.name, sha, match: rel.files.find((x) => x.sha256 === sha)?.name });
  };
  return (
    <>
      <DocTitle kicker="Events and evidence" title="Verifier releases" lead="Everything you need to check the offline verifier before you trust it: the files, their SHA-256 sums, a signature over the sums, the 64 test vectors and a bundle that was tampered with on purpose." />
      <H2 id="current">govern verify {cur.version}</H2>
      <p className="mb-4 text-sm text-muted">Released {cur.date}. {cur.note}</p>
      {err && <Banner tone="bad" title="The release files could not be built">{err}</Banner>}
      {!rel && !err && <p className="flex items-center gap-2 text-sm text-muted"><Spinner />Building the release files in your browser…</p>}
      {rel && (
        <>
          <ReleaseFiles rel={rel} />
          <p className="mb-4 text-xs text-muted">These files were fixed when this release was first built here ({rel.fixedAt.slice(0, 10)}) and are served byte for byte from then on, so a file you downloaded earlier still matches SHA256SUMS. The sample bundles are a fixed stretch of the demo organisation’s chain, opened read-only.</p>
          <H3 id="sums">SHA256SUMS and its signature</H3>
          <Code title="SHA256SUMS" code={rel.sums.trimEnd()} />
          <SumsDownloads rel={rel} />
          <SimpleTable caption="Release key" head={['', '']} rows={[
            ['Algorithm', 'Ed25519'],
            ['Public key', <span key="p" className="inline-flex items-center gap-2"><span className="font-mono text-[12px] break-all">{rel.pubHex}</span><CopyButton compact text={rel.pubHex} /></span>],
            ['Fingerprint', <span key="f" className="font-mono">{rel.fingerprint}</span>],
            ['Signature (hex)', <span key="s" className="font-mono text-[11.5px] break-all">{rel.sigHex}</span>],
          ]} />
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="primary" icon={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => setSigOk(checkSums(rel.sums, rel.sigHex))}>Check the signature here</Button>
            {sigOk !== undefined && (sigOk
              ? <StatusChip tone="ok" icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}>The release key signed these sums</StatusChip>
              : <StatusChip tone="bad" icon={<XCircle className="h-3.5 w-3.5" aria-hidden />}>The signature does not match</StatusChip>)}
          </div>
          <P className="mt-4">Compare the fingerprint with the one printed in the README of the source repository and in the npm and PyPI package metadata — three places we do not control together.</P>
          <Code title="On your machine" code={`sha256sum -c SHA256SUMS\nopenssl pkeyutl -verify -pubin -inkey elan1-release-key.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig\n\ngovern verify govern-verify-${rel.version}-reference-bundle.zip   # PASS, exit 0\ngovern verify govern-verify-${rel.version}-tampered-bundle.zip    # FAIL_INTEGRITY, exit 1`} />
          <H3 id="check-file">Check a file you downloaded</H3>
          <div className="flex flex-wrap items-center gap-3">
            <input ref={fileRef} type="file" className="sr-only" id="rel-file" onChange={(e) => void onFile(e.target.files?.[0] ?? undefined)} />
            <Button size="sm" variant="secondary" icon={<Upload className="h-3.5 w-3.5" />} onClick={() => fileRef.current?.click()}>Choose a file</Button>
            <span className="text-sm text-muted">Its SHA-256 is worked out in your browser and compared with SHA256SUMS.</span>
          </div>
          {checked && (
            <Banner className="mt-3" tone={checked.match ? 'ok' : 'bad'} title={checked.match ? `${checked.name} matches ${checked.match}` : `${checked.name} is not in SHA256SUMS`}>
              <span className="font-mono text-[12px] break-all">{checked.sha}</span>
            </Banner>
          )}
        </>
      )}
      <H2 id="history">Every release</H2>
      <SimpleTable caption="Verifier releases" head={['Version', 'Released', 'Status', 'Notes', 'Files']} rows={VERIFIER_RELEASES.map((r) => [
        <span key={r.version} className="font-mono">{r.version}</span>, r.date,
        r.status === 'current' ? <Badge key="s" tone="ok">Current</Badge> : <span key="s"><Badge tone="held">Superseded</Badge><span className="block mt-1 text-xs text-muted">on {r.supersededOn}</span></span>,
        <span key="n">{r.note}{r.why && <span className="block mt-1 text-muted">Why superseded: {r.why}</span>}</span>,
        r.status === 'current'
          ? <a key="f" href="#current" className="link text-sm whitespace-nowrap">Above</a>
          : <Button key="f" size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} aria-expanded={older === r.version} onClick={() => setOlder(older === r.version ? undefined : r.version)}>{older === r.version ? 'Hide files' : 'Files'}</Button>,
      ])} />
      {older && <OlderRelease key={older} version={older} />}
      <P>A superseded release stays downloadable with its dated note (RELEASE-NOTE.txt, listed in its SHA256SUMS), so an auditor can reproduce a result from the day it was made. Install the current release with <DocLink to="/developers/cli">npm or pipx</DocLink>.</P>
    </>
  );
}

function ReleaseFiles({ rel }: { rel: Release }) {
  return (
    <div className="my-5 overflow-x-auto border border-line">
      <table className="w-full text-sm">
        <caption className="sr-only">Files of govern verify {rel.version}</caption>
        <thead className="bg-sunken/80"><tr className="border-b border-line">{['File', 'What it is', 'Size', 'SHA-256', ''].map((h, i) => <th key={i} scope="col" className="h-9 px-3 text-left label whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>
          {rel.files.map((f) => (
            <tr key={f.name} className="border-b border-line last:border-b-0 align-top">
              <td className="px-3 py-2.5 font-mono text-[12px] break-all min-w-[180px]">{f.name}</td>
              <td className="px-3 py-2.5 min-w-[220px] leading-relaxed">{f.what} <span className="text-muted">Licence: {f.licence}.</span></td>
              <td className="px-3 py-2.5 whitespace-nowrap num">{bytesLabel(f.bytes)}</td>
              <td className="px-3 py-2.5 font-mono text-[11.5px] text-muted" title={f.sha256}>{f.sha256.slice(0, 16)}…</td>
              <td className="px-3 py-2.5"><Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadBlob(f.name, f.blob)} aria-label={`Download ${f.name}`}>Download</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SumsDownloads({ rel }: { rel: Release }) {
  const suffix = rel.status === 'current' ? '' : `-${rel.version}`;
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadBlob(`SHA256SUMS${suffix}`, new Blob([rel.sums], { type: 'text/plain' }))}>SHA256SUMS</Button>
      <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadBlob(`SHA256SUMS${suffix}.sig`, sigBlob(rel.sigHex))}>SHA256SUMS.sig</Button>
      <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadBlob('elan1-release-key.pem', new Blob([rel.pem], { type: 'application/x-pem-file' }))}>elan1-release-key.pem</Button>
    </div>
  );
}

/** A superseded release: its files, its dated note and its signed sums, built the first time they are asked for. */
function OlderRelease({ version }: { version: string }) {
  const [rel, setRel] = useState<Release>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    let live = true;
    buildRelease(version).then((r) => { if (live) setRel(r); }).catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [version]);
  return (
    <section aria-labelledby={`rel-${version}`} className="my-4 border border-line bg-surface p-4">
      <H3 id={`rel-${version}`}>govern verify {version}</H3>
      {err && <Banner tone="bad" title="The release files could not be built">{err}</Banner>}
      {!rel && !err && <p className="flex items-center gap-2 text-sm text-muted"><Spinner />Building the release files in your browser…</p>}
      {rel && (
        <>
          <p className="text-sm text-muted">Released {rel.date}; superseded on {rel.supersededOn}. {rel.why}</p>
          <ReleaseFiles rel={rel} />
          <Code title={`SHA256SUMS (${rel.version})`} code={rel.sums.trimEnd()} />
          <SumsDownloads rel={rel} />
        </>
      )}
    </section>
  );
}

/* ── The Action Receipt standard ──────────────────────────── */

const MEMBERS: [string, string, string][] = [
  ['format', 'Always', 'The format and its version: action-receipt/1.'],
  ['seal_suite', 'Always', 'Which sealing suite made the digest, from the suite registry.'],
  ['sealed_fields', 'Always', 'The fields the digest covers, in order.'],
  ['digest', 'Always', 'SHA-256 over the length-prefixed preimage of the sealed fields.'],
  ['issuer', 'Always', 'The organisation that made the write, as ar-org:<domain>.'],
  ['limits', 'Always', 'What the receipt does and does not show, verbatim.'],
  ['signature', 'CL-2', 'Ed25519 over the digest by a key bound to the issuer.'],
  ['key_id', 'CL-2', 'Which published key signed it.'],
  ['anchor', 'CL-3', 'The Merkle inclusion proof and two RFC 3161 timestamp tokens.'],
  ['audience', 'CL-4', 'The one organisation the receipt is addressed to.'],
  ['nonce', 'CL-4', 'Used once; a second presentation is refused.'],
  ['expires_at', 'CL-4', 'RFC 3339 UTC; after it the receipt is refused.'],
  ['disclosure_suite', 'CL-D', 'How fields are disclosed selectively: elan1-sd-v1.'],
  ['disclosures', 'CL-D', 'The salted fields the recipient was given.'],
];

const ERRATA = [
  { id: 'E-2026-03', date: '2026-10-27', section: 'Appendix B', text: 'The printed expected digest for TV-41 had two bytes transposed. The vectors file was right; no implementation changes.' },
  { id: 'E-2026-02', date: '2026-10-05', section: '§6.3 expires_at', text: 'expires_at is RFC 3339 in UTC with a trailing Z. An offset (+05:30) is not allowed; a receipt that carries one does not verify.' },
  { id: 'E-2026-01', date: '2026-09-14', section: '§4.2 Preimage', text: 'The length prefix is 4 octets big-endian, as both implementations always did; the text said little-endian.' },
];

const LISTED = [
  { name: 'Elan1 Govern (TypeScript, hosted and Sovereign)', role: 'Producer and verifier', level: 'CL-D', tested: '2026-10-27', vectors: '64 of 64' },
  { name: 'elan1-govern (Python)', role: 'Verifier — the second implementation', level: 'CL-D', tested: '2026-10-27', vectors: '64 of 64' },
];

export function Standard() {
  const [email, setEmail] = useState('');
  const [section, setSection] = useState('§4 The seal');
  const [desc, setDesc] = useState('');
  const [sent, setSent] = useState<{ ref: string; email?: string }>();
  const [tried, setTried] = useState(false);
  const descOk = desc.trim().length >= 20;
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const report = () => {
    setTried(true);
    if (!descOk || !emailOk) return;
    let n = 1;
    try { n = Number(localStorage.getItem('eg:dr-count') ?? '0') + 1; localStorage.setItem('eg:dr-count', String(n)); } catch { /* storage unavailable */ }
    const ref = `DR-2026-${String(41 + n).padStart(3, '0')}`;
    if (email.trim()) pushMail({ channel: 'email', to: email.trim(), subject: `Defect report ${ref} received`, body: `We have your report on ${section}: “${desc.trim().slice(0, 140)}${desc.trim().length > 140 ? '…' : ''}”. An editor acknowledges it within 5 working days and the decision is published with reasons.` });
    setSent({ ref, email: email.trim() || undefined });
    setDesc(''); setTried(false);
  };
  return (
    <>
      <DocTitle kicker="Between organisations" title="The Action Receipt standard" lead="An open format for the receipt one organisation hands another for a write it made: what it contains, how it is graded, who may change it, and under what licence you may use it." />
      <H2 id="members">Members</H2>
      <SimpleTable caption="Action Receipt members" head={['Member', 'Present', 'Means']} rows={MEMBERS.map(([m, when, what]) => [<C key={m}>{m}</C>, when, what])} />
      <H3 id="suites">Suite registry</H3>
      <SimpleTable caption="Registered suites" head={['Suite', 'For', 'Status']} rows={[
        [<C key="1">elan1-seal-v6</C>, 'Sealing: 16 frozen fields, length-prefixed preimage, SHA-256, Ed25519', 'Registered'],
        [<C key="2">rfc3161-6962</C>, 'Anchoring: RFC 6962 Merkle batches, two RFC 3161 timestamp authorities', 'Registered'],
        [<C key="3">elan1-sd-v1</C>, 'Selective disclosure, in the style of SD-JWT (RFC 9901)', 'Registered'],
      ]} />
      <P>Levels are described on the <DocLink to="/developers/conformance#levels">conformance</DocLink> page.</P>

      <H2 id="licences">Licences</H2>
      <SimpleTable caption="Licences" head={['Part', 'Licence', 'What you may do']} rows={[
        ['The specification text', 'CC BY 4.0', 'Copy, adapt and republish it, commercially too, with attribution.'],
        ['The reference verifier (govern verify)', 'Apache-2.0', 'Use, modify and ship it, with the licence and notices; includes a patent licence.'],
        ['Test vectors and sample bundles', 'CC0 1.0', 'Anything. No attribution needed.'],
      ]} />
      <Note tone="neutral">The licences are what let a second implementation exist without asking us. That is the point: a receipt has to be checkable by someone who does not use our software.</Note>

      <H2 id="governance">Governance</H2>
      <UL>
        <li><strong>Editors</strong> — two editors maintain the text; at least one is from outside elan1 once a second producer is listed. Every decision is published with its reasons.</li>
        <li><strong>Versions</strong> — <C>action-receipt/MAJOR</C>. A minor change never makes a valid receipt invalid; a major change is announced 12 months ahead and both versions are verified until then.</li>
        <li><strong>Changes</strong> — proposal, draft, <strong>60 days of public comment</strong>, decision. New suites enter the registry the same way.</li>
        <li><strong>Defects</strong> — anyone can report one, with no account. An editor acknowledges it within <strong>5 working days</strong>.</li>
      </UL>

      <H2 id="errata">Errata</H2>
      <SimpleTable caption="Errata" head={['Erratum', 'Date', 'Section', 'Correction']} rows={ERRATA.map((e) => [<span key={e.id} className="font-mono">{e.id}</span>, e.date, e.section, e.text])} />

      <H2 id="certification">Certification</H2>
      <P>An implementation is listed at a conformance level when it passes, for that level, all 64 test vectors (including the 28 meant to fail) and the tampered bundle, and sends the result file. Certification here is a published test record — which tests passed, on which date, with which version — and nothing more. It is re-run for every minor version; a listing that is not re-run within 30 days of a new version is marked out of date.</P>
      <SimpleTable caption="Listed implementations" head={['Implementation', 'Role', 'Level', 'Last tested', 'Vectors']} rows={LISTED.map((l) => [l.name, l.role, <span key="l" className="font-mono">{l.level}</span>, l.tested, l.vectors])} />
      <P>To be listed, run the vectors from the <DocLink to="/developers/verifier-release">verifier release</DocLink> and send the result file with a defect report marked “listing”.</P>

      <H2 id="defects">Report a defect</H2>
      {sent && <Banner tone="ok" className="mb-4" title={`Report ${sent.ref} received`}>An editor acknowledges it within 5 working days.{sent.email ? ` A copy was sent to ${sent.email}.` : ' You did not leave an email, so check this page’s errata for the decision.'}</Banner>}
      <div className="grid gap-4 sm:grid-cols-2 max-w-[72ch]">
        <Field label="Section" htmlFor="dr-section">
          <Select id="dr-section" value={section} onChange={(e) => setSection(e.target.value)}>
            {['§2 Members', '§4 The seal', '§5 Anchoring', '§6 Addressing', '§7 Disclosure', 'Appendix B Test vectors', 'Listing request'].map((s) => <option key={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="Email (optional)" htmlFor="dr-email" hint="Only to send you the acknowledgement." error={tried && !emailOk ? 'Enter a valid email or leave it empty.' : undefined}>
          <Input id="dr-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" invalid={tried && !emailOk} />
        </Field>
        <Field label="What is wrong" htmlFor="dr-desc" required className="sm:col-span-2" error={tried && !descOk ? 'Describe the defect in 20 characters or more.' : undefined}>
          <Textarea id="dr-desc" rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Quote the text, say what you expected and what an implementation does." invalid={tried && !descOk} />
        </Field>
      </div>
      <Button className="mt-4" variant="primary" icon={<FileCheck2 className="h-4 w-4" />} onClick={report}>Send the report</Button>
    </>
  );
}

/* ── Path to production ───────────────────────────────────── */

export function PathToProduction() {
  return (
    <>
      <DocTitle kicker="Get started" title="Path to production" lead="From a sandbox key to a production key in five steps. The sandbox is self-serve; a production key is never self-serve — a person reviews it." />
      <OL>
        <li><strong>Sandbox tenant</strong> — apply with a work email, the company and one line on what the agent will do. Follow the verification link; the tenant is created with fixtures, and its <C>sk_sbx_</C> key is shown once.</li>
        <li><strong>Prove the three answers</strong> — in the sandbox, make a call that is allowed, one that is refused, and one that is held and then decided by a real person in your organisation.</li>
        <li><strong>Conformance</strong> — run C1–C14 against your agent’s sandbox receipts. Every test passes; keep the result file.</li>
        <li><strong>Ask for a production key</strong> — attach the result file and name the declaration version, the target system, the residency domain, a production owner, the mode, and a reversal plan or an irreversible flag.</li>
        <li><strong>Review</strong> — a person checks four things and decides within {REVIEW_TARGET_DAYS} working days. Approved, you collect the <C>gk_</C> key once.</li>
      </OL>
      <div className="my-5 flex flex-wrap gap-2">
        <Link to="/agents/production?tab=sandbox" className="inline-flex h-9 items-center gap-2 border border-fg bg-fg px-3 text-sm font-medium text-canvas hover:opacity-90">Open Path to production in the console</Link>
        <Link to="/developers/conformance" className="inline-flex h-9 items-center border border-line-strong px-3 text-sm font-medium hover:border-fg">Run the suite on a sample</Link>
      </div>

      <H2 id="sandbox">The sandbox</H2>
      <SimpleTable caption="Sandbox limits" head={['', '']} rows={[
        ['Key', <span key="k"><C>sk_sbx_…</C>, self-serve, shown once</span>],
        ['Writes', `${SANDBOX_LIMITS.perMinute} a minute, ${SANDBOX_LIMITS.concurrent} at once. A call over either limit is refused with GATE.SANDBOX_LIMIT_REACHED and recorded`],
        ['Month', `${SANDBOX_LIMITS.perMonth.toLocaleString('en-IN')} calls, then a hard stop (GATE.SANDBOX_LIMIT_REACHED, recorded like the others)`],
        ['Receipts', 'Marked sandbox inside the receipt body, so the mark is sealed in the hash chain with the rest of the record (and signed from L2); shown with a Sandbox chip'],
        ['Meter', 'Metered at 0. Sandbox calls never appear on an invoice'],
        ['Fixtures', '3 vendors, 5 bills, a customer over its credit limit, and an approver group of your owners'],
      ]} />

      <H2 id="production-key">The production-key request</H2>
      <P>Owners and admins ask, from the console or from the agent’s Keys tab. The request is recorded as a receipt and goes to review; there is no button that issues a <C>gk_</C> key directly.</P>
      <H3 id="four-checks">What the reviewer checks</H3>
      <OL>{REVIEW_CHECKS.map((c) => <li key={c.id}>{c.label}.</li>)}</OL>
      <P>Target: a decision within {REVIEW_TARGET_DAYS} working days. A decline says why, in a sentence you can act on. On a hosted organisation a production reviewer at Elan1 decides; the decision is recorded on your chain under the name of the person who made it. On a Sovereign installation the review is yours: an owner or admin other than the requester decides. Nobody reviews their own request.</P>

      <H2 id="promotion">Promotion: advisory to enforced</H2>
      <P>An agent that uses check and record is advisory: Elan1 Govern answers and records, and your code runs the call. To move it to a governed run, where Elan1 Govern holds the credentials and an agent that skips the check is stopped, ask for a promotion. It needs:</P>
      <UL>
        <li>at least <strong>{PROMOTION_MIN_DAYS} days</strong> of advisory traffic on the chain, counted from the agent’s first check-and-record decision (not from when the agent was added), with decisions still arriving in the last 7 days;</li>
        <li>a connector for Elan1 Govern to run the calls through;</li>
        <li>a <strong>bypass proof</strong> — evidence that every other path to the target fails:</li>
      </UL>
      <OL>{BYPASS_PATHS.map((b) => <li key={b.id}>{b.label}.</li>)}</OL>
      <P>Approved, the agent’s route changes to a governed run, recorded as a receipt. Until then, describe it as advisory: “every attempt is evaluated and recorded, including the ones we refused”.</P>

      <H2 id="who-we-refuse">Who we do not onboard</H2>
      <P>We onboard: {ELIGIBLE_LABEL.toLowerCase()}. Applicants in these {APPLICANT_REFUSALS.length} categories are refused, at set-up and at the sandbox application, with the sentence shown here. Each refusal is recorded.</P>
      <SimpleTable caption="Applicant categories we refuse" head={['Applicant', 'What we say']} rows={APPLICANT_REFUSALS.map((r) => [<span key={r.id} className="whitespace-normal">{r.label}</span>, <span key="s">{r.sentence}{r.instead && <span className="block mt-1 text-muted">Instead: {r.instead}</span>}</span>])} />
    </>
  );
}
