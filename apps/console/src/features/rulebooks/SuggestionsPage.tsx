import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FilePlus2, X, ArrowRight, Search, Moon, CheckCircle2, CircleSlash, Plus } from 'lucide-react';
import type { Agent, Rule, Rulebook, RuleSuggestion } from '@/types';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { ROLE_INFO } from '@/lib/permissions';
import { n, plural } from '@/lib/format';
import { Badge, Banner, Button, DataTable, Dialog, EmptyState, Field, PageHeader, Skeleton, Tabs, Textarea, toast, type Column } from '@/components/ui';
import { AgentLink, Person, When } from '@/components/domain';
import { OUTCOME, draftOf, nextVersionNo, publishedOf, registerOrg, semDiff } from './lib';
import { DiffBadge, RuleBody } from './parts';
import { buildYaml, parseRulebookYaml, NO_EXTRAS } from './yamlSync';
import { createSuggestion, dismissalOf, namedLists, orgTools, dismissSuggestion, ensureNightlyScan, runSuggestionScan, suggestionGroups, suggestionScanAt, type SuggestionGroup } from '@/features/work/backend';

type Tab = 'open' | 'drafted' | 'dismissed';
type RB = Rulebook & { agent?: Agent; suggestions: number };

export default function SuggestionsPage() {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const nav = useNavigate();
  const canEdit = useCan('rulebooks.edit');
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided: an L1 version is "published".
  const sl = useOrgLevel() !== 'l1';
  const reason = canEdit ? undefined : `Owners and admins open suggestions as drafts; ${role ? ROLE_INFO[role].label.toLowerCase() + 's' : 'your role'} can read them.`;
  const [params, setParams] = useSearchParams();
  const tab = (['open', 'drafted', 'dismissed'].includes(params.get('tab') ?? '') ? params.get('tab') : 'open') as Tab;

  // the 02:00 IST run: if the console was closed at 02:00, it runs when the page opens (as Elan1 Govern, recorded)
  useEffect(() => {
    try {
      const r = ensureNightlyScan(orgId);
      if (r && (r.created.length || r.reopened.length)) toast.info('The nightly suggestion run caught up', `${plural(r.created.length, 'new suggestion')}${r.reopened.length ? `, ${plural(r.reopened.length, 'dismissed suggestion')} reopened because its approvals at least doubled` : ''}.`);
    } catch { /* the page still shows what exists */ }
  }, [orgId]);
  const sq = useQuery((o) => api.suggestions(o), [], { kinds: ['receipt', 'suggestion'] });
  const rq = useQuery((o) => api.rulebooks(o), [], { kinds: ['rulebook', 'agent'] });
  const notes = useMemo(() => {
    const m: Record<string, { reason: string; by?: string; ts: string; approvals: number }> = {};
    for (const s of sq.data ?? []) {
      const d = dismissalOf(orgId, s.id);
      if (d) m[s.id] = { reason: d.reason, by: d.by, ts: d.at, approvals: d.approvals };
    }
    return m;
  }, [sq.data, orgId]);
  const lastRun = suggestionScanAt(orgId);

  const [dismissing, setDismissing] = useState<RuleSuggestion>();
  const [busy, setBusy] = useState<string>();
  const [scanOpen, setScanOpen] = useState(false);

  const all = sq.data ?? [];
  const list = all.filter((s) => s.status === tab).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rbOf = (s: RuleSuggestion) => rq.data?.find((r) => r.id === s.rulebookId);

  const openAsDraft = async (s: RuleSuggestion) => {
    const rb = rbOf(s);
    if (!user || !rb || !rb.agent) return;
    setBusy(s.id);
    try {
      const draft = draftOf(rb);
      const base = draft ?? publishedOf(rb)!;
      // the same context the rulebook editor uses: this organisation's tools, approver groups and named lists
      const groups = api.approverGroups(orgId);
      registerOrg(orgTools(orgId), groups);
      const ctxBase = { slug: rb.slug, owner: rb.agent.ownerId, approverIds: rb.approverGroups.map((g) => g.id), groups, lists: namedLists(orgId) };
      const parsed = parseRulebookYaml(base.yaml, { ...ctxBase, version: base.version });
      const baseRules = parsed.ok ? parsed.rules : base.rules;
      const i = baseRules.findIndex((r) => r.id === s.proposed.id);
      const rules: Rule[] = i >= 0 ? baseRules.map((r, j) => (j === i ? { ...s.proposed } : r)) : [...baseRules, { ...s.proposed }];
      const N = nextVersionNo(rb);
      const yaml = buildYaml({ ...ctxBase, version: N }, rules, parsed.ok ? parsed.extras : NO_EXTRAS);
      const note = draft ? `${draft.note}; plus: ${s.title} (from rule suggestion)` : `Draft: ${s.title} (from rule suggestion)`;
      // save the draft first: the suggestion is marked drafted only once the draft exists
      await api.saveDraft(orgId, rb.id, yaml, rules, note, user.id);
      await api.setSuggestion(orgId, s.id, 'drafted', user.id);
      sq.refetch();
      toast.ok(`Opened as draft v${N}`, `Nothing is live yet. Test it on past actions, then a person ${sl ? 'signs and publishes' : 'publishes'} it.`);
      nav(`/rulebooks/${rb.slug}?tab=rules`);
    } catch (e) {
      toast.bad('Could not open the draft', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const dismiss = async (s: RuleSuggestion, why: string) => {
    if (!user) return;
    try {
      await dismissSuggestion(orgId, s.id, why, user.id);
      sq.refetch();
      toast.info('Suggestion dismissed', `Recorded with your reason. The nightly run reopens it only if its approvals reach ${n(s.evidence.approvals * 2)} (double today's ${n(s.evidence.approvals)}).`);
    } catch (e) {
      toast.bad('Not dismissed', (e as Error).message);
    }
  };

  return (
    <div className="overflow-x-clip">
      <PageHeader
        kicker="Records · Suggestions"
        crumbs={[{ label: 'Rulebooks', to: '/rulebooks' }, { label: 'Rule suggestions' }]}
        title="Rule suggestions"
        description={<>Each night at 02:00 IST, Elan1 Govern looks for groups of at least 10 consistent approvals over 30 days with none rejected, and proposes a rule that would have allowed them.{lastRun && <> Last run <When iso={lastRun} />.</>}</>}
        actions={<Button variant="secondary" icon={<Search className="h-4 w-4" />} onClick={() => setScanOpen(true)}>Look for suggestions</Button>}
      />

      <Banner tone="neutral" className="mb-6" title="A suggestion never publishes itself">
        A person opens it as a draft, tests it on past actions and publishes it. The numbers below are what people already decided — not a recommendation.
      </Banner>

      <Tabs label="Suggestion status" className="mb-6" value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} items={[
        { value: 'open', label: 'Open', count: all.filter((s) => s.status === 'open').length },
        { value: 'drafted', label: 'Opened as draft', count: all.filter((s) => s.status === 'drafted').length },
        { value: 'dismissed', label: 'Dismissed', count: all.filter((s) => s.status === 'dismissed').length },
      ]} />

      {(sq.error || rq.error) && <Banner tone="bad" className="mb-4" title="Suggestions could not be loaded" actions={<Button size="sm" variant="secondary" onClick={() => { sq.refetch(); rq.refetch(); }}>Try again</Button>}>{(sq.error ?? rq.error)!.message}</Banner>}

      {(sq.loading && !sq.data) || (rq.loading && !rq.data) ? (
        <div className="space-y-4">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-64 w-full" />)}</div>
      ) : list.length === 0 ? (
        <div className="border border-line bg-surface">
          <EmptyState title={tab === 'open' ? 'No open suggestions' : tab === 'drafted' ? 'None opened as a draft' : 'None dismissed'} disc="orbit"
            action={tab === 'open' ? <Button variant="secondary" icon={<Search className="h-4 w-4" />} onClick={() => setScanOpen(true)}>Look for suggestions</Button> : undefined}>
            {tab === 'open' ? 'When people approve the same kind of call at least 10 times over 30 days without a rejection, a suggestion appears here the next morning.' : 'Suggestions move here when someone acts on them.'}
          </EmptyState>
        </div>
      ) : (
        <ul className="space-y-5">
          {list.map((s) => (
            <SuggestionCard key={s.id} s={s} rb={rbOf(s)} canEdit={canEdit} readOnlyReason={reason} busy={busy === s.id} note={notes[s.id]}
              onOpen={() => openAsDraft(s)} onDismiss={() => setDismissing(s)} />
          ))}
        </ul>
      )}

      <DismissDialog s={dismissing} onClose={() => setDismissing(undefined)} onConfirm={async (why) => { if (dismissing) await dismiss(dismissing, why); setDismissing(undefined); }} />
      <ScanDialog open={scanOpen} onClose={() => setScanOpen(false)} canEdit={canEdit} onCreated={() => { sq.refetch(); setParams({ tab: 'open' }, { replace: true }); }} />
    </div>
  );
}

function SuggestionCard({ s, rb, canEdit, readOnlyReason: _readOnlyReason, busy, note, onOpen, onDismiss }: {
  s: RuleSuggestion; rb?: RB; canEdit: boolean; readOnlyReason?: string; busy: boolean; note?: { reason: string; by?: string; ts: string; approvals: number }; onOpen: () => void; onDismiss: () => void;
}) {
  const published = rb ? publishedOf(rb) : undefined;
  const draft = rb ? draftOf(rb) : undefined;
  const current = published?.rules.find((r) => r.id === s.proposed.id);
  const sl = useOrgLevel() !== 'l1';
  const diff = current ? semDiff([current], [s.proposed])[0] : undefined;
  const ev = s.evidence;
  return (
    <li className="border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-line">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1.5 text-xs text-muted">
            {rb && <AgentLink slug={rb.slug} />}
            <span aria-hidden>·</span>
            {rb && <Link to={`/rulebooks/${rb.slug}`} className="hover:underline">rulebook v{rb.currentVersion}</Link>}
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1"><Moon className="h-3 w-3" aria-hidden />found <When iso={s.createdAt} /></span>
          </div>
          <h2 className="text-lg font-semibold leading-snug">{s.title}</h2>
        </div>
        <div className="flex items-center gap-2">
          {current ? (diff ? <DiffBadge kind={diff.change} /> : <Badge>Same as live</Badge>) : <DiffBadge kind="added" />}
          {s.status === 'drafted' && <Badge tone="info" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Opened as draft</Badge>}
          {s.status === 'dismissed' && <Badge icon={<CircleSlash className="h-3 w-3" aria-hidden />}>Dismissed</Badge>}
        </div>
      </div>

      <div className="grid gap-px bg-line grid-cols-2 md:grid-cols-4 border-b border-line">
        {[
          ['Approvals', ev.approvals],
          ['Days', ev.days],
          ['Counterparties', ev.counterparties],
          ['Rejections', ev.rejections],
        ].map(([k, v]) => (
          <div key={k} className="bg-surface px-5 py-3">
            <p className="label">{k}</p>
            <p className="mt-1 font-display text-2xl font-semibold num">{n(v as number)}</p>
          </div>
        ))}
      </div>

      <div className="px-5 py-4 grid gap-5 lg:grid-cols-12">
        <div className="lg:col-span-5 min-w-0">
          <p className="label mb-1.5">What people decided</p>
          <p className="text-sm leading-relaxed">{s.rationale}</p>
          {ev.rejections > 0 && <p className="mt-2 text-xs text-held-fg">{plural(ev.rejections, 'rejection')} in the group. Read the proposed conditions closely; they should leave those calls held.</p>}
          {current && diff && <p className="mt-3 text-sm text-muted"><span className="font-mono text-fg">{diff.text}</span></p>}
          {s.status === 'dismissed' && note && (
            <div className="mt-4 border-l-[3px] border-line-strong pl-3">
              <p className="text-xs text-muted">Dismissed by {note.by ? <Person id={note.by} size={16} className="align-middle" /> : 'someone'} <When iso={note.ts} /></p>
              <p className="text-sm mt-1">“{note.reason}”</p>
              <p className="text-xs text-muted mt-1">Reopens if its approvals reach {n(note.approvals * 2)} — double the {n(note.approvals)} at dismissal.</p>
            </div>
          )}
        </div>
        <div className="lg:col-span-7 min-w-0 space-y-3">
          {current && (
            <details className="border border-line">
              <summary className="cursor-pointer px-4 py-2 text-sm text-muted hover:text-fg">Live rule <span className="font-mono">{current.id}</span> in v{published?.version}</summary>
              <div className="px-4 pb-4 pt-1"><RuleBody rule={current} agentTools={rb?.agent?.tools} /></div>
            </details>
          )}
          <div className={`border border-line border-l-[3px] ${OUTCOME[s.proposed.decide].edge}`}>
            <p className="label px-4 pt-3">Proposed rule · <span className="font-mono normal-case tracking-normal">{s.proposed.id}</span></p>
            <div className="px-4 py-3"><RuleBody rule={s.proposed} agentTools={rb?.agent?.tools} /></div>
          </div>
        </div>
      </div>

      {/* the actions bar: owners and admins act on an open suggestion; everyone can follow a drafted one */}
      {((s.status === 'open' && canEdit) || (s.status === 'drafted' && rb)) && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-line bg-sunken/40">
          {canEdit ? <p className="text-xs text-muted">Opening as a draft writes a receipt and adds this rule to {draft ? `draft v${draft.version}` : 'a new draft'}. Nothing is live until a person {sl ? 'signs and publishes' : 'publishes'}.</p> : <span />}
          {s.status === 'open' && canEdit && (
            <span className="flex gap-2">
              <Button variant="ghost" icon={<X className="h-4 w-4" />} onClick={onDismiss} disabled={busy}>Dismiss</Button>
              <Button variant="primary" icon={<FilePlus2 className="h-4 w-4" />} loading={busy} onClick={onOpen} disabled={!rb}>Open as draft</Button>
            </span>
          )}
          {s.status === 'drafted' && rb && (
            <Link to={`/rulebooks/${rb.slug}?tab=${draft ? 'test' : 'versions'}`} className="inline-flex items-center gap-1.5 h-10 px-4 text-base font-medium border border-line-strong/70 bg-surface hover:border-fg">
              {draft ? `Open draft v${draft.version}` : 'See versions'} <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

function DismissDialog({ s, onClose, onConfirm }: { s?: RuleSuggestion; onClose: () => void; onConfirm: (why: string) => Promise<void> }) {
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const presets = ['The approvals were exceptions, not a pattern', 'Policy requires a person for these', 'Will revisit after the quarter close'];
  const close = () => { setWhy(''); onClose(); };
  return (
    <Dialog open={!!s} onClose={close} title="Dismiss this suggestion" description={s?.title}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={why.trim().length < 4} onClick={async () => { setBusy(true); try { await onConfirm(why.trim()); setWhy(''); } finally { setBusy(false); } }}>Dismiss with reason</Button></>}>
      <Field label="Reason" required htmlFor="dismiss-why" hint="Recorded on a receipt. The suggestion returns only if its approvals at least double.">
        <Textarea id="dismiss-why" rows={3} value={why} onChange={(e) => setWhy(e.target.value)} data-autofocus />
      </Field>
      <div className="mt-3 flex flex-wrap gap-2">
        {presets.map((p) => <button key={p} type="button" onClick={() => setWhy(p)} className="text-xs h-7 px-2 border border-line hover:border-line-strong text-muted hover:text-fg">{p}</button>)}
      </div>
    </Dialog>
  );
}

/**
 * What the nightly run finds, computed now with the same code from the approvals people made in the last 30 days.
 * A qualifying group can be turned into a suggestion here; the 02:00 IST run creates the rest.
 */
function ScanDialog({ open, onClose, canEdit, onCreated }: { open: boolean; onClose: () => void; canEdit: boolean; onCreated: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const gq = useQuery(async (o) => suggestionGroups(o), [open], { live: false });
  const [busy, setBusy] = useState<string>();
  const groups = gq.data ?? [];

  const create = async (g: SuggestionGroup) => {
    if (!user) return;
    setBusy(g.key);
    try {
      const s = await createSuggestion(orgId, g.key, user.id);
      toast.ok('Suggestion created', `${s.title}. Recorded as suggestion.created. It never publishes itself.`);
      gq.refetch();
      onCreated();
    } catch (e) {
      toast.bad('Not created', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const runAll = async () => {
    if (!user) return;
    setBusy('all');
    try {
      const r = runSuggestionScan(orgId, user.id);
      toast.ok('Run complete', `${plural(r.created.length, 'suggestion')} created${r.reopened.length ? `, ${plural(r.reopened.length, 'dismissed suggestion')} reopened` : ''}. Each is recorded.`);
      gq.refetch();
      onCreated();
    } catch (e) {
      toast.bad('The run did not complete', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const columns: Column<SuggestionGroup>[] = [
    { key: 'agent', header: 'Agent', cell: (g) => <AgentLink slug={g.agent} /> },
    { key: 'rule', header: 'Held by rule', cell: (g) => <span className="font-mono text-[12.5px]">{g.ruleId}</span> },
    { key: 'ap', header: 'Approved', align: 'right', cell: (g) => g.approved, sort: (g) => g.approved },
    { key: 'rej', header: 'Rejected or expired', align: 'right', cell: (g) => g.rejected + g.expired, hideBelow: 'sm' },
    { key: 'cp', header: 'Counterparties', align: 'right', cell: (g) => g.counterparties.length || '—', hideBelow: 'md' },
    {
      key: 'res', header: 'Result', cell: (g) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className={g.qualifies ? 'text-fg font-medium' : 'text-muted'}>{g.why}{g.qualifies && g.suggestionId ? ' · already listed' : ''}</span>
          {g.qualifies && !g.suggestionId && canEdit && <Button size="sm" variant="secondary" icon={<Plus className="h-3.5 w-3.5" aria-hidden />} loading={busy === g.key} onClick={() => create(g)}>Create suggestion</Button>}
        </span>
      ),
    },
  ];
  const qualifying = groups.filter((g) => g.qualifies).length;
  const creatable = groups.filter((g) => g.qualifies && !g.suggestionId).length;
  return (
    <Dialog open={open} onClose={onClose} size="xl" title="Look for suggestions" description="The same check the 02:00 IST run makes, on the approvals people decided in the last 30 days. A qualifying group can be turned into a suggestion now."
      footer={<>{canEdit && creatable > 0 && <Button variant="secondary" loading={busy === 'all'} onClick={runAll}>Create all {n(creatable)}</Button>}<Button variant="primary" onClick={onClose}>Close</Button></>}>
      {gq.loading && !gq.data ? <Skeleton className="h-40 w-full" /> : gq.error ? (
        <Banner tone="bad" title="The check could not run" actions={<Button size="sm" variant="secondary" onClick={gq.refetch}>Try again</Button>}>{gq.error.message}</Banner>
      ) : (
        <>
          <p className="text-sm mb-3"><span className="font-semibold">{plural(groups.length, 'group')}</span> of held calls checked. {qualifying ? `${plural(qualifying, 'group')} ${qualifying === 1 ? 'qualifies' : 'qualify'}${creatable < qualifying ? `, ${n(qualifying - creatable)} already listed` : ''}.` : 'None qualifies today.'}</p>
          <DataTable columns={columns} rows={groups} rowKey={(g) => g.key} maxHeight={380} caption="Approval groups checked for suggestions"
            empty={<EmptyState compact disc="orbit" title="No decided approvals in 30 days">Suggestions need at least 10 approvals of the same kind.</EmptyState>} />
          <p className="mt-3 text-xs text-muted">Rules: at least 10 approvals over at least 7 days, the latest within 14 days, none rejected or expired. Never for refuse rules or for tools that delete, change access or change production. A dismissed suggestion reopens when its approvals at least double.</p>
        </>
      )}
    </Dialog>
  );
}

