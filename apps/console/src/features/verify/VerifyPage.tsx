import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Building2, Download, FileArchive, FileJson, FlaskConical, Handshake, Lock, Receipt as ReceiptIcon, ShieldCheck, Upload, X } from 'lucide-react';
import type { LevelId, VerifyCode } from '@/types';
import { LEVEL_INFO } from '@/lib/levels';
import { bundleFromFile } from '@/lib/disclosure';
import { n } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, Banner, Button, EmptyState, Field, Input, Kbd, Meter, Panel, Select, Tabs, Textarea, toast } from '@/components/ui';
import { PublicChrome } from './PublicChrome';
import {
  PROFILE_OPTIONS, SAMPLE_ORGS, buildSample, bundleToZip, bytesLabel, cancelVerify, downloadBlob, downloadJson, isPublicKeyHex, normaliseFingerprint,
  orgName, parseFile, parseText, publishedFingerprint, runVerify, type Loaded6, type Result6, type SampleId,
} from './bundle';
import { ChecksPanel, CodeBadge, ReportPanel, ResultHero, RevealedPanel } from './ResultView';
import { ReceiptTable } from './ReceiptTable';
import { OfflinePanel, ProvesPanel } from './Explainers';

type InputTab = 'file' | 'paste';
type Phase = 'idle' | 'running' | 'done';

const KIND_LABEL: Record<Loaded6['kind'], string> = { bundle: 'Bundle or pack', receipt: 'Single receipt', disclosure: 'Disclosure package', cross: 'Receipt from another organisation', disclosure_bundle: 'Disclosure bundle over a range' };

/**
 * /verify — the public, in-browser verifier. No sign-in, no network: L1 auditor packs, L2+ evidence bundles
 * (ZIP or JSON), single receipts, selective-disclosure packages and receipts from other organisations are
 * read and checked in this tab. Six result codes; a nine-section report.
 */
export default function VerifyPage() {
  const [params] = useSearchParams();
  const wantsShared = params.get('input') === 'disclosure';
  const [tab, setTab] = useState<InputTab>(wantsShared ? 'paste' : 'file');
  const [loaded, setLoaded] = useState<Loaded6>();
  const [loadError, setLoadError] = useState<string>();
  const [busySample, setBusySample] = useState<SampleId>();
  const [paste, setPaste] = useState('');
  const [fpText, setFpText] = useState('');
  const [pkText, setPkText] = useState('');
  const [profileId, setProfileId] = useState('claimed');
  const [audience, setAudience] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [started, setStarted] = useState(0);
  const [, tick] = useState(0);
  const [result, setResult] = useState<Result6>();
  const [runError, setRunError] = useState<string>();
  const [stale, setStale] = useState(false);
  const [focus, setFocus] = useState<{ seq: number; nonce: number }>();
  const [dragOver, setDragOver] = useState(false);
  const runId = useRef(0);
  const verdictRef = useRef<HTMLHeadingElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { document.title = 'Verify · Elan1 Govern'; }, []);
  // ?input=disclosure selects the Paste tab, also when the link is followed while already on /verify
  useEffect(() => { if (wantsShared) setTab('paste'); }, [wantsShared]);
  useEffect(() => () => cancelVerify(), []);
  useEffect(() => {
    if (phase !== 'running') return;
    const t = window.setInterval(() => tick((x) => x + 1), 250);
    return () => window.clearInterval(t);
  }, [phase]);

  const fp = normaliseFingerprint(fpText);
  const pkInvalid = pkText.trim() !== '' && !isPublicKeyHex(pkText);
  const needsKey = (loaded?.kind === 'receipt' || loaded?.kind === 'bundle') && !!loaded.bundle && Array.isArray(loaded.bundle.receipts) && !Object.keys(loaded.bundle.public_keys ?? {}).length;
  const isBundle = loaded?.kind === 'bundle';
  const shared = loaded?.kind === 'disclosure' || loaded?.kind === 'cross';

  const run = useCallback(async (l: Loaded6 | undefined) => {
    if (!l) return;
    if (fp.error) { toast.bad('Check the fingerprint', fp.error); return; }
    const id = ++runId.current;
    setPhase('running');
    setStarted(performance.now());
    setRunError(undefined);
    window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
    try {
      const r = await runVerify(l, { fingerprint: fp.value, publicKey: pkText, profileId, audience });
      if (id !== runId.current) return;
      setResult(r);
      setStale(false);
      setPhase('done');
      const brokenAt = r.chain?.brokenAt;
      if (r.exitCode === 0) toast.ok(r.code, r.headline);
      else if (r.code === 'FAIL_INTEGRITY' || r.code === 'FAIL_PROFILE') toast.bad(r.code, r.headline);
      else toast.info(r.code, r.headline);
      window.setTimeout(() => {
        verdictRef.current?.focus({ preventScroll: true });
        if (brokenAt !== undefined) setFocus({ seq: brokenAt, nonce: Date.now() });
      }, 40);
    } catch (e) {
      if (id !== runId.current) return;
      setRunError((e as Error).message || 'The check stopped unexpectedly.');
      setPhase(result ? 'done' : 'idle');
    }
  }, [fp.value, fp.error, pkText, profileId, audience, result]);

  const cancel = () => {
    runId.current++;
    cancelVerify();
    setPhase(result && !stale ? 'done' : 'idle');
    toast.info('Check cancelled', 'Nothing was decided. Run it again when you are ready.');
  };

  const accept = (l: Loaded6, autorun: boolean) => {
    runId.current++;
    cancelVerify();
    setLoaded(l);
    setLoadError(undefined);
    setResult(undefined);
    setPhase('idle');
    setFocus(undefined);
    if (l.tamper?.expect === 'FAIL_PROFILE') setProfileId('claimed');
    if (autorun) window.setTimeout(() => void runRef.current(l), 0);
  };
  const runRef = useRef(run);
  runRef.current = run;

  const loadSample = (id: SampleId) => {
    setBusySample(id);
    window.setTimeout(() => {
      buildSample(id).then((l) => accept(l, true)).catch((e: Error) => setLoadError(e.message)).finally(() => setBusySample(undefined));
    }, 40);
  };

  const readFile = async (file: File) => {
    if (file.size > 80 * 1024 * 1024) { setLoadError(`${file.name} is ${bytesLabel(file.size)}. Bundles over 80 MB are better checked with the command-line verifier.`); return; }
    try {
      accept(await parseFile(file), true);
    } catch (e) {
      setLoaded(undefined);
      setResult(undefined);
      setLoadError(`${file.name}: ${(e as Error).message}`);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void readFile(f);
  };

  const readPaste = () => {
    try {
      const l = parseText(paste, 'paste', 'Pasted JSON');
      accept(l, l.kind !== 'receipt' || !!pkText || Object.keys(l.bundle?.public_keys ?? {}).length > 0);
    } catch (e) {
      setLoaded(undefined);
      setResult(undefined);
      setLoadError((e as Error).message);
    }
  };

  const clear = () => {
    runId.current++;
    cancelVerify();
    setLoaded(undefined); setResult(undefined); setLoadError(undefined); setPhase('idle'); setPaste(''); setFocus(undefined);
  };

  const onKeyRun = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (tab === 'paste' && paste.trim() && (!loaded || loaded.origin === 'paste')) readPaste(); else void run(loaded); }
  };
  const markStale = () => { if (result) setStale(true); };

  const b = loaded?.bundle;
  const receiptCount = Array.isArray(b?.receipts) ? b!.receipts.length : 0;
  const sealCount = b?.seals?.length ?? 0;
  const estimate = Math.max(800, receiptCount * 5 + sealCount * 5);
  const elapsed = phase === 'running' ? performance.now() - started : 0;
  const levels: LevelId[] = (b?.manifest?.assurance_levels ?? []).map((x) => x.level);
  const resultLevels: LevelId[] = result?.raw?.levels.map((x) => x.level) ?? levels;

  return (
    <PublicChrome>
      <div className="mx-auto max-w-[1280px] px-4 py-8 lg:px-8 lg:py-12" onKeyDown={onKeyRun}>
        <header className="max-w-[900px]">
          <p className="label text-accent-fg">Public verifier · no account needed</p>
          <h1 className="mt-2 text-4xl sm:text-5xl font-bold tracking-tighter2 leading-[1.05]">Check the evidence yourself</h1>
          <p className="mt-4 flex items-start gap-2 text-lg text-fg">
            <Lock className="mt-1 h-4 w-4 shrink-0 text-muted" aria-hidden />
            <span>Verification runs in this browser. Nothing is sent to Elan1 Govern.</span>
          </p>
          <p className="mt-2 max-w-[76ch] text-md text-muted leading-relaxed">
            Load an L1 auditor pack, an L2 or L3 evidence bundle (the ZIP or its JSON), one receipt, a disclosure package or a receipt another organisation sent you. The page recomputes every hash and Seal v6 digest, checks every Ed25519 seal and signature, walks the previous-hash links, rebuilds each Merkle root, checks both timestamp tokens and, if you choose one, a regime’s verifier profile — the same checks as <span className="font-mono text-fg text-[13px]">govern verify</span>, with the same six result codes. L1 records are sealed in a hash chain by Elan1 Govern and not yet externally timestamped; from L2 they are also signed and timestamped. A batch timestamped by only one authority is reported as degraded, not failed.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {['SHA-256 over canonical JSON', 'Ed25519 seals and signatures', 'Previous-hash chain', 'Checkpoints', 'Seal v6 · 16 fields', 'Merkle batches (RFC 6962)', 'Timestamps from two authorities (RFC 3161)', 'Selective disclosure (SD-JWT)', 'Receipts between organisations'].map((x) => <Badge key={x}>{x}</Badge>)}
          </div>
        </header>

        {wantsShared && !loaded && (
          <Banner tone="info" className="mt-8 max-w-[900px]" title="Checking something a counterparty shared with you?">
            Paste the disclosure package or receipt they sent, or open the link they gave you — it leads to their counterparty portal. Supply the issuer’s key fingerprint, obtained from them directly, to rule out a substituted key.
          </Banner>
        )}

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-12">
          <Panel className="min-w-0 lg:col-span-7" kicker="Step 1" title="Load the evidence" flush>
            <div className="px-5 pt-1">
              <Tabs<InputTab> label="How to load evidence" className="overflow-y-hidden" value={tab} onChange={setTab} items={[
                { value: 'file', label: <span className="inline-flex items-center gap-1.5"><Upload className="h-3.5 w-3.5" aria-hidden />Drop or choose a file</span> },
                { value: 'paste', label: <span className="inline-flex items-center gap-1.5"><FileJson className="h-3.5 w-3.5" aria-hidden />Paste JSON</span> },
              ]} />
            </div>
            <div className="p-5">
              {tab === 'file' ? (
                <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
                  className={cn('flex flex-col items-center justify-center gap-3 border border-dashed px-6 py-10 text-center transition-colors', dragOver ? 'border-fg bg-sunken' : 'border-line-strong/70 bg-sunken/30')}>
                  <span className="inline-flex h-11 w-11 items-center justify-center border border-line bg-surface"><Upload className="h-5 w-5 text-muted" aria-hidden /></span>
                  <div>
                    <p className="text-md font-medium">Drop a bundle, pack or receipt here</p>
                    <p className="mt-1 text-sm text-muted">bundle.zip, bundle.json, auditor-pack.zip, auditor-pack.json, receipts.jsonl, a disclosure package or one receipt — read in this tab, never uploaded</p>
                  </div>
                  <input ref={fileRef} type="file" accept=".zip,.json,.jsonl,application/json,application/zip" className="sr-only" id="pack-file"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ''; }} />
                  <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>Choose a file</Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <Field label="JSON to check" htmlFor="paste" hint={<>A bundle, a list of receipts, one receipt, a disclosure package or a counterparty receipt. <Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd> checks it.</>}>
                    <Textarea id="paste" value={paste} onChange={(e) => setPaste(e.target.value)} rows={9} spellCheck={false}
                      placeholder={'{\n  "manifest": { "bundle_format": "elan1.evidence.bundle.v1", … },\n  "receipts": [ … ],\n  "seals": [ … ],\n  "anchors": { … }\n}'}
                      className="font-mono text-[12.5px] leading-[1.6]" />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" size="sm" disabled={!paste.trim()} onClick={readPaste}>Read and check</Button>
                    {paste && <Button variant="ghost" size="sm" onClick={() => setPaste('')}>Clear</Button>}
                  </div>
                </div>
              )}

              <div className="mt-6 space-y-4 border-t border-line pt-4">
                <SampleRow title="Each organisation’s evidence, one per level">
                  {SAMPLE_ORGS.map((o) => (
                    <Button key={o.id} size="sm" icon={<Building2 className="h-4 w-4" />} loading={busySample === o.id} disabled={!!busySample || phase === 'running'} onClick={() => loadSample(o.id as SampleId)}>
                      <span className="font-mono text-[11px] text-muted mr-1">{LEVEL_INFO[o.level].tag}</span>{orgShort(o.id)}
                    </Button>
                  ))}
                </SampleRow>
                <SampleRow title="Samples that must not pass">
                  {([['fail-integrity', 'FAIL_INTEGRITY', 'L2'], ['fail-integrity-l1', 'FAIL_INTEGRITY', 'L1 edited'], ['fail-tail-l1', 'FAIL_INTEGRITY', 'L1 tail cut'], ['fail-profile', 'FAIL_PROFILE'], ['incomplete', 'INCOMPLETE'], ['unsupported', 'UNSUPPORTED'], ['usage', 'USAGE']] as [SampleId, VerifyCode, string?][]).map(([id, code, tag]) => (
                    <Button key={id} size="sm" variant="secondary" icon={<FlaskConical className="h-4 w-4" />} loading={busySample === id} disabled={!!busySample || phase === 'running'} onClick={() => loadSample(id)}>
                      {tag && <span className="font-mono text-[11px] text-muted mr-1">{tag}</span>}<span className="font-mono text-[12px]">{code}</span>
                    </Button>
                  ))}
                </SampleRow>
                <SampleRow title="Shared between organisations (L3)">
                  <Button size="sm" variant="secondary" icon={<Handshake className="h-4 w-4" />} loading={busySample === 'disclosure'} disabled={!!busySample || phase === 'running'} onClick={() => loadSample('disclosure')}>Disclosure package</Button>
                  <Button size="sm" variant="secondary" icon={<Handshake className="h-4 w-4" />} loading={busySample === 'cross'} disabled={!!busySample || phase === 'running'} onClick={() => loadSample('cross')}>Counterparty receipt</Button>
                  <Button size="sm" variant="ghost" icon={<ReceiptIcon className="h-4 w-4" />} loading={busySample === 'receipt'} disabled={!!busySample || phase === 'running'} onClick={() => loadSample('receipt')}>One receipt</Button>
                </SampleRow>
                <p className="text-xs text-muted">Building an organisation’s sample opens its chain read-only in this browser and builds the same pack or bundle the console exports. A sample is not an export: no receipt is written to the organisation’s chain — not even the sandbox calls, expiries or hourly checkpoint that opening it in the console would add — and nothing is billed.</p>
              </div>

              {loadError && <Banner tone="bad" title="That could not be read" className="mt-4">{loadError}</Banner>}

              {loaded && (
                <div className="mt-4 border border-line bg-surface">
                  <div className="flex items-start gap-3 px-4 py-3">
                    <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center border border-line bg-sunken">
                      {loaded.tamper ? <FlaskConical className="h-4 w-4 text-muted" aria-hidden /> : loaded.fromZip ? <FileArchive className="h-4 w-4 text-muted" aria-hidden /> : <FileJson className="h-4 w-4 text-muted" aria-hidden />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold break-words">{loaded.label}</p>
                      <p className="mt-0.5 text-xs text-muted num">{describe(loaded)}</p>
                    </div>
                    {isBundle && b && Array.isArray(b.receipts) && (
                      <span className="flex shrink-0 gap-1">
                        <Button size="sm" variant="ghost" icon={<Download className="h-4 w-4" />} onClick={() => downloadJson('bundle.json', b)} title="Save as JSON"><span className="hidden sm:inline">JSON</span></Button>
                        <Button size="sm" variant="ghost" icon={<FileArchive className="h-4 w-4" />} onClick={() => downloadBlob('bundle.zip', bundleToZip(b))} title="Save as a ZIP with its members"><span className="hidden sm:inline">ZIP</span></Button>
                      </span>
                    )}
                    {shared && <Button size="sm" variant="ghost" icon={<Download className="h-4 w-4" />} onClick={() => downloadJson(loaded.kind === 'disclosure' ? 'disclosure.json' : 'action-receipt.json', loaded.disclosure ?? loaded.cross)}><span className="hidden sm:inline">Save</span></Button>}
                    <button type="button" onClick={clear} aria-label="Remove the loaded evidence" className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-muted hover:bg-sunken hover:text-fg"><X className="h-4 w-4" /></button>
                  </div>
                  {loaded.tamper && (
                    <div className="border-t border-line px-4 py-3">
                      <Banner tone="held" title={<span className="inline-flex flex-wrap items-center gap-2">Expected result <CodeBadge code={loaded.tamper.expect} /></span>}>
                        {loaded.tamper.what}{loaded.tamper.seq !== undefined && <> Receipt <span className="font-mono">#{loaded.tamper.seq}</span>: <span className="font-mono text-[12.5px]">{loaded.tamper.field}</span> changed from <strong>{loaded.tamper.from}</strong> to <strong>{loaded.tamper.to}</strong>.</>}
                      </Banner>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Panel>

          <Panel className="min-w-0 lg:col-span-5" kicker="Step 2 · options" title="Pin the key and choose a profile">
            <div className="space-y-4">
              <Field label={shared ? 'Issuer’s key fingerprint' : 'Expected key fingerprint'} htmlFor="fp"
                hint="Use a fingerprint you obtained from the organisation separately — not one printed in the file. Without it the best result is PASS_KEY_FROM_BUNDLE."
                error={fp.error}>
                <Input id="fp" mono value={fpText} placeholder="17f410d32e400e2d" onChange={(e) => { setFpText(e.target.value); markStale(); }} invalid={!!fp.error} autoComplete="off" spellCheck={false} />
              </Field>
              {loaded?.orgId && (
                <button type="button" className="link text-sm text-left" onClick={() => { setFpText(publishedFingerprint(loaded.orgId!)); markStale(); }}>
                  Use the fingerprint {orgName(loaded.orgId)} publishes
                </button>
              )}
              {needsKey && (
                <Field label="Public key (hex)" htmlFor="pk" required={loaded?.kind === 'receipt'}
                  hint="This file carries no key. Paste the organisation’s Ed25519 public key as 64 hex characters." error={pkInvalid ? 'A public key is 64 hex characters.' : undefined}>
                  <Input id="pk" mono value={pkText} onChange={(e) => { setPkText(e.target.value); markStale(); }} invalid={pkInvalid} autoComplete="off" spellCheck={false} placeholder="e.g. 3b6a27bc…" />
                </Field>
              )}
              {(!loaded || isBundle) && (
                <Field label="Verifier profile" htmlFor="profile" hint="Checks the records against a regime’s rules as well as for integrity. A failing rule gives FAIL_PROFILE; integrity failures always come first.">
                  <Select id="profile" value={profileId} onChange={(e) => { setProfileId(e.target.value); markStale(); }}>
                    {PROFILE_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </Select>
                </Field>
              )}
              {shared && (
                <Field label="Your organisation’s domain (optional)" htmlFor="aud" hint="Checks the record was addressed to you, e.g. starhealth.in.">
                  <Input id="aud" value={audience} onChange={(e) => { setAudience(e.target.value); markStale(); }} placeholder="yourcompany.in" autoComplete="off" />
                </Field>
              )}
              <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
                <Button variant="primary" size="lg" icon={<ShieldCheck className="h-4 w-4" />} disabled={!loaded || phase === 'running' || !!fp.error || pkInvalid} onClick={() => void run(loaded)}>
                  {result ? 'Verify again' : 'Verify'}
                </Button>
                <span className="text-xs text-muted">{loaded ? <>or press <Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd></> : 'Load evidence first.'}</span>
              </div>
              {stale && phase === 'done' && <Banner tone="neutral">The options changed since the last check. Verify again to apply them.</Banner>}
            </div>
          </Panel>
        </div>

        <div ref={resultRef} className="mt-10 scroll-mt-20" aria-live="polite">
          {runError && <Banner tone="bad" title="The check could not finish" className="mb-6">{runError}</Banner>}
          {phase === 'running' && (
            <section className="border border-line border-l-[6px] border-l-fg bg-surface p-6 sm:p-8" aria-busy="true">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="label">Checking in this browser</p>
                  <p className="mt-1 font-display text-2xl sm:text-3xl font-semibold tracking-tighter2">
                    {loaded?.kind === 'disclosure' || loaded?.kind === 'disclosure_bundle' ? 'Checking the issuer signature and each revealed field' : loaded?.kind === 'cross' ? 'Checking the issuer’s signature and hash' : `Checking ${n(receiptCount)} receipt${receiptCount === 1 ? '' : 's'}${sealCount ? `, ${n(sealCount)} seals and their timestamps` : ''}`}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
              </div>
              <Meter value={Math.min(0.95, elapsed / estimate)} className="mt-5 h-2" label="Verification progress" />
              <p className="mt-2 text-sm text-muted num">{(elapsed / 1000).toFixed(1)} s · recomputing hashes and digests, checking seals and signatures, rebuilding Merkle roots — off the main thread, so the page stays usable</p>
            </section>
          )}
          {phase === 'idle' && !runError && (
            <div className="border border-line bg-surface">
              <EmptyState disc="registration" title="Nothing checked yet">
                Load a file, paste JSON, or try a sample. The samples that must not pass show each failure code with exactly what was changed.
              </EmptyState>
            </div>
          )}
          {phase === 'done' && result && loaded && (
            <div className="space-y-6">
              <ResultHero ref={verdictRef} r={result} label={loaded.label} brokenAt={result.chain?.brokenAt} onJump={(seq) => setFocus({ seq, nonce: Date.now() })} expect={loaded.tamper?.expect} />
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                <div className="min-w-0 lg:col-span-7"><ReportPanel r={result} /></div>
                <div className="min-w-0 lg:col-span-5 space-y-6">
                  <ChecksPanel checks={result.checks} title={result.kind === 'bundle' || result.kind === 'receipt' ? 'The verifier’s 9 checks' : `${result.checks.length} checks`} />
                  <RevealedPanel r={result} />
                </div>
              </div>
              {result.chain && b && Array.isArray(b.receipts) && result.chain.checks.length > 0 && (
                <ReceiptTable checks={result.chain.checks} receipts={b.receipts} publicKeys={b.public_keys ?? {}} checkpoints={b.checkpoints ?? []}
                  levels={result.raw?.levels ?? []} brokenAt={result.chain.brokenAt} focus={focus} orgId={loaded.orgId} />
              )}
            </div>
          )}
        </div>

        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-7"><ProvesPanel levels={Array.from(new Set(resultLevels))} /></div>
          <div className="min-w-0 lg:col-span-5"><OfflinePanel result={phase === 'done' ? result : undefined} label={loaded?.label} /></div>
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6 text-sm text-muted">
          <p className="max-w-[72ch]">How receipts, Seal v6, the evidence bundle and the six result codes are built is documented for developers and auditors.</p>
          <span className="flex flex-wrap gap-4">
            <Link to="/developers/receipts" className="link inline-flex items-center gap-1">Receipts <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
            <Link to="/developers/seal" className="link inline-flex items-center gap-1">Seal v6 and the bundle <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
            <Link to="/status" className="link inline-flex items-center gap-1">Chain integrity status <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
          </span>
        </div>
      </div>
    </PublicChrome>
  );
}

function SampleRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="label mb-2">{title}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

const orgShort = (id: string) => ({ org_demo: 'Demo Traders', org_northbank: 'Northbank', org_kaveri: 'Kaveri Health', org_deccan: 'Deccan Bank' } as Record<string, string>)[id] ?? id;

function describe(l: Loaded6) {
  const parts: string[] = [KIND_LABEL[l.kind]];
  const b = l.bundle;
  if ((l.kind === 'bundle' || l.kind === 'receipt') && b && Array.isArray(b.receipts)) {
    const m = b.manifest ?? {};
    if (m.bundle_format) parts.push(String(m.bundle_format));
    else if (m.format) parts.push(String(m.format));
    parts.push(`${n(b.receipts.length)} receipt${b.receipts.length === 1 ? '' : 's'}`);
    if (b.seals) parts.push(`${n(b.seals.length)} seals`);
    if (b.anchors?.batches) parts.push(`${n(b.anchors.batches.length)} batches`);
    parts.push(`${n(Object.keys(b.public_keys ?? {}).length)} keys`);
    if (m.assurance_levels?.length) parts.push(m.assurance_levels.map((x) => `${LEVEL_INFO[x.level].tag} ${x.count}`).join(' + '));
  }
  if (l.kind === 'disclosure' && l.disclosure) parts.push(`receipt #${l.disclosure.seq}`, `${l.disclosure.revealed.length} of ${l.disclosure.committed.length} fields revealed`);
  if (l.kind === 'cross' && l.cross) parts.push(`from ${l.cross.issuerName}`, `receipt #${l.cross.seq}`);
  if (l.kind === 'disclosure_bundle') { const db = bundleFromFile(l.disclosureBundle); if (db) parts.push(`from ${db.issuerName}`, `${n(db.items.length)} receipts, #${db.range.fromSeq}–#${db.range.toSeq}`, `${db.fields.length} fields revealed`); }
  if (l.fromZip) parts.push('from a ZIP');
  parts.push(bytesLabel(l.bytes));
  return parts.join(' · ');
}
