import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import { useOrgId, useRole, useUser } from '@/store/session';
import { date, dateTime } from '@/lib/format';
import { Banner, Button, Field, Input, RadioCards, Select, Textarea, toast } from '@/components/ui';
import { ReceiptLink } from '@/components/domain';
import { devpathApi, requestProblems, REVIEW_TARGET_DAYS, type DevPathView, type ProdKeyRequest, type RequestInput } from '@/mock/devpath';
import type { Receipt } from '@/types';

/**
 * Ask for a production key (gk_). Never issues one: the request is recorded and goes to review, which checks
 * four things within 2 working days. Used on Path to production and in the agent's Issue key dialog.
 */
export function RequestForm({ view, agentSlug, lockAgent, onDone }: { view: DevPathView; agentSlug?: string; lockAgent?: boolean; onDone?: (r: { request: ProdKeyRequest; receipt?: Receipt }) => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const canAct = role === 'owner' || role === 'admin';
  const agents = view.agents.filter((a) => !a.retired);
  const [slug, setSlug] = useState(agentSlug && agents.some((a) => a.slug === agentSlug) ? agentSlug : agents[0]?.slug ?? '');
  const agent = agents.find((a) => a.slug === slug);
  const runs = view.state.runs.filter((r) => r.agentSlug === slug);
  const draft = view.state.requests.find((r) => r.agentSlug === slug && r.status === 'draft');
  const open = view.state.requests.find((r) => r.agentSlug === slug && (r.status === 'in_review' || r.status === 'approved'));
  const people = view.people.length ? view.people : user ? [{ id: user.id, name: user.name, role: role ?? 'owner' }] : [];
  const [runId, setRunId] = useState('');
  const [target, setTarget] = useState('');
  const [residency, setResidency] = useState(view.residency);
  const [ownerId, setOwnerId] = useState('');
  const [enforcement, setEnforcement] = useState<RequestInput['enforcement']>('governed_run');
  const [reversal, setReversal] = useState<RequestInput['reversal']>('reversal_plan');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ request: ProdKeyRequest; receipt?: Receipt }>();

  // defaults follow the chosen agent (and a draft filed from the add-agent wizard)
  useEffect(() => {
    const a = agents.find((x) => x.slug === slug);
    const best = view.state.runs.find((r) => r.agentSlug === slug && r.allPassed) ?? view.state.runs.find((r) => r.agentSlug === slug);
    setRunId(draft?.conformanceRunId ?? best?.id ?? '');
    setTarget(draft?.targetSystem || a?.connectors.join(', ') || '');
    setOwnerId(draft?.productionOwnerId ?? a?.ownerId ?? people[0]?.id ?? '');
    setEnforcement(draft?.enforcement ?? (a?.route === 'mcp' ? 'governed_run' : 'check_and_record'));
    setReversal(draft?.reversal ?? 'reversal_plan');
    setNote(draft?.reversalNote ?? '');
    setTried(false); setError(undefined); setDone(undefined);
  }, [slug]);

  const input: RequestInput = { agentSlug: slug, conformanceRunId: runId || undefined, targetSystem: target, residency, productionOwnerId: ownerId, enforcement, reversal, reversalNote: note };
  const problems = useMemo(() => (slug ? requestProblems(orgId, input) : ['Choose an agent.']), [orgId, slug, runId, target, residency, ownerId, enforcement, reversal, note, view]);

  const submit = async () => {
    setTried(true);
    if (!user || problems.length) return;
    setBusy(true); setError(undefined);
    try {
      const r = await devpathApi.requestKey(orgId, input, user.id);
      setDone(r);
      toast.ok('Production key asked for', `In review; a decision is due by ${date(r.request.dueBy!)}. Recorded as a receipt.`);
      onDone?.(r);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (done) {
    return (
      <Banner tone="ok" title="Your request is in review">
        A person checks the result file, the declaration version, the target and residency, and the production owner, and decides by {dateTime(done.request.dueBy!)} ({REVIEW_TARGET_DAYS} working days). Recorded on <ReceiptLink seq={done.receipt?.seq} />. Follow it on <Link to="/agents/production?tab=keys" className="underline">Path to production</Link>.
      </Banner>
    );
  }
  if (!agents.length) return <Banner tone="info" title="No agent yet">Add an agent first; a production key belongs to one agent.</Banner>;

  return (
    <div className="space-y-4">
      {!canAct && <Banner tone="neutral" title="Owners and admins ask for production keys">Your role can read requests but cannot make one.</Banner>}
      {open && <Banner tone="held" title={`${open.agentSlug} already has a request ${open.status === 'approved' ? 'approved — collect the key on Path to production' : 'in review'}`}>Asked {dateTime(open.submittedAt ?? open.requestedAt)}. <Link to="/agents/production?tab=keys" className="underline">Open it</Link>.</Banner>}
      {draft && <Banner tone="info" title="A draft from the add-agent wizard">Finish it here; nothing is reviewed until you send it.</Banner>}
      {error && <Banner tone="bad" title="The request was not sent">{error}</Banner>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Agent" htmlFor="pk-agent">
          <Select id="pk-agent" value={slug} disabled={lockAgent} onChange={(e) => setSlug(e.target.value)}>
            {agents.map((a) => <option key={a.slug} value={a.slug}>{a.name} ({a.slug})</option>)}
          </Select>
        </Field>
        <Field label="Conformance result file" htmlFor="pk-run" hint={runs.length ? 'Every test must pass.' : undefined}>
          <Select id="pk-run" value={runId} onChange={(e) => setRunId(e.target.value)}>
            <option value="">{runs.length ? 'Choose a run' : 'No run for this agent yet'}</option>
            {runs.map((r) => <option key={r.id} value={r.id}>{dateTime(r.at)} · {r.allPassed ? 'all 14 pass' : `${r.failed} failing`}{r.highest ? ` · ${r.highest}` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Declaration version" htmlFor="pk-decl" hint="The published rulebook version the agent runs.">
          <Input id="pk-decl" value={agent?.publishedVersion ? `Version ${agent.publishedVersion}` : 'None published'} readOnly />
        </Field>
        <Field label="Target system" htmlFor="pk-target" hint="What the agent writes to in production.">
          <Input id="pk-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="For example: Zoho Books (Demo Traders), Gmail" />
        </Field>
        <Field label="Residency domain" htmlFor="pk-res" hint="Must be the organisation’s.">
          <Input id="pk-res" value={residency} onChange={(e) => setResidency(e.target.value)} />
        </Field>
        <Field label="Production owner" htmlFor="pk-owner" hint="A named person who answers for the agent while the key is live.">
          <Select id="pk-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role})</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Mode, in writing">
        <RadioCards name="pk-mode" cols={2} value={enforcement} onChange={setEnforcement} options={[
          { value: 'governed_run', label: 'Governed run (enforced)', description: 'MCP. Elan1 Govern holds the credentials; an agent that skips the check is stopped.' },
          { value: 'check_and_record', label: 'Check and record (advisory)', description: 'REST or SDK. Every attempt is evaluated and recorded; your code runs the call.' },
        ]} />
      </Field>
      <Field label="If a write is wrong">
        <RadioCards name="pk-rev" cols={2} value={reversal} onChange={setReversal} options={[
          { value: 'reversal_plan', label: 'We have a reversal plan', description: 'Say how a wrong write is undone, and within how long.' },
          { value: 'irreversible', label: 'Declared irreversible', description: 'The writes cannot be undone; every one is held for a person first.' },
        ]} />
      </Field>
      {reversal === 'reversal_plan' && (
        <Field label="Reversal plan" htmlFor="pk-note">
          <Textarea id="pk-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: payments are reversed by a credit note within 30 days; bills are voided, never deleted." />
        </Field>
      )}
      {tried && problems.length > 0 && (
        <Banner tone="held" title="Before it can be reviewed">
          <ul className="list-[square] pl-5 space-y-0.5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Banner>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={busy} disabled={!canAct || !!open} onClick={submit}>Send for review</Button>
        <span className="text-sm text-muted">A person decides within {REVIEW_TARGET_DAYS} working days. No gk_ key is issued until then.</span>
      </div>
    </div>
  );
}
