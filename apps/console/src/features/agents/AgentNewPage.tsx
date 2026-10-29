import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, KeyRound, Lock, Send, ShieldCheck, AlertTriangle, PlugZap, Info, UserCheck, SlidersHorizontal } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import type { Agent, Connector, Receipt, RiskLevel, RiskTag } from '@/types';
import { rulebookYaml } from '@/mock/catalog';
import { GRADUATION, NO_GRANT_LABEL } from '@/lib/autonomy';
import { PlanUpsell } from '@/shell/access';
import { atLeast, LEVEL_INFO } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { n, plural } from '@/lib/format';
import {
  Badge, Banner, Button, Checkbox, CodeBlock, CopyButton, DecisionChip, EmptyState, Field, Hash, Input, PageHeader, Panel,
  RadioCards, Segmented, Select, Skeleton, StatusChip, Tabs, Textarea, toast,
} from '@/components/ui';
import { ReceiptLink, RouteMode, TagList } from '@/components/domain';
import { BUSINESS_UNITS, RiskLevelMark, isHighImpact, starterRules } from './parts';
import { buildSnippets, type SnippetId } from './snippets';
import { createAgent, endpoints, testCall, type CreateResult, type Declaration } from './backend';
import { devpathApi } from '@/mock/devpath';

type Step = 1 | 2 | 3;
type Framework = Agent['framework'];
type RouteChoice = 'mcp' | 'advisory';

const FRAMEWORKS: Framework[] = ['Claude', 'Cursor', 'LangChain', 'OpenAI Agents SDK', 'Custom'];
// 'suggestions' is also a static route under /rulebooks, which would hide that agent's rulebook
const RESERVED = ['new', 'map', 'gate', 'gmail', 'zoho', 'admin', 'autonomy', 'keys', 'people', 'organisation', 'deployment', 'suggestions'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTOR_KINDS: { value: Declaration['actorKind']; label: string; description: string }[] = [
  { value: 'agent', label: 'Agent', description: 'Acts on its own account under its rulebook.' },
  { value: 'agent_on_behalf_of_person', label: 'Agent for a person', description: 'Acts for a named person who started the task.' },
  { value: 'service', label: 'Service', description: 'A scheduled job with no model on the decision path.' },
];

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

interface Draft {
  name: string; slug: string; slugTouched: boolean; description: string; ownerId: string; framework: Framework; riskLevel: RiskLevel; businessUnit: string;
  route: RouteChoice; advisoryVia: 'rest' | 'sdk'; tools: string[]; starter: 'strict' | 'balanced'; actorKind: Declaration['actorKind'];
  environment: 'sandbox' | 'production'; expiry: string; reviewNote: string;
  /** model name and version (records area): recorded after the agent is created */
  modelName?: string; modelVersion?: string;
}

const STEPS: { n: Step; title: string; sub: string }[] = [
  { n: 1, title: 'Details', sub: 'Name, owner and route' },
  { n: 2, title: 'Tools and rulebook', sub: 'What it may call' },
  { n: 3, title: 'Connect', sub: 'Key and set-up' },
];

export default function AgentNewPage() {
  const nav = useNavigate();
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const dual = atLeast(level, 'l2');
  const l3 = atLeast(level, 'l3');
  const canManage = useCan('agents.manage');
  const membersQ = useQuery((o) => api.members(o), [], { live: false });
  const consQ = useQuery((o) => api.connectors(o), [], { kinds: ['receipt'] });
  const agentsQ = useQuery((o) => api.agents(o), [], { live: false });

  const [step, setStep] = useState<Step>(1);
  const [tried, setTried] = useState(false);
  const [d, setD] = useState<Draft>({
    name: '', slug: '', slugTouched: false, description: '', ownerId: user?.id ?? '', framework: 'Claude', riskLevel: 'medium', businessUnit: '',
    route: 'mcp', advisoryVia: 'rest', tools: [], starter: 'strict', actorKind: 'agent', environment: 'sandbox', expiry: '90', reviewNote: '',
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const [created, setCreated] = useState<CreateResult>();
  const set =<K extends keyof Draft>(k: K, v: Draft[K]) => setD((s) => ({ ...s, [k]: v }));

  const owners = (membersQ.data ?? []).filter((m) => m.status === 'active' && m.user && m.role !== 'auditor');

  /* validation */
  const taken = agentsQ.data?.some((a) => a.slug === d.slug);
  const errors = {
    name: d.name.trim().length < 3 ? 'Give the agent a name of at least 3 characters.' : undefined,
    slug: !d.slug ? 'A slug is needed — it appears on every receipt.'
      : d.slug.length < 3 ? 'Use at least 3 characters.'
      : !SLUG_RE.test(d.slug) ? 'Use lowercase letters a–z, digits 0–9 and single hyphens, not at the start or end.'
      : RESERVED.includes(d.slug) ? `“${d.slug}” is reserved.`
      : taken ? 'Another agent already uses this slug.' : undefined,
    description: d.description.trim().length < 10 ? 'Say in a sentence what the agent does. It becomes the purpose in the AI inventory.' : undefined,
    owner: !d.ownerId ? 'Choose the person accountable for this agent.' : undefined,
    businessUnit: !d.businessUnit ? 'Choose the business unit. It is recorded on the AI inventory entry.' : undefined,
  };
  const step1Ok = !errors.name && !errors.slug && !errors.description && !errors.owner && !errors.businessUnit;
  const step2Ok = d.tools.length > 0;

  /* tools and preview */
  const allTools = useMemo(() => (consQ.data ?? []).flatMap((c) => c.tools.map((t) => ({ ...t, connector: c }))), [consQ.data]);
  const picked = allTools.filter((t) => d.tools.includes(t.name));
  const rules = useMemo(() => starterRules(picked.map((t) => ({ name: t.name, tags: t.tags })), d.starter), [picked, d.starter]);
  const yaml = useMemo(() => rulebookYaml(d.slug || 'new-agent', 1, d.ownerId || 'owner', rules, ['owners']), [d.slug, d.ownerId, rules]);
  const route = d.route === 'mcp' ? 'mcp' : d.advisoryVia;
  const ep = useMemo(() => endpoints(orgId), [orgId]);

  const next = () => {
    setTried(true);
    if (step === 1 && step1Ok) { setStep(2); setTried(false); window.scrollTo(0, 0); }
  };

  const create = async () => {
    setTried(true);
    if (!user || !step1Ok || !step2Ok) return;
    setCreating(true);
    setCreateError(undefined);
    try {
      const connectorIds = Array.from(new Set(picked.map((t) => t.connector.id)));
      const r = await createAgent(orgId, {
        name: d.name.trim(), slug: d.slug, description: d.description.trim(), framework: d.framework, route, ownerId: d.ownerId, riskLevel: d.riskLevel,
        // a production key is never issued directly: the agent starts with a sandbox key and a draft request goes to review
        connectorIds, tools: d.tools, rules, businessUnit: d.businessUnit, environment: 'sandbox', expiresDays: d.expiry === 'never' ? undefined : Number(d.expiry),
        actorKind: d.actorKind, reviewNote: d.reviewNote,
        // no autonomy is chosen here: from L3 each write type starts at A2 Propose and graduates to A3 later
      }, user.id);
      // the model is its own receipt (agent.model_recorded); the linked AI inventory entry follows
      let modelError: string | undefined;
      if (d.modelName?.trim()) {
        // the agent exists either way; a model that was not recorded is said, not swallowed
        try { await api.records.setModel(orgId, { kind: 'agent', id: r.agent.id }, { name: d.modelName, version: d.modelVersion?.trim() || 'Not recorded' }, user.id); } catch (e) { modelError = (e as Error).message; }
      }
      if (d.environment === 'production') {
        try { await devpathApi.draftRequest(orgId, d.slug, user.id); } catch { /* the request can still be started on Path to production */ }
      }
      setCreated(r);
      setStep(3);
      window.scrollTo(0, 0);
      toast.ok(`${d.slug} created`, r.rulebook.status === 'published' ? 'Rulebook v1 published. Copy the key now — it is shown once.' : 'Rulebook v1 is waiting for a second person. Copy the key now — it is shown once.');
      if (modelError) toast.held('The model was not recorded', `${modelError} Record the model name and version on the agent’s page.`);
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  if (!canManage) {
    return (
      <div className="min-w-0 overflow-x-clip">
        <PageHeader kicker="Agents" crumbs={[{ label: 'Agents', to: '/agents' }, { label: 'Add an agent' }]} title="Add an agent" />
        <Panel>
          <EmptyState title="Owners and admins add agents" disc="gate" action={<Button variant="secondary" onClick={() => nav('/agents')}>Back to agents</Button>}>
            Your role can read the agent registry but cannot register an agent or issue its key. Ask an owner or admin.
          </EmptyState>
        </Panel>
      </div>
    );
  }

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Agents"
        crumbs={[{ label: 'Agents', to: '/agents' }, { label: 'Add an agent' }]}
        title="Add an agent"
        description="3 steps: describe the agent, choose what it may call, then connect it with its own key. It joins the AI inventory automatically."
      />

      <Stepper step={step} done={created ? 3 : step - 1} onGo={(s) => { if (!created && s < step) setStep(s); }} />

      {step === 1 && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 [&>*]:min-w-0">
          <Panel className="lg:col-span-8" title="Details" kicker="Step 1 of 3">
            <div className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Name" required htmlFor="ag-name" error={tried ? errors.name : undefined}>
                  <Input id="ag-name" value={d.name} invalid={tried && !!errors.name} placeholder="For example: Payables assistant" data-autofocus
                    onChange={(e) => setD((s) => ({ ...s, name: e.target.value, slug: s.slugTouched ? s.slug : slugify(e.target.value) }))} />
                </Field>
                <Field label="Slug" required htmlFor="ag-slug" error={(tried || d.slugTouched) ? errors.slug : undefined} hint="Lowercase a–z, 0–9 and hyphens. Shown on every receipt; cannot change later."
                  aside={d.slugTouched && d.name ? <button type="button" className="text-xs text-muted hover:text-fg underline" onClick={() => setD((s) => ({ ...s, slug: slugify(s.name), slugTouched: false }))}>Reset from name</button> : undefined}>
                  <Input id="ag-slug" mono value={d.slug} invalid={(tried || d.slugTouched) && !!errors.slug} placeholder="payables-assistant"
                    onChange={(e) => setD((s) => ({ ...s, slug: e.target.value.toLowerCase(), slugTouched: true }))} />
                </Field>
              </div>
              <Field label="What it does" required htmlFor="ag-desc" error={tried ? errors.description : undefined} hint="One or two plain sentences. This becomes its purpose in the AI inventory.">
                <Textarea id="ag-desc" rows={2} value={d.description} invalid={tried && !!errors.description} onChange={(e) => set('description', e.target.value)}
                  placeholder="Reads supplier invoices, drafts bills and records payments under ₹50,000." />
              </Field>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Owner" required htmlFor="ag-owner" error={tried ? errors.owner : undefined} hint="Accountable person. Approvers who own an agent are flagged when they approve it.">
                  {membersQ.loading ? <Skeleton className="h-10" /> : membersQ.error ? <p className="text-sm text-bad-fg">{membersQ.error.message} <button type="button" className="underline" onClick={membersQ.refetch}>Try again</button></p> : (
                    <Select id="ag-owner" value={d.ownerId} onChange={(e) => set('ownerId', e.target.value)}>
                      <option value="">Choose a person</option>
                      {owners.map((m) => <option key={m.userId} value={m.userId}>{m.user!.name} · {m.user!.title}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="Business unit" required htmlFor="ag-unit" error={tried ? errors.businessUnit : undefined} hint="Recorded on the AI inventory entry.">
                  <Select id="ag-unit" value={d.businessUnit} onChange={(e) => set('businessUnit', e.target.value)}>
                    <option value="">Choose a unit</option>
                    {BUSINESS_UNITS.map((b) => <option key={b} value={b}>{b}</option>)}
                  </Select>
                </Field>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Framework" htmlFor="ag-fw">
                  <Select id="ag-fw" value={d.framework} onChange={(e) => set('framework', e.target.value as Framework)}>
                    {FRAMEWORKS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </Select>
                </Field>
                <Field label="Risk level" hint="High-risk agents need an ask or refuse rule on every high-impact tool.">
                  <Segmented label="Risk level" value={d.riskLevel} onChange={(v) => set('riskLevel', v)} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
                </Field>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Model name" htmlFor="ag-model" hint="The model the agent runs on. Recorded on the agent and its AI inventory entry.">
                  <Input id="ag-model" value={d.modelName ?? ''} placeholder="Claude Sonnet 4.5" onChange={(e) => set('modelName', e.target.value)} />
                </Field>
                <Field label="Model version" htmlFor="ag-model-v" hint="Version or snapshot id.">
                  <Input id="ag-model-v" mono value={d.modelVersion ?? ''} placeholder="claude-sonnet-4-5-20250929" onChange={(e) => set('modelVersion', e.target.value)} />
                </Field>
              </div>
              <Field label="How the agent connects" required>
                <RadioCards
                  name="route"
                  cols={2}
                  value={d.route}
                  onChange={(v) => set('route', v)}
                  options={[
                    { value: 'mcp', label: 'Governed run over MCP', aside: <Badge tone="inverse">Recommended</Badge>, description: 'Elan1 Govern holds the tool credentials and runs each call; a refused call cannot run.' },
                    { value: 'advisory', label: 'Check and record over REST or SDK', aside: <Badge>Advisory</Badge>, description: 'Your agent holds its own credentials and runs the call; Elan1 Govern advises and records.' },
                  ]}
                />
              </Field>
              {d.route === 'advisory' && (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm text-muted">Calls checked through</span>
                  <Segmented label="Advisory route" size="sm" value={d.advisoryVia} onChange={(v) => set('advisoryVia', v)} options={[{ value: 'rest', label: 'REST API' }, { value: 'sdk', label: 'Python SDK' }]} />
                  <p className="w-full text-xs text-muted">Advisory means the agent can still run a call that was refused. Receipts record what was decided, not what the agent did next.</p>
                </div>
              )}
              <Field label="Who acts" hint="Recorded in the agent's declaration (actor_kind) and sealed into every record from L2.">
                <RadioCards name="actor" cols={3} value={d.actorKind} onChange={(v) => set('actorKind', v)} options={ACTOR_KINDS} />
              </Field>
            </div>
            <div className="mt-6 pt-5 border-t border-line flex flex-wrap items-center justify-between gap-3">
              <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => nav('/agents')}>Cancel</Button>
              <Button variant="primary" iconRight={<ArrowRight className="h-4 w-4" />} onClick={next}>Next: tools and rulebook</Button>
            </div>
          </Panel>

          <aside className="lg:col-span-4 space-y-4">
            <Panel title="What you are creating" tone="sunken">
              <dl className="space-y-3 text-sm">
                <div><dt className="label">Agent</dt><dd className="mt-0.5 font-medium">{d.name || <span className="text-subtle">Unnamed</span>} <span className="font-mono text-[12px] text-muted">{d.slug}</span></dd></div>
                <div><dt className="label">Route</dt><dd className="mt-1"><RouteMode route={route} /></dd></div>
                <div><dt className="label">Risk level</dt><dd className="mt-1"><RiskLevelMark level={d.riskLevel} /></dd></div>
                <div><dt className="label">Endpoint</dt><dd className="mt-1 font-mono text-[12px] break-all">{ep.host}</dd><dd className="text-xs text-muted mt-0.5">{ep.note}</dd></div>
              </dl>
            </Panel>
            <Panel title="What happens next">
              <ol className="space-y-3 text-sm text-muted">
                <li className="flex gap-2"><span className="font-mono text-fg">1</span>{dual ? `A rulebook v1 is drafted from a starter preset. At ${LEVEL_INFO[level].label} a different person approves its review before it is published; until then every call is refused.` : 'A rulebook v1 is published from a starter preset you choose.'}</li>
                <li className="flex gap-2"><span className="font-mono text-fg">2</span>The agent gets one key, sandbox by default, shown once.</li>
                <li className="flex gap-2"><span className="font-mono text-fg">3</span>Its declaration (who acts and which writes it makes) is recorded on the chain.</li>
                <li className="flex gap-2"><span className="font-mono text-fg">4</span>It is added to the AI inventory so it can be assessed.</li>
                {l3 && <li className="flex gap-2"><span className="font-mono text-fg">5</span>Its write types start at A2 Propose: a person approves every write until a two-person graduation to A3.</li>}
              </ol>
            </Panel>
          </aside>
        </div>
      )}

      {step === 2 && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 [&>*]:min-w-0">
          <div className="lg:col-span-7 space-y-6">
            <Panel title="Tools the agent may call" kicker="Step 2 of 3" actions={<span className="text-sm text-muted num">{plural(d.tools.length, 'tool')} chosen</span>}>
              {consQ.loading ? <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
                : consQ.error ? <Banner tone="bad" title="Could not load connectors" actions={<Button size="sm" onClick={consQ.refetch}>Try again</Button>}>{consQ.error.message}</Banner>
                : !consQ.data?.length ? (
                  <EmptyState compact title="No connectors yet" disc="registration" action={<Button size="sm" onClick={() => nav('/connectors')}>Open connectors</Button>}>Connect Gmail, Zoho Books or your own MCP server first.</EmptyState>
                ) : (
                  <div className="space-y-5">
                    {consQ.data.map((c) => <ConnectorTools key={c.id} c={c} chosen={d.tools} onChange={(tools) => set('tools', tools)} />)}
                  </div>
                )}
              {tried && !d.tools.length && <p className="mt-4 text-sm text-bad-fg" role="alert">Choose at least one tool. An agent with no tools has every call refused.</p>}
            </Panel>

            <Panel title="Starter preset">
              <RadioCards
                name="starter"
                cols={2}
                value={d.starter}
                onChange={(v) => set('starter', v)}
                options={[
                  { value: 'strict', label: 'Strict', description: 'High-impact tools are refused. Reads are allowed; other writes ask a person.' },
                  { value: 'balanced', label: 'Balanced', description: 'High-impact tools ask a person (owners). Everything else chosen is allowed.' },
                ]}
              />
              <p className="mt-3 text-xs text-muted">You can refine the rules in the rulebook editor at any time. Every published version is kept, and each publish is a receipt.</p>
            </Panel>

            {dual && (
              <Panel title="Dual control" kicker={`Enforced at ${LEVEL_INFO[level].label}`}>
                <p className="text-sm text-muted mb-3">Rulebook v1 is created in review. A different owner or admin approves the review in Work › Reviews; then someone other than the reviewer publishes it. Until it is published, every call is refused with <span className="font-mono">no-rulebook</span>.</p>
                <Field label="Note for the reviewer" htmlFor="ag-review" hint="Recorded on the review.requested receipt.">
                  <Textarea id="ag-review" rows={2} value={d.reviewNote} onChange={(e) => set('reviewNote', e.target.value)} placeholder="For example: starter rules for the payables pilot; high-impact tools held for owners" />
                </Field>
              </Panel>
            )}

            <Panel title="Key" kicker="Issued when you create the agent">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Environment">
                  <RadioCards name="env" cols={1} value={d.environment} onChange={(v) => set('environment', v)} options={[
                    { value: 'sandbox', label: 'Sandbox', aside: <Badge>Default</Badge>, description: 'Key starts sk_sbx_. Use it while you build and test.' },
                    { value: 'production', label: 'Production, by review', description: 'A sandbox key now, and a production-key request (gk_) started for you. A person reviews it within 2 working days once the conformance suite passes.' },
                  ]} />
                </Field>
                <Field label="Expires" htmlFor="ag-exp" hint="Rotate before the expiry to keep the agent connected.">
                  <Select id="ag-exp" value={d.expiry} onChange={(e) => set('expiry', e.target.value)}>
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                    <option value="365">1 year</option>
                    <option value="never">No expiry</option>
                  </Select>
                </Field>
              </div>
            </Panel>

            {l3 ? (
              <Panel title="Autonomy" kicker={`${LEVEL_INFO[level].label} · nothing to choose`}>
                <p className="text-sm text-muted">No one sets an agent’s autonomy. Each write type starts at <span className="font-medium text-fg">A2 Propose</span>: the guard holds every write for a person after the rulebook. A write type reaches A3 only by a graduation one owner or admin proposes and a different one approves, once its record shows at least {GRADUATION.minDays} days, {GRADUATION.minRecords} records and {GRADUATION.minApprovals} approvals; then {GRADUATION.supervisedDays} days are supervised. A4 and A5 are not yet available.</p>
              </Panel>
            ) : (
              // autonomy is part of L3: below it the panel is left out and owners see one line
              <PlanUpsell to="l3" what="Earned autonomy (A2 Propose, A3 by two-person graduation) starts at L3 Proven." />
            )}

            {createError && <Banner tone="bad" title="The agent was not created">{createError}</Banner>}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => setStep(1)}>Back</Button>
              <Button variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={creating} onClick={create}>Create agent and issue key</Button>
            </div>
          </div>

          <div className="lg:col-span-5 space-y-4 lg:sticky lg:top-6 self-start">
            <Panel title="Starter rulebook preview" actions={<span className="font-mono text-xs text-muted">v1 · default refuse{dual ? ' · in review' : ''}</span>} flush>
              {rules.length === 0 ? (
                <div className="p-5 text-sm text-muted">Choose tools to see the rules. With no rules, every call is refused.</div>
              ) : (
                <ul className="divide-y divide-line">
                  {rules.map((r) => {
                    const t = picked.find((x) => x.name === r.match.tool);
                    return (
                      <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                        <div className="min-w-0">
                          <p className="font-mono text-[12.5px] truncate">{r.match.tool}</p>
                          <p className="text-xs text-muted">{r.reason}{r.approver ? ` Approver: ${r.approver}.` : ''}{t && !t.tags.length ? ' No risk tags — tag it on the connector.' : ''}</p>
                        </div>
                        <DecisionChip decision={r.decide} size="sm" short />
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-t border-line bg-sunken/50">
                <p className="text-sm font-medium">Anything no rule allows is refused.</p>
                <DecisionChip decision="refuse" size="sm" short />
              </div>
            </Panel>
            <CodeBlock code={yaml} title={`rulebook · ${d.slug || 'new-agent'}.yaml`} maxHeight={320} />
            {d.riskLevel === 'high' && picked.some((t) => isHighImpact(t.tags)) && (
              <Banner tone="info" title="High-risk agent">Every high-impact tool is {d.starter === 'strict' ? 'refused' : 'held for an owner'}, so this rulebook can be published. A high-risk agent cannot publish a version that allows a high-impact tool without a person.</Banner>
            )}
          </div>
        </div>
      )}

      {step === 3 && created && <ConnectStep created={created} draft={d} onFinish={() => nav(`/agents/${created.agent.slug}`)} />}
    </div>
  );
}

/* ── Stepper ──────────────────────────────────────────────── */

function Stepper({ step, done, onGo }: { step: Step; done: number; onGo: (s: Step) => void }) {
  return (
    <nav aria-label="Progress" className="mb-6">
      <ol className="flex border border-line bg-surface">
        {STEPS.map((s, i) => {
          const isDone = s.n <= done;
          const current = s.n === step;
          return (
            <li key={s.n} className={cn('relative min-w-0', current ? 'flex-1' : 'flex-none sm:flex-1', i > 0 && 'border-l border-line')}>
              <button type="button" onClick={() => onGo(s.n)} disabled={!isDone || current} aria-current={current ? 'step' : undefined}
                className={cn('w-full flex items-center gap-3 px-3 sm:px-4 py-3 text-left disabled:cursor-default', isDone && !current && 'hover:bg-sunken/60')}>
                <span className={cn('h-7 w-7 shrink-0 inline-flex items-center justify-center border text-sm font-semibold num', current ? 'bg-fg text-canvas border-fg' : isDone ? 'border-fg text-fg' : 'border-line-strong/70 text-subtle')}>
                  {isDone && !current ? <Check className="h-4 w-4" aria-label="Done" /> : s.n}
                </span>
                <span className="min-w-0">
                  <span className={cn('text-sm font-semibold truncate', current ? 'block' : 'hidden sm:block', !current && !isDone && 'text-muted')}>{s.title}</span>
                  {!current && <span className="sr-only sm:hidden">{s.title}</span>}
                  <span className="hidden sm:block text-xs text-muted truncate">{s.sub}</span>
                </span>
              </button>
              {current && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-fg" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* ── Step 2: tools per connector ──────────────────────────── */

function ConnectorTools({ c, chosen, onChange }: { c: Connector; chosen: string[]; onChange: (tools: string[]) => void }) {
  const names = c.tools.map((t) => t.name);
  const sel = names.filter((x) => chosen.includes(x));
  const all = sel.length === names.length && names.length > 0;
  const toggle = (name: string, on: boolean) => onChange(on ? [...chosen, name] : chosen.filter((x) => x !== name));
  return (
    <section className="border border-line">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-sunken/60 border-b border-line">
        <div className="flex items-center gap-2 min-w-0">
          <PlugZap className="h-4 w-4 text-muted shrink-0" aria-hidden />
          <Link to={`/connectors/${c.id}`} className="font-medium truncate hover:underline underline-offset-2">{c.name}</Link>
          {c.mode === 'demo' && <Badge tone="info">Demo mode</Badge>}
          {c.status === 'error' && <StatusChip tone="bad" size="sm" icon={<AlertTriangle className="h-3 w-3" />}>Connection error</StatusChip>}
        </div>
        <Checkbox checked={all} onChange={(v) => onChange(v ? Array.from(new Set([...chosen, ...names])) : chosen.filter((x) => !names.includes(x)))} label={<span className="text-xs">Select all {names.length}</span>} />
      </header>
      <ul className="divide-y divide-line">
        {c.tools.map((t) => {
          const high = isHighImpact(t.tags);
          const tags = (t.tags.length ? t.tags : []) as RiskTag[];
          return (
            <li key={t.name} className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3', high && 'shadow-[inset_3px_0_0_rgb(var(--accent))]')}>
              <Checkbox checked={chosen.includes(t.name)} onChange={(v) => toggle(t.name, v)} label={<span className="font-mono text-[12.5px]">{t.name}</span>} description={t.description} />
              <div className="flex flex-wrap items-center gap-1.5 pl-6 sm:pl-0">
                {tags.length ? <TagList tags={tags} /> : <span className="text-xs text-held-fg">No risk tags{t.suggestedTags?.length ? ' · suggested on the connector' : ''}</span>}
                {!t.enabled && <Badge tone="held" title="Calls to this tool are refused until someone switches it on in Connectors">Off at connector</Badge>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ── Step 3: connect ──────────────────────────────────────── */

function ConnectStep({ created, draft, onFinish }: { created: CreateResult; draft: Draft; onFinish: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const { agent, secret, mcpUrl, endpoints: ep } = created;
  const advisory = agent.route !== 'mcp';
  const inReview = created.rulebook.status === 'in_review';
  const [stored, setStored] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ receipt: Receipt; approverGroup?: string }>();
  const [testError, setTestError] = useState<string>();

  const consQ = useQuery((o) => api.connectors(o), [], { live: false });
  const { sampleTool, sampleIsRead } = useMemo(() => {
    const tagsOf = (name: string) => (consQ.data ?? []).flatMap((c) => c.tools).find((t) => t.name === name)?.tags ?? [];
    // read-only: it reads data and has no tag that writes, sends, moves or changes anything
    const readOnly = (name: string) => { const tg = tagsOf(name); return tg.includes('reads_data') && tg.every((x) => x === 'reads_data' || x === 'personal_data'); };
    const tool = agent.tools.find((t) => readOnly(t)) ?? agent.tools.find((t) => tagsOf(t).includes('reads_data') && !isHighImpact(tagsOf(t))) ?? agent.tools.find((t) => !isHighImpact(tagsOf(t))) ?? agent.tools[0];
    return { sampleTool: tool as string | undefined, sampleIsRead: !!tool && readOnly(tool) };
  }, [agent.tools, consQ.data]);

  const snippets = useMemo(() => buildSnippets(agent.slug, mcpUrl, secret, sampleTool ?? 'tool.name', agent.name, ep), [agent.slug, agent.name, mcpUrl, secret, sampleTool, ep]);
  const [tab, setTab] = useState<SnippetId>(advisory ? (draft.advisoryVia === 'sdk' ? 'sdk' : 'rest') : draft.framework === 'Cursor' ? 'cursor' : draft.framework === 'LangChain' ? 'langchain' : draft.framework === 'OpenAI Agents SDK' ? 'openai' : 'claude');
  const current = snippets.find((s) => s.id === tab)!;
  const sandbox = agent.keys[0]?.environment === 'sandbox';

  const sendTest = async () => {
    if (!user || !sampleTool) return;
    setTesting(true);
    setTestError(undefined);
    try {
      const r = await testCall(orgId, agent.slug, sampleTool, { test_call: true, limit: 1 }, user.id);
      setTest({ receipt: r.receipt, approverGroup: r.approverGroup });
      const dec = r.receipt.decision;
      // a refusal the guard could not or may not record (POLICY.TENANT_STOPPED, a failed receipt writer) has no receipt
      if (!r.receipt.seq || r.receipt.details?.recorded === false) toast.bad('Test call refused — no record written', `${r.receipt.rule_id}: ${r.receipt.reason ?? ''}`);
      else toast.ok('Test call recorded', `Receipt #${n(r.receipt.seq)} — ${dec === 'allow' ? 'allowed' : dec === 'ask' ? `held for ${r.approverGroup ?? 'a person'}` : 'refused'} by ${r.receipt.rule_id}.`);
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-7 space-y-6">
        {inReview ? (
          <Banner tone="held" title={`${agent.name} is registered — rulebook v1 is waiting for a second person`} actions={<Button size="sm" variant="secondary" onClick={() => nav('/work/reviews')}>Open reviews</Button>}>
            Dual control is enforced at this level. A different owner or admin approves the review; then someone other than the reviewer publishes it. Until then every call is refused with <span className="font-mono">no-rulebook</span>. <Link className="underline" to={`/rulebooks/${agent.slug}`}>Open the rulebook</Link>
          </Banner>
        ) : (
          <Banner tone="ok" title={`${agent.name} is registered`}>
            Rulebook v1 is published. The creation, the declaration and the publish are each recorded as a receipt in the hash chain. <Link className="underline" to={`/rulebooks/${agent.slug}`}>Open the rulebook</Link>
          </Banner>
        )}
        {created.aiSystemError && (
          <Banner tone="held" title="The agent was not added to the AI inventory" actions={<Button size="sm" variant="secondary" onClick={() => nav('/inventory')}>Open the inventory</Button>}>
            {created.aiSystemError} Register it there so it can be assessed.
          </Banner>
        )}
        {created.autonomyStarted > 0 && (
          <Banner tone="info" title={`${plural(created.autonomyStarted, 'write type')} at A2 Propose`} actions={<Button size="sm" variant="secondary" onClick={() => nav(`/agents/${agent.slug}?tab=autonomy`)}>Open autonomy</Button>}>
            A person approves every write. Once a write type’s record meets the thresholds, an owner or admin can propose its graduation to A3 and a different one approves it.
          </Banner>
        )}

        <Panel title="Connection details" kicker="Step 3 of 3">
          <div className="space-y-5">
            <div>
              <p className="label mb-1.5">{advisory ? (draft.advisoryVia === 'sdk' ? 'SDK base address' : 'Check endpoint') : 'MCP address'}</p>
              <div className="flex items-center gap-2 border border-line bg-sunken/70 px-3 py-2.5">
                {advisory ? <Info className="h-4 w-4 text-muted shrink-0" aria-hidden /> : <Lock className="h-4 w-4 text-muted shrink-0" aria-hidden />}
                <code className="flex-1 min-w-0 break-all font-mono text-[13px]">{advisory ? (draft.advisoryVia === 'sdk' ? `https://${ep.host}` : ep.checkUrl) : mcpUrl}</code>
                <CopyButton text={advisory ? (draft.advisoryVia === 'sdk' ? `https://${ep.host}` : ep.checkUrl) : mcpUrl} label="Copy address" />
              </div>
              <p className="mt-1.5 text-xs text-muted">{ep.note}{advisory && <> MCP address, if you later move this agent to a governed run: <span className="font-mono break-all">{mcpUrl}</span></>}</p>
            </div>
            <div>
              <p className="label mb-1.5">Agent key · {sandbox ? 'sandbox' : 'production'}</p>
              <div className="flex items-center gap-2 border border-held/50 bg-held-bg px-3 py-2.5">
                <KeyRound className="h-4 w-4 text-held-fg shrink-0" aria-hidden />
                <code className="flex-1 min-w-0 break-all font-mono text-[13px]">{secret}</code>
                <CopyButton text={secret} label="Copy key" />
              </div>
              <p className="mt-2 flex items-start gap-1.5 text-sm text-held-fg"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />This key is shown once and will not be shown again. Elan1 Govern keeps only its hash and the prefix <span className="font-mono">{secret.slice(0, 12)}</span>.</p>
              {sandbox && <p className="mt-1.5 text-xs text-muted">{draft.environment === 'production' ? 'A production-key request was started for this agent. ' : ''}When testing is done, pass the conformance suite and ask for a production key on <Link to={`/agents/production?tab=keys&agent=${agent.slug}`} className="underline">Path to production</Link>; a person reviews it within 2 working days.</p>}
            </div>
            <Checkbox checked={stored} onChange={setStored} label="I have stored the key in a secret manager" description="Needed to finish. If you lose it, revoke it on the agent's Keys tab and issue another." />
          </div>
        </Panel>

        <Panel title="Connect your agent" flush>
          <div className="px-5 pt-2">
            <Tabs label="Set-up snippets" value={tab} onChange={setTab} items={snippets.map((s) => ({ value: s.id, label: s.label }))} />
          </div>
          <div className="p-5 space-y-3">
            {advisory && tab !== 'rest' && tab !== 'sdk' && <Banner tone="neutral">This agent is set to check and record. These MCP snippets connect it as a governed run instead, where a refused call cannot run.</Banner>}
            {!advisory && (tab === 'rest' || tab === 'sdk') && <Banner tone="neutral">REST and the SDK are advisory: Elan1 Govern advises and records; the agent runs the call. Prefer the MCP snippets for this agent.</Banner>}
            <p className="text-sm text-muted">{current.note}</p>
            <CodeBlock code={current.code} title={current.title} wrap />
          </div>
        </Panel>
      </div>

      <div className="lg:col-span-5 space-y-6">
        <Panel title="Send a test call" actions={<Button size="sm" variant="secondary" icon={<Send className="h-3.5 w-3.5" />} loading={testing} onClick={sendTest} disabled={!sampleTool}>{test ? 'Send another' : 'Send a test call'}</Button>}>
          {testError && <Banner tone="bad" className="mb-3" title="The test call failed">{testError}</Banner>}
          {!test ? (
            <p className="text-sm text-muted">
              Sends <span className="font-mono text-fg">{sampleTool ?? '—'}</span> through the guard (stop, identity, rulebook{atLeast(api.levelOf(orgId), 'l3') ? ', autonomy' : ''}) and writes the receipt. {inReview ? 'No version is published yet, so expect a refusal with no-rulebook.' : advisory ? 'Nothing runs: this agent is advisory.' : sampleIsRead ? 'Read-only, so it is safe to run.' : 'This tool writes, so the call is decided and recorded like any other: if a rule allows it, it runs; if a rule asks a person, a real approval waits for one (it expires in 1 hour).'}
            </p>
          ) : !test.receipt.seq || test.receipt.details?.recorded === false ? (
            <div className="space-y-3 animate-rise-in">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-sm">{test.receipt.rule_id}</span>
                <DecisionChip decision={test.receipt.decision} />
              </div>
              <Banner tone="bad" title="Refused before it ran — no record written">
                {test.receipt.reason} {test.receipt.rule_id === 'POLICY.TENANT_STOPPED' && <Link className="underline" to="/billing">Open the Meter</Link>}
              </Banner>
              <p className="text-xs text-muted">No receipt was written for this call, so there is none to open. Nothing ran.</p>
            </div>
          ) : (
            <div className="space-y-4 animate-rise-in">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <ReceiptLink seq={test.receipt.seq} className="text-base" />
                <DecisionChip decision={test.receipt.decision} />
              </div>
              <dl className="text-sm divide-y divide-line border-y border-line">
                <div className="flex justify-between gap-4 py-2"><dt className="text-muted">Tool</dt><dd className="font-mono text-[12.5px]">{test.receipt.tool}</dd></div>
                <div className="flex justify-between gap-4 py-2"><dt className="text-muted">Rule</dt><dd className="font-mono text-[12.5px]">{test.receipt.rule_id}</dd></div>
                <div className="flex justify-between gap-4 py-2"><dt className="text-muted">Rulebook</dt><dd className="font-mono text-[12.5px]">{test.receipt.rulebook ? `v${test.receipt.rulebook.version}` : 'none published'}</dd></div>
                {test.receipt.decision === 'ask' && <div className="flex justify-between gap-4 py-2"><dt className="text-muted">Approver group</dt><dd>{test.approverGroup ?? 'owners'}</dd></div>}
                {test.receipt.details?.autonomy && <div className="flex justify-between gap-4 py-2"><dt className="text-muted">Autonomy</dt><dd>{String(test.receipt.details.autonomy)}{test.receipt.details.autonomy_grant === 'none' ? ' (no grant)' : ''}</dd></div>}
                <div className="flex justify-between gap-4 py-2"><dt className="text-muted">Outcome</dt><dd>{test.receipt.outcome?.status === 'ok' ? `Ran · ${test.receipt.outcome.ms} ms` : test.receipt.outcome?.status === 'not_run' ? 'Did not run' : advisory ? 'Agent runs the call' : 'Waiting for a person'}</dd></div>
                <div className="flex justify-between gap-4 py-2"><dt className="text-muted">Hash</dt><dd><Hash value={test.receipt.hash} /></dd></div>
                <div className="flex justify-between gap-4 py-2"><dt className="text-muted">Previous</dt><dd><Hash value={test.receipt.prev_hash} /></dd></div>
              </dl>
              <p className="text-xs text-muted">{test.receipt.reason}</p>
              <Link to={`/activity/${test.receipt.seq}`} className="inline-flex items-center gap-1 text-sm font-medium hover:underline underline-offset-2">Open the receipt <ArrowRight className="h-3.5 w-3.5" /></Link>
            </div>
          )}
        </Panel>

        <Panel title="Summary" tone="sunken">
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-muted">Agent</dt><dd className="font-mono text-[12.5px]">{agent.slug}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Route</dt><dd><RouteMode route={agent.route} compact /></dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Tools</dt><dd className="num">{n(agent.tools.length)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Preset</dt><dd className="capitalize">{draft.starter}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Rulebook v1</dt><dd className="inline-flex items-center gap-1">{inReview ? <><UserCheck className="h-3.5 w-3.5" />In review</> : <><ShieldCheck className="h-3.5 w-3.5" />Published</>}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Declaration</dt><dd className="font-mono text-[12px]">{created.declaration.id} v{created.declaration.version}{created.declaration.seq ? <> · <ReceiptLink seq={created.declaration.seq} /></> : null}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Actor kind</dt><dd>{created.declaration.actorKind.replace(/_/g, ' ')}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">AI inventory</dt><dd className="inline-flex items-center gap-1">{created.aiSystem ? <><ShieldCheck className="h-3.5 w-3.5" /><Link to={`/inventory/${created.aiSystem.id}`} className="underline">Added · {draft.businessUnit} · unassessed</Link></> : 'Not added'}</dd></div>
            {atLeast(api.levelOf(orgId), 'l3') && <div className="flex justify-between gap-3"><dt className="text-muted">Autonomy</dt><dd className="inline-flex items-center gap-1"><SlidersHorizontal className="h-3.5 w-3.5" />{created.autonomyStarted ? 'A2 Propose · A3 by graduation' : NO_GRANT_LABEL}</dd></div>}
          </dl>
        </Panel>

        <div className="flex flex-col items-stretch gap-2">
          <Button variant="primary" size="lg" disabled={!stored} onClick={onFinish} iconRight={<ArrowRight className="h-4 w-4" />}>Finish and open the agent</Button>
          {!stored && <p className="text-xs text-muted text-center">Tick “I have stored the key” to finish.</p>}
        </div>
      </div>
    </div>
  );
}
