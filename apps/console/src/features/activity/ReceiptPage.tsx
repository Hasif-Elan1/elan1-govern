import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { stringify } from 'yaml';
import { ArrowDown, ArrowRight, ArrowUpRight, BookOpen, Bot, ChevronLeft, ChevronRight, ClipboardCheck, Download, EyeOff, FileWarning, Fingerprint, KeyRound, Layers, Link2, MessageSquareText, Search, Send, ShieldCheck, Stamp, Waypoints } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useSession, useUser } from '@/store/session';
import { useUi } from '@/store/ui';
import type { Framework, Receipt } from '@/types';
import { LEVEL_INFO, levelRank } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { dateTime, seqLabel } from '@/lib/format';
import { userName } from '@/mock/users';
import { ApprovalChip, Badge, Banner, Button, CodeBlock, CopyButton, DecisionChip, EmptyState, Hash, IconButton, Input, JsonView, KeyValue, PageHeader, Panel, Skeleton, StatusChip, Tabs, Timeline, toast } from '@/components/ui';
import { AgentLink, ArgsTable, Person, ReceiptLink, When } from '@/components/domain';
import { KindMark, ModeChip, NavButton, OutcomeCell, SYSTEM_RULES, channelPhrase, downloadText, isGuardRule, storyOf, systemRuleIdsYaml } from './shared';
import { EnvironmentChip } from '@/features/evidence/EnvironmentChip';
import { DecisionTrace, traceStepCount } from './DecisionTrace';
import { fingerprintOf, sealWords, verifyReceipt, type ReceiptVerification } from './verify';
import { CheckList, VerdictLine } from './VerifyResult';
import { claimFor, CUSTODY_MODE_LABEL, custodyAtLevel, RECEIPT_FIELDS, receiptFieldsPresent } from './assurance';
import { controlIdsForReceipt, indexControls, liveControls, requirementsOf } from '@/features/compliance/evidence';
import { loadReceiptAssurance, type ReceiptAssurance } from './receiptAssurance';
import { AnchoredPanel, SealTab } from './SealTab';
import { IssueDialog, ReceivedCard, RedactedShareDialog } from './ShareDialogs';
import { LevelTag, UpgradeHint } from './UpgradeHint';
import { SmartLink, useCanSee } from '@/shell/access';
import { UnsignedReceiptNote } from '@/features/keys/UnsignedInterval';
import { isInterimKid } from '@/mock/keys';

type TabId = 'summary' | 'trace' | 'signed' | 'seal' | 'chain' | 'rule';
const TAB_IDS: TabId[] = ['summary', 'trace', 'signed', 'seal', 'chain', 'rule'];
type Loaded = Awaited<ReturnType<typeof api.receipt>>;
type Assurance = { data?: ReceiptAssurance; loading: boolean; error?: Error; refetch: () => void };

/** The exact lines of one rule from the signed YAML, so the snippet is what was signed. */
function ruleSnippet(yaml: string, id: string): string | undefined {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*- id: ["']?${id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}["']?\\s*$`).test(l));
  if (start < 0) return undefined;
  const indent = lines[start].indexOf('-');
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) break;
    const ind = l.length - l.trimStart().length;
    if (ind <= indent) break;
    out.push(l);
  }
  return out.map((l) => l.slice(indent)).join('\n');
}

export default function ReceiptPage() {
  const { seq: raw } = useParams();
  const seq = Number(String(raw ?? '').replace(/[#,\s]/g, ''));
  const valid = Number.isInteger(seq) && seq > 0;
  const [sp, setSp] = useSearchParams();
  const tab = (TAB_IDS.includes(sp.get('tab') as TabId) ? sp.get('tab') : 'summary') as TabId;
  const setTab = (t: TabId) => { const n = new URLSearchParams(sp); if (t === 'summary') n.delete('tab'); else n.set('tab', t); setSp(n, { replace: true }); };
  const openAsk = useUi((s) => s.openAsk);
  // ?org=<id> (the verifier's 'Open it in the console'): a receipt number means something only within one organisation.
  // Switch to that organisation when this person belongs to it; otherwise never show this organisation's receipt with the same number.
  const orgParam = sp.get('org') ?? undefined;
  const orgId = useOrgId();
  const orgLevel = useOrgLevel();
  const user = useUser();
  const switchOrg = useSession((s) => s.switchOrg);
  const member = !orgParam || !!user?.orgIds.includes(orgParam);
  const otherOrg = !!orgParam && orgParam !== orgId;
  useEffect(() => {
    if (!orgParam) return;
    if (orgParam !== orgId && member) { switchOrg(orgParam); toast.info('Switched organisation', 'This receipt belongs to another organisation you are a member of.'); }
    if (orgParam === orgId || member) { const n = new URLSearchParams(sp); n.delete('org'); setSp(n, { replace: true }); }
  }, [orgParam, orgId, member, switchOrg, sp, setSp]);
  const { data, loading, error } = useQuery((o) => (valid ? api.receipt(o, seq) : Promise.reject(new Error(`“${raw}” is not a receipt number.`))), [seq, valid], { kinds: ['receipt', 'checkpoint', 'key', 'approval'] });
  const assurance = useQuery(
    (o) => (data ? loadReceiptAssurance(o, data.receipt, data.checkpoint?.seq) : Promise.resolve(undefined)),
    [data?.receipt.seq, data?.receipt.hash, data?.checkpoint?.seq],
    { kinds: ['receipt', 'checkpoint', 'key', 'level'] },
  );

  if (otherOrg && !member) return <NotFound seq={raw ?? ''} message="This receipt belongs to an organisation you are not a member of. Receipt numbers are per organisation, so the receipt with this number here is a different record." />;
  if (error && !data && !otherOrg) return <NotFound seq={raw ?? ''} message={error.message} />;
  if ((loading && !data) || otherOrg) {
    return (
      <div>
        <PageHeader crumbs={[{ label: 'Activity', to: '/activity' }, { label: valid ? `Receipt ${seqLabel(seq)}` : 'Receipt' }]} title={valid ? `Receipt ${seqLabel(seq)}` : 'Receipt'} />
        <div className="space-y-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-48 w-full" /><Skeleton className="h-64 w-full" /></div>
      </div>
    );
  }
  if (!data) return null;
  const r = data.receipt;
  const a = assurance.data;
  const as: Assurance = { data: a, loading: assurance.loading, error: assurance.error, refetch: assurance.refetch };
  // Seal v6 is part of L2: below it the tab is left out (a receipt sealed before a move back down keeps it)
  const sealTab = levelRank(orgLevel) >= 1 || !!a?.seal.sealed;
  const view: TabId = tab === 'seal' && !sealTab ? 'summary' : tab;

  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Activity', to: '/activity' }, { label: `Receipt ${seqLabel(r.seq)}` }]}
        kicker="Records · Receipt"
        title={`Receipt ${seqLabel(r.seq)}`}
        meta={
          <>
            <KindMark kind={r.kind} className="text-fg" />
            <DecisionChip decision={r.decision} />
            {a && <LevelTag level={a.level} title={`Written at ${LEVEL_INFO[a.level].label}`} />}
            {a?.seal.sealed && <Badge tone="neutral" icon={<Layers className="h-3 w-3" aria-hidden />}>Sealed</Badge>}
            <span className="text-sm text-muted num">{dateTime(r.ts)}</span>
            {r.agent && <AgentLink slug={r.agent} className="text-sm" />}
            {r.actor && r.kind !== 'decision' && <Person id={r.actor} size={20} />}
          </>
        }
        actions={
          <>
            <div className="flex items-center border border-line">
              <PrevNext to={data.prev?.seq} label="Previous receipt" icon={<ChevronLeft className="h-4 w-4" />} />
              <span className="h-9 w-px bg-line" />
              <PrevNext to={data.next?.seq} label="Next receipt" icon={<ChevronRight className="h-4 w-4" />} />
            </div>
            <CopyButton text={typeof window !== 'undefined' ? window.location.origin + `/activity/${r.seq}` : `/activity/${r.seq}`} label="Copy link" className="h-10 px-3" />
            <Button variant="secondary" icon={<MessageSquareText className="h-4 w-4" />} onClick={() => openAsk({ kind: 'receipt', title: `Receipt ${seqLabel(r.seq)}`, payload: r })}>Explain</Button>
          </>
        }
      />

      {assurance.error && <Banner tone="bad" title="The assurance details could not be loaded" className="mb-4" actions={<Button size="sm" onClick={assurance.refetch}>Try again</Button>}>{assurance.error.message}</Banner>}
      <UnsignedReceiptNote seq={r.seq} kid={r.kid} />

      <Tabs<TabId> label="Receipt views" value={view} onChange={setTab} className="mb-6" items={[
        { value: 'summary', label: 'Summary' },
        { value: 'trace', label: 'Decision trace' },
        // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
        { value: 'signed', label: levelRank(a?.level ?? orgLevel) >= 1 ? 'Signed receipt' : 'Sealed receipt' },
        ...(sealTab ? [{ value: 'seal' as TabId, label: 'Seal v6' }] : []),
        { value: 'chain', label: 'Chain' },
        { value: 'rule', label: 'Rule version' },
      ]} />

      {view === 'summary' && <SummaryTab data={data} as={as} onTab={setTab} />}
      {view === 'trace' && <TraceTab data={data} as={as} />}
      {view === 'signed' && <SignedTab data={data} as={as} />}
      {view === 'seal' && (a ? <SealTab r={r} a={a} /> : <AssuranceSkeleton error={assurance.error} />)}
      {view === 'chain' && <ChainTab data={data} as={as} />}
      {view === 'rule' && <RuleTab data={data} />}
    </div>
  );
}

function AssuranceSkeleton({ error }: { error?: Error }) {
  if (error) return <Panel><EmptyState compact title="Not available" disc="registration">{error.message}</EmptyState></Panel>;
  return <div className="space-y-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-64 w-full" /></div>;
}

function PrevNext({ to, label, icon }: { to?: number; label: string; icon: ReactNode }) {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  return <IconButton label={to ? `${label} ${seqLabel(to)}` : `No ${label.toLowerCase()} yet`} disabled={!to} onClick={() => to && nav(`/activity/${to}${sp.toString() ? `?${sp}` : ''}`)}>{icon}</IconButton>;
}

function NotFound({ seq, message }: { seq: string; message: string }) {
  const nav = useNavigate();
  const [v, setV] = useState('');
  return (
    <div>
      <PageHeader crumbs={[{ label: 'Activity', to: '/activity' }, { label: 'Not found' }]} kicker="Records · Receipt" title="Receipt not found" />
      <Panel>
        <EmptyState title={`There is no receipt ${seq.startsWith('#') ? seq : `#${seq}`} here`} disc="registration"
          action={
            <form className="flex flex-wrap items-center justify-center gap-2" onSubmit={(e) => { e.preventDefault(); const s = v.replace(/[#,\s]/g, ''); if (s) nav(`/activity/${s}`); }}>
              <Input aria-label="Receipt number" mono value={v} onChange={(e) => setV(e.target.value)} placeholder="#3412" className="w-40 h-9" />
              <Button type="submit" size="sm" variant="primary" icon={<Search className="h-3.5 w-3.5" />}>Open</Button>
              <Button type="button" size="sm" onClick={() => nav('/activity')}>Back to activity</Button>
            </form>
          }>
          {message} Receipt numbers belong to one organisation’s chain — if you work across clients, check which organisation is selected.
        </EmptyState>
      </Panel>
    </div>
  );
}

/* ── Summary ──────────────────────────────────────────────── */

function SummaryTab({ data, as, onTab }: { data: Loaded; as: Assurance; onTab: (t: TabId) => void }) {
  const openAsk = useUi((s) => s.openAsk);
  const r = data.receipt;
  const a = as.data;
  const rootSeq = r.ref_seq ?? r.seq;
  const root = r.ref_seq ? data.related.find((x) => x.seq === r.ref_seq) : r;
  const followUps = data.related.filter((x) => x.ref_seq === rootSeq);
  const thread = useMemo(() => {
    const all = [...(root ? [root] : []), ...followUps];
    if (!all.some((x) => x.seq === r.seq)) all.push(r);
    return all.filter((x, i, arr) => arr.findIndex((y) => y.seq === x.seq) === i).sort((x, y) => x.seq - y.seq);
  }, [root, followUps, r]);

  const links = useQuery(async (o) => {
    const [agent, comp, assessments] = await Promise.all([r.agent ? api.agent(o, r.agent).catch(() => undefined) : Promise.resolve(undefined), api.compliance(o), api.assessments(o)]);
    const system = agent?.aiSystem;
    const assessment = system ? assessments.filter((x) => x.aiSystemId === system.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0] : undefined;
    const enabled = comp.frameworks.filter((f) => f.enabled);
    // the same controls, predicates and framework mapping as Coverage (level controls and mappings included)
    const byId = indexControls(liveControls(o, comp.controls));
    const maps = (f: Framework, id: string) => requirementsOf(f, byId).some((q) => q.controlIds.includes(id));
    const controls = controlIdsForReceipt(o, r).map((id) => {
      const c = byId[id];
      const fw = enabled.find((f) => maps(f, id)) ?? comp.frameworks.find((f) => maps(f, id));
      return c ? { id, name: c.name, to: fw ? `/compliance/${fw.id}#${id}` : `/compliance#${id}`, framework: fw?.short } : undefined;
    }).filter(Boolean) as { id: string; name: string; to: string; framework?: string }[];
    return { agent: agent?.agent, system, assessment, controls };
  }, [r.seq, r.agent], { kinds: ['assessment', 'agent'] });

  const sealedFields = a?.seal.sealed ? a.seal.seal.fields.length : 0;
  const fields: { k: ReactNode; v: ReactNode; mono?: boolean }[] = [
    { k: 'seq', v: seqLabel(r.seq), mono: true },
    { k: 'ts', v: <span title={r.ts}>{dateTime(r.ts)}</span> },
    { k: 'org', v: r.org, mono: true },
    { k: 'kind', v: r.kind, mono: true },
    ...(r.agent ? [{ k: 'agent', v: <AgentLink slug={r.agent} /> }] : []),
    ...(r.tool ? [{ k: 'tool', v: r.tool, mono: true }] : []),
    ...(r.decision ? [{ k: 'decision', v: <DecisionChip decision={r.decision} size="sm" /> }] : []),
    ...(r.rule_id ? [{ k: 'rule_id', v: r.rule_id, mono: true }] : []),
    ...(r.rulebook ? [{ k: 'rulebook', v: <span className="font-mono text-[12px]">v{r.rulebook.version} · {r.rulebook.hash.slice(0, 12)}…</span> }] : []),
    ...(r.args_hash ? [{ k: 'args_hash', v: <Hash value={r.args_hash} len={14} /> }] : []),
    ...(r.approval ? [{ k: 'approval', v: <span className="inline-flex items-center gap-2"><ApprovalChip status={r.approval.status} size="sm" /><span className="font-mono text-[12px]">{r.approval.id}</span></span> }] : []),
    ...(r.kind !== 'admin' ? [{ k: 'outcome', v: <OutcomeCell r={r} /> }] : []),
    ...(r.details?.mode ? [{ k: 'mode', v: <ModeChip r={r} /> }] : []),
    ...(r.environment ? [{ k: 'environment', v: <EnvironmentChip r={r} withNote /> }] : []),
    ...(r.ref_seq ? [{ k: 'ref_seq', v: <ReceiptLink seq={r.ref_seq} /> }] : []),
    ...(r.actor ? [{ k: 'actor', v: <Person id={r.actor} size={20} /> }] : []),
    ...(r.action ? [{ k: 'action', v: r.action, mono: true }] : []),
    { k: 'kid', v: r.kid, mono: true },
    { k: 'prev_hash', v: <Hash value={r.prev_hash} len={14} /> },
    { k: 'hash', v: <Hash value={r.hash} len={14} /> },
    { k: 'sig', v: <Hash value={r.sig} len={14} /> },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-8 space-y-6">
        <Panel kicker="What happened">
          <p className="font-display text-lg sm:text-xl leading-snug tracking-tightish">{storyOf(r, { root: r.ref_seq ? root : undefined, followUps })}</p>
          {r.reason && <p className="mt-3 text-sm text-muted">Reason recorded: “{r.reason}”</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={<MessageSquareText className="h-3.5 w-3.5" />} onClick={() => openAsk({ kind: 'receipt', title: `Receipt ${seqLabel(r.seq)}`, payload: r })}>Explain this receipt</Button>
            {r.kind === 'decision' && <Button size="sm" variant="ghost" icon={<Waypoints className="h-3.5 w-3.5" />} onClick={() => onTab('trace')}>See the decision trace</Button>}
            <Button size="sm" variant="ghost" icon={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => onTab('signed')}>Verify it</Button>
          </div>
          <p className="mt-4 text-xs text-muted">Ask Govern explains in plain words. It never makes decisions — no model sits on the decision path.</p>
        </Panel>

        <Panel title="All fields" actions={
          <span className="text-xs text-muted text-right">{receiptFieldsPresent(r)} of {RECEIPT_FIELDS.length} receipt fields present
            {sealedFields > 0 && <> · <button type="button" className="underline underline-offset-2 hover:text-fg" onClick={() => onTab('seal')}>Seal v6: {sealedFields} of 16 frozen fields</button></>}
          </span>
        }>
          <KeyValue cols={2} items={fields} />
        </Panel>

        {(r.args_summary || r.details) && (
          <Panel title={r.args_summary ? 'Arguments the rules inspected' : 'Details'}>
            <ArgsTable args={(r.args_summary ?? r.details)!} />
            {r.args_summary && <p className="mt-3 text-xs text-muted">A receipt never holds full arguments, message bodies or prompts — only the values a rule inspected, with email addresses reduced to domains. The full call is bound by <span className="font-mono">args_hash</span>.</p>}
            {r.args_summary && r.details && <div className="mt-4"><p className="label mb-2">Details</p><ArgsTable args={r.details} /></div>}
          </Panel>
        )}
      </div>

      <div className="lg:col-span-4 space-y-6">
        <AssurancePanel r={r} as={as} onTab={onTab} />

        {data.approval && (
          <Panel title="Approval" actions={<ApprovalChip status={data.approval.status} size="sm" />}>
            <p className="text-sm font-medium">{data.approval.headline}</p>
            <KeyValue className="mt-3" items={[
              { k: 'Approver group', v: data.approval.approverGroup },
              { k: 'Triggered by', v: data.approval.triggeredBy || '—' },
              ...(data.approval.escalations?.length ? [{ k: 'Escalated', v: `${data.approval.escalations.length}× — now ${data.approval.approverGroup}` }] : []),
              ...(data.approval.override ? [{ k: 'Owner override', v: userName(data.approval.override.by) }] : []),
              ...(data.approval.decidedBy ? [{ k: 'Decided by', v: <Person id={data.approval.decidedBy} size={20} /> }] : []),
              ...(data.approval.decidedAt ? [{ k: 'Decided', v: <When iso={data.approval.decidedAt} /> }] : [{ k: 'Expires', v: <When iso={data.approval.expiresAt} /> }]),
            ]} />
            <SmartLink to={`/approvals/${data.approval.id}`} hideWhenBlocked className="mt-3 inline-flex items-center gap-1 text-sm font-medium hover:underline underline-offset-2">Open the approval <ArrowRight className="h-3.5 w-3.5" /></SmartLink>
          </Panel>
        )}

        <Panel title="Receipt thread" kicker="Decision → approval → outcome">
          <Timeline items={thread.map((x) => ({
            title: <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">{x.seq === r.seq ? <span className="font-mono text-[12.5px] font-semibold">{seqLabel(x.seq)}</span> : <ReceiptLink seq={x.seq} />}<KindMark kind={x.kind} />{x.seq === r.seq && <Badge tone="inverse">This receipt</Badge>}</span>,
            time: dateTime(x.ts),
            tone: x.decision === 'allow' ? 'ok' : x.decision === 'ask' ? 'held' : x.decision === 'refuse' ? 'bad' : 'neutral',
            body: x.kind === 'decision' ? `${x.decision === 'ask' ? 'Held' : x.decision === 'allow' ? 'Allowed' : 'Refused'} by ${x.rule_id}` : x.kind === 'approval' ? (x.approval?.status === 'expired' ? 'Expired — refused' : `${x.approval?.status === 'rejected' ? 'Rejected' : 'Approved'} by ${userName(x.approval?.approver ?? x.actor)}${channelPhrase(x.approval?.channel)}`) : x.kind === 'outcome' ? `Outcome ${x.outcome?.status ?? ''}` : x.action,
          }))} />
        </Panel>

        <Panel title="Connected records" flush>
          {links.error && <div className="px-5 py-3"><Banner tone="bad">{links.error.message}</Banner></div>}
          <ul className="divide-y divide-line text-sm">
            {r.agent && <LinkRow icon={<Bot className="h-4 w-4" />} label="Agent" to={`/agents/${r.agent}`} value={links.data?.agent?.name ?? r.agent} />}
            {r.rulebook && r.agent && <LinkRow icon={<BookOpen className="h-4 w-4" />} label="Rulebook" to={`/rulebooks/${r.agent}?version=${r.rulebook.version}`} value={`Version ${r.rulebook.version}`} />}
            {links.data?.system && <LinkRow icon={<ClipboardCheck className="h-4 w-4" />} label="AI system" to={`/inventory/${links.data.system.id}`} value={links.data.system.name} />}
            {links.data?.assessment && <LinkRow icon={<FileWarning className="h-4 w-4" />} label="Assessment" to={`/assessments/${links.data.assessment.id}`} value={`${links.data.assessment.template.replace('_', ' ')} · ${links.data.assessment.status.replace('_', ' ')}`} />}
            {data.checkpoint ? <LinkRow icon={<Stamp className="h-4 w-4" />} label="Checkpoint" to="/evidence" value={`${seqLabel(data.checkpoint.seq)} · ${dateTime(data.checkpoint.ts)}`} />
              : <LinkRow icon={<Stamp className="h-4 w-4" />} label="Checkpoint" to="/evidence" value="Not yet covered" />}
            {a?.proof && <LinkRow icon={<Layers className="h-4 w-4" />} label="Batch" to="/assurance/anchors" value={a.proof.batchId} />}
          </ul>
          <div className="border-t border-line px-5 py-3">
            <p className="label mb-2">Counts as evidence for</p>
            {links.loading && !links.data ? <Skeleton className="h-16" /> : (
              <ul className="space-y-1.5">
                {(links.data?.controls ?? []).map((c) => (
                  <li key={c.id} className="flex items-baseline gap-2 text-sm min-w-0"><SmartLink to={c.to} plainClassName="font-mono text-[12px] shrink-0" className="font-mono text-[12px] hover:underline underline-offset-2 shrink-0">{c.id}</SmartLink><span className="text-muted truncate">{c.name}</span>{c.framework && <span className="text-xs text-subtle shrink-0">{c.framework}</span>}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-subtle">Coverage is a count of receipts, not a test that a control works.</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}

/** What this receipt's evidence shows at its level, and what was shared around it. */
function AssurancePanel({ r, as, onTab }: { r: Receipt; as: Assurance; onTab: (t: TabId) => void }) {
  const a = as.data;
  if (!a) return <Panel title="Assurance">{as.error ? <p className="text-sm text-bad-fg">{as.error.message}</p> : <Skeleton className="h-28" />}</Panel>;
  const sealed = a.seal.sealed;
  const anchored = sealed ? !!a.proof : undefined;
  return (
    <Panel title="Assurance" kicker="At the time it was written" actions={<LevelTag level={a.level} />}>
      <p className="text-sm">{claimFor(a.level, { anchored })}</p>
      <ul className="mt-3 space-y-2 text-sm">
        {/* Seal v6 and timestamps are part of L2: below it these rows are left out */}
        {(sealed || levelRank(a.state.level) >= 1) && <li className="flex items-start justify-between gap-3"><span className="text-muted">Sealed (Seal v6)</span>{sealed ? <button type="button" onClick={() => onTab('seal')} className="underline underline-offset-2">16 fields</button> : <span className="text-muted">Before the boundary</span>}</li>}
        {(sealed || levelRank(a.state.level) >= 1) && <li className="flex items-start justify-between gap-3"><span className="text-muted">Timestamped</span>{anchored ? <span>{a.proof!.tokens.length} authorities{a.batchStatus === 'late' ? ' (late)' : ''}</span> : <span className="text-muted">{sealed ? 'Batch still open' : '—'}</span>}</li>}
        <li className="flex items-start justify-between gap-3"><span className="text-muted">Key</span><span className="text-right">{isInterimKid(r.org, r.kid) ? 'Elan1 Govern interim chain key · not your key' : r.kid === a.custody.kid ? CUSTODY_MODE_LABEL[a.custody.mode] : custodyAtLevel(a.level).holder}</span></li>
        {a.autonomy.applies && <li className="flex items-start justify-between gap-3"><span className="text-muted">Autonomy at decision time</span><StatusChip tone={a.autonomy.hasGrant ? 'neutral' : 'held'} size="sm">{a.autonomy.label}</StatusChip></li>}
      </ul>
      {(a.issued.length > 0 || a.disclosures.length > 0 || a.received.length > 0) && (
        <div className="mt-4 border-t border-line pt-3 space-y-2 text-sm">
          {a.issued.map((x) => (
            <p key={x.id} className="flex flex-wrap items-center gap-x-2 gap-y-1"><Send className="h-3.5 w-3.5 text-muted" aria-hidden />Issued to <span className="font-medium">{x.counterpartyName}</span>
              {x.token && <Link to={`/counterparty/${x.token}`} target="_blank" className="inline-flex items-center gap-0.5 underline underline-offset-2">portal<ArrowUpRight className="h-3 w-3" /></Link>}</p>
          ))}
          {a.disclosures.map((d) => (
            <p key={d.id} className="flex flex-wrap items-center gap-x-2"><EyeOff className="h-3.5 w-3.5 text-muted" aria-hidden />Disclosed to <span className="font-mono text-xs">{d.audience}</span> · {d.revealed.length} of {d.committed.length} fields{d.status !== 'active' && <Badge>{d.status}</Badge>} <SmartLink to="/assurance/disclosure" hideWhenBlocked className="underline underline-offset-2">Disclosure</SmartLink></p>
          ))}
          {a.received.map((x) => <p key={x.id} className="flex flex-wrap items-center gap-x-2"><Link2 className="h-3.5 w-3.5 text-muted" aria-hidden />Received from <span className="font-medium">{x.issuerName}</span> · {x.verification.state}</p>)}
        </div>
      )}
      {levelRank(a.state.level) < 1 && <UpgradeHint className="mt-4" compact to="l2" title="Sealed and timestamped records start at L2 Attested.">Records from the upgrade on are sealed and timestamped by two authorities; this one stays sealed in a hash chain by Elan1 Govern.</UpgradeHint>}
    </Panel>
  );
}

/** A connected record: a link when this role and plan can open its screen, a plain row otherwise. */
function LinkRow({ icon, label, value, to }: { icon: ReactNode; label: string; value: ReactNode; to: string }) {
  const open = useCanSee(to);
  const body = (
    <>
      <span className="text-muted">{icon}</span>
      <span className="text-muted w-24 shrink-0">{label}</span>
      <span className="flex-1 min-w-0 truncate font-medium">{value}</span>
      {open && <ChevronRight className="h-4 w-4 text-subtle group-hover:text-fg" aria-hidden />}
    </>
  );
  return (
    <li>
      {open
        ? <Link to={to} className="flex items-center gap-3 px-5 py-2.5 hover:bg-sunken/60 group">{body}</Link>
        : <div className="flex items-center gap-3 px-5 py-2.5">{body}</div>}
    </li>
  );
}

/* ── Decision trace ───────────────────────────────────────── */

function knownLimits(level: string): string[] {
  const out = [
    'In a governed run an allowed action runs before its receipt is written.',
    'Calls rejected before the guard (bad key, rate limit) produce no receipt.',
    'Limits are counted outside the chain lock.',
  ];
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  if (level === 'l1') out.push('Sealed in a hash chain by Elan1 Govern and not externally timestamped: the key-holder could re-seal a rewritten chain.');
  else out.push('A receipt’s time is attested to within its 15-minute batch; the newest batch is unanchored until both authorities stamp it.');
  if (level === 'l3' || level === 'sovereign') out.push('Autonomy is applied after the rulebook and never relaxes a refusal. Revoking a grant changes future calls, not receipts already written.');
  if (level === 'sovereign') out.push('Your operators run the cluster and the timestamp authorities; elan1 sees nothing, so health is what your monitoring reports.');
  return out;
}

function TraceTab({ data, as }: { data: Loaded; as: Assurance }) {
  const r = data.receipt;
  const orgLevel = useOrgLevel();
  const ctx = useQuery(async (o) => {
    const [agent, connectors] = await Promise.all([r.agent ? api.agent(o, r.agent).then((x) => x.agent).catch(() => undefined) : Promise.resolve(undefined), api.connectors(o)]);
    return { agent, hasTool: connectors.some((c) => c.tools.some((t) => t.name === r.tool && t.enabled)) };
  }, [r.seq, r.agent], { kinds: ['agent', 'connector'] });
  if (r.kind !== 'decision') {
    const rootSeq = r.ref_seq;
    return (
      <Panel>
        <EmptyState title={r.kind === 'admin' ? 'Admin changes do not pass through the decision path' : `This ${r.kind} receipt answers an earlier decision`} disc="registration"
          action={rootSeq ? <NavButton to={`/activity/${rootSeq}?tab=trace`} variant="primary">Open the decision trace of {seqLabel(rootSeq)}</NavButton> : undefined}>
          {r.kind === 'admin' ? `A person changed the set-up from the console. The change is still ${levelRank(orgLevel) >= 1 ? 'signed and chained' : 'sealed in the hash chain'} like every other receipt.` : 'The decision path ran once, for the original call. This receipt records what happened next.'}
        </EmptyState>
      </Panel>
    );
  }
  const a = as.data;
  const lv = a?.level ?? orgLevel;
  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <Panel className="lg:col-span-8" title="The decision path for this call" kicker={`As built · ${traceStepCount(r, a?.packs)} steps`}>
        {ctx.error && <Banner tone="bad" className="mb-4">{ctx.error.message}</Banner>}
        {(ctx.loading && !ctx.data) || (as.loading && !a) ? <Skeleton className="h-96" /> : (
          <DecisionTrace r={r} agent={ctx.data?.agent} version={data.rulebook?.version} connectorsHaveTool={!!ctx.data?.hasTool} autonomy={a?.autonomy} packs={a?.packs} level={a?.level} orgLevel={orgLevel} />
        )}
      </Panel>
      <div className="lg:col-span-4 space-y-6">
        <Panel title="How to read this">
          <ul className="space-y-2.5 text-sm text-muted leading-relaxed">
            <li><span className="font-medium text-fg">One path for every call,</span> read or write. A tag rule governs tools Elan1 Govern has never seen.</li>
            <li><span className="font-medium text-fg">Default refuse.</span> Anything no rule allows is refused and recorded.</li>
            <li><span className="font-medium text-fg">Strictest wins.</span> Refuse beats ask beats allow; a limit can turn allow into ask, never loosen.</li>
            <li><span className="font-medium text-fg">No model decides.</span> decide() is pure logic over the {levelRank(lv) >= 1 ? 'signed' : 'published'} rules{levelRank(lv) >= 2 ? ', then the autonomy level in force (A2, or A3 after a two-person graduation)' : ''}.</li>
          </ul>
        </Panel>
        <Panel title="Known limits" kicker={LEVEL_INFO[lv].label} tone="sunken">
          <ul className="space-y-2 text-sm text-muted leading-relaxed list-disc pl-4">
            {knownLimits(lv).map((x) => <li key={x}>{x}</li>)}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

/* ── Signed receipt ───────────────────────────────────────── */

function SignedTab({ data, as }: { data: Loaded; as: Assurance }) {
  const r = data.receipt;
  const a = as.data;
  const role = useRole();
  const user = useUser();
  const orgLevel = useOrgLevel();
  const [result, setResult] = useState<ReceiptVerification>();
  const [tamper, setTamper] = useState<{ field: string; from: string; to: string; result: ReceiptVerification }>();
  const [share, setShare] = useState(false);
  const [issue, setIssue] = useState(false);
  const [verifying, setVerifying] = useState<string>();
  const signingKey = a?.signingKeys.find((k) => k.kid === r.kid);
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const w = sealWords(levelRank(a?.level ?? orgLevel) >= 1);
  const fp = fingerprintOf(data.publicKey);
  const related = data.related.find((x) => x.kind === 'approval' && x.ref_seq === r.seq);
  const canShare = role === 'owner' || role === 'admin';

  const ctx = () => ({
    publicKeys: a?.publicKeys ?? (data.publicKey ? { [r.kid]: data.publicKey } : {}), prev: data.prev, signingKeys: a?.signingKeys, checkpoint: data.checkpoint, between: a?.between,
    l2: a ? { level: a.level, l2Since: a.l2Since, seal: a.seal.sealed ? a.seal.seal : undefined, proof: a.proof, proofError: a.proofError, authorities: a.authorities } : undefined,
  });
  const verify = () => { setTamper(undefined); setResult(verifyReceipt(r, ctx())); };
  const tryTamper = () => {
    const copy: Receipt = JSON.parse(JSON.stringify(r));
    let field = 'reason', from = String(r.reason ?? ''), to = '';
    if (copy.args_summary && typeof copy.args_summary.amount === 'number') {
      field = 'args_summary.amount'; from = String(copy.args_summary.amount); copy.args_summary.amount = Number(copy.args_summary.amount) + 1; to = String(copy.args_summary.amount);
    } else if (copy.decision) {
      field = 'decision'; from = copy.decision; copy.decision = copy.decision === 'allow' ? 'refuse' : 'allow'; to = copy.decision;
    } else { copy.reason = `${copy.reason ?? ''} (edited)`; to = copy.reason; }
    setResult(undefined);
    setTamper({ field, from, to, result: verifyReceipt(copy, ctx()) });
  };
  const reverify = async (id: string) => {
    if (!user) return;
    setVerifying(id);
    try {
      const x = await api.verifyReceived(r.org, id, user.id);
      toast.ok(`Receipt from ${x.issuerName}: ${x.verification.state}`, `Recorded as ${seqLabel(x.boundSeq ?? 0)}.`);
      as.refetch();
    } catch (e) { toast.bad('Not verified', (e as Error).message); } finally { setVerifying(undefined); }
  };

  const custody = a?.custody;
  // sealed by Elan1 Govern's interim chain key during a key compromise: hash-chained, not signed with the organisation's key
  const interim = isInterimKid(r.org, r.kid);
  const current = !interim && custody && r.kid === custody.kid;
  const atLevel = custodyAtLevel(a?.level ?? 'l1');
  const ceremony = custody?.ceremonies.find((c) => c.kidAfter === r.kid);
  const anchored = a?.seal.sealed ? !!a.proof : undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-7 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted">The exact receipt object, as {w.signed}. The hash covers every field except <span className="font-mono">hash</span> and <span className="font-mono">sig</span>.</p>
          <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadText(`receipt-${r.org}-${r.seq}.json`, JSON.stringify(r, null, 2))}>Download JSON</Button>
        </div>
        <JsonView value={r} maxHeight={620} />

        {/* owners and admins share from L2 (owners below it see one line on the plan); everyone sees receipts received */}
        {canShare && levelRank(orgLevel) < 1 && !(a && a.received.length > 0) && (
          <UpgradeHint compact to="l2" title="Redacted sharing (SD-JWT) starts at L2 Attested.">Share a receipt revealing only the fields a reader needs; at L3, issue it to a counterparty who verifies it in their own portal. At L1 the whole receipt is shared, as above.</UpgradeHint>
        )}
        {((canShare && levelRank(orgLevel) >= 1) || (!!a && a.received.length > 0)) && (
          <Panel title="Share" kicker="Outside the organisation">
            {canShare && (levelRank(orgLevel) >= 1 ? (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" icon={<EyeOff className="h-3.5 w-3.5" />} onClick={() => setShare(true)}>Share with redaction</Button>
                  {levelRank(orgLevel) >= 2 && <Button size="sm" variant="secondary" icon={<Send className="h-3.5 w-3.5" />} onClick={() => setIssue(true)}>Issue to counterparty</Button>}
                </div>
                <p className="text-xs text-muted">Choose which of the 11 committed fields the recipient reads (SD-JWT, RFC 9901). Hidden fields stay bound by the signature.</p>
                {levelRank(orgLevel) < 2 && <UpgradeHint compact to="l3" title="Issuing receipts to counterparties and their portal start at L3 Proven.">Customers, vendors, insurers, lenders and regulators verify receipts you issue with your key; each holds a seat.</UpgradeHint>}
              </div>
            ) : (
              <UpgradeHint compact to="l2" title="Redacted sharing (SD-JWT) starts at L2 Attested.">Share a receipt revealing only the fields a reader needs; at L3, issue it to a counterparty who verifies it in their own portal. At L1 the whole receipt is shared, as above.</UpgradeHint>
            ))}
            {a && a.received.length > 0 && (
              <div className={cn('space-y-3', canShare && 'mt-4')}>
                {a.received.map((x) => <ReceivedCard key={x.id} x={x} verifying={verifying === x.id} onVerify={canShare ? () => reverify(x.id) : undefined} />)}
              </div>
            )}
          </Panel>
        )}
      </div>
      <div className="lg:col-span-5 space-y-6">
        <Panel title="Verify this receipt" kicker="In this browser">
          <p className="text-sm text-muted mb-4">Recomputes the SHA-256 hash over canonical JSON and checks the Ed25519 {w.signature} with the public key{a && levelRank(a.level) >= 1 ? ', then the seal, both timestamp tokens and the Merkle inclusion proof' : ''}. Nothing is sent to Elan1 Govern.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<ShieldCheck className="h-4 w-4" />} onClick={verify} disabled={as.loading && !a} loading={as.loading && !a}>Verify this receipt now</Button>
            <Button variant="ghost" onClick={tryTamper} disabled={as.loading && !a} title="Changes one field in a copy and verifies the copy">Try a tampered copy</Button>
          </div>
          {result && (
            <div className="mt-4 space-y-3">
              <VerdictLine verdict={result.verdict}>
                {result.verdict === 'verified' ? <>Unchanged since it was {w.signed}. {claimFor(a?.level ?? 'l1', { anchored })}</> : result.verdict === 'failed' ? 'At least one check failed — see below.' : `The signing key is not available, so the ${w.signature} cannot be checked.`}
              </VerdictLine>
              <CheckList checks={result.checks} grouped />
              <p className="text-xs text-muted num">Checked in {result.ms} ms.</p>
            </div>
          )}
          {tamper && (
            <div className="mt-4 space-y-3">
              <p className="text-sm">In a copy, <span className="font-mono">{tamper.field}</span> was changed from <span className="font-mono">{tamper.from || '—'}</span> to <span className="font-mono">{tamper.to}</span>. The stored receipt is untouched.</p>
              <VerdictLine verdict={tamper.result.verdict}>The copy no longer matches the hash that was {w.signed} — this is what tamper-evident means.</VerdictLine>
              <CheckList checks={tamper.result.checks} grouped />
            </div>
          )}
        </Panel>

        <Panel title={interim ? 'Interim chain key' : 'Signing key'} actions={interim ? <Badge tone="bad">Not the organisation’s key</Badge> : signingKey && <Badge tone={signingKey.status === 'active' ? 'ok' : signingKey.status === 'revoked' ? 'bad' : 'neutral'}>{signingKey.status === 'active' ? 'Active' : signingKey.status === 'revoked' ? 'Revoked' : 'Retired'}</Badge>}>
          {!a ? <Skeleton className="h-40" /> : (
            <>
              <KeyValue items={[
                { k: 'Key id', v: r.kid, mono: true },
                { k: 'Algorithm', v: 'Ed25519' },
                { k: 'Fingerprint', v: fp ? <span className="inline-flex items-center gap-1"><Fingerprint className="h-3.5 w-3.5 text-muted" aria-hidden /><span className="font-mono">{fp}</span><CopyButton text={fp} compact label="Copy fingerprint" /></span> : '—' },
                { k: 'Public key', v: <Hash value={data.publicKey} len={18} /> },
                { k: 'Held by', v: interim ? 'Elan1 Govern (interim chain key, while signing was off)' : current ? (custody!.heldBy === 'customer' ? 'The organisation (customer-held)' : custody!.mode === 'aws_kms' ? 'Elan1 Govern, in AWS KMS' : 'Elan1 Govern') : atLevel.holder },
                { k: 'Custody', v: interim ? 'Interim chain key · hash chain only, not the organisation’s key' : current ? `${custody!.provider}` : atLevel.where },
                ...(current ? [{ k: 'Location', v: custody!.location }, { k: 'Residency', v: custody!.residencyDomain }, { k: 'Key reference', v: <span className="font-mono text-[11.5px] break-all">{custody!.keyRef}</span> }] : []),
                ...(current && custody!.quorum ? [{ k: 'Quorum', v: `${custody!.quorum.required} of ${custody!.quorum.of} key holders` }] : []),
                ...(signingKey?.retiredAt ? [{ k: 'Retired', v: dateTime(signingKey.retiredAt) }] : []),
              ]} />
              {ceremony && (
                <div className="mt-3 border border-line p-3 text-sm">
                  <p className="font-medium flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" aria-hidden />Key ceremony · {ceremony.kind}</p>
                  <p className="text-xs text-muted mt-0.5">{dateTime(ceremony.at)} · quorum {ceremony.quorum} · {ceremony.participants.map((p) => p.name).join(', ')}{ceremony.hsmSerial ? ` · ${ceremony.hsmSerial}` : ''}</p>
                  {ceremony.seq && <Link to={`/activity/${ceremony.seq}`} className="mt-1 inline-flex items-center gap-1 text-xs font-medium hover:underline underline-offset-2">Ceremony receipt {seqLabel(ceremony.seq)} <ArrowRight className="h-3 w-3" /></Link>}
                </div>
              )}
              <p className="mt-3 text-xs text-muted leading-relaxed">{interim ? 'This receipt was written while signing was off after a declared key compromise. Elan1 Govern’s interim chain key linked it into the hash chain, so a change to it still shows, but it is not signed with the organisation’s key and this fingerprint is not one the organisation publishes.' : 'Compare this fingerprint with the one the organisation published out of band.'} {interim ? '' : current ? custody!.note : `This key is no longer the active key. When it ${w.signed} this receipt, it was held by ${atLevel.holder.toLowerCase().startsWith('the') ? atLevel.holder.charAt(0).toLowerCase() + atLevel.holder.slice(1) : atLevel.holder}.`} A receipt proves what the key {w.signed}, not who else saw it.</p>
              <SmartLink to="/agents/keys" hideWhenBlocked className="mt-2 inline-flex items-center gap-1 text-sm font-medium hover:underline underline-offset-2">Keys and custody <ArrowRight className="h-3.5 w-3.5" /></SmartLink>
            </>
          )}
        </Panel>
      </div>
      {canShare && <RedactedShareDialog open={share} onClose={() => setShare(false)} r={r} related={related} />}
      {canShare && levelRank(orgLevel) >= 2 && <IssueDialog open={issue} onClose={() => setIssue(false)} r={r} related={related} onIssued={as.refetch} />}
    </div>
  );
}

/* ── Chain neighbours ─────────────────────────────────────── */

function ChainCard({ r, current, label }: { r?: Receipt; current?: boolean; label: string }) {
  if (!r) {
    return (
      <div className="flex-1 min-w-0 border border-dashed border-line-strong bg-sunken/40 p-4 flex flex-col justify-center">
        <p className="label">{label}</p>
        <p className="mt-2 text-sm text-muted">{label === 'Next' ? 'Not written yet — this is the chain head.' : 'Before the window loaded here.'}</p>
      </div>
    );
  }
  const edge = r.decision === 'allow' ? 'border-t-ok' : r.decision === 'ask' ? 'border-t-held' : r.decision === 'refuse' ? 'border-t-bad' : 'border-t-line-strong';
  const body = (
    <div className={cn('h-full border border-t-[3px] bg-surface p-4', edge, current ? 'border-x-fg border-b-fg shadow-[0_0_0_1px_rgb(var(--fg))]' : 'border-x-line border-b-line hover:border-x-line-strong hover:border-b-line-strong')}>
      <div className="flex items-center justify-between gap-2">
        <p className="label">{label}</p>
        <DecisionChip decision={r.decision} size="sm" short />
      </div>
      <p className="mt-2 font-mono text-lg font-semibold">{seqLabel(r.seq)}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted"><KindMark kind={r.kind} className="text-xs" /><span>{dateTime(r.ts)}</span></div>
      <div className="mt-3 space-y-1.5">
        <div><p className="text-[10.5px] uppercase tracking-label text-subtle">prev_hash</p><p className="font-mono text-[11.5px] bg-sunken border border-line px-2 py-1 truncate" title={r.prev_hash}>{r.prev_hash.slice(0, 20)}…</p></div>
        <div><p className="text-[10.5px] uppercase tracking-label text-subtle">hash</p><p className="font-mono text-[11.5px] bg-sunken border border-fg/40 px-2 py-1 truncate" title={r.hash}>{r.hash.slice(0, 20)}…</p></div>
      </div>
    </div>
  );
  return <div className="flex-1 min-w-0">{current ? body : <Link to={`/activity/${r.seq}?tab=chain`} className="block h-full">{body}</Link>}</div>;
}

function Connector({ ok, show }: { ok?: boolean; show: boolean }) {
  return (
    <div className="relative flex items-center justify-center h-12 lg:h-auto lg:w-24 shrink-0" aria-hidden={!show}>
      <span className={cn('absolute left-1/2 top-0 bottom-0 w-px lg:left-0 lg:right-0 lg:top-1/2 lg:bottom-auto lg:w-auto lg:h-px', show ? (ok ? 'bg-fg/70' : 'bg-bad') : 'bg-line')} />
      {show ? (
        <span className={cn('relative z-[1] inline-flex items-center gap-1 text-[11px] px-1.5 h-5 border whitespace-nowrap', ok ? 'border-ok/40 bg-ok-bg text-ok-fg' : 'border-bad/40 bg-bad-bg text-bad-fg')}>
          <Link2 className="h-3 w-3" />{ok ? 'linked' : 'broken'}
        </span>
      ) : <ArrowDown className="relative lg:hidden h-3.5 w-3.5 text-subtle bg-surface" />}
    </div>
  );
}

function ChainTab({ data, as }: { data: Loaded; as: Assurance }) {
  const r = data.receipt;
  const a = as.data;
  const orgLevel = useOrgLevel();
  const prevOk = data.prev ? data.prev.hash === r.prev_hash : undefined;
  const nextOk = data.next ? data.next.prev_hash === r.hash : undefined;
  const cp = data.checkpoint;
  const boundary = a?.state.boundaries.find((b) => b.firstSeq === r.seq);
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const w = sealWords(levelRank(a?.level ?? orgLevel) >= 1);
  return (
    <div className="space-y-6">
      {boundary && <Banner tone="info" title={`This is the first receipt at ${LEVEL_INFO[boundary.to].label}`}>The organisation moved from {LEVEL_INFO[boundary.from].label} on {dateTime(boundary.at)}. {boundary.recordsBefore} records before keep {LEVEL_INFO[boundary.from].short} rules; {boundary.recordsAfter} from here are {boundary.to === 'l1' ? 'sealed in a hash chain' : 'sealed and timestamped'}.</Banner>}
      <Panel title="Where this receipt sits in the chain" kicker="Each receipt names the hash of the one before it">
        <div className="flex flex-col lg:flex-row items-stretch">
          <ChainCard r={data.prev} label="Previous" />
          <Connector ok={prevOk} show={!!data.prev} />
          <ChainCard r={r} current label="This receipt" />
          <Connector ok={nextOk} show={!!data.next} />
          <ChainCard r={data.next} label="Next" />
        </div>
        <div className="mt-5 grid gap-px bg-line border border-line sm:grid-cols-2">
          <div className="bg-surface p-4 text-sm">
            <p className="label mb-1">Link to the previous receipt</p>
            {data.prev ? <p className="text-muted">The hash of <span className="font-mono text-fg">{seqLabel(data.prev.seq)}</span> is <span className="font-mono text-fg">{data.prev.hash.slice(0, 12)}…</span>; this receipt’s prev_hash is <span className="font-mono text-fg">{r.prev_hash.slice(0, 12)}…</span>. {prevOk ? 'They match.' : 'They do not match.'}</p> : <p className="text-muted">The receipt before is outside this window.</p>}
          </div>
          <div className="bg-surface p-4 text-sm">
            <p className="label mb-1">Link to the next receipt</p>
            {data.next ? <p className="text-muted"><span className="font-mono text-fg">{seqLabel(data.next.seq)}</span> names <span className="font-mono text-fg">{data.next.prev_hash.slice(0, 12)}…</span> as its prev_hash. {nextOk ? 'It matches this receipt’s hash.' : 'It does not match.'}</p> : <p className="text-muted">No receipt follows yet. Changing this one later would break the next link and every checkpoint after it.</p>}
          </div>
        </div>
      </Panel>

      <Panel title="Checkpoint" kicker={w.signed === 'signed' ? 'Signed chain head' : 'Sealed chain head'} actions={<NavButton to={`/activity/chain?at=${r.seq}`} size="sm" icon={<Waypoints className="h-3.5 w-3.5" />}>Chain explorer</NavButton>}>
        {cp ? (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] items-start">
            <div>
              <p className="text-sm">Covered by the checkpoint at <ReceiptLink seq={cp.seq} />, {w.signed} {dateTime(cp.ts)} by <span className="font-mono">{cp.kid}</span>{cp.onDemand ? ' (on demand)' : ' (hourly)'}.</p>
              <p className="mt-1 text-sm text-muted">The checkpoint {w.signed === 'signed' ? 'signs' : 'seals'} the chain head; walking {cp.seq - r.seq} links forward from this receipt reaches the hash it names. That catches a cut-off tail as well as an edited receipt.</p>
            </div>
            <Hash value={cp.hash} len={16} />
          </div>
        ) : (
          <Banner tone="held" title={`Not yet covered by a ${w.signed} checkpoint`} actions={<NavButton to="/evidence" size="sm">Go to evidence</NavButton>}>
            This receipt is newer than the last checkpoint. Checkpoints are {w.signed} every hour when the chain moves, or on demand from Evidence.
          </Banner>
        )}
      </Panel>

      {!a ? <Skeleton className="h-40" /> : a.seal.sealed ? (
        <AnchoredPanel r={r} proof={a.proof} proofError={a.proofError} authorities={a.authorities} status={a.batchStatus} />
      ) : levelRank(a.state.level) < 1 ? (
        <UpgradeHint to="l2" title="Merkle batches and timestamps from two authorities start at L2 Attested.">At L2 every 15-minute batch of receipts becomes an RFC 6962 Merkle tree whose root eMudhra and a global authority timestamp; each receipt gets an inclusion proof shown here.</UpgradeHint>
      ) : (
        <Panel title="Anchored"><p className="text-sm text-muted">Written before the L2 boundary: it is covered by the hash chain and the checkpoints above, not by a timestamped batch.</p></Panel>
      )}
    </div>
  );
}

/* ── Rule version ─────────────────────────────────────────── */

function RuleTab({ data }: { data: Loaded }) {
  const r = data.receipt;
  const [full, setFull] = useState(false);
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided: an L1 rulebook version is "published".
  const signedLevel = levelRank(useOrgLevel()) >= 1;
  const version = data.rulebook?.version;
  if (r.kind === 'admin') return <Panel><EmptyState title="No rule decided this receipt" disc="registration">Admin changes are recorded, not decided by a rulebook.</EmptyState></Panel>;
  if (!r.rule_id) {
    return (
      <Panel>
        <EmptyState title={`This ${r.kind} receipt has no rule of its own`} disc="registration" action={r.ref_seq ? <NavButton to={`/activity/${r.ref_seq}?tab=rule`} variant="primary">See the rule on {seqLabel(r.ref_seq)}</NavButton> : undefined}>
          The rule that held the call is on the original decision receipt.
        </EmptyState>
      </Panel>
    );
  }
  // a rule id the guard writes itself always shows its own explanation, never the "version not held" banner
  const system: string | undefined = isGuardRule(r.rule_id) ? SYSTEM_RULES[r.rule_id] : undefined;
  const snippet = version ? ruleSnippet(version.yaml, r.rule_id) ?? (data.rule ? stringify([data.rule]) : undefined) : data.rule ? stringify([data.rule]) : undefined;
  const hashOk = version && r.rulebook ? version.hash === r.rulebook.hash : undefined;
  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-7 space-y-4">
        {system ? (
          <>
            <Banner tone="neutral" title={<>System rule <span className="font-mono">{r.rule_id}</span></>}>{system} It is part of the guard, not a line in the customer’s rulebook.</Banner>
            <CodeBlock title="Rulebook default" language="yaml" code={systemRuleIdsYaml()} />
          </>
        ) : snippet ? (
          <CodeBlock title={`rules → ${r.rule_id}`} language="yaml" code={snippet} />
        ) : (
          <Banner tone="held" title="Rule text not available">Version {r.rulebook?.version} of this rulebook is not held in this organisation’s records.</Banner>
        )}
        {version && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setFull((f) => !f)}>{full ? 'Hide' : 'Show'} the whole {signedLevel ? 'signed' : 'published'} rulebook</Button>
            {full && <CodeBlock className="mt-2" title={`${data.rulebook?.slug} · version ${version.version}`} language="yaml" code={version.yaml} maxHeight={480} />}
          </div>
        )}
      </div>
      <div className="lg:col-span-5">
        <Panel title="Rulebook version" actions={data.rulebook && <NavButton to={`/rulebooks/${data.rulebook.slug}?version=${r.rulebook?.version ?? ''}`} size="sm" iconRight={<ArrowRight className="h-3.5 w-3.5" />}>Open</NavButton>}>
          {version ? (
            <>
              <KeyValue items={[
                { k: 'Rulebook', v: data.rulebook?.slug, mono: true },
                { k: 'Version', v: `${version.version}${version.status !== 'published' ? ` (${version.status})` : ''}` },
                { k: 'Hash', v: <Hash value={version.hash} len={16} /> },
                { k: 'Matches receipt', v: hashOk ? <Badge tone="ok">Yes</Badge> : <Badge tone="bad">No</Badge> },
                ...(version.signedBy ? [{ k: signedLevel ? 'Signed by' : 'Published by', v: <Person id={version.signedBy} size={20} /> }] : []),
                ...(version.signedAt ? [{ k: signedLevel ? 'Signed' : 'Published', v: dateTime(version.signedAt) }] : []),
                ...(version.reviewedBy ? [{ k: 'Reviewed by', v: <Person id={version.reviewedBy} size={20} /> }] : []),
              ]} />
              <p className="mt-3 text-sm text-muted">“{version.note}”</p>
            </>
          ) : r.rulebook ? (
            <KeyValue items={[{ k: 'Version', v: String(r.rulebook.version) }, { k: 'Hash', v: <Hash value={r.rulebook.hash} len={16} /> }]} />
          ) : <p className="text-sm text-muted">No rulebook version is named on this receipt.</p>}
        </Panel>
      </div>
    </div>
  );
}
