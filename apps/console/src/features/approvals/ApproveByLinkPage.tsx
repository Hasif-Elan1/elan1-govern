import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, Clock3, LogOut, Phone, ShieldCheck, X, CircleSlash, Users, OctagonX, Fingerprint } from 'lucide-react';
import { LinkSignIn } from '@/features/auth/LinkSignIn';
import { api, db } from '@/api';
import type { ApprovalLinkToken, LevelId, Receipt } from '@/types';
import { useNow } from '@/hooks/useQuery';
import { useSession } from '@/store/session';
import { can, ROLE_INFO } from '@/lib/permissions';
import { ORGS, userName } from '@/mock/users';
import { channelLabel, dateTime, rupees, seqLabel } from '@/lib/format';
import { ApprovalChip, Button, ProductMark, Spinner } from '@/components/ui';
import { Money, TagList } from '@/components/domain';
import { LEGAL_ENTITY } from '@/lib/company';
import { DecisionForm } from './DecisionForm';
import { heldReason, needsCallBack, preciseCountdown } from './lib';
import { decideByLink, firstApprovalOf, mayDecide, needsTwo, twoPersonPolicy, twoPersonReason } from '@/features/work/backend';
import { outageActive, sameActorBlocks, sealWord } from '@/mock/approvalsExt';
import { payloadDigest } from './decide';
import { BlastRadiusSection, ChecksSection, DiffSection } from './DecidePanels';
import { LinkApprovalsUnavailable } from './OutageNotice';

type Detail = Awaited<ReturnType<typeof api.approval>>;
type Resolved = ApprovalLinkToken & { approvalStatus: string };

/** The demo sign-in shortcut appears only on the demonstration host, never on a production link. */
const DEMO_MODE = typeof window !== 'undefined' && /localhost|127\.0\.0\.1|\.local|\.test|demo|preview/i.test(window.location.hostname);

/**
 * The signed single-use link page opened from email, a phone link, Slack or WhatsApp. Mobile-first (360–430px).
 * The token names the organisation, the approval, the person it was sent to and the channel. The link still
 * requires sign-in as that person. Once used, it cannot be used again, and the page says when and by whom.
 */
export default function ApproveByLinkPage() {
  const { token = '' } = useParams();
  const user = useSession((s) => s.user);
  const signOut = useSession((s) => s.signOut);
  const [link, setLink] = useState<Resolved>();
  const [data, setData] = useState<Detail>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [used, setUsed] = useState<{ approve: boolean; partial: boolean; receipt: Receipt }>();
  const now = useNow(1000);

  const load = useCallback(() => {
    api.resolveApprovalLink(token)
      .then(async (l) => {
        setLink(l);
        const d = await api.approval(l.orgId, l.approvalId);
        setData(d);
        setError(undefined);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    setLoading(true);
    load();
    const off = db.subscribe((o, kind) => { if (link && o === link.orgId && (kind === 'approval' || kind === 'receipt')) load(); });
    return () => { off(); };
  }, [load, link?.orgId]);

  useEffect(() => { document.title = 'Approve an action · Elan1 Govern'; }, []);

  // the timestamp authorities named in the footer come from the organisation's own anchoring record
  const [tsas, setTsas] = useState<string[]>();
  useEffect(() => {
    if (!link?.orgId) return;
    let live = true;
    api.anchors(link.orgId, 1).then((v) => { if (live && v.enabled) setTsas(v.authorities.map((x) => x.name)); }).catch(() => undefined);
    return () => { live = false; };
  }, [link?.orgId]);

  const a = data?.approval;
  const agent = data?.agent;
  const orgId = link?.orgId ?? '';
  const org = ORGS.find((o) => o.id === orgId);
  const level = (org?.plan ?? 'l1') as LevelId;
  const enforced = agent?.route === 'mcp';
  const expired = !!a && (a.status === 'expired' || (a.status === 'pending' && new Date(a.expiresAt).getTime() <= now));
  const notMember = !!user && !!a && !mayDecide(orgId, a, user.id).ok;
  const wrongPerson = !!user && !!link && user.id !== link.issuedTo;
  const wrongUser = !!user && (!user.orgIds.includes(orgId) || !can(user.role, 'approvals.decide') || notMember || wrongPerson);
  const selfApproval = !!agent && !!user && agent.ownerId === user.id;
  const two = !!a && needsTwo(orgId, a);
  const twoWhy = a ? twoPersonReason(orgId, a) : undefined;
  // why two people: the amount (the two-person limit) or the scope (whole organisation or across a boundary)
  const twoSentence = twoWhy === 'scope'
    ? 'This call reaches beyond one record or account, so it needs two different approvers.'
    : `This amount${orgId ? ` (${rupees(twoPersonPolicy(orgId).above)} or more)` : ''} needs two different approvers.`;
  const first = a ? firstApprovalOf(orgId, a.id) : undefined;
  // fail closed: while the approvals service is down nothing is decided through any screen, this link included
  const down = !!orgId && outageActive(orgId);
  // an emergency stop holds waiting approvals: nobody can decide them until it is lifted (expiry still runs)
  const held = a && orgId ? heldReason(orgId, a) : undefined;
  // the digest of exactly what this page shows (the link view), recorded on the decision receipt
  const digest = useMemo(() => (a && orgId ? payloadDigest(orgId, a, 'link') : ''), [a, orgId]);

  // a decision form can only be open while the approval is decidable
  useEffect(() => { if ((held || down) && mode) setMode(null); }, [held, down, mode]);

  let body: React.ReactNode;
  if (loading && !data) {
    body = <div className="flex justify-center py-24"><Spinner className="h-6 w-6" /></div>;
  } else if (error || !a || !link) {
    body = (
      <StateCard icon={<CircleSlash className="h-5 w-5" aria-hidden />} title="This link is not valid">
        {error ?? 'The approval could not be found.'} Ask the person who sent it to check the approvals inbox.
      </StateCard>
    );
  } else if (used) {
    body = (
      <div className="animate-rise-in">
        <div className="border border-line bg-surface p-5">
          <span className={`inline-flex h-10 w-10 items-center justify-center ${used.approve ? 'bg-ok-bg text-ok-fg' : 'bg-sunken text-fg'}`}>
            {used.approve ? <Check className="h-5 w-5" aria-hidden /> : <X className="h-5 w-5" aria-hidden />}
          </span>
          <h1 className="mt-4 text-2xl font-semibold tracking-tighter2">{used.partial ? 'First approval recorded' : used.approve ? 'Approved' : 'Rejected'}</h1>
          <p className="mt-2 text-md text-muted leading-relaxed">
            {used.partial
              ? `${twoSentence} The call keeps waiting until a second person in the group approves.`
              : used.approve
                ? enforced ? `Elan1 Govern ran the call through ${a.connector}.` : 'The agent may now run the call; it records the outcome.'
                : 'The call did not run. The agent was told your reason.'}
          </p>
          <div className="mt-5 border-t border-line pt-4">
            <p className="label">Receipt</p>
            <p className="mt-1 font-mono text-3xl font-semibold">{seqLabel(used.receipt.seq)}</p>
            <p className="mt-1 text-xs text-muted">{level === 'l1' ? 'Sealed in a hash chain' : 'Signed and hash-chained'} · {dateTime(used.receipt.ts)}</p>
          </div>
        </div>
        <p className="mt-4 border border-line bg-sunken/60 px-4 py-3 text-sm font-medium">This link has been used. It cannot be used again.</p>
        {user && can(user.role, 'activity.read') && user.orgIds.includes(orgId) && (
          <Link to={`/activity/${used.receipt.seq}`} className="mt-4 block text-center text-sm underline underline-offset-2">Open the receipt in the console</Link>
        )}
      </div>
    );
  } else if (link.usedAt) {
    body = (
      <StateCard icon={<ShieldCheck className="h-5 w-5" aria-hidden />} title="This link has been used">
        Used {dateTime(link.usedAt)} by {userName(link.usedBy)}{link.usedSeq !== undefined && <> — receipt {seqLabel(link.usedSeq)}</>}. Links work once.
        {a.status === 'pending' && <> The approval is still waiting{first ? ' for a second approver' : ''}; decide it in the console.</>}
        <div className="mt-3"><ApprovalChip status={a.status} /></div>
      </StateCard>
    );
  } else if (a.status !== 'pending') {
    body = (
      <StateCard icon={<ShieldCheck className="h-5 w-5" aria-hidden />} title={expired ? 'This approval expired' : 'This approval has already been decided'}>
        {expired
          ? <>No one decided before {dateTime(a.expiresAt)}. Expiry is a refusal; the call did not run.</>
          : <>{a.status === 'rejected' ? 'Rejected' : 'Approved'} by {userName(a.decidedBy)}{a.decidedAt && <> on {dateTime(a.decidedAt)}</>}{a.channel && <> via {channelLabel[a.channel]}</>}. This link cannot be used again.</>}
        <div className="mt-3"><ApprovalChip status={a.status} /></div>
      </StateCard>
    );
  } else if (down) {
    // checked before expiry: nothing expires while the approvals service is down
    body = <LinkApprovalsUnavailable orgId={orgId} headline={a.headline} member={!!user && user.orgIds.includes(orgId)} />;
  } else if (expired) {
    body = (
      <StateCard icon={<Clock3 className="h-5 w-5" aria-hidden />} title="This approval expired">
        No one decided before {dateTime(a.expiresAt)}. Expiry is a refusal; the call did not run.
      </StateCard>
    );
  } else {
    body = (
      <div>
        <p className="label text-accent-fg">Waiting for your decision · {org?.name ?? 'your organisation'}</p>
        <h1 className="mt-2 text-[22px] leading-[30px] font-semibold tracking-tighter2">{a.headline}</h1>
        {a.amount !== undefined && <p className="mt-4 font-display text-5xl font-semibold tracking-tighter2"><Money value={a.amount} /></p>}
        {a.counterparty && <p className="mt-1 text-sm text-muted">To {a.counterparty}</p>}

        <div className="mt-5 flex items-center justify-between gap-3 border border-line bg-surface px-4 py-3">
          <span className="inline-flex items-center gap-2 text-sm text-muted"><Clock3 className="h-4 w-4" aria-hidden />Expires in</span>
          <span className="font-display text-xl font-semibold num" aria-live="off">{preciseCountdown(a.expiresAt, now)}</span>
        </div>

        {two && (
          <p className="mt-3 flex items-start gap-2 border border-line bg-sunken/60 px-3 py-2.5 text-sm">
            <Users className="h-4 w-4 mt-0.5 shrink-0 text-muted" aria-hidden />
            <span>{first ? <>Approved first by {userName(first.userId)}. {twoSentence} Yours would be the second approval.</> : `${twoSentence} Yours would be the first.`}</span>
          </p>
        )}

        <dl className="mt-5 space-y-4">
          <div>
            <dt className="label">Why it was held</dt>
            <dd className="mt-1 text-md leading-relaxed">{a.ruleReason}</dd>
            {a.triggeredBy && <dd className="mt-1 text-sm text-muted">Rule <span className="font-mono">{a.ruleId}</span> · {a.triggeredBy}</dd>}
          </div>
          <div>
            <dt className="label">If you approve</dt>
            <dd className="mt-1 text-md leading-relaxed">{a.effect}</dd>
            <dd className="mt-1 text-sm text-muted">{enforced ? 'Governed run: it runs immediately on approval.' : 'Check and record: the agent runs the call itself.'}</dd>
          </div>
          {a.riskTags.length > 0 && <div><dt className="label">Risk</dt><dd className="mt-1.5"><TagList tags={a.riskTags} max={6} /></dd></div>}
        </dl>

        {/* the same content as the console decide screen: what changes, every check with its version, the blast radius */}
        <div className="mt-4 border-t border-line">
          <DiffSection a={a} />
          <ChecksSection a={a} orgIdOverride={orgId} />
          <BlastRadiusSection a={a} orgIdOverride={orgId} />
        </div>

        {digest && (
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <Fingerprint className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>What this page shows has digest</span>
            <span className="font-mono text-fg break-all" title={digest}>sha256:{digest.slice(0, 16)}…</span>
            <span>· recorded on your decision receipt, {sealWord(level)}.</span>
          </p>
        )}

        {needsCallBack(a) && (
          <p className="mt-5 flex items-start gap-2 border border-held/50 border-l-[3px] border-l-held bg-held-bg px-3 py-2.5 text-sm text-held-fg">
            <Phone className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <span><span className="font-semibold">Confirm by phone with a contact you already hold.</span> Not a number from this request.</span>
          </p>
        )}

        {held && (
          <div className="mt-5 flex items-start gap-2 border border-bad/40 border-l-[3px] border-l-bad bg-bad-bg px-3 py-2.5 text-sm" role="status">
            <OctagonX className="h-4 w-4 mt-0.5 shrink-0 text-bad-fg" aria-hidden />
            <span className="text-fg/80">{held}</span>
          </div>
        )}

        <div className="mt-6">
          {!user ? (
            <LinkSignIn orgId={orgId} issuedTo={link.issuedTo} approvalId={a.id} token={token} demo={DEMO_MODE} />
          ) : wrongUser ? (
            <div className="border border-line bg-surface p-4 text-sm">
              <p className="font-semibold">This link was sent to {userName(link.issuedTo)}</p>
              <p className="mt-1 text-muted">
                You are signed in as {user.name} ({ROLE_INFO[user.role].label.toLowerCase()}).{' '}
                {!user.orgIds.includes(orgId) ? `You are not a member of ${org?.name ?? 'this organisation'}.`
                  : !can(user.role, 'approvals.decide') ? `Approvers, admins and owners decide; ${user.role === 'auditor' ? 'auditors review the record' : 'viewers can only read'}.`
                    : notMember ? `Only members of ${a.approverGroup} decide this.`
                      : 'A single-use link works only for the person it was sent to. You can decide in the console instead.'}
              </p>
              <Button className="mt-3" variant="secondary" size="lg" block icon={<LogOut className="h-4 w-4" aria-hidden />} onClick={() => signOut()}>Sign in as someone else</Button>
              {user.orgIds.includes(orgId) && can(user.role, 'approvals.decide') && !notMember && (
                <Link to={`/approvals/${a.id}`} className="mt-3 block text-center text-sm underline underline-offset-2">Decide in the console instead</Link>
              )}
            </div>
          ) : held ? (
            <div className="space-y-3">
              <Button variant="primary" block className="h-12 text-md" icon={<Check className="h-4 w-4" aria-hidden />} disabled title="Held by the emergency stop. Lift the stop to decide it.">
                {two && !first ? 'Give the first approval' : 'Approve'}
              </Button>
              <div className="h-px bg-line" aria-hidden />
              <Button variant="secondary" block className="h-12 text-md" icon={<X className="h-4 w-4" aria-hidden />} disabled title="Held by the emergency stop. Lift the stop to decide it.">Reject</Button>
              <p className="pt-1 text-center text-xs text-muted">This link stays unused while the stop holds the approval. It works once the stop is lifted, until the approval expires.</p>
            </div>
          ) : mode ? (
            <div className="border border-line bg-surface p-4">
              <DecisionForm
                compact
                approval={a}
                route={agent?.route}
                mode={mode}
                channel={link.channel}
                orgIdOverride={orgId}
                selfApproval={selfApproval}
                payloadDigest={digest}
                submit={(approve, reason, extra) => decideByLink(token, approve, reason, user.id, { ...extra, payloadView: 'link' })}
                onCancel={() => setMode(null)}
                onDone={(r) => { setMode(null); setUsed({ approve: r.approve, partial: r.partial, receipt: r.receipt }); }}
              />
            </div>
          ) : (
            <div className="space-y-3">
              {selfApproval && (sameActorBlocks(orgId, a, user.id)
                ? <p className="border border-bad/40 bg-bad-bg px-3 py-2 text-sm">You set up this agent, so you cannot also approve its action. You can reject it, or another member of {a.approverGroup} approves it.</p>
                : <p className="border border-held/50 bg-held-bg px-3 py-2 text-sm text-held-fg">You own this agent — your approval will be flagged.</p>)}
              <Button variant="primary" block className="h-12 text-md" icon={<Check className="h-4 w-4" aria-hidden />} onClick={() => setMode('approve')} disabled={(!!first && first.userId === user.id) || sameActorBlocks(orgId, a, user.id)} title={sameActorBlocks(orgId, a, user.id) ? 'You own the agent that proposed this, so you cannot also approve it.' : first && first.userId === user.id ? 'You gave the first approval; a different person gives the second.' : undefined}>
                {two && !first ? 'Give the first approval' : 'Approve'}
              </Button>
              <div className="h-px bg-line" aria-hidden />
              <Button variant="secondary" block className="h-12 text-md" icon={<X className="h-4 w-4" aria-hidden />} onClick={() => setMode('reject')}>Reject</Button>
              <p className="pt-1 text-center text-xs text-muted">Signed in as {user.name} · this link was sent by {channelLabel[link.channel]} · it works once</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas text-fg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-[440px] items-center justify-between px-4">
          <ProductMark />
          <span className="text-xs text-muted">Single-use link{link ? ` · ${channelLabel[link.channel]}` : ''}</span>
        </div>
      </header>
      <main className="mx-auto max-w-[440px] px-4 py-6">{body}</main>
      <footer className="mx-auto max-w-[440px] px-4 pb-8 space-y-2 text-xs text-muted leading-relaxed">
        <p>{channelSentence(level)}</p>
        <p>Every decision is a hash-chained receipt. {evidenceSentence(level, tsas)}</p>
        <p>Elan1 Govern · {LEGAL_ENTITY}</p>
      </footer>
    </div>
  );
}

/** How approvals reach people at this level (F2): chat buttons only on rules approvable in chat; never chat at Sovereign. */
function channelSentence(level: LevelId) {
  if (level === 'sovereign') return 'Approvals reach this organisation’s approvers by email through its own mail relay. Slack and WhatsApp are not available under deny-all egress; every decision is made on this page or in the console, after signing in.';
  return 'Email always carries a link to this page, and deciding here asks you to sign in. In Slack and WhatsApp, a rule marked approvable in chat puts Approve and Reject buttons on the message for the person it was sent to, with no password; any other held call opens this page.';
}

/** The footer's evidence sentence for the organisation's level (the TSAs are named for L2 and above). */
function evidenceSentence(level: LevelId, tsas?: string[]) {
  if (level === 'l1') return 'Sealed in a hash chain by Elan1 Govern; not yet externally timestamped.'; // never "signed" at L1 until DR-017 is decided
  if (level === 'sovereign') return `Signed in the organisation’s own HSM and timestamped by its own two authorities${tsas?.length ? ` (${tsas.join(' and ')})` : ''}.`;
  return `Signed and timestamped by ${tsas?.length ? tsas.join(' and ') : 'eMudhra TSA (India) and a global timestamp authority'}.`;
}

function StateCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="border border-line bg-surface p-5">
      <span className="inline-flex h-10 w-10 items-center justify-center bg-sunken text-muted">{icon}</span>
      <h1 className="mt-4 text-xl font-semibold">{title}</h1>
      <div className="mt-2 text-sm text-muted leading-relaxed">{children}</div>
    </div>
  );
}

