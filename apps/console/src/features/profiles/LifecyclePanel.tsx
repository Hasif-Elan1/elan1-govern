import { useState } from 'react';
import { BadgeCheck, BookOpenCheck, CheckCircle2, CircleDashed, CircleSlash, FlaskConical, PenLine, ShoppingCart, Undo2, XCircle } from 'lucide-react';
import type { VerifierProfile } from '@/types';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { date, rupees } from '@/lib/format';
import { PROFILE_STATUS_LABEL } from '@/lib/profiles';
import { userName } from '@/mock/users';
import { ADDON_STOP_RULE, CONFORMANCE_TESTS, type ConformanceResult } from '@/mock/packsFactory';
import { Banner, Button, KeyValue, Panel, Skeleton, StatusChip, Tooltip, toast } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { FormDialog } from '@/features/packs/FormDialog';

function PChip({ state }: { state: ConformanceResult['state'] }) {
  if (state === 'pass') return <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>Pass</StatusChip>;
  if (state === 'fail') return <StatusChip size="sm" tone="bad" icon={<XCircle className="h-3 w-3" aria-hidden />}>Fail</StatusChip>;
  if (state === 'not_run') return <StatusChip size="sm" tone="held" icon={<CircleDashed className="h-3 w-3" aria-hidden />}>Not run</StatusChip>;
  return <StatusChip size="sm" tone="neutral" icon={<CircleSlash className="h-3 w-3" aria-hidden />}>Not applicable</StatusChip>;
}

/**
 * The entitlement reason as this role should read it. Only an owner orders or cancels a profile, so other roles are
 * not told to: they read what the state is and that an owner decides it.
 */
export function entitlementWhy(e: { why?: string; withdrawn: boolean; ordered: boolean; issued?: boolean; trial: boolean; preview?: boolean } | undefined, isOwner: boolean): string | undefined {
  if (!e?.why || isOwner) return e?.why;
  if (e.withdrawn) {
    const cut = e.why.indexOf(' Its order is still open');
    return cut < 0 ? e.why : `${e.why.slice(0, cut)} Its order stays open until an owner cancels it.`;
  }
  if (e.issued && !e.ordered && !e.trial && !e.preview) return 'Not ordered. It is run against the chain or claimed in a bundle once an owner orders it.';
  return e.why;
}

/**
 * A profile's lifecycle in this organisation: the order that entitles it (or the L1 trial), its author and issuer
 * (never the same person), the twelve conformance tests P1–P12, and its status — draft, issued, superseded, withdrawn.
 * Issuing and withdrawing are governed writes; every step is a receipt.
 */
export function LifecyclePanel({ profile }: { profile: VerifierProfile }) {
  const orgId = useOrgId();
  const user = useUser();
  const role = useRole();
  const level = useOrgLevel();
  const l2 = atLeast(level, 'l2');
  const q = useQuery((o) => api.profileLifecycle(o, profile.id), [profile.id, level]);
  const [busy, setBusy] = useState<string>();
  const [dialog, setDialog] = useState<'reader' | 'withdraw'>();
  const lc = q.data;
  const manager = role === 'owner' || role === 'admin';
  // issuing, the P11 reading and fixture runs are written to the client's chain: owners and admins only, never the author.
  // Auditors are read-only here; they still run a profile on an export from the verifier, which writes nothing.
  const reviewer = manager;

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast.ok(ok, 'Recorded on the chain.'); } catch (e) { toast.bad('Not recorded', (e as Error).message); } finally { setBusy(undefined); }
  };

  if (!lc) return <Skeleton className="h-64" />;
  const e = lc.entitlement;
  const why = entitlementWhy(e, role === 'owner');
  const open = lc.conformance.filter((c) => c.state !== 'pass');
  const isAuthor = !!user && lc.authorId === user.id;

  return (
    <Panel kicker="Order, authorship and conformance" title={`${PROFILE_STATUS_LABEL[lc.status]} · P1–P12 ${lc.conformance.length - open.length} of 12 pass`} flush>
      {/* entitlement */}
      <div className="px-5 py-4 border-b border-line">
        {e.withdrawn ? (
          <Banner tone="bad" title={`Withdrawn ${lc.withdrawnAt ? date(lc.withdrawnAt) : ''}`}
            actions={e.ordered && role === 'owner' ? <Button size="sm" variant="secondary" loading={busy === 'cancel'} onClick={() => act('cancel', () => api.cancelProfileOrder(orgId, profile.id, user!.id), `Order cancelled — ${ADDON_STOP_RULE}`)}>Cancel the open order</Button> : undefined}>
            {lc.withdrawnReason ? `“${lc.withdrawnReason}” — ${userName(lc.withdrawnBy)}. ` : ''}{why}
          </Banner>
        )
          : e.trial ? <Banner tone="info" title="Trial at L1">{e.why}</Banner>
          : e.preview ? <Banner tone="held" title="Not issued — preview only">{e.why}</Banner>
          : e.ordered ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span><StatusChip size="sm" tone="ok" icon={<ShoppingCart className="h-3 w-3" aria-hidden />}>Ordered</StatusChip> <span className="text-muted ml-1"><When iso={e.order!.at} /> by {userName(e.order!.by)} · <ReceiptLink seq={e.order!.seq} /> · {rupees(300000)} a year on its own line</span></span>
              {role === 'owner' && <Tooltip content={`Cancelled orders are ${ADDON_STOP_RULE}`}><Button size="sm" variant="ghost" loading={busy === 'cancel'} onClick={() => act('cancel', () => api.cancelProfileOrder(orgId, profile.id, user!.id), `Order cancelled — ${ADDON_STOP_RULE}`)}>Cancel the order</Button></Tooltip>}
            </div>
          ) : (
            <Banner tone="held" title="Not ordered" actions={role === 'owner' ? <Button size="sm" variant="primary" icon={<ShoppingCart className="h-3.5 w-3.5" />} loading={busy === 'order'} onClick={() => act('order', () => api.orderProfile(orgId, profile.id, user!.id), `${profile.name} ordered`)}>Order for {rupees(300000)} a year</Button> : undefined}>
              {why}
            </Banner>
          )}
      </div>

      {/* authorship */}
      <div className="px-5 py-4 border-b border-line">
        <KeyValue cols={2} items={[
          { k: 'Author', v: lc.authorId ? <>{userName(lc.authorId)}{lc.submittedAt && <span className="text-muted"> · {date(lc.submittedAt)}</span>}</> : profile.author ?? <span className="text-muted">{l2 ? 'Not yet signed' : 'Not yet recorded'}</span> },
          { k: 'Issuer (never the author)', v: lc.certifierId ? <>{userName(lc.certifierId)}{lc.certifiedAt && <span className="text-muted"> · {date(lc.certifiedAt)}</span>}</> : profile.certifier ?? <span className="text-muted">Not issued</span> },
          { k: 'Second reader (P11)', v: lc.secondReader ? <>{userName(lc.secondReader.by)} · {date(lc.secondReader.at)}</> : profile.status === 'certified' ? 'Recorded with the issued version' : <span className="text-muted">Not yet</span> },
          { k: 'Fixture run (P3–P6)', v: lc.fixtures ? <>{date(lc.fixtures.at)} · {lc.fixtures.range}{lc.fixtures.seq !== undefined && <> · <ReceiptLink seq={lc.fixtures.seq} /></>}</> : profile.status === 'certified' ? 'With the issued version' : <span className="text-muted">Not run</span> },
        ]} />
        {/* authoring, the P11 reading, fixtures, issuing and withdrawing are owners' and admins': other roles see no buttons.
            The same-person rule (never the author) stays as a disabled button with its reason. */}
        {manager && (
        <div className="mt-4 flex flex-wrap gap-2">
          {lc.status === 'draft' && !lc.authorId && (
            <Tooltip content={`${l2 ? 'Sign the draft as its author' : 'Record yourself as the draft’s author (sealed in a hash chain)'}. A different person issues it.`}>
              <Button size="sm" variant="secondary" icon={<PenLine className="h-3.5 w-3.5" />} loading={busy === 'submit'} onClick={() => act('submit', () => api.submitProfile(orgId, profile.id, user!.id), l2 ? 'Signed as the author' : 'Recorded as the author')}>{l2 ? 'Sign as author' : 'Record as author'}</Button>
            </Tooltip>
          )}
          {lc.status === 'draft' && reviewer && (
            <>
              <Tooltip content={isAuthor ? 'The second reader is never the author.' : 'Read the known-good report and say, unprompted, what it does not prove'}>
                <Button size="sm" variant="secondary" icon={<BookOpenCheck className="h-3.5 w-3.5" />} disabled={isAuthor || !!lc.secondReader} onClick={() => setDialog('reader')}>{lc.secondReader ? 'Second reader recorded' : 'Record the second reader'}</Button>
              </Tooltip>
              {l2 && (
                <Tooltip content="Verify a known-good, a tampered, a non-conforming and an incomplete bundle from this chain, offline. Recorded.">
                  <Button size="sm" variant="secondary" icon={<FlaskConical className="h-3.5 w-3.5" />} loading={busy === 'fixtures'} onClick={() => act('fixtures', () => api.runProfileFixtures(orgId, profile.id, user!.id), 'Fixture tests run')}>Run the fixture tests</Button>
                </Tooltip>
              )}
              <Tooltip content={!lc.authorId ? (l2 ? 'The author signs first.' : 'The author is recorded first.') : isAuthor ? 'Dual control: the issuer is never the author.' : open.length ? `Still open: ${open.map((c) => c.id).join(', ')}` : 'Issue this version: a governed write under dual control'}>
                <Button size="sm" variant="primary" icon={<BadgeCheck className="h-3.5 w-3.5" />} disabled={!lc.authorId || isAuthor || open.length > 0} loading={busy === 'issue'} onClick={() => act('issue', () => api.issueProfile(orgId, profile.id, user!.id), `${profile.name} issued`)}>Issue</Button>
              </Tooltip>
            </>
          )}
          {lc.status !== 'withdrawn' && (
            <Tooltip content="A profile found wrong, or whose regime was withdrawn, is withdrawn: it can no longer be run, ordered or claimed.">
              <Button size="sm" variant="quiet-danger" icon={<Undo2 className="h-3.5 w-3.5" />} onClick={() => setDialog('withdraw')}>Withdraw</Button>
            </Tooltip>
          )}
        </div>
        )}
        {lc.status === 'draft' && lc.authorId && !isAuthor && lc.eligibleIssuers.length > 0 && <p className="mt-2 text-xs text-muted">Eligible issuers: {lc.eligibleIssuers.map((u) => userName(u)).join(', ')}. No agents.</p>}
      </div>

      {/* P1–P12 */}
      <ul className="divide-y divide-line">
        {lc.conformance.map((c) => (
          <li key={c.id} className="px-5 py-2.5 grid gap-x-4 gap-y-1 sm:grid-cols-[48px_1fr_auto] items-start">
            <span className="font-mono text-[12.5px] font-semibold">{c.id}</span>
            <span className="min-w-0 text-sm"><span className="font-medium">{c.title}</span><span className="block text-xs text-muted">Passes when: {CONFORMANCE_TESTS.find((t) => t.id === c.id)?.passesWhen}</span><span className="block mt-0.5">{c.detail}</span></span>
            <PChip state={c.state} />
          </li>
        ))}
      </ul>

      <FormDialog open={dialog === 'reader'} onClose={() => setDialog(undefined)} title="P11 · the second reader"
        description="Someone who did not author the profile reads the known-good report and states, unprompted, what it does not prove."
        fields={[{ id: 'statement', kind: 'textarea', label: 'What the report does not prove, in the reader’s words', min: 40, rows: 5 }]}
        submitLabel="Record the reading"
        onSubmit={async (v) => { await api.recordProfileSecondReader(orgId, profile.id, user!.id, String(v.statement)); toast.ok('Second reader recorded', 'P11 passes.'); }} />
      <FormDialog open={dialog === 'withdraw'} onClose={() => setDialog(undefined)} tone="danger" title={`Withdraw ${profile.name} v${profile.version}?`}
        description={`It can no longer be run, ordered or claimed in a bundle; the verifier reports a bundle that already claims it with the withdrawal date. Every earlier run stays on the chain.${e.ordered ? ` Its open order is cancelled with it: ${ADDON_STOP_RULE}.` : ''}`}
        fields={[{ id: 'reason', kind: 'textarea', label: 'Why it is withdrawn', min: 12, rows: 3 }]}
        submitLabel="Withdraw the profile"
        onSubmit={async (v) => { const r = await api.withdrawProfile(orgId, profile.id, user!.id, String(v.reason)); toast.held(`${profile.name} withdrawn`, `${r.withdrawnAt ? `From ${date(r.withdrawnAt)}.` : 'Recorded.'}${r.orderCancelled ? ` Its order was cancelled: ${ADDON_STOP_RULE}.` : ''}`); }} />
      {lc.status === 'certified' && lc.certifiedAt && lc.certifierId && <p className="px-5 py-3 border-t border-line text-xs text-muted">Issued in this organisation {date(lc.certifiedAt)} by {userName(lc.certifierId)}; authored by {userName(lc.authorId)}.</p>}
    </Panel>
  );
}
