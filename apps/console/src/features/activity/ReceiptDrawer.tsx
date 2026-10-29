import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, BookOpen, MessageSquareText } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useUi } from '@/store/ui';
import { dateTime, seqLabel } from '@/lib/format';
import { LEVEL_INFO } from '@/lib/levels';
import { ApprovalChip, Banner, Button, DecisionChip, Drawer, Hash, KeyValue, Skeleton } from '@/components/ui';
import { AgentLink, ArgsTable, Person, ReceiptLink, Section, When } from '@/components/domain';
import { KindMark, ModeChip, OutcomeCell, storyOf } from './shared';
import { SmartLink } from '@/shell/access';

/** Right-hand summary of one receipt, opened from a row of the activity log. */
export function ReceiptDrawer({ seq, onClose }: { seq: number; onClose: () => void }) {
  const nav = useNavigate();
  const openAsk = useUi((s) => s.openAsk);
  const { data, loading, error } = useQuery((o) => api.receipt(o, seq), [seq]);
  const seal = useQuery((o) => api.seal(o, seq), [seq], { kinds: ['level'] });
  const r = data?.receipt;
  const root = r?.ref_seq ? data?.related.find((x) => x.seq === r.ref_seq) : undefined;
  const followUps = data?.related.filter((x) => x.ref_seq === (r?.ref_seq ?? r?.seq)) ?? [];

  return (
    <Drawer
      open
      onClose={onClose}
      kicker={r ? `${r.kind} receipt` : 'Receipt'}
      title={`Receipt ${seqLabel(seq)}`}
      width={600}
      footer={
        <>
          {r && <Button variant="ghost" icon={<MessageSquareText className="h-4 w-4" />} onClick={() => openAsk({ kind: 'receipt', title: `Receipt ${seqLabel(r.seq)}`, payload: r })}>Explain</Button>}
          <Button variant="primary" iconRight={<ArrowUpRight className="h-4 w-4" />} onClick={() => nav(`/activity/${seq}`)}>Open full receipt</Button>
        </>
      }
    >
      {error && <Banner tone="bad" title="This receipt could not be loaded">{error.message}</Banner>}
      {loading && !data && <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-40" /><Skeleton className="h-24" /></div>}
      {r && (
        <div>
          <div className="flex flex-wrap items-center gap-2 pb-4">
            <DecisionChip decision={r.decision} />
            <KindMark kind={r.kind} />
            <span className="text-sm text-muted">{dateTime(r.ts)}</span>
          </div>
          <p className="text-md leading-relaxed">{storyOf(r, { root, followUps })}</p>

          <Section title="Record" className="mt-2">
            <KeyValue items={[
              { k: 'Sequence', v: <span className="font-mono">{seqLabel(r.seq)}</span> },
              { k: 'Time', v: <When iso={r.ts} /> },
              ...(r.agent ? [{ k: 'Agent', v: <AgentLink slug={r.agent} /> }] : []),
              ...(r.actor ? [{ k: r.kind === 'admin' ? 'Changed by' : 'Decided by', v: <Person id={r.actor} /> }] : []),
              ...(r.tool ? [{ k: 'Tool', v: r.tool, mono: true }] : []),
              ...(r.action ? [{ k: 'Action', v: r.action, mono: true }] : []),
              ...(r.rule_id ? [{ k: 'Rule', v: r.rule_id, mono: true }] : []),
              ...(r.rulebook ? [{ k: 'Rulebook', v: <Link className="hover:underline underline-offset-2 inline-flex items-center gap-1" to={`/rulebooks/${r.agent}?version=${r.rulebook.version}`}><BookOpen className="h-3.5 w-3.5" aria-hidden />Version {r.rulebook.version}</Link> }] : []),
              ...(r.details?.mode ? [{ k: 'Mode', v: <ModeChip r={r} /> }] : []),
              ...(r.kind !== 'admin' ? [{ k: 'Outcome', v: <OutcomeCell r={r} /> }] : []),
              ...(r.approval ? [{ k: 'Approval', v: <SmartLink to={`/approvals/${r.approval.id}`} plainClassName="inline-flex items-center gap-2" className="inline-flex items-center gap-2 hover:underline underline-offset-2"><ApprovalChip status={r.approval.status} size="sm" /><span className="font-mono text-xs">{r.approval.id}</span></SmartLink> }] : []),
              ...(r.ref_seq ? [{ k: 'Answers', v: <ReceiptLink seq={r.ref_seq} /> }] : []),
              { k: 'Hash', v: <Hash value={r.hash} len={16} /> },
              { k: 'Previous hash', v: <Hash value={r.prev_hash} len={16} /> },
              { k: 'Key', v: r.kid, mono: true },
              { k: 'Assurance', v: seal.data ? (seal.data.sealed ? <Link to={`/activity/${r.seq}?tab=seal`} className="hover:underline underline-offset-2">{LEVEL_INFO[seal.data.level].short} — sealed (Seal v6, 16 fields)</Link> : <span className="text-muted">{LEVEL_INFO[seal.data.level].short} — sealed in a hash chain, no Seal v6 record</span>) : seal.error ? '—' : <Skeleton className="h-4 w-32" /> },
            ]} />
          </Section>

          {r.reason && (
            <Section title="Reason">
              <p className="text-sm">{r.reason}</p>
            </Section>
          )}
          {(r.args_summary || r.details) && (
            <Section title={r.args_summary ? 'Arguments the rules inspected' : 'Details'}>
              <ArgsTable args={(r.args_summary ?? r.details)!} />
              {r.args_summary && <p className="mt-2 text-xs text-muted">Full arguments are never stored. Only the values a rule inspected are kept; email addresses become domains.</p>}
            </Section>
          )}
          {(root || followUps.some((x) => x.seq !== r.seq)) && (
            <Section title="Related receipts">
              <ul className="space-y-1.5">
                {[...(root ? [root] : []), ...followUps].filter((x) => x.seq !== r.seq).map((x) => (
                  <li key={x.seq} className="flex items-center gap-3 text-sm">
                    <ReceiptLink seq={x.seq} />
                    <KindMark kind={x.kind} />
                    <DecisionChip decision={x.decision} size="sm" />
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </Drawer>
  );
}
