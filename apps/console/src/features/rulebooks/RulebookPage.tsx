import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Save, Undo2, Lightbulb, Boxes, AlertTriangle, ArrowRight, CircleDot, Users } from 'lucide-react';
import type { Agent, Rule, Rulebook, RulebookVersion, RuleSuggestion } from '@/types';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { ROLE_INFO } from '@/lib/permissions';
import { n, plural } from '@/lib/format';
import { Banner, Button, Dialog, Field, Hash, PageHeader, Select, Skeleton, StatusChip, Tabs, Textarea, toast } from '@/components/ui';
import { AgentLink, AgentStatus, Person, RouteMode, When } from '@/components/domain';
import { draftOf, nextVersionNo, publishedOf, registerOrg, rulesKey, type Problem } from './lib';
import { dualControl, namedLists, orgTools } from '@/features/work/backend';
import { LevelBadge } from '@/features/work/level';
import { NO_EXTRAS, buildYaml, finalYaml, parseRulebookYaml, type Extras, type YamlCtx } from './yamlSync';
import { DefaultRefuseChip, VersionStatus } from './parts';
import { RulesTab, type RuleHits } from './RulesTab';
import { YamlTab } from './YamlTab';
import { TryTab, argsForRule } from './TryTab';
import { TestTab, type TestRun } from './TestTab';
import { VersionsTab } from './VersionsTab';
import { PublishTab } from './PublishTab';
import { SmartLink } from '@/shell/access';

type TabKey = 'rules' | 'yaml' | 'try' | 'test' | 'versions' | 'publish';
const TABS: TabKey[] = ['rules', 'yaml', 'try', 'test', 'versions', 'publish'];

interface Working { rules: Rule[]; extras: Extras; yaml: string; problems: Problem[]; yamlOk: boolean }

export default function RulebookPage() {
  const { slug = '' } = useParams();
  const q = useQuery((o) => api.rulebook(o, slug), [slug], { kinds: ['rulebook', 'agent'] });

  if (q.error) {
    return (
      <>
        <PageHeader kicker="Records" title="Rulebook not found" crumbs={[{ label: 'Rulebooks', to: '/rulebooks' }, { label: slug }]} />
        <Banner tone="bad" title="This rulebook could not be loaded" actions={<Link to="/rulebooks" className="link text-sm">All rulebooks</Link>}>{q.error.message}</Banner>
      </>
    );
  }
  if (q.loading || !q.data) {
    return (
      <div aria-busy="true" aria-label="Loading rulebook">
        <Skeleton className="h-4 w-40 mb-4" />
        <Skeleton className="h-9 w-80 mb-3" />
        <Skeleton className="h-4 w-[60%] mb-8" />
        <Skeleton className="h-10 w-full mb-6" />
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-36 w-full" />)}</div>
      </div>
    );
  }
  if (!q.data.agent) return <Banner tone="bad" title="This rulebook has no agent">Every rulebook belongs to one agent.</Banner>;
  return <Editor key={slug} rb={q.data.rulebook} agent={q.data.agent} suggestions={q.data.suggestions} />;
}

function Editor({ rb, agent, suggestions }: { rb: Rulebook; agent: Agent; suggestions: RuleSuggestion[] }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const level = useOrgLevel();
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided: an L1 version is sealed and published.
  const sl = level !== 'l1';
  const canEdit = useCan('rulebooks.edit');
  const canPublish = useCan('rulebooks.publish');
  // the editor knows this organisation's tools (catalogue and connector tools) and approver groups
  const groups = useMemo(() => api.approverGroups(orgId), [orgId]);
  registerOrg(orgTools(orgId), groups);
  const listsQ = useQuery(async (o) => namedLists(o), [], { kinds: ['receipt'] });
  const lists = listsQ.data;
  const dc = dualControl(orgId);
  const reviewsQ = useQuery((o) => api.reviews(o), [], { kinds: ['receipt', 'rulebook'] });
  const readOnlyReason = canEdit ? undefined : `Owners and admins edit rulebooks; ${role ? ROLE_INFO[role].label.toLowerCase() + 's' : 'your role'} can read them.`;
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab') as TabKey | null;
  const tab: TabKey = tabParam && TABS.includes(tabParam) ? tabParam : 'rules';
  const setTab = useCallback((t: TabKey) => setParams((p) => { const x = new URLSearchParams(p); x.set('tab', t); return x; }, { replace: true }), [setParams]);

  const published = publishedOf(rb);
  const draft = draftOf(rb);
  const N = nextVersionNo(rb);
  const base: RulebookVersion = draft ?? published ?? rb.versions[rb.versions.length - 1];
  const ctx: YamlCtx = useMemo(() => ({ slug: rb.slug, version: N, owner: agent.ownerId, approverIds: rb.approverGroups.map((g) => g.id), groups, lists }), [rb.slug, N, agent.ownerId, rb.approverGroups, groups, lists]);

  const baseParsed = useMemo(() => {
    const p = parseRulebookYaml(base.yaml, { ...ctx, version: base.version });
    return p.ok ? { rules: p.rules, extras: p.extras } : { rules: base.rules, extras: NO_EXTRAS };
  }, [base.yaml, base.version, base.rules, ctx]);
  const baseSig = `${rulesKey(baseParsed.rules)}|${JSON.stringify(baseParsed.extras)}`;
  const init = useCallback((): Working => ({ rules: baseParsed.rules, extras: baseParsed.extras, yaml: base.yaml, problems: [], yamlOk: true }), [baseParsed, base.yaml]);

  const [w, setW] = useState<Working>(init);
  // ?version=N (receipt and drawer links) opens the published version that decided the receipt
  const versionParam = params.get('version');
  const versionFromUrl = useCallback((raw: string | null): 'working' | number => {
    if (!raw) return 'working';
    const v = Number(raw.replace(/^v/i, ''));
    return Number.isInteger(v) && rb.versions.some((x) => x.version === v && x.status === 'published') ? v : 'working';
  }, [rb.versions]);
  const [viewV, setViewV] = useState<'working' | number>(() => versionFromUrl(versionParam));
  const lastVersionParam = useRef(versionParam);
  useEffect(() => {
    if (lastVersionParam.current === versionParam) return;
    lastVersionParam.current = versionParam;
    setViewV(versionFromUrl(versionParam));
  }, [versionParam, versionFromUrl]);
  const versionMissing = versionParam !== null && versionFromUrl(versionParam) === 'working';
  const baseId = `${rb.id}:${base.version}:${base.hash}`;
  const lastBase = useRef(baseId);
  useEffect(() => {
    if (lastBase.current === baseId) return;
    lastBase.current = baseId;
    setW(init());
    setViewV('working');
  }, [baseId, init]);

  const workKey = rulesKey(w.rules);
  const dirty = w.yaml !== base.yaml || `${workKey}|${JSON.stringify(w.extras)}` !== baseSig;

  // unsaved-changes guard for reloads and closing the tab
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const onBuilder = (rules: Rule[], extras: Extras) => setW({ rules, extras, yaml: buildYaml(ctx, rules, extras), problems: [], yamlOk: true });

  const parseTimer = useRef<number>();
  const onYaml = (text: string) => {
    setW((prev) => ({ ...prev, yaml: text }));
    window.clearTimeout(parseTimer.current);
    parseTimer.current = window.setTimeout(() => {
      const p = parseRulebookYaml(text, ctx);
      setW((prev) => (prev.yaml !== text ? prev : p.ok ? { ...prev, rules: p.rules, extras: p.extras, problems: p.problems, yamlOk: true } : { ...prev, problems: p.problems, yamlOk: false }));
    }, 300);
  };
  useEffect(() => () => window.clearTimeout(parseTimer.current), []);

  const viewing = viewV === 'working' ? undefined : rb.versions.find((v) => v.version === viewV);
  const shownVersion = viewing ?? draft ?? published;

  const [testRun, setTestRun] = useState<TestRun>();
  const [seed, setSeed] = useState<{ tool: string; args: Record<string, string>; n: number }>();
  const [saveOpen, setSaveOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  const restore = (v: RulebookVersion) => {
    const p = parseRulebookYaml(v.yaml, { ...ctx, version: v.version });
    const rules = p.ok ? p.rules : v.rules;
    const extras = p.ok ? p.extras : NO_EXTRAS;
    onBuilder(rules, extras);
    setViewV('working');
    setTab('rules');
    toast.info(`Version ${v.version} copied into the draft`, `Save the draft, test it and publish it as version ${N} to roll back.`);
  };

  // decisions per rule in the last 30 days, and approvals waiting per rule
  const hitsQ = useQuery((o) => api.receipts(o, { agent: rb.slug, kind: 'decision', from: Date.now() - 30 * 864e5 }), [rb.slug], { live: false });
  const apprQ = useQuery((o) => api.approvals(o), [], { kinds: ['approval'] });
  const hits: RuleHits = useMemo(() => {
    const out: RuleHits = {};
    for (const r of hitsQ.data?.items ?? []) {
      const k = r.rule_id ?? 'default';
      const cur = (out[k] ??= { count: 0, last: r.ts });
      cur.count++;
    }
    const items = hitsQ.data?.items;
    if (items) out.__total = { count: items.length, last: items[0]?.ts };
    return out;
  }, [hitsQ.data]);
  const pendingByRule = useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of apprQ.data ?? []) if (a.agentSlug === rb.slug && a.status === 'pending') out[a.ruleId] = (out[a.ruleId] ?? 0) + 1;
    return out;
  }, [apprQ.data, rb.slug]);

  const fromSuggestion = draft && /suggestion/i.test(draft.note) ? suggestions.find((s) => s.status === 'drafted' && draft.rules.some((r) => r.id === s.proposed.id)) : undefined;
  const totalPending = Object.values(pendingByRule).reduce((a, b) => a + b, 0);

  const shownRules = viewing ? viewing.rules : w.rules;
  const shownExtras = viewing ? (parseRulebookYaml(viewing.yaml, { ...ctx, version: viewing.version }).extras) : w.extras;

  const versionOptions = [
    { value: 'working', label: `v${N} · ${draft ? (draft.status === 'in_review' ? 'in review' : 'draft') : 'new draft'}${dirty ? ' · unsaved' : ''}` },
    ...rb.versions.filter((v) => v.status === 'published').sort((a, b) => b.version - a.version).map((v) => ({ value: String(v.version), label: `v${v.version} · ${v.version === rb.currentVersion ? 'published, live' : 'published'}` })),
  ];

  const yamlErrors = w.problems.filter((p) => p.level === 'error').length;
  const pendingReview = (reviewsQ.data ?? []).find((r) => r.rulebookId === rb.id && r.version === N && r.status === 'pending');
  const approvedReview = (reviewsQ.data ?? []).find((r) => r.rulebookId === rb.id && r.version === N && r.status === 'approved');

  return (
    <div className="overflow-x-clip">
      <PageHeader
        kicker="Records"
        crumbs={[{ label: 'Rulebooks', to: '/rulebooks' }, { label: rb.slug }]}
        title={<span className="inline-flex flex-wrap items-baseline gap-x-3">{agent.name} rulebook <span className="font-mono text-lg font-medium text-muted">v{shownVersion?.version}</span></span>}
        // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
        description={`One rulebook per agent. Every published version is ${sl ? 'signed' : 'sealed'} and verified on every call. Anything no rule allows is refused.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="rb-version" className="sr-only">Version</label>
            <div className="w-[230px]"><Select id="rb-version" size_="sm" value={String(viewV)} onChange={(e) => setViewV(e.target.value === 'working' ? 'working' : Number(e.target.value))}>{versionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></div>
            {canEdit ? (
              <Button size="sm" variant="primary" icon={<Save className="h-4 w-4" />} disabled={!dirty || !w.yamlOk} onClick={() => setSaveOpen(true)} title={!w.yamlOk ? 'Fix the YAML errors first' : undefined}>Save draft</Button>
            ) : null}
          </div>
        }
        meta={
          <>
            <AgentLink slug={agent.slug} />
            <AgentStatus agent={agent} />
            <RouteMode route={agent.route} compact />
            {shownVersion && <VersionStatus status={shownVersion.status} />}
            <DefaultRefuseChip />
            <LevelBadge level={level} />
            {dc.enforced
              ? <StatusChip tone="info" size="sm" icon={<Users className="h-3 w-3" aria-hidden />}>Dual control required{dc.enforcedByLevel ? ` (${level === 'sovereign' ? 'SOV' : level.toUpperCase()})` : ' (policy)'}</StatusChip>
              : <StatusChip tone="neutral" size="sm" icon={<Users className="h-3 w-3" aria-hidden />}>Review recorded (L1)</StatusChip>}
            {agent.aiSystemId && <Link to={`/inventory/${agent.aiSystemId}`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg"><Boxes className="h-3.5 w-3.5" aria-hidden />AI system</Link>}
            {totalPending > 0 && <SmartLink to="/approvals" plainClassName="text-xs text-held-fg" className="text-xs text-held-fg hover:underline">{plural(totalPending, 'approval')} waiting</SmartLink>}
          </>
        }
      />

      <div className="mb-6 grid gap-px bg-line border border-line sm:grid-cols-2 lg:grid-cols-4">
        <div className="bg-surface px-4 py-3 min-w-0">
          <p className="label mb-1.5">{sl ? 'Signed by' : 'Published by'}</p>
          {shownVersion?.signedBy ? <span className="flex flex-wrap items-center gap-2"><Person id={shownVersion.signedBy} size={20} /><When iso={shownVersion.signedAt} className="text-xs text-muted" /></span> : <span className="text-sm text-muted">Not {sl ? 'signed' : 'published'} — {shownVersion?.status === 'in_review' ? 'in review' : 'draft'}</span>}
        </div>
        <div className="bg-surface px-4 py-3 min-w-0">
          <p className="label mb-1.5">Reviewed by</p>
          {shownVersion?.reviewedBy ? <Person id={shownVersion.reviewedBy} size={20} />
            : shownVersion?.status === 'published' ? <span className="text-sm text-muted">No review recorded</span>
              : approvedReview ? <Person id={approvedReview.reviewerId} size={20} />
                : pendingReview ? <span className="text-sm text-muted">Waiting for a second person<SmartLink to="/work/reviews?kind=rulebook_review&show=all" hideWhenBlocked className="link"><span className="text-muted no-underline"> · </span>Reviews</SmartLink></span>
                  : <span className="text-sm text-muted">Not sent for review yet</span>}
        </div>
        <div className="bg-surface px-4 py-3 min-w-0">
          <p className="label mb-1.5">{shownVersion?.status === 'published' ? (sl ? 'Signed hash' : 'Published hash') : 'Draft hash'}</p>
          <Hash value={shownVersion?.hash} len={16} />
        </div>
        <div className="bg-surface px-4 py-3 min-w-0">
          <p className="label mb-1.5">Live version</p>
          <span className="text-sm"><span className="font-mono">v{published?.version}</span> · {plural(published?.rules.length ?? 0, 'rule')} · <When iso={published?.signedAt} className="text-muted" /></span>
        </div>
      </div>

      {fromSuggestion && draft && (
        <Banner tone="info" className="mb-6" title={`Draft v${draft.version} started from a rule suggestion`}
          actions={<Link to="/rulebooks/suggestions?tab=drafted" className="inline-flex items-center gap-1 text-sm font-medium hover:underline">Suggestion <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>}>
          <span className="inline-flex items-start gap-1.5"><Lightbulb className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden /><span><span className="font-medium">{fromSuggestion.title}.</span> {fromSuggestion.evidence.approvals} approvals over {fromSuggestion.evidence.days} days across {plural(fromSuggestion.evidence.counterparties, 'counterparty', 'counterparties')}, {fromSuggestion.evidence.rejections} rejected. Opened as a draft by <Person id={draft.createdBy} size={16} className="align-middle" /> <When iso={draft.createdAt} />. A suggestion never publishes itself.</span></span>
        </Banner>
      )}

      {!canEdit && (
        <Banner tone="neutral" className="mb-6" title="Read only">{readOnlyReason} You can still try actions and test the draft on past actions — neither writes anything.</Banner>
      )}

      {versionMissing && (
        <Banner tone="held" className="mb-6" title={`Version ${versionParam} is not a published version of this rulebook`}>
          Showing the working draft instead. Choose a published version from the version menu to read it.
        </Banner>
      )}

      {(hitsQ.error || apprQ.error) && (
        <Banner tone="bad" className="mb-6" title="Some figures could not be loaded" actions={<Button size="sm" variant="secondary" onClick={() => { hitsQ.refetch(); apprQ.refetch(); }}>Try again</Button>}>
          {hitsQ.error ? `Decisions per rule: ${hitsQ.error.message} ` : ''}{apprQ.error ? `Approvals waiting per rule: ${apprQ.error.message}` : ''} The rules themselves are shown as saved.
        </Banner>
      )}

      <Tabs label="Rulebook sections" value={tab} onChange={setTab} className="mb-6" items={[
        { value: 'rules', label: 'Rules', count: shownRules.length },
        { value: 'yaml', label: <span className="inline-flex items-center gap-1.5">YAML{!w.yamlOk && <AlertTriangle className="h-3.5 w-3.5 text-bad-fg" aria-label="has errors" />}</span> },
        { value: 'try', label: 'Try an action' },
        { value: 'test', label: <span className="inline-flex items-center gap-1.5">Test on past actions{testRun && testRun.key === workKey && <CircleDot className="h-3 w-3 text-ok-fg" aria-label="tested" />}</span> },
        { value: 'versions', label: 'Versions', count: rb.versions.length },
        { value: 'publish', label: 'Publish' },
      ]} />

      <div role="tabpanel" aria-label={tab}>
        {tab === 'rules' && (
          <RulesTab rules={shownRules} extras={shownExtras} editable={canEdit} readOnlyReason={readOnlyReason} publishedRules={published?.rules} publishedVersion={published?.version}
            agent={agent} hits={hits} pendingByRule={pendingByRule} onChange={onBuilder} lists={lists ?? {}}
            onListsChanged={(next) => { listsQ.refetch(); if (canEdit && !viewing) setW((prev) => ({ ...prev, yaml: buildYaml({ ...ctx, lists: next }, prev.rules, prev.extras), problems: [], yamlOk: true })); }}
            viewing={viewing ? { version: viewing, onRestore: canEdit && viewing.status === 'published' ? () => restore(viewing) : undefined } : undefined}
            onTry={(r) => { const ex = argsForRule(r, agent.tools, lists ?? {}); setSeed({ ...ex, n: Date.now() }); setTab('try'); }} />
        )}
        {tab === 'yaml' && (
          <YamlTab yaml={viewing ? viewing.yaml : w.yaml} onChange={onYaml} readOnly={!canEdit || !!viewing} readOnlyReason={viewing && canEdit ? `Version ${viewing.version} is read only. Choose the working draft to edit.` : undefined}
            problems={viewing ? [] : w.problems} yamlOk={viewing ? true : w.yamlOk} extras={shownExtras} rules={shownRules} versionLabel={viewing ? `v${viewing.version}` : `v${N} draft`} />
        )}
        {tab === 'try' && <TryTab rules={w.rules} publishedRules={published?.rules} publishedVersion={published?.version} draftVersionNo={N} agent={agent} seed={seed} lists={lists ?? {}} />}
        {tab === 'test' && <TestTab slug={rb.slug} rules={w.rules} rulesKey={workKey} publishedRules={published?.rules} publishedVersion={published?.version} draftVersionNo={N} run={testRun} onRun={setTestRun} />}
        {tab === 'versions' && <VersionsTab rb={rb} working={{ yaml: w.yaml, rules: w.rules, dirty }} draftVersionNo={N} canEdit={canEdit} onRestore={restore} onView={(v) => { setViewV(v === N && draft ? 'working' : v); setTab('rules'); }} />}
        {tab === 'publish' && (
          <PublishTab rb={rb} agent={agent} rules={w.rules} extras={w.extras} yaml={finalYaml(w.yaml, ctx, w.rules, w.extras)} yamlOk={w.yamlOk} dirty={dirty} draft={draft} draftVersionNo={N} published={published}
            testRun={testRun} rulesKey={workKey} canPublish={canPublish} readOnlyReason={canPublish ? undefined : `Owners and admins ${sl ? 'sign and publish' : 'publish'}; ${role ? ROLE_INFO[role].label.toLowerCase() + 's' : 'your role'} can read the checks.`}
            suggestion={fromSuggestion} goTab={setTab} onPublished={() => setViewV('working')} reviews={reviewsQ.data ?? []} onReviewsChanged={reviewsQ.refetch} />
        )}
      </div>

      {dirty && canEdit && (
        <div className="sticky bottom-4 z-40 mt-8" role="region" aria-label="Unsaved changes">
          <div>
            <div className="flex flex-wrap items-center gap-3 border border-ink-700 bg-ink-800 text-paper px-4 py-3 shadow-e4 animate-rise-in">
              <span className="h-2 w-2 bg-ember shrink-0" aria-hidden />
              <span className="text-sm font-medium">Unsaved changes to draft v{N}</span>
              <span className="text-sm text-ink-300 hidden sm:inline">{rulesChangedText(baseParsed.rules, w.rules)} · nothing changes for {rb.slug} until a version is {sl ? 'signed and published' : 'published'}</span>
              {!w.yamlOk && <span className="text-sm text-ember">{plural(yamlErrors, 'YAML error')}</span>}
              <span className="ml-auto flex gap-2">
                <Button size="sm" variant="ghost" className="text-paper hover:bg-ink-700" icon={<Undo2 className="h-4 w-4" />} onClick={() => setDiscardOpen(true)}>Discard</Button>
                <Button size="sm" variant="inverse" icon={<Save className="h-4 w-4" />} disabled={!w.yamlOk} onClick={() => setSaveOpen(true)}>Save draft</Button>
              </span>
            </div>
          </div>
        </div>
      )}

      <SaveDraftDialog open={saveOpen} onClose={() => setSaveOpen(false)} draft={draft} version={N} signedLevel={sl}
        onSave={async (note) => {
          if (!user) return;
          await api.saveDraft(orgId, rb.id, finalYaml(w.yaml, ctx, w.rules, w.extras), w.rules, note, user.id);
          toast.ok(`Draft v${N} saved`, `Saved, not published. Test it on past actions, then ${sl ? 'sign and publish' : 'publish'}.`);
          setSaveOpen(false);
        }} />

      <Dialog open={discardOpen} onClose={() => setDiscardOpen(false)} size="sm" title="Discard unsaved changes?" description={`The working copy goes back to ${draft ? `saved draft v${draft.version}` : `published v${published?.version}`}. This cannot be undone.`}
        footer={<><Button variant="ghost" onClick={() => setDiscardOpen(false)}>Keep editing</Button><Button variant="quiet-danger" onClick={() => { setW(init()); setDiscardOpen(false); toast.info('Changes discarded'); }}>Discard changes</Button></>} />

    </div>
  );
}

function rulesChangedText(before: Rule[], after: Rule[]) {
  const b = new Map(before.map((r) => [r.id, JSON.stringify(r)]));
  const a = new Map(after.map((r) => [r.id, JSON.stringify(r)]));
  let added = 0, removed = 0, changed = 0;
  for (const [id, v] of a) { if (!b.has(id)) added++; else if (rulesKey([JSON.parse(b.get(id)!)]) !== rulesKey([JSON.parse(v)])) changed++; }
  for (const id of b.keys()) if (!a.has(id)) removed++;
  const parts = [added && `${n(added)} added`, changed && `${n(changed)} edited`, removed && `${n(removed)} removed`].filter(Boolean);
  return parts.length ? `Rules: ${parts.join(', ')}` : 'Order, wording or YAML changed';
}

function SaveDraftDialog({ open, onClose, draft, version, onSave, signedLevel }: { open: boolean; onClose: () => void; draft?: RulebookVersion; version: number; onSave: (note: string) => Promise<void>; signedLevel: boolean }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setNote(draft?.note ?? 'Draft: '); }, [open, draft?.note]);
  const save = async () => {
    setBusy(true);
    try { await onSave(note.trim()); } catch (e) { toast.bad('Draft not saved', (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Save draft v${version}`} description={signedLevel
        ? 'Saving keeps your changes as an unsigned draft. The agent keeps using the published version until someone signs and publishes.'
        : 'Saving keeps your changes as an unpublished draft. The agent keeps using the published version until someone publishes.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Save className="h-4 w-4" />} loading={busy} disabled={note.trim().length < 4} onClick={save}>Save draft</Button></>}>
      <Field label="Note" htmlFor="draft-note" required hint="What this draft changes. Shown in the version history.">
        <Textarea id="draft-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus />
      </Field>
      {draft?.status === 'in_review' && <p className="mt-3 text-xs text-muted">This draft is in review. Saving changes moves it back to draft.</p>}
    </Dialog>
  );
}
