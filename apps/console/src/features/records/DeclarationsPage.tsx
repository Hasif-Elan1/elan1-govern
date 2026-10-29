import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Ban, CheckCircle2, FilePlus2 } from 'lucide-react';
import type { PackId } from '@/types';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgId, useOrgLevel, useRole, useUser } from '@/store/session';
import { ACTOR_KIND_LABEL, declApi, type ActorKind, type AgentDeclRow, type PackDeclRow } from '@/mock/recordsDecl';
import { PACK_PARAMS } from '@/features/packs/config';
import { date, n, plural, rupees } from '@/lib/format';
import { Badge, Banner, Button, Dialog, EmptyState, Field, Hash, PageHeader, Panel, Select, Skeleton, Stat, StatusChip, Tabs, Textarea, Tooltip, toast } from '@/components/ui';
import { Person, ReceiptLink } from '@/components/domain';
import { WithdrawVersionDialog, WithdrawnChip } from './declarations';
import { evidenceClaim } from './level';

type Tab = 'rulebooks' | 'agents' | 'packs';
type Target =
  | { kind: 'rulebook'; id: string; version: number }
  | { kind: 'agent'; row: AgentDeclRow; version: number }
  | { kind: 'pack'; row: PackDeclRow; version: number };

/**
 * Records › Declarations — the three versioned declarations an organisation acts under, and withdrawing a version of
 * any of them: an agent's rulebook versions, an agent's declaration (decl.<agent>: who it acts for and the write types
 * it declares) and each installed regulatory pack's declaration (decl.<pack>: the parameters of its checks).
 */
export default function DeclarationsPage() {
  const level = useOrgLevel();
  const role = useRole();
  const manager = role === 'owner' || role === 'admin';
  const q = useQuery(async (o) => {
    const [view, rbs, ext] = await Promise.all([api.records.declarations(o), api.rulebooks(o), declApi.view(o)]);
    return { ...view, rbs, ext };
  }, [level], { kinds: ['receipt', 'rulebook', 'agent', 'pack', 'open'] });
  const [tab, setTab] = useState<Tab>('rulebooks');
  const [target, setTarget] = useState<Target>();
  const [declare, setDeclare] = useState<AgentDeclRow>();
  const rows = q.data?.rows ?? [];
  const agents = (q.data?.ext.agents ?? []).filter((a) => a.versions.length);
  const packs = q.data?.ext.packs ?? [];
  const withdrawnAt = [
    ...rows.flatMap((r) => r.versions.filter((v) => v.withdrawn).map((v) => v.withdrawn!.at)),
    ...agents.flatMap((a) => a.versions.filter((v) => v.withdrawn).map((v) => v.withdrawn!.at)),
    ...packs.flatMap((p) => p.versions.filter((v) => v.withdrawn).map((v) => v.withdrawn!.at)),
  ].sort();
  const refusing = rows.filter((r) => !r.inForce).length;
  const rb = target?.kind === 'rulebook' ? q.data?.rbs.find((x) => x.id === target.id) : undefined;

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Records"
        title="Declarations"
        description="An agent acts under three versioned declarations: its rulebook, its own declaration (who it acts for and the write types it declares) and the declaration of each regulatory pack installed. The version in force is the one every new call uses and its receipt names. A withdrawn version stays in the history and its receipts keep verifying, but no call made after the withdrawal uses it."
      />

      {q.error && <Banner tone="bad" title="Declarations did not load" className="mb-6" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>}

      <div className="grid gap-4 grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-4 mb-6">
        {!q.data ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px]" />) : (
          <>
            <Stat label="Rulebooks" value={n(rows.length)} sub={plural(rows.reduce((t, r) => t + r.versions.filter((v) => v.status === 'published').length, 0), 'published version')} />
            <Stat label="Agent and pack declarations" value={n(agents.length + packs.length)} sub={`${plural(agents.length, 'agent')}, ${plural(packs.length, 'installed pack')}`} />
            <Stat label="Withdrawn versions" value={n(withdrawnAt.length)} sub={withdrawnAt.length ? `Latest ${date(withdrawnAt[withdrawnAt.length - 1])}` : 'None'} />
            <Stat label="Rulebooks with no version in force" value={n(refusing)} sub={refusing ? 'Every call to these agents is refused' : 'Every agent has a version in force'} />
          </>
        )}
      </div>

      <Tabs<Tab> className="mb-6" label="Declaration kinds" value={tab} onChange={setTab} items={[
        { value: 'rulebooks', label: 'Rulebook versions', count: q.data ? rows.length : undefined },
        { value: 'agents', label: 'Agent declarations', count: q.data ? agents.length : undefined },
        { value: 'packs', label: 'Pack declarations', count: q.data ? packs.length : undefined },
      ]} />

      {q.loading && !q.data ? <Skeleton className="h-64" /> : tab === 'rulebooks' ? (
        <div className="space-y-4">
          {rows.length === 0 ? (
            <Panel><EmptyState title="No rulebooks yet" disc="registration">Add an agent: its starter rulebook becomes its first version.</EmptyState></Panel>
          ) : rows.map((r) => (
            <Panel key={r.rulebookId} title={<span className="inline-flex flex-wrap items-center gap-2"><Link to={`/rulebooks/${r.slug}`} className="font-mono hover:underline underline-offset-2">{r.slug}</Link>{r.agentName && <span className="text-sm font-normal text-muted">{r.agentName}</span>}</span>}
              kicker="Rulebook"
              actions={r.inForce ? <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" />}>v{r.inForce} in force</StatusChip> : <StatusChip size="sm" tone="bad">No version in force</StatusChip>} flush>
              <VersionTable caption={`Versions of the ${r.slug} rulebook`} heads={['Version', 'State', level === 'l1' ? 'Published by' : 'Signed by', 'Hash', 'Note', '']}>
                {r.versions.map((v) => (
                  <tr key={v.version} className="border-b border-line last:border-b-0 align-top">
                    <td className="px-4 py-2.5 font-mono font-semibold whitespace-nowrap">v{v.version}<span className="block text-xs font-normal text-muted">{plural(v.rules, 'rule')}</span></td>
                    <td className="px-4 py-2.5 whitespace-nowrap"><StateCell withdrawn={v.withdrawn} inForce={v.inForce} other={v.status === 'published' ? undefined : <Badge>{v.status === 'in_review' ? 'In review' : 'Draft'}</Badge>} /></td>
                    <td className="px-4 py-2.5">{v.signedBy ? <span className="flex flex-col gap-0.5"><Person id={v.signedBy} size={20} />{v.signedAt && <span className="text-xs text-muted">{date(v.signedAt)}</span>}</span> : <span className="text-xs text-subtle">—</span>}</td>
                    <td className="px-4 py-2.5"><Hash value={v.hash} len={10} /></td>
                    <td className="px-4 py-2.5 max-w-[320px]"><span className="line-clamp-2">{v.withdrawn ? `Withdrawn: ${v.withdrawn.reason}` : v.note}</span></td>
                    <td className="px-4 py-2.5 text-right">
                      {v.status === 'published' && !v.withdrawn && <WithdrawButton manager={manager} inForce={v.inForce} onClick={() => setTarget({ kind: 'rulebook', id: r.rulebookId, version: v.version })} />}
                    </td>
                  </tr>
                ))}
              </VersionTable>
            </Panel>
          ))}
        </div>
      ) : tab === 'agents' ? (
        <div className="space-y-4">
          <p className="text-sm text-muted max-w-3xl">The agent declaration <span className="font-mono">decl.&lt;agent&gt;</span> says who the agent acts for and which write types it may make, in the lexicon its receipts use. Every receipt names the version in force. Record a new version when the agent’s tools or the person it acts for change.</p>
          {agents.length === 0 ? (
            <Panel><EmptyState title="No agent declarations yet" disc="registration">Add an agent: its declaration is recorded with it.</EmptyState></Panel>
          ) : agents.map((a) => (
            <Panel key={a.slug} kicker="Agent declaration"
              title={<span className="inline-flex flex-wrap items-center gap-2"><Link to={`/agents/${a.slug}`} className="font-mono hover:underline underline-offset-2">decl.{a.slug}</Link><span className="text-sm font-normal text-muted">{a.name}</span>{a.retired && <Badge>Retired</Badge>}</span>}
              actions={<span className="inline-flex flex-wrap items-center gap-2">
                {a.inForce ? <StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" />}>v{a.inForce} in force</StatusChip> : <StatusChip size="sm" tone="bad">No version in force</StatusChip>}
                {!a.retired && manager && <Tooltip content="Record a new version from the agent’s current tools"><Button size="sm" variant="ghost" icon={<FilePlus2 className="h-3.5 w-3.5" />} onClick={() => setDeclare(a)}>New version</Button></Tooltip>}
              </span>} flush>
              {a.drift && <p className="px-5 py-2 text-xs text-held-fg bg-held-bg border-b border-line">The agent’s tools have changed since the version in force. Record a new version so its receipts declare the write types it now makes.</p>}
              <VersionTable caption={`Versions of decl.${a.slug}`} heads={['Version', 'State', 'Acts as', 'Lexicon hash', 'Recorded', '']}>
                {a.versions.map((v) => (
                  <tr key={v.version} className="border-b border-line last:border-b-0 align-top">
                    <td className="px-4 py-2.5 font-mono font-semibold whitespace-nowrap">v{v.version}<span className="block text-xs font-normal text-muted">{plural(v.writeTypes.length, 'write type')}</span></td>
                    <td className="px-4 py-2.5 whitespace-nowrap"><StateCell withdrawn={v.withdrawn} inForce={v.inForce} /></td>
                    <td className="px-4 py-2.5 max-w-[260px]"><span className="block">{ACTOR_KIND_LABEL[v.actorKind] ?? v.actorKind}</span><span className="block text-xs text-muted line-clamp-2">{v.withdrawn ? `Withdrawn: ${v.withdrawn.reason}` : v.note ?? ''}</span></td>
                    <td className="px-4 py-2.5"><Hash value={v.lexiconHash} len={10} /></td>
                    <td className="px-4 py-2.5 whitespace-nowrap"><span className="flex flex-col gap-0.5">{v.recordedBy && <Person id={v.recordedBy} size={18} />}<span className="text-xs text-muted">{date(v.recordedAt)}</span>{v.seq !== undefined && <ReceiptLink seq={v.seq} className="text-xs" />}</span></td>
                    <td className="px-4 py-2.5 text-right">{!v.withdrawn && <WithdrawButton manager={manager} inForce={v.inForce} onClick={() => setTarget({ kind: 'agent', row: a, version: v.version })} />}</td>
                  </tr>
                ))}
              </VersionTable>
            </Panel>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted max-w-3xl">A regulatory pack’s declaration <span className="font-mono">decl.&lt;pack&gt;</span> sets the parameters its nine checks run with before every governed write. Each configuration is a new version; withdrawing the version in force puts the newest version not withdrawn back, with its parameters.</p>
          {packs.length === 0 ? (
            <Panel><EmptyState title="No regulatory pack installed" disc="registration" action={<Link to="/records/packs" className="text-sm underline underline-offset-2">Regulatory packs</Link>}>A pack’s declaration appears here once it is installed.</EmptyState></Panel>
          ) : packs.map((p) => (
            <Panel key={p.id} kicker="Pack declaration"
              title={<span className="inline-flex flex-wrap items-center gap-2"><Link to={`/records/packs/${p.id}`} className="font-mono hover:underline underline-offset-2">decl.{p.id}</Link><span className="text-sm font-normal text-muted">{p.regime}</span></span>}
              actions={<StatusChip size="sm" tone="ok" icon={<CheckCircle2 className="h-3 w-3" />}>v{p.inForce} in force</StatusChip>} flush>
              <VersionTable caption={`Versions of decl.${p.id}`} heads={['Version', 'State', 'Parameters', 'Recorded', '']}>
                {p.versions.map((v) => (
                  <tr key={v.version} className="border-b border-line last:border-b-0 align-top">
                    <td className="px-4 py-2.5 font-mono font-semibold whitespace-nowrap">v{v.version}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap"><StateCell withdrawn={v.withdrawn} inForce={v.inForce} /></td>
                    <td className="px-4 py-2.5 max-w-[360px]">
                      {v.values ? <ParamList pack={p.id} values={v.values} changed={v.changed ?? []} /> : <span className="text-xs text-muted">The pack’s defaults, as installed</span>}
                      {v.withdrawn && <span className="block mt-1 text-xs text-muted line-clamp-2">Withdrawn: {v.withdrawn.reason}</span>}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap"><span className="flex flex-col gap-0.5">{v.by && <Person id={v.by} size={18} />}{v.at && <span className="text-xs text-muted">{date(v.at)}</span>}{v.seq !== undefined && <ReceiptLink seq={v.seq} className="text-xs" />}</span></td>
                    <td className="px-4 py-2.5 text-right">{!v.withdrawn && <WithdrawButton manager={manager} inForce={v.inForce} onClick={() => setTarget({ kind: 'pack', row: p, version: v.version })} />}</td>
                  </tr>
                ))}
              </VersionTable>
            </Panel>
          ))}
        </div>
      )}
      <p className="mt-4 text-xs text-muted">Withdrawing and recording are receipts. {evidenceClaim(level)}</p>

      {rb && target?.kind === 'rulebook' && <WithdrawVersionDialog rb={rb} version={target.version} onClose={() => setTarget(undefined)} onDone={q.refetch} />}
      {target && target.kind !== 'rulebook' && <WithdrawDeclarationDialog target={target} onClose={() => setTarget(undefined)} onDone={q.refetch} />}
      {declare && <NewAgentVersionDialog row={declare} onClose={() => setDeclare(undefined)} onDone={q.refetch} />}
    </div>
  );
}

function VersionTable({ caption, heads, children }: { caption: string; heads: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-sunken/60"><tr className="border-b border-line">{heads.map((h, i) => <th key={i} scope="col" className="label text-left px-4 h-8">{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function StateCell({ withdrawn, inForce, other }: { withdrawn?: { at: string; seq?: number }; inForce: boolean; other?: ReactNode }) {
  if (withdrawn) return <span className="flex flex-col gap-1"><WithdrawnChip at={withdrawn.at} />{withdrawn.seq !== undefined && <ReceiptLink seq={withdrawn.seq} className="text-xs" />}</span>;
  if (inForce) return <Badge tone="ok">In force</Badge>;
  return <>{other ?? <span className="text-xs text-subtle">Superseded</span>}</>;
}

/** Owners and admins withdraw a version; other roles read the history without the button. */
function WithdrawButton({ manager, inForce, onClick }: { manager: boolean; inForce: boolean; onClick: () => void }) {
  if (!manager) return null;
  return (
    <Tooltip content={inForce ? 'Stop new calls using this version; the newest version not withdrawn takes over' : 'Stop this version ever being used again'}>
      <Button size="sm" variant="quiet-danger" icon={<Ban className="h-3.5 w-3.5" />} onClick={onClick}>Withdraw</Button>
    </Tooltip>
  );
}

function ParamList({ pack, values, changed }: { pack: PackId; values: Record<string, number>; changed: string[] }) {
  const params = PACK_PARAMS[pack] ?? [];
  return (
    <ul className="space-y-0.5">
      {params.filter((x) => values[x.id] !== undefined).map((x) => (
        <li key={x.id} className="text-xs"><span className="text-muted">{x.label}</span> <span className={changed.includes(x.id) ? 'font-semibold' : undefined}>{x.unit === '₹' ? rupees(values[x.id]) : `${values[x.id]} ${x.unit}`}</span>{changed.includes(x.id) && <span className="text-muted"> (changed)</span>}</li>
      ))}
    </ul>
  );
}

function WithdrawDeclarationDialog({ target, onClose, onDone }: { target: Extract<Target, { kind: 'agent' | 'pack' }>; onClose: () => void; onDone: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const name = target.kind === 'agent' ? `decl.${target.row.slug}` : `decl.${target.row.id}`;
  const versions = target.row.versions as { version: number; inForce: boolean; withdrawn?: unknown }[];
  const v = versions.find((x) => x.version === target.version);
  const fallback = versions.filter((x) => x.version !== target.version && !x.withdrawn).sort((a, b) => a.version - b.version).pop();
  const blocked = !v ? 'No such version.' : v.withdrawn ? 'Already withdrawn.' : v.inForce && !fallback
    ? (target.kind === 'agent' ? `Version ${target.version} is the only version of ${name}. Record a new version first.` : `Version ${target.version} is the only version of ${name} left. Configure a new version on the pack first.`)
    : undefined;
  const submit = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const r = target.kind === 'agent'
        ? await declApi.withdrawAgent(orgId, target.row.slug, target.version, reason, user.id)
        : await declApi.withdrawPack(orgId, target.row.id, target.version, reason, user.id);
      toast.ok(`${name} v${target.version} withdrawn`, r.wasInForce ? `Version ${r.nowInForce} is in force for new calls. Recorded on the chain.` : 'It can no longer be used. Recorded on the chain.');
      onDone();
      onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} tone="danger" title={`Withdraw ${name} v${target.version}`}
      description="The version stays in the history and every receipt that named it keeps verifying. No call made from now on uses it."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" icon={<Ban className="h-4 w-4" />} loading={busy} disabled={!!blocked || reason.trim().length < 8} onClick={submit}>Withdraw the version</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Not withdrawn">{err}</Banner>}
        {blocked ? <Banner tone="held" title="This version cannot be withdrawn now">{blocked}</Banner>
          : v?.inForce && fallback ? <Banner tone="info" title={`Version ${fallback.version} takes over for new calls`}>{target.kind === 'pack' ? `The pack’s checks run with the parameters of version ${fallback.version} from the next call.` : `Receipts name ${name} v${fallback.version} from the next call.`}</Banner>
            : <p className="text-sm text-muted">It is not in force, so calls do not change. Withdrawing it records why it must not return.</p>}
        <Field label="Why it is withdrawn" required htmlFor="wd-decl-r" hint="A sentence. It goes on the receipt as written."><Textarea id="wd-decl-r" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus /></Field>
        <p className="text-xs text-muted">Recorded as <span className="font-mono">{target.kind === 'agent' ? 'declaration.version_withdrawn' : 'pack.declaration_withdrawn'}</span>, {level === 'l1' ? 'sealed in the hash chain' : 'signed with the organisation’s key'}.</p>
      </div>
    </Dialog>
  );
}

function NewAgentVersionDialog({ row, onClose, onDone }: { row: AgentDeclRow; onClose: () => void; onDone: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const current = row.versions.find((v) => v.inForce);
  const [actorKind, setActorKind] = useState<ActorKind>(current?.actorKind ?? 'agent');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const submit = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const v = await declApi.recordAgent(orgId, row.slug, { actorKind, note }, user.id);
      toast.ok(`decl.${row.slug} v${v.version} recorded`, `In force from the next call: ${plural(v.writeTypes.length, 'write type')}. Recorded on the chain.`);
      onDone();
      onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={`New version of decl.${row.slug}`} description={`The write types are taken from the agent’s ${plural(row.currentTools, 'tool')} as they are now. The new version is in force from the next call.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={note.trim().length < 8} onClick={submit}>Record the version</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Not recorded">{err}</Banner>}
        <Field label="The agent acts as" htmlFor="nd-kind"><Select id="nd-kind" value={actorKind} onChange={(e) => setActorKind(e.target.value as ActorKind)}>{(Object.keys(ACTOR_KIND_LABEL) as ActorKind[]).map((k) => <option key={k} value={k}>{ACTOR_KIND_LABEL[k]}</option>)}</Select></Field>
        <Field label="Why a new version" required htmlFor="nd-note" hint="A sentence. It goes on the receipt."><Textarea id="nd-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus /></Field>
        <p className="text-xs text-muted">Recorded as <span className="font-mono">declaration.recorded</span>, {level === 'l1' ? 'sealed in the hash chain' : 'signed with the organisation’s key'}.</p>
      </div>
    </Dialog>
  );
}
