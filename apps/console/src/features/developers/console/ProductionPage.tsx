import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Ban, CheckCircle2, Clock3, Download, FlaskConical, KeyRound, MailCheck, Play, Rocket, ShieldCheck, Undo2, XCircle } from 'lucide-react';
import { useQuery, useNow } from '@/hooks/useQuery';
import { useOrgId, useRole, useUser } from '@/store/session';
import { cn } from '@/lib/cn';
import { date, dateTime, n, plural, relative } from '@/lib/format';
import { userName } from '@/mock/users';
import type { Decision } from '@/types';
import {
  Badge, Banner, Button, Checkbox, CopyButton, DecisionChip, Dialog, EmptyState, Field, Input, KeyValue, PageHeader, Panel, Select, Skeleton, Stat, StatusChip, Tabs, Textarea, toast,
} from '@/components/ui';
import { AgentLink, ReceiptLink, RouteMode } from '@/components/domain';
import { DemoOutbox } from '@/features/auth/Outbox';
import { downloadJson } from '@/features/verify/bundle';
import { APPLICANT_REFUSALS, ELIGIBLE_LABEL, type ApplicantCategory, type ApplicantRefusal } from '@/features/onboarding/refusals';
import { TabPanel, usePageTitle, useTabParam } from '@/features/agentsdoor/shared';
import {
  BYPASS_PATHS, PROMOTION_MIN_DAYS, PROMOTION_RECENT_DAYS, REVIEW_CHECKS, REVIEW_TARGET_DAYS, SANDBOX_LIMITS, advisoryShortfall, devpathApi, inputFor, resultFile, reviewerFor,
  type DevPathView, type ProdKeyRequest, type PromotionRequest, type ReviewCheckId, type RunInput, type SandboxLimit,
} from '@/mock/devpath';
import { RunResult } from '../sections/Production';
import { RequestForm } from './RequestForm';

type TabId = 'sandbox' | 'conformance' | 'keys' | 'review' | 'promotion';
const TABS = ['sandbox', 'conformance', 'keys', 'review', 'promotion'] as const;

const errText = (e: unknown) => (e as Error)?.message ?? String(e);

/**
 * Agents › Path to production. The developer path from a sandbox key to a reviewed production key, and the
 * promotion of an advisory agent to a governed run. Every step is recorded on the organisation's chain.
 */
export default function ProductionPage() {
  usePageTitle('Path to production');
  const [tab, setTab] = useTabParam<TabId>(TABS);
  const { data: view, loading, error } = useQuery((o) => devpathApi.view(o), [], { kinds: ['devpath', 'agent', 'receipt', 'approval', 'key'] });
  const reviewCount = view ? view.state.requests.filter((r) => r.status === 'in_review').length + view.state.promotions.filter((p) => p.status === 'in_review').length : undefined;

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader kicker="Agents" title="Path to production" description="A sandbox key is self-serve; a production key never is. Prove the three answers in the sandbox, pass the conformance suite, then ask — a person reviews within 2 working days." actions={<Link to="/developers/path-to-production" className="inline-flex items-center gap-1 text-sm link">How it works<ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>} />
      {error && <Banner tone="bad" title="Path to production could not load">{errText(error)}</Banner>}
      {loading && !view ? <Skeleton className="h-24 w-full mb-6" /> : view && <Steps view={view} onGo={setTab} />}
      <Tabs<TabId> label="Path to production" value={tab} onChange={setTab} items={[
        { value: 'sandbox', label: 'Sandbox' },
        { value: 'conformance', label: 'Conformance', count: view?.state.runs.length },
        { value: 'keys', label: 'Production keys', count: view?.state.requests.filter((r) => r.status !== 'withdrawn').length },
        { value: 'review', label: view?.sovereign ? 'Review' : 'Review desk', count: reviewCount },
        { value: 'promotion', label: 'Promotion', count: view?.state.promotions.length },
      ]} />
      {view && tab === 'sandbox' && <TabPanel label="Sandbox"><SandboxTab view={view} /></TabPanel>}
      {view && tab === 'conformance' && <TabPanel label="Conformance"><ConformanceTab view={view} /></TabPanel>}
      {view && tab === 'keys' && <TabPanel label="Production keys"><KeysTab view={view} /></TabPanel>}
      {view && tab === 'review' && <TabPanel label="Review"><ReviewTab view={view} /></TabPanel>}
      {view && tab === 'promotion' && <TabPanel label="Promotion"><PromotionTab view={view} /></TabPanel>}
    </div>
  );
}

/* ── The five steps ───────────────────────────────────────── */

function Steps({ view, onGo }: { view: DevPathView; onGo: (t: TabId) => void }) {
  const st = view.state;
  const u = view.usage;
  const lastRun = st.runs[0];
  const lastReq = st.requests.find((r) => r.status !== 'withdrawn');
  const steps: { tab: TabId; title: string; done: boolean; text: string }[] = [
    { tab: 'sandbox', title: 'Sandbox tenant', done: st.sandbox?.status === 'active', text: st.sandbox?.status === 'active' ? `Active since ${date(st.sandbox.verifiedAt!)}` : st.sandbox ? 'Waiting for the email link' : 'Not created' },
    { tab: 'sandbox', title: 'Three answers', done: u.allowed > 0 && u.refused > 0 && u.resolvedByPerson > 0, text: `${n(u.allowed)} allowed · ${n(u.refused)} refused · ${n(u.resolvedByPerson)} decided by a person` },
    { tab: 'conformance', title: 'Conformance', done: !!st.runs.find((r) => r.allPassed), text: lastRun ? `${lastRun.allPassed ? 'All 14 pass' : `${lastRun.failed} failing`} · ${relative(lastRun.at)}` : 'Not run' },
    { tab: 'keys', title: 'Production key', done: st.requests.some((r) => r.status === 'issued'), text: lastReq ? REQ_LABEL[lastReq.status] + (lastReq.status === 'in_review' && lastReq.dueBy ? ` · due ${date(lastReq.dueBy)}` : '') : 'Not asked for' },
    { tab: 'promotion', title: 'Promotion', done: st.promotions.some((p) => p.status === 'approved'), text: st.promotions[0] ? `${st.promotions[0].agentSlug}: ${PRO_LABEL[st.promotions[0].status]}` : `${plural(view.agents.filter((a) => a.route !== 'mcp' && !a.retired).length, 'advisory agent')}` },
  ];
  return (
    <ol className="mb-6 grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-5" aria-label="Steps to production">
      {steps.map((s, i) => (
        <li key={s.title} className="bg-surface">
          <button type="button" onClick={() => onGo(s.tab)} className="flex h-full w-full items-start gap-3 p-4 text-left hover:bg-sunken/60">
            <span className={cn('mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center border text-[11px] font-semibold num', s.done ? 'border-fg bg-fg text-canvas' : 'border-line-strong text-muted')}>{s.done ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : i + 1}</span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{s.title}<span className="sr-only">{s.done ? ' (done)' : ''}</span></span>
              <span className="block text-xs text-muted leading-snug">{s.text}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

const REQ_LABEL: Record<ProdKeyRequest['status'], string> = { draft: 'Draft', in_review: 'In review', approved: 'Approved — collect the key', declined: 'Declined', issued: 'Key issued', withdrawn: 'Withdrawn' };
const PRO_LABEL: Record<PromotionRequest['status'], string> = { in_review: 'In review', approved: 'Approved — governed run', declined: 'Declined', withdrawn: 'Withdrawn' };

function ReqChip({ status }: { status: ProdKeyRequest['status'] }) {
  const tone = status === 'issued' || status === 'approved' ? 'ok' : status === 'declined' ? 'bad' : status === 'in_review' ? 'held' : 'neutral';
  const icon = status === 'declined' ? <XCircle className="h-3 w-3" aria-hidden /> : status === 'in_review' ? <Clock3 className="h-3 w-3" aria-hidden /> : status === 'issued' || status === 'approved' ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <Undo2 className="h-3 w-3" aria-hidden />;
  return <StatusChip tone={tone} size="sm" icon={icon}>{REQ_LABEL[status]}</StatusChip>;
}

function DueBy({ dueBy }: { dueBy?: string }) {
  const now = useNow(60_000);
  if (!dueBy) return null;
  const late = new Date(dueBy).getTime() < now;
  return <span className={cn('text-xs', late ? 'text-bad-fg font-medium' : 'text-muted')}>{late ? 'Past the 2-working-day target' : 'Decision due'} {dateTime(dueBy)}</span>;
}

function useCanAct() {
  const role = useRole();
  return role === 'owner' || role === 'admin';
}

function SecretOnce({ secret, onDone, label }: { secret?: string; onDone: () => void; label: string }) {
  const [stored, setStored] = useState(false);
  useEffect(() => { if (secret) setStored(false); }, [secret]);
  return (
    <Dialog open={!!secret} onClose={stored ? onDone : () => toast.held('Store the key first', 'Tick the box once the key is in your secret manager. It will not be shown again.')} title="Copy the key now" description={`${label} This is the only time the full key is shown. Elan1 Govern keeps only a hash and the prefix.`}
      footer={<Button variant="primary" disabled={!stored} onClick={onDone}>Done</Button>}>
      <div className="space-y-4">
        <div className="flex items-center gap-2 border border-line bg-sunken/70 p-3">
          <code className="flex-1 min-w-0 break-all font-mono text-[13px]">{secret}</code>
          {secret && <CopyButton text={secret} label="Copy key" />}
        </div>
        <Banner tone="held" title="It will not be shown again">If you lose it, revoke it on the agent’s Keys tab and ask again.</Banner>
        <Checkbox checked={stored} onChange={setStored} label="I have stored this key somewhere safe" />
      </div>
    </Dialog>
  );
}

/* ── Sandbox ──────────────────────────────────────────────── */

function SandboxTab({ view }: { view: DevPathView }) {
  const orgId = useOrgId();
  const user = useUser();
  const canAct = useCanAct();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const verifyToken = sp.get('verify') ?? undefined;
  const t = view.state.sandbox;
  const [secret, setSecret] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const verify = async () => {
    if (!user || !verifyToken) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await devpathApi.verifySandbox(orgId, verifyToken, user.id);
      setSecret(r.secret);
      toast.ok('Sandbox tenant created', `Fixtures loaded; receipt #${n(r.receipt.seq)}. Copy the key now.`);
      setSp((p) => { const x = new URLSearchParams(p); x.delete('verify'); return x; }, { replace: true });
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <SecretOnce secret={secret} onDone={() => setSecret(undefined)} label="Your sandbox key (sk_sbx_)." />
      {err && <Banner tone="bad" title="Not verified">{err}</Banner>}
      {verifyToken && t?.status === 'unverified' && (
        <Banner tone="info" title={`Verify ${t.email}`} actions={<Button size="sm" variant="primary" icon={<MailCheck className="h-3.5 w-3.5" />} loading={busy} disabled={!canAct} onClick={verify}>Verify and create the tenant</Button>}>
          You followed the link sent to {t.email}. Verifying creates the sandbox tenant with its fixtures and shows the sandbox key once.
        </Banner>
      )}
      {t?.status === 'active' ? <SandboxActive view={view} /> : <SandboxApply view={view} />}
      {t?.status === 'unverified' && !verifyToken && (
        <Panel title="Check your email" kicker="Step 2 of 3">
          <p className="text-sm text-muted mb-3">We sent a verification link to <strong className="text-fg">{t.email}</strong> on {dateTime(t.appliedAt)}. The tenant is created when it is followed.</p>
          <DemoOutbox orgId={orgId} emails={[t.email]} title="Demo outbox" limit={3} />
          <Button className="mt-3" size="sm" variant="secondary" onClick={() => nav(`/agents/production?tab=sandbox&verify=${t.token}`)}>Open the verification link</Button>
        </Panel>
      )}
    </div>
  );
}

function SandboxApply({ view }: { view: DevPathView }) {
  const orgId = useOrgId();
  const user = useUser();
  const canAct = useCanAct();
  const agents = view.agents.filter((a) => !a.retired);
  const [email, setEmail] = useState(user?.email ?? '');
  const [company, setCompany] = useState('');
  const [desc, setDesc] = useState('');
  const [cat, setCat] = useState<ApplicantCategory>('eligible');
  const [slug, setSlug] = useState(agents[0]?.slug ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [refused, setRefused] = useState<{ r: ApplicantRefusal; seq: number }>();

  const apply = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined); setRefused(undefined);
    try {
      const r = await devpathApi.applySandbox(orgId, { email, company, description: desc, category: cat, agentSlug: slug }, user.id);
      if ('refused' in r && r.refused) { setRefused({ r: r.refused, seq: r.receipt.seq }); return; }
      toast.ok('Verification link sent', `Check ${email}. The application is receipt #${n(r.receipt.seq)}.`);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  return (
    <Panel title="Apply for a sandbox tenant" kicker="Step 1 of 3 · self-serve">
      <p className="text-sm text-muted mb-4 max-w-[72ch]">A sandbox tenant has fixtures to call against and its own sk_sbx_ key. {SANDBOX_LIMITS.perMinute} writes a minute, {SANDBOX_LIMITS.concurrent} at once, {n(SANDBOX_LIMITS.perMonth)} a month, then a hard stop. Sandbox calls are metered at 0 and never billed.</p>
      {!canAct && <Banner tone="neutral" className="mb-4" title="Owners and admins apply">Your role can read this page but cannot apply.</Banner>}
      {err && <Banner tone="bad" className="mb-4" title="Not sent">{err}</Banner>}
      {refused && (
        <Banner tone="bad" className="mb-4" title="We cannot open a sandbox for this">
          {refused.r.sentence}{refused.r.instead && <> {refused.r.instead}</>} Recorded on <ReceiptLink seq={refused.seq} />.
        </Banner>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Work email" htmlFor="sb-email" hint="The verification link goes here. A personal mailbox is refused.">
          <Input id="sb-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Company" htmlFor="sb-company">
          <Input id="sb-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="As registered" />
        </Field>
        <Field label="What will the agent do?" htmlFor="sb-desc" hint="One line." className="sm:col-span-2">
          <Input id="sb-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="For example: records supplier payments in Zoho Books after a person approves large ones" />
        </Field>
        <Field label="Which describes you?" htmlFor="sb-cat" className="sm:col-span-2">
          <Select id="sb-cat" value={cat} onChange={(e) => setCat(e.target.value as ApplicantCategory)}>
            <option value="eligible">{ELIGIBLE_LABEL}</option>
            {APPLICANT_REFUSALS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </Select>
        </Field>
        <Field label="Agent the sandbox key is for" htmlFor="sb-agent">
          <Select id="sb-agent" value={slug} onChange={(e) => setSlug(e.target.value)}>
            {agents.map((a) => <option key={a.slug} value={a.slug}>{a.name} ({a.slug})</option>)}
          </Select>
        </Field>
      </div>
      <Button className="mt-4" variant="primary" icon={<MailCheck className="h-4 w-4" />} loading={busy} disabled={!canAct || !agents.length} onClick={apply}>Send the verification link</Button>
    </Panel>
  );
}

function SandboxActive({ view }: { view: DevPathView }) {
  const orgId = useOrgId();
  const user = useUser();
  const canAct = useCanAct();
  const t = view.state.sandbox!;
  const u = view.usage;
  const withKey = view.agents.filter((a) => a.sandboxKey && !a.retired);
  const [slug, setSlug] = useState(withKey.find((a) => a.slug === t.agentSlug)?.slug ?? withKey[0]?.slug ?? '');
  const [busy, setBusy] = useState<Decision | 'burst'>();
  const [last, setLast] = useState<{ seq: number; decision?: Decision; rule?: string; wanted: Decision; approvalId?: string; outcomeSeq?: number; limited?: SandboxLimit; reason?: string }>();
  const [burst, setBurst] = useState<{ seq: number; decision?: Decision; limited?: SandboxLimit }[]>();
  const [err, setErr] = useState<string>();

  const send = async (want: Decision) => {
    if (!user) return;
    setBusy(want); setErr(undefined); setBurst(undefined);
    try {
      const r = await devpathApi.sendFixture(orgId, slug, want, user.id);
      setLast({ seq: r.receipt.seq, decision: r.receipt.decision, rule: r.receipt.rule_id, wanted: want, approvalId: r.approvalId, outcomeSeq: r.outcome?.seq, limited: r.limited, reason: r.receipt.reason });
    } catch (e) { setErr(errText(e)); } finally { setBusy(undefined); }
  };
  // one more call than the limit allows at once, sent together: the extra one is refused and recorded
  const sendTogether = async () => {
    if (!user) return;
    setBusy('burst'); setErr(undefined); setLast(undefined);
    try {
      const rs = await Promise.all(Array.from({ length: SANDBOX_LIMITS.concurrent + 1 }, () => devpathApi.sendFixture(orgId, slug, 'allow', user.id)));
      setBurst(rs.map((r) => ({ seq: r.receipt.seq, decision: r.receipt.decision, limited: r.limited })).sort((a, b) => a.seq - b.seq));
    } catch (e) { setErr(errText(e)); } finally { setBusy(undefined); }
  };
  const LIMIT_LABEL: Record<SandboxLimit, string> = { per_month: 'the month’s hard stop', concurrent: `${SANDBOX_LIMITS.concurrent} at once`, per_minute: `${SANDBOX_LIMITS.perMinute} a minute` };

  const proof = [
    { label: 'A call that is allowed', ok: u.allowed > 0, n: u.allowed },
    { label: 'A call that is refused', ok: u.refused > 0, n: u.refused },
    { label: 'A held call decided by a person in your organisation', ok: u.resolvedByPerson > 0, n: u.resolvedByPerson },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-7 space-y-6">
        <Panel title="Prove the three answers" kicker="In the sandbox">
          <ul className="mb-4 space-y-1.5">
            {proof.map((p) => (
              <li key={p.label} className="flex items-center gap-2 text-sm">
                {p.ok ? <CheckCircle2 className="h-4 w-4 text-ok-fg" aria-hidden /> : <Clock3 className="h-4 w-4 text-muted" aria-hidden />}
                <span>{p.label}</span><span className="ml-auto text-muted num">{n(p.n)}</span><span className="sr-only">{p.ok ? 'done' : 'not yet'}</span>
              </li>
            ))}
          </ul>
          {err && <Banner tone="bad" className="mb-3" title="Not sent">{err}</Banner>}
          {withKey.length ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Agent" htmlFor="fx-agent" className="min-w-[200px]">
                <Select id="fx-agent" value={slug} onChange={(e) => setSlug(e.target.value)}>
                  {withKey.map((a) => <option key={a.slug} value={a.slug}>{a.slug} · {a.sandboxKey}…</option>)}
                </Select>
              </Field>
              {(['allow', 'refuse', 'ask'] as Decision[]).map((d) => (
                <Button key={d} size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} loading={busy === d} disabled={!canAct || !!busy} onClick={() => send(d)}>
                  {d === 'allow' ? 'An allowed call' : d === 'refuse' ? 'A refused call' : 'A held call'}
                </Button>
              ))}
              <Button size="sm" variant="ghost" icon={<Play className="h-3.5 w-3.5" />} loading={busy === 'burst'} disabled={!canAct || !!busy} onClick={sendTogether} title={`Sends ${SANDBOX_LIMITS.concurrent + 1} allowed calls at the same moment; the limit is ${SANDBOX_LIMITS.concurrent} at once`}>
                {SANDBOX_LIMITS.concurrent + 1} calls at once
              </Button>
            </div>
          ) : <EmptyState compact title="No agent has a sandbox key" disc="aperture">Issue an sk_sbx_ key on an agent’s Keys tab.</EmptyState>}
          {burst && (
            <div className="mt-4 border border-line bg-sunken/40 p-3 text-sm" aria-live="polite">
              <p className="mb-2">{burst.length} calls sent together; the limit is {SANDBOX_LIMITS.concurrent} at once.</p>
              <ul className="space-y-1">
                {burst.map((b) => (
                  <li key={b.seq} className="flex flex-wrap items-center gap-2">
                    <DecisionChip decision={b.decision} size="sm" /><ReceiptLink seq={b.seq} />
                    {b.limited ? <span className="text-muted">refused: <span className="font-mono">GATE.SANDBOX_LIMIT_REACHED</span> ({LIMIT_LABEL[b.limited]}) · recorded, metered at 0</span> : <span className="text-muted">ran in the sandbox</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {last && (
            <div className="mt-4 border border-line bg-sunken/40 p-3 text-sm" aria-live="polite">
              <div className="flex flex-wrap items-center gap-2">
                <DecisionChip decision={last.decision} size="sm" />
                <ReceiptLink seq={last.seq} />
                <span className="text-muted">rule <span className="font-mono">{last.rule}</span></span>
                {last.outcomeSeq && <span className="text-muted">· outcome <ReceiptLink seq={last.outcomeSeq} /></span>}
              </div>
              {last.limited && <p className="mt-1">Refused with <span className="font-mono">GATE.SANDBOX_LIMIT_REACHED</span> — over {LIMIT_LABEL[last.limited]}. {last.reason} <Link to="/developers/refusals/GATE.SANDBOX_LIMIT_REACHED" className="link">What to do</Link></p>}
              {!last.limited && last.decision !== last.wanted && <p className="mt-1 text-muted">The rulebook decided this fixture differently from what you asked for; send another.</p>}
              {last.approvalId && <p className="mt-1">Held for a person. <Link to={`/approvals/${last.approvalId}`} className="link">Decide it in Approvals</Link> — a real person must, for the escalation to count.</p>}
            </div>
          )}
          {!canAct && <p className="mt-3 text-xs text-muted">Owners and admins send fixture calls.</p>}
        </Panel>
        <Panel title="Recent sandbox receipts" flush>
          {view.recentSandbox.length ? (
            <ul className="divide-y divide-line">
              {view.recentSandbox.map((r) => (
                <li key={r.seq} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                  <ReceiptLink seq={r.seq} />
                  {r.kind === 'decision' ? <DecisionChip decision={r.decision} size="sm" /> : <Badge>{r.kind}</Badge>}
                  <AgentLink slug={r.agent} />
                  <span className="font-mono text-[12px] text-muted truncate max-w-[220px]">{r.tool}</span>
                  <span className="ml-auto text-xs text-muted">{relative(r.ts)}</span>
                </li>
              ))}
            </ul>
          ) : <EmptyState compact title="No sandbox calls yet" disc="aperture">Send a fixture call above.</EmptyState>}
        </Panel>
      </div>
      <div className="lg:col-span-5 space-y-6">
        <Panel title="Sandbox tenant" kicker={t.id} actions={<StatusChip tone="ok" size="sm" icon={<FlaskConical className="h-3 w-3" aria-hidden />}>Active</StatusChip>}>
          <KeyValue items={[
            { k: 'Verified', v: `${t.email} · ${dateTime(t.verifiedAt!)}` },
            { k: 'Company', v: t.company },
            { k: 'Agent', v: <AgentLink slug={t.agentSlug} /> },
            { k: 'Key', v: t.keyPrefix ? `${t.keyPrefix}…` : '—', mono: true },
            { k: 'Recorded', v: <span className="inline-flex gap-2">{t.seqs.applied && <ReceiptLink seq={t.seqs.applied} />}{t.seqs.created && <ReceiptLink seq={t.seqs.created} />}</span> },
          ]} />
          <p className="label mt-4 mb-1.5">Fixtures</p>
          <ul className="list-[square] pl-5 text-sm space-y-0.5 marker:text-accent">{t.fixtures.map((f) => <li key={f}>{f}</li>)}</ul>
        </Panel>
        <div className="grid grid-cols-2 gap-4">
          <Stat label="This month" value={n(u.month)} sub={`of ${n(SANDBOX_LIMITS.perMonth)}, then a hard stop`} />
          <Stat label="Last minute" value={n(u.lastMinute)} sub={`of ${SANDBOX_LIMITS.perMinute} a minute`} />
          <Stat label="In flight" value={n(u.running)} sub={`of ${SANDBOX_LIMITS.concurrent} at once`} />
          <Stat label="Over a limit" value={n(u.limited)} sub="Refused and recorded (GATE.SANDBOX_LIMIT_REACHED)" />
          <Stat label="Metered" value="0" sub="Sandbox calls are never billed (₹0)" />
          <Stat label="Sandbox decisions" value={n(u.decisions)} sub={`${n(u.allowed)} · ${n(u.refused)} · ${n(u.asked)} held`} />
        </div>
      </div>
    </div>
  );
}

/* ── Conformance ──────────────────────────────────────────── */

function ConformanceTab({ view }: { view: DevPathView }) {
  const orgId = useOrgId();
  const user = useUser();
  const canAct = useCanAct();
  const agents = view.agents.filter((a) => !a.retired);
  const [slug, setSlug] = useState(view.state.sandbox?.agentSlug ?? agents[0]?.slug ?? '');
  const agent = agents.find((a) => a.slug === slug);
  const [given, setGiven] = useState<RunInput>({ failClosed: false, retryAfter: false, webhookVerify: true, familyHandling: false, copy: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [shown, setShown] = useState<string>();
  const input = agent ? inputFor(agent.route, given) : given;
  const rest = agent?.route === 'rest';
  const run = view.state.runs.find((r) => r.id === shown) ?? view.state.runs.find((r) => r.agentSlug === slug);

  const go = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await devpathApi.runConformance(orgId, slug, given, user.id);
      setShown(r.id);
      toast[r.allPassed ? 'ok' : 'held'](r.allPassed ? 'All 14 tests pass' : `${r.failed} ${r.failed === 1 ? 'test fails' : 'tests fail'}`, `Recorded as receipt #${n(r.seq!)}. Download the result file to attach it.`);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <div className="lg:col-span-5 space-y-6">
        <Panel title="Run C1–C14" kicker="Against the agent’s sandbox receipts">
          {err && <Banner tone="bad" className="mb-3" title="The run did not finish">{err}</Banner>}
          <div className="space-y-4">
            <Field label="Agent" htmlFor="cf-agent">
              <Select id="cf-agent" value={slug} onChange={(e) => { setSlug(e.target.value); setShown(undefined); }}>
                {agents.map((a) => <option key={a.slug} value={a.slug}>{a.name} ({a.slug})</option>)}
              </Select>
            </Field>
            {agent && <p className="text-sm text-muted">Route: <RouteMode route={agent.route} compact /></p>}
            <fieldset className="space-y-2">
              <legend className="label mb-1">What your client does</legend>
              {rest ? (
                <>
                  <Checkbox checked={given.failClosed} onChange={(v) => setGiven({ ...given, failClosed: v })} label="Treats a timeout or a 5xx as a refusal (C6)" />
                  <Checkbox checked={given.retryAfter} onChange={(v) => setGiven({ ...given, retryAfter: v })} label="Waits Retry-After seconds on a 429 (C7)" />
                  <Checkbox checked={given.familyHandling} onChange={(v) => setGiven({ ...given, familyHandling: v })} label="Retries only PLATFORM.* refusals, with the same intent (C11)" />
                </>
              ) : <p className="text-sm text-muted">{agent?.route === 'mcp' ? 'A governed run fails closed, honours Retry-After and tells refusal families apart by design.' : 'The SDK fails closed, honours Retry-After and tells refusal families apart.'}</p>}
              <Checkbox checked={given.webhookVerify} onChange={(v) => setGiven({ ...given, webhookVerify: v })} label="Verifies X-Elan1-Signature on webhooks (C9)" />
            </fieldset>
            <Field label="Copy your integration shows people" htmlFor="cf-copy" hint={`Scanned for C13 and C14 at ${view.level === 'l1' ? 'L1: “signed” is not allowed; say “sealed in a hash chain”' : 'your level'}.`}>
              <Textarea id="cf-copy" rows={3} value={given.copy} onChange={(e) => setGiven({ ...given, copy: e.target.value })} placeholder="For example: Every payment is checked against your rulebook and recorded." />
            </Field>
            <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={busy} disabled={!canAct || !agent} onClick={go}>Run the suite</Button>
            {!canAct && <p className="text-xs text-muted">Owners and admins run the suite.</p>}
            <p className="text-xs text-muted">Inputs used: fail closed {input.failClosed ? 'yes' : 'no'}, Retry-After {input.retryAfter ? 'yes' : 'no'}, families {input.familyHandling ? 'yes' : 'no'}.</p>
          </div>
        </Panel>
        <Panel title="Earlier runs" flush>
          {view.state.runs.length ? (
            <ul className="divide-y divide-line">
              {view.state.runs.map((r) => (
                <li key={r.id} className={cn('flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm', run?.id === r.id && 'bg-sunken/50')}>
                  <button type="button" className="link text-left" onClick={() => { setSlug(r.agentSlug); setShown(r.id); }}>{dateTime(r.at)}</button>
                  <span className="font-mono text-[12px]">{r.agentSlug}</span>
                  {r.allPassed ? <Badge tone="ok">14 pass</Badge> : <Badge tone="bad">{r.failed} failing</Badge>}
                  {r.highest && <span className="font-mono text-[11.5px] text-muted">{r.highest}</span>}
                  <span className="ml-auto inline-flex items-center gap-2">{r.seq && <ReceiptLink seq={r.seq} />}
                    <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => downloadJson(`conformance-${r.agentSlug}-${r.at.slice(0, 10)}.json`, resultFile(r))} aria-label={`Download the result file of ${dateTime(r.at)}`}>File</Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : <EmptyState compact title="No run yet" disc="aperture">Run the suite once the sandbox has the three answers.</EmptyState>}
        </Panel>
      </div>
      <div className="lg:col-span-7">
        {run ? <RunResult run={run} /> : <EmptyState title="No result for this agent yet" disc="aperture">Run the suite. Every test must pass before you ask for a production key.</EmptyState>}
        {run && <p className="mt-2 text-xs text-muted">Run by {userName(run.by)} {relative(run.at)} on {run.sample.receipts} sandbox receipts. {run.seq && <>Recorded on <ReceiptLink seq={run.seq} />.</>}</p>}
      </div>
    </div>
  );
}

/* ── Production keys ──────────────────────────────────────── */

function KeysTab({ view }: { view: DevPathView }) {
  const orgId = useOrgId();
  const user = useUser();
  const canAct = useCanAct();
  const [sp] = useSearchParams();
  const [secret, setSecret] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const reqs = view.state.requests;

  const collect = async (r: ProdKeyRequest) => {
    if (!user) return;
    setBusy(r.id);
    try {
      const out = await devpathApi.collectKey(orgId, r.id, user.id);
      setSecret(out.secret);
      toast.ok('Production key issued', `${out.request.keyPrefix}… for ${r.agentSlug}; receipt #${n(out.receipt.seq)}.`);
    } catch (e) { toast.bad('Not issued', errText(e)); } finally { setBusy(undefined); }
  };
  const withdraw = async (r: ProdKeyRequest) => {
    if (!user) return;
    setBusy(r.id);
    try { await devpathApi.withdrawRequest(orgId, r.id, user.id); toast.info('Request withdrawn', 'Recorded as a receipt.'); } catch (e) { toast.bad('Not withdrawn', errText(e)); } finally { setBusy(undefined); }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-12 [&>*]:min-w-0">
      <SecretOnce secret={secret} onDone={() => setSecret(undefined)} label="Your production key (gk_)." />
      <div className="lg:col-span-6">
        <Panel title="Ask for a production key" kicker="Reviewed by a person">
          <RequestForm view={view} agentSlug={sp.get('agent') ?? undefined} />
        </Panel>
      </div>
      <div className="lg:col-span-6 space-y-4">
        {!reqs.length && <EmptyState title="No request yet" disc="aperture">Ask once the conformance suite passes. A person decides within {REVIEW_TARGET_DAYS} working days.</EmptyState>}
        {reqs.map((r) => (
          <Panel key={r.id} title={<span className="inline-flex flex-wrap items-center gap-2"><AgentLink slug={r.agentSlug} /><ReqChip status={r.status} /></span>} kicker={r.id}>
            <KeyValue items={[
              { k: 'Asked', v: <>{dateTime(r.submittedAt ?? r.requestedAt)} by {userName(r.requestedBy)} {r.seqs.requested && <ReceiptLink seq={r.seqs.requested} />}</> },
              { k: 'Mode', v: r.enforcement === 'governed_run' ? 'Governed run (enforced)' : 'Check and record (advisory)' },
              { k: 'Declaration', v: r.declarationVersion ? `Version ${r.declarationVersion}` : '—' },
              { k: 'Target · residency', v: `${r.targetSystem || '—'} · ${r.residency}` },
              { k: 'Production owner', v: userName(r.productionOwnerId) },
              { k: 'If wrong', v: r.reversal === 'irreversible' ? 'Declared irreversible' : r.reversalNote || '—' },
              ...(r.reviewer ? [{ k: 'Reviewed', v: <>{userName(r.reviewer)} · {dateTime(r.reviewedAt!)} {r.seqs.reviewed && <ReceiptLink seq={r.seqs.reviewed} />}</> }] : []),
              ...(r.keyPrefix ? [{ k: 'Key', v: <>{r.keyPrefix}… · {dateTime(r.issuedAt!)} {r.seqs.issued && <ReceiptLink seq={r.seqs.issued} />}</> }] : []),
            ]} />
            {r.status === 'in_review' && <div className="mt-2"><DueBy dueBy={r.dueBy} /></div>}
            {r.note && <Banner tone={r.status === 'declined' ? 'bad' : 'info'} className="mt-3" title={r.status === 'declined' ? 'Why it was declined' : 'Reviewer’s note'}>{r.note}</Banner>}
            {(r.status === 'approved' || r.status === 'in_review' || r.status === 'draft') && (
              <div className="mt-3 flex flex-wrap gap-2">
                {r.status === 'approved' && <Button size="sm" variant="primary" icon={<KeyRound className="h-3.5 w-3.5" />} loading={busy === r.id} disabled={!canAct} onClick={() => collect(r)}>Collect the key</Button>}
                <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} disabled={!canAct || busy === r.id} onClick={() => withdraw(r)}>Withdraw</Button>
              </div>
            )}
          </Panel>
        ))}
      </div>
    </div>
  );
}

/* ── Review desk ──────────────────────────────────────────── */

function ReviewTab({ view }: { view: DevPathView }) {
  const reqs = view.state.requests.filter((r) => r.status === 'in_review');
  const pros = view.state.promotions.filter((p) => p.status === 'in_review');
  const done = [...view.state.requests.filter((r) => r.reviewedAt).map((r) => ({ id: r.id, what: `Production key · ${r.agentSlug}`, ok: r.status !== 'declined', at: r.reviewedAt!, by: r.reviewer!, seq: r.seqs.reviewed })),
    ...view.state.promotions.filter((p) => p.reviewedAt).map((p) => ({ id: p.id, what: `Promotion · ${p.agentSlug}`, ok: p.status === 'approved', at: p.reviewedAt!, by: p.reviewer!, seq: p.seqs.reviewed }))].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <div className="space-y-6">
      {view.sovereign ? (
        <Banner tone="info" title="Your review">On a Sovereign installation the production-key and promotion reviews are yours: an owner or admin other than the requester checks the same four things and decides, under their own name.</Banner>
      ) : (
        <Banner tone="neutral" title="Elan1 review desk">In service, only Elan1’s production reviewers see this queue and decide. It is shown here so the whole path can be walked in the demo: an owner or admin who did not ask stands in for the desk. The decision is recorded on your chain under the name of the person who made it, marked as the desk’s stand-in — never under a reviewer who did not act. Nobody reviews their own request. Target: {REVIEW_TARGET_DAYS} working days.</Banner>
      )}
      {!reqs.length && !pros.length && <EmptyState title="Nothing waiting for review" disc="aperture">Production-key requests and promotions appear here when they are sent.</EmptyState>}
      {reqs.map((r) => <ReviewRequest key={r.id} view={view} req={r} />)}
      {pros.map((p) => <ReviewPromotion key={p.id} view={view} pro={p} />)}
      {done.length > 0 && (
        <Panel title="Decided" flush>
          <ul className="divide-y divide-line">
            {done.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                {x.ok ? <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Approved</StatusChip> : <StatusChip tone="bad" size="sm" icon={<Ban className="h-3 w-3" aria-hidden />}>Declined</StatusChip>}
                <span>{x.what}</span><span className="text-muted">by {userName(x.by)} {relative(x.at)}</span>
                <span className="ml-auto">{x.seq && <ReceiptLink seq={x.seq} />}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function ReviewRequest({ view, req }: { view: DevPathView; req: ProdKeyRequest }) {
  const orgId = useOrgId();
  const user = useUser();
  const who = reviewerFor(orgId, req.requestedBy, user?.id);
  const run = view.state.runs.find((r) => r.id === req.conformanceRunId);
  const agent = view.agents.find((a) => a.slug === req.agentSlug);
  // what the record says about each check, for the reviewer to confirm
  const facts: Record<ReviewCheckId, ReactNode> = {
    conformance: run ? <>{run.allPassed ? 'All 14 pass' : `${run.failed} failing`} · {run.agentSlug} · {dateTime(run.at)} {run.seq && <ReceiptLink seq={run.seq} />}</> : 'No result file attached',
    declaration: <>Version {req.declarationVersion ?? '—'}; the agent runs version {agent?.publishedVersion ?? '—'}</>,
    target: <>{req.targetSystem} · {req.residency} (organisation: {view.residency})</>,
    owner: <>{userName(req.productionOwnerId)}{view.people.some((p) => p.id === req.productionOwnerId) ? ` (${view.people.find((p) => p.id === req.productionOwnerId)!.role})` : ' — not an owner, admin or approver here'}</>,
  };
  const [checks, setChecks] = useState<Partial<Record<ReviewCheckId, boolean>>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'a' | 'd'>();
  const [err, setErr] = useState<string>();
  const decide = async (approve: boolean) => {
    if (!user) return;
    setBusy(approve ? 'a' : 'd'); setErr(undefined);
    try {
      const r = await devpathApi.reviewRequest(orgId, req.id, approve, checks, note, user.id);
      toast[approve ? 'ok' : 'held'](approve ? 'Production key approved' : 'Request declined', `${req.agentSlug}; receipt #${n(r.receipt.seq)}.${approve ? ' The requester collects the key once.' : ''}`);
    } catch (e) { setErr(errText(e)); } finally { setBusy(undefined); }
  };
  const all = REVIEW_CHECKS.every((c) => checks[c.id]);
  return (
    <Panel title={`Production key for ${req.agentSlug}`} kicker={`${req.id} · asked by ${userName(req.requestedBy)}`} actions={<DueBy dueBy={req.dueBy} />}>
      {err && <Banner tone="bad" className="mb-3" title="Not decided">{err}</Banner>}
      <ul className="space-y-3">
        {REVIEW_CHECKS.map((c) => (
          <li key={c.id}>
            <Checkbox checked={!!checks[c.id]} onChange={(v) => setChecks({ ...checks, [c.id]: v })} label={c.label} description={facts[c.id]} disabled={!who.canAct} />
          </li>
        ))}
      </ul>
      <Field label="Note for the requester" htmlFor={`rv-${req.id}`} hint="Required to decline: say what to fix." className="mt-4">
        <Textarea id={`rv-${req.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={!who.canAct} />
      </Field>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={<ShieldCheck className="h-4 w-4" />} loading={busy === 'a'} disabled={!who.canAct || !all || !!busy} onClick={() => decide(true)}>Approve</Button>
        <Button variant="quiet-danger" icon={<Ban className="h-4 w-4" />} loading={busy === 'd'} disabled={!who.canAct || note.trim().length < 10 || !!busy} onClick={() => decide(false)}>Decline</Button>
        {!who.canAct && <span className="text-sm text-muted">{who.whyNot}</span>}
        {who.canAct && !all && <span className="text-sm text-muted">Approve when all four checks hold.</span>}
      </div>
    </Panel>
  );
}

function ReviewPromotion({ pro }: { view: DevPathView; pro: PromotionRequest }) {
  const orgId = useOrgId();
  const user = useUser();
  const who = reviewerFor(orgId, pro.requestedBy, user?.id);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'a' | 'd'>();
  const [err, setErr] = useState<string>();
  const decide = async (approve: boolean) => {
    if (!user) return;
    setBusy(approve ? 'a' : 'd'); setErr(undefined);
    try {
      const r = await devpathApi.reviewPromotion(orgId, pro.id, approve, note, user.id);
      toast[approve ? 'ok' : 'held'](approve ? `${pro.agentSlug} now uses a governed run` : 'Promotion declined', `Receipt #${n(r.receipt.seq)}.`);
    } catch (e) { setErr(errText(e)); } finally { setBusy(undefined); }
  };
  return (
    <Panel title={`Promote ${pro.agentSlug} to a governed run`} kicker={`${pro.id} · asked by ${userName(pro.requestedBy)}`} actions={<DueBy dueBy={pro.dueBy} />}>
      {err && <Banner tone="bad" className="mb-3" title="Not decided">{err}</Banner>}
      <KeyValue cols={2} items={[
        { k: 'Advisory since', v: `${date(pro.advisorySince)} (${pro.days} days; at least ${PROMOTION_MIN_DAYS})` },
        { k: 'Advisory decisions', v: `${n(pro.advisoryDecisions)}${pro.activeDays !== undefined ? ` on ${plural(pro.activeDays, 'day')}` : ''}` },
        { k: 'From', v: <RouteMode route={pro.fromRoute} compact /> },
        { k: 'To', v: <RouteMode route="mcp" compact /> },
      ]} />
      <p className="label mt-4 mb-1.5">Bypass proof</p>
      <ul className="space-y-2">{pro.bypass.map((b) => <li key={b.id} className="border-l-2 border-line-strong pl-3 text-sm"><span className="font-medium">{b.path}</span><span className="block text-muted">{b.evidence} · tested {date(b.testedAt)}</span></li>)}</ul>
      <Field label="Note" htmlFor={`pr-${pro.id}`} hint="Required to decline." className="mt-4">
        <Textarea id={`pr-${pro.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={!who.canAct} />
      </Field>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={<Rocket className="h-4 w-4" />} loading={busy === 'a'} disabled={!who.canAct || !!busy} onClick={() => decide(true)}>Approve the promotion</Button>
        <Button variant="quiet-danger" icon={<Ban className="h-4 w-4" />} loading={busy === 'd'} disabled={!who.canAct || note.trim().length < 10 || !!busy} onClick={() => decide(false)}>Decline</Button>
        {!who.canAct && <span className="text-sm text-muted">{who.whyNot}</span>}
      </div>
    </Panel>
  );
}

/* ── Promotion ────────────────────────────────────────────── */

function PromotionTab({ view }: { view: DevPathView }) {
  const canAct = useCanAct();
  const advisory = view.agents.filter((a) => a.route !== 'mcp' && !a.retired);
  const [asking, setAsking] = useState<string>();
  const pros = view.state.promotions;
  return (
    <div className="space-y-6">
      <Banner tone="info" title="Advisory to enforced">An agent on check and record is advisory: Elan1 Govern answers and records, and your code runs the call. A governed run holds the credentials, so an agent that skips the check is stopped. Promotion needs {PROMOTION_MIN_DAYS} days of advisory traffic — counted from the agent’s first check-and-record decision, with decisions in the last {PROMOTION_RECENT_DAYS} days — and a bypass proof, and is reviewed.</Banner>
      <Panel title="Advisory agents" flush>
        {advisory.length ? (
          <ul className="divide-y divide-line">
            {advisory.map((a) => {
              const ev = a.advisory!;
              const open = pros.find((p) => p.agentSlug === a.slug && p.status === 'in_review');
              const short = advisoryShortfall(ev);
              const ready = !short && ev.connectors.length > 0;
              return (
                <li key={a.slug} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
                  <AgentLink slug={a.slug} />
                  <RouteMode route={a.route} compact />
                  <span className={cn('num', !short ? 'text-fg' : 'text-held-fg')}>{ev.decisions ? `${plural(ev.days, 'day')} since ${date(ev.since!)} · ${n(ev.decisions)} decisions on ${plural(ev.activeDays, 'day')}` : 'No advisory traffic yet'}</span>
                  <span className="text-muted">{ev.connectors.length ? ev.connectors.map((c) => c.name).join(', ') : 'No connector'}</span>
                  <span className="ml-auto">
                    {open ? <Badge tone="held">In review</Badge> : (
                      <Button size="sm" variant="secondary" icon={<Rocket className="h-3.5 w-3.5" />} disabled={!canAct || !ready || a.status !== 'active'} title={!ready ? (short ?? 'Add a connector first') : a.status !== 'active' ? 'The agent is paused' : undefined} onClick={() => setAsking(a.slug)}>Ask for promotion</Button>
                    )}
                  </span>
                  {short && <span className="basis-full text-xs text-muted">{short}</span>}
                </li>
              );
            })}
          </ul>
        ) : <EmptyState compact title="Every agent already uses a governed run" disc="aperture">Nothing to promote.</EmptyState>}
      </Panel>
      {pros.length > 0 && (
        <Panel title="Promotions" flush>
          <ul className="divide-y divide-line">
            {pros.map((p) => (
              <li key={p.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <AgentLink slug={p.agentSlug} />
                  <StatusChip tone={p.status === 'approved' ? 'ok' : p.status === 'declined' ? 'bad' : 'held'} size="sm" icon={p.status === 'approved' ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : p.status === 'declined' ? <XCircle className="h-3 w-3" aria-hidden /> : <Clock3 className="h-3 w-3" aria-hidden />}>{PRO_LABEL[p.status]}</StatusChip>
                  <span className="text-muted">asked by {userName(p.requestedBy)} {relative(p.requestedAt)}</span>
                  {p.seqs.requested && <ReceiptLink seq={p.seqs.requested} />}
                  {p.seqs.reviewed && <ReceiptLink seq={p.seqs.reviewed} />}
                  {p.status === 'in_review' && <span className="ml-auto"><DueBy dueBy={p.dueBy} /></span>}
                </div>
                {p.note && <p className={cn('mt-1', p.status === 'declined' ? 'text-bad-fg' : 'text-muted')}>{p.note}</p>}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <PromotionDialog slug={asking} view={view} onClose={() => setAsking(undefined)} />
    </div>
  );
}

function PromotionDialog({ slug, view, onClose }: { slug?: string; view: DevPathView; onClose: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const [ev, setEv] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (slug) { setEv({}); setErr(undefined); } }, [slug]);
  const a = view.agents.find((x) => x.slug === slug);
  const ready = useMemo(() => BYPASS_PATHS.every((p) => (ev[p.id] ?? '').trim().length >= 12), [ev]);
  const send = async () => {
    if (!user || !slug) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await devpathApi.requestPromotion(orgId, slug, BYPASS_PATHS.map((p) => ({ id: p.id, evidence: ev[p.id] ?? '' })), user.id);
      toast.ok('Promotion asked for', `In review; receipt #${n(r.receipt.seq)}.`);
      onClose();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={!!slug} onClose={onClose} size="lg" title={`Promote ${slug ?? ''} to a governed run`} description={a?.advisory ? `${a.advisory.days} days of advisory traffic since the first check-and-record decision, ${n(a.advisory.decisions)} decisions. Show that every path to the target other than Elan1 Govern fails.` : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Rocket className="h-4 w-4" />} loading={busy} disabled={!ready} onClick={send}>Send for review</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Not sent">{err}</Banner>}
        {BYPASS_PATHS.map((p, i) => (
          <Field key={p.id} label={`${i + 1}. ${p.label}`} htmlFor={`bp-${p.id}`} hint="What you tried, when, and what came back (12 characters or more).">
            <Input id={`bp-${p.id}`} value={ev[p.id] ?? ''} onChange={(e) => setEv({ ...ev, [p.id]: e.target.value })} {...(i === 0 ? { 'data-autofocus': true } : {})} />
          </Field>
        ))}
      </div>
    </Dialog>
  );
}
