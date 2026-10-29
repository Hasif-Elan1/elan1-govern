import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, CheckCircle2, CircleSlash, Download, FileArchive, FileJson, IndianRupee, OctagonX, ShieldCheck, Stamp, TriangleAlert } from 'lucide-react';
import { api, db } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import { atLeast, LEVEL_INFO, levelAt } from '@/lib/levels';
import { PROFILES, profileById } from '@/lib/profiles';
import { fileDigest, l1PackFiles, memberDigest, BUNDLE_MEMBERS, LEXICON_MEMBER, L1_PACK_MEMBERS, type EvidenceBundle, type VerifyBundleResult } from '@/lib/verify6';
import { DISCLOSABLE_FIELDS } from '@/lib/disclosure';
import { n, plural, rupees, seqLabel } from '@/lib/format';
import { ORGS } from '@/mock/users';
import { ENFORCEMENT_LABEL, enforcementOf, missingDeclarations, personalDataCount } from '@/mock/evidence';
import type { LevelId, SectionState } from '@/types';
import { Banner, Button, Dialog, Field, Hash, Input, LegalDraft, RadioCards, Select, Spinner, StatusChip, toast } from '@/components/ui';
import { D } from '@/features/activity/shared';
import { bundleToZip, downloadBlob, verifyBundleOffThread } from '@/features/verify/bundle';
import { CLAIM, levelStartMs } from './levelGate';
import { rememberExportSeq } from './exportSeqs';
import { GuardsPanel, PreflightResult, firstBreak, gateBlocks, planParts, type GateState, type RangeProblem } from './ExportGuards';
import { integrityCoverage, integrityProblem } from '@/mock/evidenceGuards';
import { onDemandAnchorBatches } from '@/mock/platform';
import { runIntegrityCheck } from './IntegrityRuns';
import { useMemberRole } from '@/features/settings/permissions';
import { cn } from '@/lib/cn';
import { PlanUpsell } from '@/shell/access';

type RangeMode = 'all' | '7d' | 'custom';
type Container = 'zip' | 'json';
type Member = { path: string; what: string; bytes?: number; sha256?: string };
type DonePart = { filename: string; from: number; to: number; receipts: number; digest: string; fileSha: string; seq?: number; sizeKb: number; bundle: EvidenceBundle };
type Done = {
  parts: DonePart[]; refusals: number; unanchored: number; seals: number; profile?: { id: string; version: string };
  addressedSeq?: number; recipient?: string; members: Member[]; format: string; fingerprint: string; level: LevelId; container: Container; charge: number; enforcement: string;
};

/** Price of one L2+ evidence bundle; the L1 auditor pack is free. */
export const BUNDLE_CHARGE = 2500;

function levelForSlug(slug: string): LevelId {
  const o = ORGS.find((x) => x.slug === slug);
  return o ? api.levelOf(o.id) : 'l1';
}

/** File name for an export: an evidence bundle from L2, an auditor pack at L1; a ZIP unless JSON was chosen. */
export function packFilename(slug: string, first?: number, last?: number, level?: LevelId, ext: 'json' | 'zip' = 'json', part?: { index: number; of: number }) {
  const lv = level ?? levelForSlug(slug);
  return `${atLeast(lv, 'l2') ? 'evidence-bundle' : 'auditor-pack'}-${slug}-${first ?? 0}-${last ?? 0}${part && part.of > 1 ? `-part${part.index}of${part.of}` : ''}.${ext}`;
}

// L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
const L1_WHAT: Record<(typeof L1_PACK_MEMBERS)[number], string> = {
  'manifest.json': 'Range, counts, the last hash, the enforcement mode and the SHA-256 of every file’s bytes (sha256sum gives the same); sealed',
  'keys.json': 'Every public key, retired ones included',
  'receipts.jsonl': 'The receipts in range',
  'checkpoints.json': 'Sealed chain heads in range',
  'summary.pdf': 'A summary to read and file: the claim, counts, enforcement mode, compliance map and how to verify',
  'compliance-map.json': 'Frameworks and requirements, with the receipts in this pack that evidence them',
  'README.txt': 'What each file is and how to verify it offline',
};

async function sha256OfBlob(b: Blob) {
  const buf = await crypto.subtle.digest('SHA-256', await b.arrayBuffer());
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function SectionChip({ state }: { state: SectionState }) {
  if (state === 'pass') return <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Pass</StatusChip>;
  if (state === 'fail') return <StatusChip tone="bad" size="sm" icon={<OctagonX className="h-3 w-3" aria-hidden />}>Fail</StatusChip>;
  if (state === 'warn') return <StatusChip tone="held" size="sm" icon={<TriangleAlert className="h-3 w-3" aria-hidden />}>Note</StatusChip>;
  if (state === 'incomplete') return <StatusChip tone="held" size="sm" icon={<TriangleAlert className="h-3 w-3" aria-hidden />}>Incomplete</StatusChip>;
  return <StatusChip tone="neutral" size="sm" icon={<CircleSlash className="h-3 w-3" aria-hidden />}>Not applicable</StatusChip>;
}

/**
 * Export evidence: choose a range, a verifier profile (L2+), a recipient and the file type (ZIP or JSON), see the
 * guards and the charge, verify it yourself first, then generate and download. L1 writes the auditor pack
 * (auditor-pack/1, free); from L2 the 8-member evidence bundle (₹2,500 each). Every export is written to the chain.
 */
/** What a finished export hands back to the screen that opened the dialog (Settings › Organisation, a pack pilot). */
export interface ExportedSummary { exportId: string; seq?: number; receipts: number; firstSeq: number; lastSeq: number; parts: number; charge: number; filenames: string[]; exportIds?: string[]; jsons?: string[] }

export function ExportPackDialog({ open, onClose, initialProfile, initialFrom, initialTo, title, note, onExported, requireVerify }: {
  /** the file must pass "Verify it yourself first" before it can be generated (an evidence request, the first close-out bundle) */
  requireVerify?: boolean;
  open: boolean; onClose: () => void; initialProfile?: string;
  /** opens on the sequence range (for example the range typed in Activity's export dialog) */
  initialFrom?: number; initialTo?: number;
  /** a title for the screen that opened it (for example the final export when an organisation closes) */
  title?: string;
  /** a line of context shown above the range (for example how many receipts match Activity's filters) */
  note?: ReactNode;
  /** called once the files are generated, downloaded and recorded */
  onExported?: (r: ExportedSummary) => void;
}) {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const level = useOrgLevel();
  const l2 = atLeast(level, 'l2');
  const l3 = atLeast(level, 'l3');
  const canExport = useCan('evidence.export');
  const canCheckpoint = useCan('evidence.checkpoint');
  const memberRole = useMemberRole();
  /** An integrity run recorded on the chain (the kind that clears an export) is started by an owner or an admin. */
  const canRunRecorded = memberRole === 'owner' || memberRole === 'admin';
  const [mode, setMode] = useState<RangeMode>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [profileId, setProfileId] = useState('none');
  const [recipient, setRecipient] = useState('none');
  const [recipientName, setRecipientName] = useState('');
  const [container, setContainer] = useState<Container>('zip');
  const [gate, setGate] = useState<GateState>({ residency: 'inside', transferBasis: '', purpose: '', acknowledged: false });
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [cpPending, setCpPending] = useState(false);
  const [done, setDone] = useState<Done>();
  const [check, setCheck] = useState<{ running: boolean; result?: VerifyBundleResult; error?: string }>();
  const [pre, setPre] = useState<{ key: string; running: boolean; results?: { label: string; result: VerifyBundleResult; from: number; to: number }[]; error?: string }>();
  const [checking, setChecking] = useState(false);
  /**
   * "Everything" and "Last 7 days" end at the head of the chain when the dialog opened, or when the integrity check
   * was last run from here: that pinned head is what is checked, verified first and exported. Records written after
   * it belong to the next export, so live traffic never moves the range away from a run that has just covered it.
   */
  const [pinTo, setPinTo] = useState<number>();
  /** Run the integrity check over the window now; the export can go once it passes. */
  const runCheck = async () => {
    if (!user) return;
    setChecking(true);
    try {
      const r = await runIntegrityCheck(orgId, user.id);
      // the export now ends at the head this run checked
      if (r.result === 'pass') setPinTo(r.toSeq);
      setTick((x) => x + 1);
      if (r.result === 'pass') toast.ok('Integrity check passed', `${seqLabel(r.fromSeq)}–${seqLabel(r.toSeq)} checked. Recorded as ${r.seq !== undefined ? seqLabel(r.seq) : 'a receipt'}; the export can go, up to ${seqLabel(r.toSeq)}.`);
      else toast.bad('Integrity check failed', `${r.reason ?? 'The chain does not verify'}${r.brokenAt !== undefined ? ` (at ${seqLabel(r.brokenAt)})` : ''}. The export stays blocked.`);
    } catch (e) { toast.bad('The check could not run', (e as Error).message); } finally { setChecking(false); }
  };

  const anchors = useQuery((o) => (open && l2 ? api.anchors(o, 100000) : Promise.resolve(undefined)), [open, l2, tick], { live: false });
  const cps = useQuery((o) => (open && l3 ? api.counterparties(o) : Promise.resolve(undefined)), [open, l3], { live: false });
  const custody = useQuery((o) => (open && l2 ? api.custody(o) : Promise.resolve(undefined)), [open, l2], { live: false });
  // which profiles this organisation may claim: ordered, issued and not withdrawn (the same entitlement the server checks)
  const ents = useQuery((o) => (open && l2 ? api.profiles(o) : Promise.resolve(undefined)), [open, l2], { live: false });
  const claimBlock = (id: string): string | undefined => {
    const e = ents.data?.find((x) => x.id === id)?.entitlement;
    return !e || e.canClaim ? undefined : e.withdrawn ? 'withdrawn' : e.issued === false ? 'not issued' : !e.ordered ? 'not ordered' : 'not claimable';
  };

  const d = db.getDB(orgId);
  const firstSeq = d.receipts[0]?.seq ?? 0;
  const headSeq = d.receipts[d.receipts.length - 1]?.seq ?? 0;

  useEffect(() => {
    if (!open) return;
    const ranged = initialFrom !== undefined || initialTo !== undefined;
    setMode(ranged ? 'custom' : 'all'); setDone(undefined); setCheck(undefined); setPre(undefined); setRecipient('none'); setRecipientName(''); setContainer('zip');
    setGate({ residency: 'inside', transferBasis: '', purpose: '', acknowledged: false });
    setProfileId(initialProfile && profileById(initialProfile) ? initialProfile : 'none');
    setFrom(String(initialFrom ?? firstSeq)); setTo(String(initialTo ?? headSeq));
    setPinTo(headSeq || undefined);
  }, [open, orgId, initialProfile, initialFrom, initialTo]);

  const range = useMemo(() => {
    // pinned to the head when the dialog opened (or the last integrity run from here): the range checked is the range exported
    if (mode === 'all') return { f: undefined as number | undefined, t: pinTo, error: undefined as string | undefined };
    if (mode === '7d') {
      const since = Date.now() - 7 * D;
      const f = d.receipts.find((r) => new Date(r.ts).getTime() >= since)?.seq ?? headSeq;
      return { f: pinTo !== undefined ? Math.min(f, pinTo) : f, t: pinTo, error: undefined };
    }
    const f = Number(from.replace(/[#,\s]/g, ''));
    const t = Number(to.replace(/[#,\s]/g, ''));
    if (!f || !t) return { f: undefined, t: undefined, error: 'Enter both sequence numbers.' };
    if (f > t) return { f, t, error: 'The first number must not be after the last.' };
    if (t < firstSeq || f > headSeq) return { f, t, error: `This organisation’s window runs from ${seqLabel(firstSeq)} to ${seqLabel(headSeq)}.` };
    return { f: Math.max(f, firstSeq), t: Math.min(t, headSeq), error: undefined };
  }, [mode, from, to, orgId, headSeq, firstSeq, pinTo]);

  const preview = useMemo(() => {
    if (!open) return undefined;
    const rs = d.receipts.filter((r) => (range.f === undefined || r.seq >= range.f) && (range.t === undefined || r.seq <= range.t));
    const seqs = new Set(rs.map((r) => r.seq));
    const cpsIn = d.checkpoints.filter((c) => seqs.has(c.seq));
    const lastCp = cpsIn.reduce((m, c) => Math.max(m, c.seq), 0);
    const last = rs[rs.length - 1]?.seq ?? 0;
    const sealedFrom = levelStartMs(orgId, 'l2');
    const isSealed = (r: (typeof rs)[number]) => sealedFrom !== undefined && new Date(r.ts).getTime() >= sealedFrom;
    const sealed = rs.filter(isSealed);
    // batches timestamped on demand ("Anchor now") travel in anchors.json too, so their records are not the unanchored tail
    const lastRegular = anchors.data?.totals.lastAnchoredSeq ?? 0;
    const onDemand = l2 ? onDemandAnchorBatches(d).filter((b) => b.lastSeq > lastRegular) : [];
    const lastAnchored = Math.max(lastRegular, ...onDemand.map((b) => b.lastSeq));
    const overlaps = (b: { firstSeq: number; lastSeq: number }) => rs.length > 0 && b.lastSeq >= rs[0].seq && b.firstSeq <= last;
    const batches = anchors.data ? anchors.data.batches.filter(overlaps).length + onDemand.filter(overlaps).length : 0;
    const runs: { level: LevelId; count: number; first: number; last: number }[] = [];
    for (const r of rs) {
      const lv = levelAt(d.org.levelHistory, new Date(r.ts).getTime(), level);
      const cur = runs[runs.length - 1];
      if (cur && cur.level === lv) { cur.count++; cur.last = r.seq; } else runs.push({ level: lv, count: 1, first: r.seq, last: r.seq });
    }
    const rbv = new Set(rs.filter((r) => r.agent && r.rulebook).map((r) => `${r.agent}@${r.rulebook!.version}`)).size;
    // what leaves is the receipts with executed erasures redacted, so the digests are taken over exactly that;
    // L1 digests are over each file's bytes in the ZIP (as the sealed manifest lists them), L2 over canonical JSON
    const exported = db.redactErased(d, rs);
    const files = l2 ? undefined : l1PackFiles({ public_keys: d.publicKeys, receipts: exported, checkpoints: cpsIn });
    const dig = files
      ? { receipts: fileDigest(files['receipts.jsonl'] ?? ''), checkpoints: fileDigest(files['checkpoints.json'] ?? ''), keys: fileDigest(files['keys.json'] ?? '') }
      : { receipts: memberDigest(exported), checkpoints: memberDigest(cpsIn), keys: memberDigest(d.publicKeys) };
    const unanchored = sealed.filter((r) => r.seq > lastAnchored).length;
    const years = l2 ? 8 : 0;
    const oldest = rs[0]?.ts;
    return {
      records: rs.length, first: rs[0]?.seq, last, refusals: rs.filter((r) => r.decision === 'refuse').length,
      checkpoints: cpsIn.length, keys: d.signingKeys.length, uncheckpointed: lastCp ? last - lastCp : rs.length,
      sealed: sealed.length, unanchored, lastAnchored, batches, runs, rbv, dig,
      enforcement: enforcementOf(d, rs), missing: missingDeclarations(d, rs), personal: personalDataCount(rs), breakAt: firstBreak(rs),
      // L2+: a completed integrity run must cover the range before it leaves (the same rule api.exportPack enforces)
      integrity: l2 && rs.length ? integrityCoverage(d, rs[0].seq, last) : undefined,
      parts: l2 ? planParts(rs, isSealed) : rs.length ? [{ index: 1, from: rs[0].seq, to: last, count: rs.length, estKb: 0 }] : [],
      retention: { years, oldest: oldest ? oldest.slice(0, 10) : undefined, ok: !oldest || !years || Date.now() - new Date(oldest).getTime() < years * 365 * D },
    };
  }, [open, range.f, range.t, orgId, tick, headSeq, anchors.data, level]);

  const profile = l2 && profileId !== 'none' ? profileById(profileId) : undefined;
  const profileBlocked = profile ? claimBlock(profile.id) : undefined;
  const profileWhy = profile && profileBlocked ? ents.data?.find((x) => x.id === profile.id)?.entitlement?.why : undefined;
  const cpList = cps.data?.counterparties ?? [];
  const recipientLabel = recipient === 'none' ? undefined
    : recipient.startsWith('cp:') ? cpList.find((c) => `cp:${c.id}` === recipient)?.name
    : recipientName.trim() ? `${recipient === 'auditor' ? 'Auditor' : 'Regulator'}: ${recipientName.trim()}` : undefined;
  const recipientError = (recipient === 'auditor' || recipient === 'regulator') && !recipientName.trim() ? 'Name the recipient, or choose “Not addressed”.' : undefined;

  const parts = preview?.parts ?? [];
  const charge = l2 ? parts.length * BUNDLE_CHARGE : 0;
  // the range is pinned, so new records at the head do not throw away a check that already passed
  const preKey = JSON.stringify([orgId, range.f, range.t ?? headSeq, profile?.id ?? 'none', parts.length]);
  const preNow = pre && pre.key === preKey ? pre : undefined;
  const preFailed = preNow?.results?.find((x) => x.result.exitCode !== 0);

  const problems: RangeProblem[] = [];
  if (preview && l2 && preview.records) {
    if (preview.breakAt !== undefined) problems.push({ id: 'break', blocking: true, title: `The chain breaks at ${seqLabel(preview.breakAt)}`, text: 'The sequence or the hash link is not continuous there, so this range would fail verification. Export the records before the break, and open an incident for the rest.', clean: { from: preview.first!, to: preview.breakAt - 1 } });
    const ic = preview.integrity;
    if (ic && !ic.covered) {
      problems.push({
        id: 'integrity', blocking: true,
        title: ic.failedAt !== undefined ? `The last integrity run failed at ${seqLabel(ic.failedAt)}` : 'No completed integrity run covers this range',
        text: `${integrityProblem(ic, preview.first!, preview.last) ?? ''}${canRunRecorded ? '' : ' The run that clears an export is recorded on the chain, so an owner or an admin runs it; ask one of them.'}`,
        clean: ic.failedAt === undefined && ic.checkedTo !== undefined && ic.checkedTo >= preview.first! ? { from: preview.first!, to: ic.checkedTo } : undefined,
        // a run that clears an export is written to the client's chain: owners and admins only (an auditor's check is read-only)
        // hidden (not disabled) for roles that can never run it; the sentence above says who can
        ...(canRunRecorded ? { action: { label: 'Run the integrity check now', onClick: runCheck, loading: checking } } : {}),
      });
    }
    if (preview.unanchored > 0 && preview.lastAnchored >= (preview.first ?? 0)) problems.push({ id: 'tail', blocking: false, title: `${plural(preview.unanchored, 'record')} not yet timestamped`, text: 'The range ends in the unanchored tail, so the recipient gets PASS_UNANCHORED_TAIL: those records are signed and chained, but their time is not yet attested. Export up to the last timestamped batch for a plain PASS, or wait for the next batch (every 15 minutes).', clean: { from: preview.first!, to: preview.lastAnchored } });
    if (preFailed) {
      const r = preFailed.result;
      const at = r.chain?.brokenAt ?? r.sections.find((s) => s.firstFailure?.seq !== undefined && (s.state === 'fail' || s.state === 'incomplete'))?.firstFailure?.seq;
      problems.push({ id: 'preflight', blocking: true, title: `Your own check returned ${r.code}`, text: `${r.headline} If it does not pass for you it will not pass for them.`, clean: at !== undefined && at > preFailed.from ? { from: preFailed.from, to: at - 1 } : undefined });
    }
  }
  const blocks = l2 && preview ? [...gateBlocks(gate, preview.personal, preview.missing), ...problems.filter((p) => p.blocking).map((p) => p.title + '.')] : [];

  const members: Member[] = !preview ? [] : l2 ? [
    { path: BUNDLE_MEMBERS[0], what: 'Range, counts, levels, enforcement mode, the residency and consent answers, profile claim and the digest of every member; signed' },
    { path: BUNDLE_MEMBERS[1], what: plural(preview.records, 'receipt'), ...preview.dig.receipts },
    { path: BUNDLE_MEMBERS[2], what: `${plural(preview.sealed, 'Seal v6 record')}${preview.records - preview.sealed ? ` · ${n(preview.records - preview.sealed)} L1 records carry no seal` : ''}` },
    { path: BUNDLE_MEMBERS[3], what: plural(preview.checkpoints, 'signed checkpoint'), ...preview.dig.checkpoints },
    { path: BUNDLE_MEMBERS[4], what: `${plural(preview.batches, 'Merkle batch', 'Merkle batches')} · ${plural(preview.batches * 2, 'RFC 3161 token')}` },
    { path: BUNDLE_MEMBERS[5], what: plural(preview.keys, 'public key'), ...preview.dig.keys },
    { path: BUNDLE_MEMBERS[6], what: `${plural(preview.rbv, 'rulebook version')}, agents, AI systems, erasures` },
    { path: BUNDLE_MEMBERS[7], what: profile ? `${profile.name} v${profile.version} and VERIFY.txt` : 'No profile claimed · VERIFY.txt' },
    { path: LEXICON_MEMBER, what: 'The lexicon: every rule id and refusal code the receipts use, with what each means' },
  ] :L1_PACK_MEMBERS.map((path) => ({
    path, what: path === 'receipts.jsonl' ? plural(preview.records, 'receipt') : path === 'checkpoints.json' ? plural(preview.checkpoints, 'sealed chain head') : L1_WHAT[path],
    ...(path === 'receipts.jsonl' ? preview.dig.receipts : path === 'checkpoints.json' ? preview.dig.checkpoints : path === 'keys.json' ? preview.dig.keys : {}),
  }));

  const exportOpts = (part?: { index: number; of: number; group: string }) => ({
    container,
    ...(l2 && preview ? { gate: { residency: gate.residency, residencyDomain: custody.data?.residencyDomain, ...(gate.residency === 'outside' ? { transferBasis: gate.transferBasis } : {}), ...(preview.personal ? { purpose: gate.purpose, personalRecords: preview.personal } : {}), missingDeclarations: preview.missing.map((m) => m.detail), acknowledged: gate.acknowledged } } : {}),
    ...(part ? { part } : {}),
  });

  /** Build exactly what would be exported (nothing is written) and verify it in this browser. */
  const verifyFirst = async () => {
    if (!user || !preview) return;
    setPre({ key: preKey, running: true });
    try {
      const results: { label: string; result: VerifyBundleResult; from: number; to: number }[] = [];
      const list = parts.length > 1 ? parts : [{ index: 1, from: range.f ?? preview.first!, to: range.t ?? preview.last, count: preview.records, estKb: 0 }];
      for (const p of list) {
        const one = list.length === 1;
        const b = await api.previewPack(orgId, user.id, one ? range.f : p.from, one ? range.t : p.to, profile?.id, exportOpts(one ? undefined : { index: p.index, of: list.length, group: 'preview' }));
        const result = await verifyBundleOffThread(JSON.parse(b.json), { expectedFingerprint: d.org.keyFingerprint });
        results.push({ label: one ? `${seqLabel(p.from)}–${seqLabel(p.to)}` : `Part ${p.index} of ${list.length}`, result, from: p.from, to: p.to });
      }
      setPre({ key: preKey, running: false, results });
    } catch (e) {
      setPre({ key: preKey, running: false, error: (e as Error).message });
    }
  };

  const generate = async () => {
    if (!user || !preview) return;
    setPending(true);
    try {
      const ext = container;
      const list = l2 && parts.length > 1 ? parts : [undefined];
      const group = `exg_${Date.now().toString(36)}`;
      const out: DonePart[] = [];
      const jsons: string[] = [];
      const exportIds: string[] = [];
      let last: Awaited<ReturnType<typeof api.exportPack>> | undefined;
      for (const p of list) {
        if (p) setProgress(`Part ${p.index} of ${list.length}`);
        const res = await api.exportPack(orgId, user.id, p ? p.from : range.f, p ? p.to : range.t, profile?.id, exportOpts(p ? { index: p.index, of: list.length, group } : undefined));
        last = res;
        jsons.push(res.json);
        exportIds.push(res.export.id);
        const b = res.bundle as EvidenceBundle;
        const filename = packFilename(d.org.slug, res.export.firstSeq, res.export.lastSeq, level, ext, p ? { index: p.index, of: list.length } : undefined);
        const blob = ext === 'zip' ? bundleToZip(b) : new Blob([res.json], { type: 'application/json' });
        downloadBlob(filename, blob);
        const seq = res.export.seq;
        if (seq !== undefined) rememberExportSeq(orgId, res.export.id, seq);
        out.push({ filename, from: res.export.firstSeq, to: res.export.lastSeq, receipts: res.export.receipts, digest: res.export.digest ?? '', fileSha: await sha256OfBlob(blob), seq, sizeKb: Math.max(1, Math.round(blob.size / 1024)), bundle: b });
      }
      let addressedSeq: number | undefined;
      if (recipientLabel && out[0]) {
        const r = db.logAdmin(orgId, user.id, 'evidence.addressed', { export: last!.export.id, recipient: recipientLabel, recipient_kind: recipient.startsWith('cp:') ? 'counterparty' : recipient, parts: out.length, ...(out[0].seq !== undefined ? { export_seq: out[0].seq } : {}) });
        addressedSeq = r.seq;
      }
      const m = out[0].bundle.manifest;
      const outMembers: Member[] = Array.isArray(m.members)
        ? m.members.map((x, i) => ({ path: x.path, what: members[i]?.what ?? '', bytes: x.bytes || undefined, sha256: x.sha256 === 'self' ? undefined : x.sha256 }))
        : members;
      setDone({
        parts: out, addressedSeq, recipient: recipientLabel, members: outMembers,
        refusals: out.reduce((s, p) => s + p.bundle.receipts.filter((r) => r.decision === 'refuse').length, 0),
        unanchored: out.reduce((s, p) => s + (typeof p.bundle.manifest.unanchored_head === 'number' ? p.bundle.manifest.unanchored_head : 0), 0),
        seals: out.reduce((s, p) => s + (p.bundle.seals?.length ?? 0), 0),
        profile: typeof m.profile_id === 'string' ? { id: m.profile_id, version: String(m.profile_version ?? '') } : undefined,
        format: String(m.format ?? (l2 ? 'elan1.evidence.bundle.v1' : 'auditor-pack/1')), fingerprint: db.getDB(orgId).org.keyFingerprint, level, container: ext,
        charge: l2 ? out.length * BUNDLE_CHARGE : 0, enforcement: ENFORCEMENT_LABEL[(m.enforcement_mode as keyof typeof ENFORCEMENT_LABEL) ?? 'none'] ?? String(m.enforcement_mode ?? ''),
      });
      const total = out.reduce((s, p) => s + p.receipts, 0);
      onExported?.({ exportId: last!.export.id, seq: out[0].seq, receipts: total, firstSeq: out[0].from, lastSeq: out[out.length - 1].to, parts: out.length, charge: l2 ? out.length * BUNDLE_CHARGE : 0, filenames: out.map((p) => p.filename), exportIds, jsons });
      toast.ok(l2 ? (out.length > 1 ? `${out.length} evidence bundles downloaded` : 'Evidence bundle downloaded') : 'Auditor pack downloaded', `${plural(total, 'receipt')} in ${out.length > 1 ? `${out.length} files` : out[0].filename}. The export is recorded on the chain${l2 ? ` and ${rupees(out.length * BUNDLE_CHARGE)} is added to this month’s invoice` : ''}.`);
    } catch (e) {
      toast.bad(l2 ? 'The bundle could not be generated' : 'The pack could not be generated', (e as Error).message);
    } finally { setPending(false); setProgress(undefined); }
  };

  const signNow = async () => {
    if (!user) return;
    setCpPending(true);
    try {
      const c = await api.signCheckpoint(orgId, user.id);
      setTick((x) => x + 1);
      if (mode === 'custom') setTo(String(Math.max(Number(to) || 0, c.seq)));
      toast.ok(`Checkpoint ${l2 ? 'signed' : 'sealed'} at ${seqLabel(c.seq)}`, 'The head of the chain is now covered.');
    } catch (e) {
      toast.bad(`The checkpoint could not be ${l2 ? 'signed' : 'sealed'}`, (e as Error).message);
    } finally { setCpPending(false); }
  };

  const verifyHere = async () => {
    if (!done) return;
    setCheck({ running: true });
    try {
      const result = await verifyBundleOffThread(done.parts[0].bundle, { expectedFingerprint: done.fingerprint });
      setCheck({ running: false, result });
    } catch (e) { setCheck({ running: false, error: (e as Error).message }); }
  };

  const takeClean = (f: number, t: number) => { setMode('custom'); setFrom(String(f)); setTo(String(t)); };

  const cli = done ? (atLeast(done.level, 'l2')
    ? `govern verify ${done.parts[0].filename} --fingerprint ${done.fingerprint}${done.profile ? ` --profile ${done.profile.id}` : ''}`
    : `govern verify ${done.parts[0].filename} --fingerprint ${done.fingerprint}`) : '';
  const verifiedOk = !!preNow?.results?.length && !preFailed && !preNow.running;
  const disabledWhy = !canExport ? 'Owners, admins and auditors can export evidence.' : profile && profileBlocked ? `${profile.name} cannot be claimed (${profileBlocked}). Choose another profile or no profile.` : recipientError ?? range.error ?? blocks[0]
    ?? (requireVerify && !verifiedOk ? 'Verify it yourself first: the file is generated once your own check passes.' : undefined);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={done ? (l2 ? (done.parts.length > 1 ? `${done.parts.length} evidence bundles ready` : 'Evidence bundle ready') : 'Auditor pack ready') : title ?? (l2 ? 'Export an evidence bundle' : 'Export an auditor pack')}
      description={done ? undefined : l2
        ? 'The 8-member bundle an auditor verifies offline: receipts, Seal v6 records, checkpoints, timestamps, keys, declarations and an optional verifier profile.'
        : 'A ZIP with the receipts, sealed checkpoints and public keys, a PDF summary, a compliance map and a README, under a sealed manifest an auditor checks offline.'}
      footer={done ? (
        <>
          <Button variant="ghost" onClick={onClose}>Done</Button>
          <Button icon={<ShieldCheck className="h-4 w-4" />} loading={check?.running} onClick={verifyHere}>Check it here</Button>
          <Button variant="primary" icon={<ArrowUpRight className="h-4 w-4" />} onClick={() => { onClose(); nav('/verify'); }}>Open the verifier</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button icon={<ShieldCheck className="h-4 w-4" />} loading={preNow?.running} disabled={!canExport || !!range.error || !preview?.records} onClick={verifyFirst}>Verify it yourself first</Button>
          <Button variant="primary" icon={<Download className="h-4 w-4" />} loading={pending} disabled={!!disabledWhy || !preview?.records} onClick={generate} title={disabledWhy}>
            {pending && progress ? progress : l2 ? `Generate and download · ${rupees(charge)}` : 'Generate and download · free'}
          </Button>
        </>
      )}
    >
      {done ? (
        <div className="space-y-5">
          <div className="flex items-start gap-3 border border-ok/40 bg-ok-bg px-4 py-3">
            <CheckCircle2 className="h-5 w-5 text-ok-fg shrink-0 mt-0.5" aria-hidden />
            <div className="text-sm min-w-0">
              <p className="font-semibold break-all">{done.parts.length > 1 ? `${done.parts.length} files` : done.parts[0].filename}</p>
              <p className="text-muted mt-0.5 num">Export ready — {n(done.parts.reduce((s, p) => s + p.receipts, 0))} records, {n(done.refusals)} refusals{atLeast(done.level, 'l2') ? `, ${n(done.unanchored)} unanchored, profile ${done.profile ? `${done.profile.id} v${done.profile.version}` : 'none'}` : ''} · {done.container === 'zip' ? 'ZIP' : 'JSON'} · {n(done.parts.reduce((s, p) => s + p.sizeKb, 0))} KB · downloaded to this device</p>
              <p className="text-muted mt-0.5">Enforcement mode: {done.enforcement} · {done.charge ? <>Charge {rupees(done.charge)} ({plural(done.parts.length, 'bundle')} × {rupees(BUNDLE_CHARGE)}) on this month’s invoice</> : 'Free — the L1 auditor pack is not billed'}</p>
            </div>
          </div>

          <div>
            <p className="label mb-2">Bundle digest{done.parts.length > 1 ? 's' : ''} — compare with the verifier’s Reproduction section</p>
            <ul className="border border-line divide-y divide-line text-sm">
              {done.parts.map((p, i) => (
                <li key={p.filename} className="px-3 py-2 grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <span className="min-w-0">
                    <span className="block font-mono text-[12px] break-all">{done.parts.length > 1 ? `Part ${i + 1}: ` : ''}{p.filename}</span>
                    <span className="block text-xs text-muted">{seqLabel(p.from)}–{seqLabel(p.to)} · {plural(p.receipts, 'record')} · recorded as {p.seq !== undefined ? <Link className="font-mono underline underline-offset-2 hover:text-fg" to={`/activity/${p.seq}`} onClick={onClose}>{seqLabel(p.seq)}</Link> : 'an admin receipt'}</span>
                  </span>
                  <span className="text-xs text-muted sm:text-right">
                    <span className="block">Bundle digest <Hash value={p.digest} len={16} /></span>
                    <span className="block">File SHA-256 <Hash value={p.fileSha} len={16} /></span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <p className="text-sm text-muted">
            Each file is written to the chain as an evidence.exported receipt
            {done.recipient ? <>; addressed to {done.recipient}{done.addressedSeq ? <> (<Link className="font-mono underline underline-offset-2 hover:text-fg" to={`/activity/${done.addressedSeq}`} onClick={onClose}>{seqLabel(done.addressedSeq)}</Link>)</> : null}</> : null}
            , so the client can see every file that left the console.
          </p>
          <MemberTable members={done.members} title={atLeast(done.level, 'l2') ? `${done.members.length} members, as listed in the signed manifest` : `${done.members.length} files, as listed in the sealed manifest`} />
          {check && (
            <div className="border border-line">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-line">
                <p className="label">Checked in this browser{done.parts.length > 1 ? ' · part 1' : ''}</p>
                {check.running && <span className="inline-flex items-center gap-2 text-sm text-muted"><Spinner /> Recomputing hashes, {atLeast(done.level, 'l2') ? 'signatures, seals and timestamps' : 'Ed25519 seals, links and the sealed manifest'}…</span>}
              </div>
              {check.error && <p className="px-4 py-3 text-sm text-bad-fg">{check.error}</p>}
              {check.result && (
                <div className="px-4 py-3 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip tone={check.result.exitCode === 0 ? 'ok' : check.result.exitCode === 1 ? 'bad' : 'held'} icon={check.result.exitCode === 0 ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <TriangleAlert className="h-3.5 w-3.5" aria-hidden />}>
                      <span className="font-mono">{check.result.code}</span>
                    </StatusChip>
                    <span className="text-sm font-medium">{check.result.label}</span>
                    <span className="text-xs text-muted num">exit {check.result.exitCode} · {n(check.result.ms)} ms</span>
                  </div>
                  <p className="text-sm">{check.result.headline}</p>
                  <p className="text-xs text-muted">Bundle digest reported: <Hash value={check.result.reproduction.bundleDigest} len={16} /> {check.result.reproduction.bundleDigest === done.parts[0].digest ? '— matches' : '— does not match'}</p>
                  <ol className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                    {check.result.sections.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-2 min-w-0"><span className="truncate"><span className="text-muted num">{s.number}.</span> {s.title}</span><SectionChip state={s.state} /></li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
          <div className="border border-line bg-sunken/50 p-4 text-sm">
            <p className="label mb-2">Next</p>
            <ol className="list-decimal pl-5 space-y-1 text-muted">
              <li>Send the file{done.parts.length > 1 ? 's' : ''}, and the key fingerprint <span className="font-mono text-fg">{done.fingerprint}</span> by a separate channel.</li>
              <li>The recipient runs <span className="font-mono text-fg break-all">{cli}</span>{done.parts.length > 1 ? ' for each part' : ''}.</li>
              <li>{atLeast(done.level, 'l2') ? 'Exit 0 is a pass (PASS, PASS_UNANCHORED_TAIL, PASS_KEY_FROM_BUNDLE, PASS_L1_INTERNAL or PASS_PAYLOAD_UNBOUND); 1 integrity, 2 profile, 3 incomplete, 4 unsupported, 5 usage.' : 'Exit 0 is PASS_L1_INTERNAL (L1: internal evidence only); exit 1 names the first broken receipt, an edited manifest or a cut-off tail; exit 3 INCOMPLETE means something needed to check is missing (a file, a seal or a key); exit 5 USAGE means the input is not a pack or an option is wrong.'}</li>
            </ol>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {!canExport && <Banner tone="neutral" title="You can read this but not export">Owners, admins and auditors can export evidence.</Banner>}
          {note && <div className="text-sm text-muted">{note}</div>}
          <RadioCards<RangeMode> name="pack-range" value={mode} onChange={setMode} cols={3} options={[
            { value: 'all', label: 'Everything', description: `${seqLabel(firstSeq)} to ${seqLabel(pinTo ?? headSeq)}` },
            { value: '7d', label: 'Last 7 days', description: `Receipts from the past week, up to ${seqLabel(pinTo ?? headSeq)}` },
            { value: 'custom', label: 'Sequence range', description: 'From one receipt number to another' },
          ]} />
          {mode === 'custom' && (
            <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
              <Field label="From" htmlFor="pk-from" error={range.error}><Input id="pk-from" mono value={from} onChange={(e) => setFrom(e.target.value)} inputMode="numeric" /></Field>
              <Field label="To" htmlFor="pk-to"><Input id="pk-to" mono value={to} onChange={(e) => setTo(e.target.value)} inputMode="numeric" /></Field>
            </div>
          )}
          {mode !== 'custom' && pinTo !== undefined && headSeq > pinTo && (
            <p className="text-xs text-muted">This export ends at {seqLabel(pinTo)}, the head when it was checked. {plural(headSeq - pinTo, 'record')} written since then go in the next export.</p>
          )}

          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            {/* verifier profiles are part of the plan from L2: below it the field is left out, not shown disabled */}
            {l2 && (
              <Field label="Verifier profile" htmlFor="pk-profile"
                error={profileWhy ? <>{profileWhy} <Link className="underline underline-offset-2" to={`/assurance/profiles?id=${profile?.id ?? ''}`} onClick={onClose}>Open the profile</Link>.</> : undefined}
                hint={profile ? `The verifier checks ${plural(profile.rules.length, 'rule')} and returns FAIL_PROFILE if one fails.` : 'No claim: the verifier checks integrity only. Only an ordered, issued profile can be claimed.'}>
                <Select id="pk-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                  <option value="none">No profile claimed</option>
                  {PROFILES.map((p) => { const b = claimBlock(p.id); return <option key={p.id} value={p.id} disabled={!!b && p.id !== profileId}>{p.name} · v{p.version}{b ? ` — ${b}` : ''}</option>; })}
                </Select>
              </Field>
            )}
            <Field label="Recipient" htmlFor="pk-to-whom" hint={recipient === 'none' ? 'Optional. When named, the recipient is recorded on the chain with the export.' : l3 && recipient.startsWith('cp:') ? 'A registered counterparty: they verify with the fingerprint pinned in their register.' : undefined} error={recipientError}>
              <Select id="pk-to-whom" value={recipient} onChange={(e) => setRecipient(e.target.value)}>
                <option value="none">Not addressed</option>
                <option value="auditor">An auditor</option>
                <option value="regulator">A regulator</option>
                {l3 && cpList.length > 0 && <optgroup label="Counterparties">{cpList.map((c) => <option key={c.id} value={`cp:${c.id}`}>{c.name}</option>)}</optgroup>}
              </Select>
            </Field>
            {(recipient === 'auditor' || recipient === 'regulator') && (
              <Field label={recipient === 'auditor' ? 'Audit firm or person' : 'Regulator'} htmlFor="pk-name" className="sm:col-span-2">
                <Input id="pk-name" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder={recipient === 'auditor' ? 'e.g. Desai & Co, Chartered Accountants' : 'e.g. Reserve Bank of India, Department of Supervision'} />
              </Field>
            )}
          </div>

          <RadioCards<Container> name="pack-container" value={container} onChange={setContainer} cols={2} options={[
            { value: 'zip', label: <span className="inline-flex items-center gap-1.5"><FileArchive className="h-4 w-4" aria-hidden />ZIP</span>, description: l2 ? 'The members as files: manifest.json, receipts.jsonl, seals.jsonl … as govern export writes them' : 'manifest.json, receipts.jsonl, summary.pdf, compliance-map.json, README.txt and the rest' },
            { value: 'json', label: <span className="inline-flex items-center gap-1.5"><FileJson className="h-4 w-4" aria-hidden />JSON</span>, description: 'One file holding every member. The verifier reads either.' },
          ]} />

          <dl className="grid sm:grid-cols-4 gap-px bg-line border border-line text-sm">
            <div className="bg-surface p-3"><dt className="label">Format</dt><dd className="mt-1 font-mono text-[12px]">{l2 ? 'elan1.evidence.bundle.v1' : 'auditor-pack/1'}</dd><dd className="text-xs text-muted">{l2 ? '8 members' : `${L1_PACK_MEMBERS.length} files`}</dd></div>
            <div className="bg-surface p-3"><dt className="label">Enforcement mode</dt><dd className="mt-1">{preview ? ENFORCEMENT_LABEL[preview.enforcement.mode] : '—'}</dd><dd className="text-xs text-muted">{preview ? `${n(preview.enforcement.governed_run)} governed run · ${n(preview.enforcement.check_and_record)} check and record` : ''}</dd></div>
            <div className="bg-surface p-3"><dt className="label">The claim</dt><dd className="mt-1 text-xs leading-relaxed">{CLAIM[level]}{preview && preview.runs.length > 1 ? '; earlier records keep their own level' : ''}.</dd></div>
            <div className={cn('bg-surface p-3', l2 && 'bg-held-bg/30')}>
              <dt className="label inline-flex items-center gap-1"><IndianRupee className="h-3 w-3" aria-hidden />Charge</dt>
              <dd className="mt-1 font-display text-lg font-semibold num">{l2 ? rupees(charge) : 'Free'}</dd>
              <dd className="text-xs text-muted">{l2 ? `${plural(Math.max(1, parts.length), 'bundle')} × ${rupees(BUNDLE_CHARGE)}, on this month’s invoice` : 'The L1 auditor pack is not billed'}</dd>
            </div>
          </dl>

          {preview && (
            <div>
              <p className="label mb-2">Preview — nothing is generated yet</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-line border border-line">
                <div className="bg-surface p-3"><p className="label">Records</p><p className="mt-1 font-display text-2xl font-semibold num">{n(preview.records)}</p><p className="text-xs text-muted font-mono">{preview.first ? `${seqLabel(preview.first)}–${seqLabel(preview.last)}` : '—'}</p></div>
                <div className="bg-surface p-3"><p className="label">Refusals</p><p className="mt-1 font-display text-2xl font-semibold num">{n(preview.refusals)}</p><p className="text-xs text-muted">in range</p></div>
                {l2 ? (
                  <>
                    <div className="bg-surface p-3"><p className="label">Sealed</p><p className="mt-1 font-display text-2xl font-semibold num">{n(preview.sealed)}</p><p className="text-xs text-muted">{n(preview.batches)} batches timestamped</p></div>
                    <div className="bg-surface p-3"><p className="label">Unanchored</p><p className="mt-1 font-display text-2xl font-semibold num">{anchors.loading && !anchors.data ? '…' : n(preview.unanchored)}</p><p className="text-xs text-muted">not yet in a 15-minute batch</p></div>
                  </>
                ) : (
                  <>
                    <div className="bg-surface p-3"><p className="label">Checkpoints</p><p className="mt-1 font-display text-2xl font-semibold num">{n(preview.checkpoints)}</p><p className="text-xs text-muted">sealed chain heads</p></div>
                    <div className="bg-surface p-3"><p className="label">Keys</p><p className="mt-1 font-display text-2xl font-semibold num">{n(preview.keys)}</p><p className="text-xs text-muted">retired ones included</p></div>
                  </>
                )}
              </div>
              {preview.runs.length > 0 && (
                <p className="mt-2 text-xs text-muted">Levels in this range: {preview.runs.map((r) => `${LEVEL_INFO[r.level].short} ${seqLabel(r.first)}–${seqLabel(r.last)} (${n(r.count)})`).join(' · ')}{preview.runs.some((r) => r.level === 'l1') && l2 ? '. L1 records are sealed in a hash chain, with no Seal v6 record, and verify as such.' : '.'}</p>
              )}
            </div>
          )}

          {l2 && preview && preview.records > 0 && (
            <GuardsPanel parts={parts} problems={problems} onClean={takeClean} gate={gate} setGate={setGate} residencyDomain={custody.data?.residencyDomain}
              personal={preview.personal} missing={preview.missing} retention={preview.retention} charge={charge} />
          )}

          <div className="border border-line px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">Verify it yourself first</p>
              {!preNow && <span className="text-xs text-muted">Not checked yet for this range</span>}
            </div>
            <p className="mt-1 text-sm text-muted">If it does not pass for you it will not pass for them. This builds exactly the {l2 ? 'bundle' : 'pack'} that would be exported — nothing is written or billed — and verifies it in this browser with your published fingerprint.</p>
            {preNow && <div className="mt-3"><PreflightResult l2={l2} running={preNow.running} error={preNow.error} results={preNow.results} /></div>}
          </div>

          <MemberTable members={members} title={l2 ? '8 members and the lexicon — digests shown where they are known before writing' :`What goes in — ${L1_PACK_MEMBERS.length} files`} />

          {preview && preview.records > 0 && preview.uncheckpointed > 0 && (
            <Banner tone="held" title={`${plural(preview.uncheckpointed, 'receipt')} after the last checkpoint`}
              actions={canCheckpoint ? <Button size="sm" icon={<Stamp className="h-3.5 w-3.5" />} loading={cpPending} onClick={signNow}>{l2 ? 'Sign' : 'Seal'} a checkpoint now</Button> : undefined}>
              The tail of this range is not yet under a {l2 ? 'signed' : 'sealed'} checkpoint. {l2 ? 'The signed manifest still fixes the record count, so a cut tail fails; a checkpoint also fixes the head for anyone holding only the receipts.' : 'The sealed manifest still names the last hash, so a cut tail fails; a checkpoint also fixes the head for anyone holding only the receipts.'}
            </Banner>
          )}

          {l3 ? (
            <p className="text-sm text-muted">Sharing one receipt with a counterparty? A <Link className="underline underline-offset-2 text-fg" to="/assurance/disclosure" onClick={onClose}>disclosure package</Link> reveals only the fields they need — for example 3 of {DISCLOSABLE_FIELDS.length} committed fields — and the rest stay checkable.</p>
          ) : l2 ? (
            // owners only: one line; every other role sees nothing about the next level
            <PlanUpsell to="l3" what="From L3 single receipts can be shared revealing only some fields." />
          ) : (
            <PlanUpsell to="l2" what="From L2 this export becomes the 8-member evidence bundle with seals and timestamps." />
          )}

          <div className="flex flex-wrap items-start gap-3 text-xs text-muted">
            <FileJson className="h-4 w-4 shrink-0" aria-hidden />
            <p className="flex-1 min-w-[220px] leading-relaxed">The manifest states the claim plainly: {CLAIM[level].charAt(0).toLowerCase() + CLAIM[level].slice(1)}.</p>
            <LegalDraft />
          </div>
        </div>
      )}
    </Dialog>
  );
}

function MemberTable({ members, title }: { members: Member[]; title: string }) {
  return (
    <div>
      <p className="label mb-2">{title}</p>
      <ul className="border border-line divide-y divide-line text-sm">
        {members.map((m, i) => (
          <li key={m.path} className="grid grid-cols-[24px_1fr] sm:grid-cols-[24px_minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-3 py-2">
            <span className="text-muted num">{i + 1}</span>
            <span className="min-w-0"><span className="font-mono text-[12.5px]">{m.path}</span><span className="block text-xs text-muted">{m.what}</span></span>
            <span className={cn('col-start-2 sm:col-start-3 text-xs text-muted sm:text-right')}>
              {m.sha256 ? <><Hash value={m.sha256} len={12} /><span className="block num">{m.bytes !== undefined ? `${n(m.bytes)} bytes` : ''}</span></> : <span title="Computed when the file is written">{m.path === 'manifest.json' ? (m.what.endsWith('signed') ? 'Signed at export' : 'Sealed at export') : 'At export'}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
