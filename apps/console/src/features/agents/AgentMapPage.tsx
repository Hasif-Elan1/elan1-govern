import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, X } from 'lucide-react';
import { api } from '@/api';
import { useQuery } from '@/hooks/useQuery';
import { useOrgLevel } from '@/store/session';
import { atLeast } from '@/lib/levels';
import { cn } from '@/lib/cn';
import type { Agent, Connector, RiskTag } from '@/types';
import { toolByName } from '@/mock/catalog';
import { userName } from '@/mock/users';
import { n, pct, HIGH_IMPACT_TAGS } from '@/lib/format';
import { Banner, Button, Checkbox, DataTable, EmptyState, PageHeader, Panel, Segmented, Skeleton, type Column } from '@/components/ui';
import { AgentLink } from '@/components/domain';
import { MixBar, addDecision, decisionsSince, emptyMix, mixText, type Mix } from './parts';
import { SmartLink, useScreenAccess } from '@/shell/access';

/* ── Graph model ──────────────────────────────────────────── */

type Col = 0 | 1 | 2 | 3 | 4;
type Kind = 'person' | 'agent' | 'tool' | 'system' | 'counterparty';
interface GNode { id: string; col: Col; kind: Kind; label: string; sub: string; href: string; high?: boolean; paused?: boolean; mix: Mix }
interface GEdge { id: string; from: string; to: string; mix: Mix; ownership?: boolean; receipts?: boolean }
type Tone = 'allow' | 'ask' | 'refuse' | 'idle';

const COLS: { title: string; hint: string }[] = [
  { title: 'People', hint: 'Owners' },
  { title: 'Agents', hint: 'Who calls' },
  { title: 'Tools', hint: 'What they call' },
  { title: 'Systems', hint: 'Where it runs' },
  { title: 'Counterparties', hint: 'Who verifies' },
];

const NW = 204, NH = 38, GAP = 10, TOP = 44;
const widthFor = (ncol: number) => (ncol === 5 ? 1400 : 1120);
const colXFor = (ncol: number) => (c: Col) => c * ((widthFor(ncol) - NW) / (ncol - 1));

/** Cross-organisation receipts issued per agent and tool (L3), and received per counterparty. */
export interface CrossEdges {
  issued: { agent: string; tool: string; cpId: string; cpName: string }[];
  counterparties: { id: string; name: string; kind: string; issued: number; received: number }[];
}

function toneOf(m: Mix): Tone {
  if (!m.total) return 'idle';
  if (m.refuse / m.total >= 0.2) return 'refuse';
  if (m.ask / m.total >= 0.1) return 'ask';
  return 'allow';
}

const TONE_STYLE: Record<Tone, { stroke: string; dash?: string; label: string }> = {
  allow: { stroke: 'rgb(var(--ok))', label: 'Mostly allowed' },
  ask: { stroke: 'rgb(var(--held))', dash: '10 5', label: 'Asks a person often (10% or more)' },
  refuse: { stroke: 'rgb(var(--bad))', dash: '3 4', label: 'Refuses often (20% or more)' },
  idle: { stroke: 'rgb(var(--line-strong))', dash: '1 5', label: 'No calls in 7 days' },
};

function build(agents: Agent[], connectors: Connector[], rs: ReturnType<typeof decisionsSince>, highOnly: boolean, includePaused: boolean, cross?: CrossEdges) {
  const ncol = cross ? 5 : 4;
  const colX = colXFor(ncol);
  const toolMeta = new Map<string, { connector?: Connector; tags: RiskTag[] }>();
  for (const c of connectors) for (const t of c.tools) toolMeta.set(t.name, { connector: c, tags: t.tags.length ? t.tags : t.suggestedTags ?? [] });
  const metaOf = (tool: string) => toolMeta.get(tool) ?? { connector: undefined, tags: toolByName(tool)?.tags ?? [] };

  const at = new Map<string, Mix>(); // agent|tool
  for (const r of rs) {
    if (!r.agent || !r.tool) continue;
    const k = `${r.agent}|${r.tool}`;
    if (!at.has(k)) at.set(k, emptyMix());
    addDecision(at.get(k)!, r.decision, r.ts);
  }

  const shown = agents.filter((a) => includePaused || a.status === 'active');
  const nodes = new Map<string, GNode>();
  const edges = new Map<string, GEdge>();
  const addEdge = (from: string, to: string, mix: Mix, ownership?: boolean) => {
    const id = `${from}>${to}`;
    const e = edges.get(id);
    if (!e) { edges.set(id, { id, from, to, mix: { ...mix }, ownership }); return; }
    e.mix = { allow: e.mix.allow + mix.allow, ask: e.mix.ask + mix.ask, refuse: e.mix.refuse + mix.refuse, total: e.mix.total + mix.total };
  };
  const bump = (node: GNode, m: Mix) => { node.mix = { allow: node.mix.allow + m.allow, ask: node.mix.ask + m.ask, refuse: node.mix.refuse + m.refuse, total: node.mix.total + m.total }; };

  for (const a of shown) {
    const seen = new Set(a.tools);
    for (const k of at.keys()) if (k.startsWith(`${a.slug}|`)) seen.add(k.split('|')[1]);
    const tools = [...seen].filter((t) => !highOnly || metaOf(t).tags.some((g) => HIGH_IMPACT_TAGS.includes(g)));
    if (highOnly && !tools.length) continue;

    const pid = `p:${a.ownerId}`;
    if (!nodes.has(pid)) nodes.set(pid, { id: pid, col: 0, kind: 'person', label: userName(a.ownerId), sub: 'Owner', href: `/agents/people?member=${encodeURIComponent(a.ownerId)}`, mix: emptyMix() });
    const aid = `a:${a.slug}`;
    const agentNode: GNode = { id: aid, col: 1, kind: 'agent', label: a.slug, sub: `${a.route === 'mcp' ? 'Governed run' : 'Advisory'}${a.status !== 'active' ? ' · paused' : ''}`, href: `/agents/${a.slug}`, paused: a.status !== 'active', mix: emptyMix() };
    nodes.set(aid, agentNode);

    for (const t of tools) {
      const m = at.get(`${a.slug}|${t}`) ?? emptyMix();
      const meta = metaOf(t);
      const tid = `t:${t}`;
      if (!nodes.has(tid)) nodes.set(tid, { id: tid, col: 2, kind: 'tool', label: t, sub: meta.connector ? (meta.tags.length ? meta.tags.map((g) => g.replace('_', ' ')).slice(0, 2).join(' · ') : 'No risk tags') : 'Not in the registry — refused', href: meta.connector ? `/connectors/${meta.connector.id}` : `/activity?tool=${encodeURIComponent(t)}`, high: meta.tags.some((g) => HIGH_IMPACT_TAGS.includes(g)), mix: emptyMix() });
      bump(nodes.get(tid)!, m);
      bump(agentNode, m);
      addEdge(aid, tid, m);
      const sid = meta.connector ? `s:${meta.connector.id}` : 's:none';
      if (!nodes.has(sid)) nodes.set(sid, meta.connector
        ? { id: sid, col: 3, kind: 'system', label: meta.connector.name.split(' — ')[0], sub: meta.connector.kind === 'mcp_upstream' ? 'Your MCP server' : `Built-in · ${meta.connector.mode}`, href: `/connectors/${meta.connector.id}`, mix: emptyMix() }
        : { id: sid, col: 3, kind: 'system', label: 'No connector', sub: 'Unknown tools are refused', href: '/connectors', mix: emptyMix() });
      bump(nodes.get(sid)!, m);
      addEdge(tid, sid, m);
    }
    addEdge(pid, aid, agentNode.mix, true);
    bump(nodes.get(pid)!, agentNode.mix);
  }

  // L3: receipts issued to counterparties hang off the system the tool reached
  if (cross) {
    for (const cp of cross.counterparties) {
      nodes.set(`c:${cp.id}`, { id: `c:${cp.id}`, col: 4, kind: 'counterparty', label: cp.name, sub: `${cp.issued} issued · ${cp.received} received`, href: `/assurance/counterparties?id=${encodeURIComponent(cp.id)}`, mix: { allow: cp.issued + cp.received, ask: 0, refuse: 0, total: cp.issued + cp.received } });
    }
    for (const x of cross.issued) {
      if (!nodes.has(`a:${x.agent}`) || !nodes.has(`t:${x.tool}`)) continue;
      const sys = [...edges.values()].find((e) => e.from === `t:${x.tool}`)?.to;
      if (!sys || !nodes.has(`c:${x.cpId}`)) continue;
      const id = `${sys}>c:${x.cpId}`;
      const e = edges.get(id);
      if (e) { e.mix.total++; e.mix.allow++; } else edges.set(id, { id, from: sys, to: `c:${x.cpId}`, mix: { allow: 1, ask: 0, refuse: 0, total: 1 }, receipts: true });
    }
  }

  // order columns to reduce crossings: people by volume, agents by owner, tools and systems by mean parent position
  const list = [...nodes.values()];
  const pos = new Map<string, number>();
  const people = list.filter((x) => x.col === 0).sort((a, b) => b.mix.total - a.mix.total);
  people.forEach((p, i) => pos.set(p.id, i));
  const parentMean = (id: string) => {
    const ps = [...edges.values()].filter((e) => e.to === id).map((e) => pos.get(e.from) ?? 0);
    return ps.length ? ps.reduce((s, x) => s + x, 0) / ps.length : 0;
  };
  const columns: GNode[][] = Array.from({ length: ncol }, (_, i) => (i === 0 ? people : []));
  for (const c of (ncol === 5 ? [1, 2, 3, 4] : [1, 2, 3]) as Col[]) {
    const col = list.filter((x) => x.col === c).sort((a, b) => parentMean(a.id) - parentMean(b.id) || b.mix.total - a.mix.total);
    col.forEach((x, i) => pos.set(x.id, i));
    columns[c] = col;
  }
  const maxRows = Math.max(1, ...columns.map((c) => c.length));
  const height = TOP + maxRows * (NH + GAP) + 8;
  const xy = new Map<string, { x: number; y: number }>();
  columns.forEach((col, c) => {
    const off = ((maxRows - col.length) * (NH + GAP)) / 2;
    col.forEach((node, i) => xy.set(node.id, { x: colX(c as Col), y: TOP + off + i * (NH + GAP) }));
  });
  const maxW = Math.max(1, ...[...edges.values()].filter((e) => !e.receipts).map((e) => e.mix.total));
  const maxR = Math.max(1, ...[...edges.values()].filter((e) => e.receipts).map((e) => e.mix.total));
  return { nodes: list, edges: [...edges.values()], xy, height, maxW, maxR, columns, ncol, W: widthFor(ncol), colX };
}

/** Everything on the path through a node: its ancestors to the left and descendants to the right. */
function pathThrough(id: string, edges: GEdge[]) {
  const nodes = new Set([id]);
  const es = new Set<string>();
  const walk = (start: string, dir: 'up' | 'down') => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of edges) {
        const next = dir === 'down' ? (e.from === cur ? e.to : undefined) : (e.to === cur ? e.from : undefined);
        if (next && !es.has(e.id)) { es.add(e.id); nodes.add(next); stack.push(next); }
      }
    }
  };
  walk(id, 'up');
  walk(id, 'down');
  return { nodes, edges: es };
}

/* ── Page ─────────────────────────────────────────────────── */

export default function AgentMapPage() {
  const nav = useNavigate();
  const access = useScreenAccess();
  // a box opens only a screen this role and plan can open; the others are labels
  const opens = (href: string) => access.canSee(href);
  const level = useOrgLevel();
  const l3 = atLeast(level, 'l3');
  const [params, setParams] = useSearchParams();
  const pinnedSlug = params.get('agent') ?? undefined;
  const agentsQ = useQuery((o) => api.agents(o), []);
  const consQ = useQuery((o) => api.connectors(o), []);
  const rsQ = useQuery(async (o) => decisionsSince(o, 7), []);
  const crossQ = useQuery(async (o): Promise<CrossEdges | undefined> => {
    if (!atLeast(api.levelOf(o), 'l3')) return undefined;
    const [rows, reg] = await Promise.all([api.crossOrgReceipts(o), api.counterparties(o)]);
    const bySeq = new Map(api.chainSlice(o).receipts.map((r) => [r.seq, r]));
    const issued = rows.filter((x) => x.direction === 'issued').map((x) => ({ agent: bySeq.get(x.seq)?.agent ?? '', tool: bySeq.get(x.seq)?.tool ?? '', cpId: x.counterpartyId, cpName: x.counterpartyName })).filter((x) => x.agent && x.tool);
    return {
      issued,
      counterparties: reg.counterparties.map((c) => ({ id: c.id, name: c.name, kind: c.kind, issued: rows.filter((x) => x.counterpartyId === c.id && x.direction === 'issued').length, received: rows.filter((x) => x.counterpartyId === c.id && x.direction === 'received').length })),
    };
  }, [level], { kinds: ['receipt', 'counterparty', 'level'] });
  const [scope, setScope] = useState<'all' | 'high'>('all');
  const [includePaused, setIncludePaused] = useState(true);
  const [hover, setHover] = useState<string>();
  const [hoverEdge, setHoverEdge] = useState<string>();

  const g = useMemo(() => {
    if (!agentsQ.data || !consQ.data || !rsQ.data || (l3 && crossQ.loading)) return undefined;
    return build(agentsQ.data, consQ.data, rsQ.data, scope === 'high', includePaused, crossQ.data);
  }, [agentsQ.data, consQ.data, rsQ.data, scope, includePaused, crossQ.data, crossQ.loading, l3]);

  const pinned = pinnedSlug && g?.nodes.some((x) => x.id === `a:${pinnedSlug}`) ? `a:${pinnedSlug}` : undefined;
  const clearPin = () => { const p = new URLSearchParams(params); p.delete('agent'); setParams(p, { replace: true }); };

  const focus = useMemo(() => {
    if (!g) return undefined;
    if (hover) return pathThrough(hover, g.edges);
    if (!hoverEdge && pinned) return pathThrough(pinned, g.edges);
    if (hoverEdge) {
      const e = g.edges.find((x) => x.id === hoverEdge);
      if (e) { const a = pathThrough(e.from, g.edges); const b = pathThrough(e.to, g.edges); return { nodes: new Set([...a.nodes].filter((x) => b.nodes.has(x)).concat(e.from, e.to)), edges: new Set([...a.edges].filter((x) => b.edges.has(x)).concat(e.id)) }; }
    }
    return undefined;
  }, [g, hover, hoverEdge, pinned]);

  const loading = agentsQ.loading || consQ.loading || rsQ.loading;
  const error = agentsQ.error ?? consQ.error ?? rsQ.error;

  const hovered = g && (hover ?? (hoverEdge ? undefined : pinned)) ? g.nodes.find((x) => x.id === (hover ?? pinned)) : undefined;
  const edgeHovered = g && hoverEdge ? g.edges.find((x) => x.id === hoverEdge) : undefined;
  const nodeById = (id: string) => g?.nodes.find((x) => x.id === id);

  const connections = useMemo(() => {
    if (!g) return [];
    return g.edges.filter((e) => e.from.startsWith('a:') && (!pinned || e.from === pinned)).map((e) => {
      const sys = g.edges.find((x) => x.from === e.to && !x.receipts);
      return { id: e.id, agent: e.from.slice(2), tool: e.to.slice(2), toolNode: nodeById(e.to)!, system: sys ? nodeById(sys.to) : undefined, mix: e.mix };
    });
  }, [g, pinned]);

  const cols: Column<(typeof connections)[number]>[] = [
    { key: 'agent', header: 'Agent', sort: (r) => r.agent, cell: (r) => <AgentLink slug={r.agent} /> },
    { key: 'tool', header: 'Tool', sort: (r) => r.tool, cell: (r) => <span className="font-mono text-[12.5px]">{r.tool}{r.toolNode.high && <span className="ml-2 text-accent-fg text-xs font-sans">High-impact</span>}</span> },
    { key: 'system', header: 'System', hideBelow: 'md', cell: (r) => r.system ? <SmartLink className="hover:underline" to={r.system.href}>{r.system.label}</SmartLink> : '—' },
    { key: 'calls', header: 'Calls · 7 days', align: 'right', sort: (r) => r.mix.total, cell: (r) => <span className="num">{n(r.mix.total)}</span> },
    { key: 'mix', header: 'Decisions', hideBelow: 'sm', width: 220, cell: (r) => <div className="flex items-center gap-2"><MixBar mix={r.mix} className="w-24" /><span className="text-xs text-muted">{TONE_STYLE[toneOf(r.mix)].label}</span></div> },
  ];

  return (
    <div className="min-w-0 overflow-x-clip">
      <PageHeader
        kicker="Agents"
        crumbs={[{ label: 'Agents', to: '/agents' }, { label: 'Agent map' }]}
        title="Agent map"
        description={`Who owns each agent, which tools it calls and which systems those tools reach${l3 ? ', and which counterparties receive its receipts' : ''}. Lines are weighted by 7-day call volume and styled by what the rulebook decided.`}
        actions={<Link to="/agents" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" />Back to agents</Link>}
      />

      {error && <Banner tone="bad" title="Could not build the map" className="mb-6" actions={<Button size="sm" onClick={() => { agentsQ.refetch(); consQ.refetch(); rsQ.refetch(); }}>Try again</Button>}>{error.message}</Banner>}
      {crossQ.error && <Banner tone="bad" title="Counterparties did not load — the counterparty column is left out" className="mb-6" actions={<Button size="sm" onClick={crossQ.refetch}>Try again</Button>}>{crossQ.error.message}</Banner>}
      {pinnedSlug && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">{pinned ? <>Showing the path through <span className="font-mono text-fg">{pinnedSlug}</span></> : <>No agent called <span className="font-mono">{pinnedSlug}</span> on this map{!includePaused ? ' (paused agents are hidden)' : ''}.</>}</span>
          <Button size="sm" variant="secondary" iconRight={<X className="h-3.5 w-3.5" />} onClick={clearPin}>Show every agent</Button>
          {pinned && <Link to={`/agents/${pinnedSlug}`} className="text-muted underline underline-offset-2 hover:text-fg">Open the agent</Link>}
        </div>
      )}

      <Panel
        flush
        title={l3 ? 'People → agents → tools → systems → counterparties' : 'People → agents → tools → systems'}
        actions={
          <div className="hidden sm:flex items-center gap-4">
            <Checkbox checked={includePaused} onChange={setIncludePaused} label="Include paused agents" />
            <Segmented label="Tools shown" size="sm" value={scope} onChange={setScope} options={[{ value: 'all', label: 'All tools' }, { value: 'high', label: 'High-impact only' }]} />
          </div>
        }
      >
        <div className="sm:hidden flex flex-wrap items-center gap-3 px-4 pt-4">
          <Segmented label="Tools shown" size="sm" value={scope} onChange={setScope} options={[{ value: 'all', label: 'All tools' }, { value: 'high', label: 'High-impact only' }]} />
          <Checkbox checked={includePaused} onChange={setIncludePaused} label="Include paused" />
        </div>

        {/* legend */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3 border-b border-line text-xs text-muted">
          {(['allow', 'ask', 'refuse', 'idle'] as Tone[]).map((t) => (
            <span key={t} className="inline-flex items-center gap-2">
              <svg width="34" height="10" aria-hidden><line x1="1" y1="5" x2="33" y2="5" stroke={TONE_STYLE[t].stroke} strokeWidth="3" strokeDasharray={TONE_STYLE[t].dash} /></svg>
              {TONE_STYLE[t].label}
            </span>
          ))}
          <span className="inline-flex items-center gap-2"><svg width="34" height="10" aria-hidden><line x1="1" y1="5" x2="33" y2="5" stroke="rgb(var(--fg))" strokeOpacity="0.35" strokeWidth="1.5" /></svg>Owns</span>
          <span className="inline-flex items-center gap-2"><span className="h-3 w-[3px] bg-accent" aria-hidden />High-impact tool</span>
          {l3 && <span className="inline-flex items-center gap-2"><svg width="34" height="10" aria-hidden><line x1="1" y1="5" x2="33" y2="5" stroke="rgb(var(--info))" strokeWidth="2" strokeDasharray="6 3" /></svg>Receipts issued to a counterparty</span>}
          <span className="sm:ml-auto">Line width = calls in 7 days</span>
        </div>

        {/* hover read-out: words, not colour alone */}
        <div className="px-5 py-2.5 border-b border-line min-h-[44px] text-sm" aria-live="polite">
          {hovered ? (
            hovered.kind === 'counterparty'
              ? <span><span className="font-medium">{hovered.label}</span> <span className="text-muted">· counterparty · {hovered.sub}</span></span>
              : <span><span className="font-medium">{hovered.label}</span> <span className="text-muted">· {hovered.sub} · {n(hovered.mix.total)} calls in 7 days{hovered.mix.total ? ` · ${mixText(hovered.mix)}` : ''}</span></span>
          ) : edgeHovered ? (
            edgeHovered.receipts
              ? <span><span className="font-medium">{nodeById(edgeHovered.from)?.label} → {nodeById(edgeHovered.to)?.label}</span> <span className="text-muted">· {n(edgeHovered.mix.total)} receipts issued</span></span>
              : <span><span className="font-medium">{nodeById(edgeHovered.from)?.label} → {nodeById(edgeHovered.to)?.label}</span> <span className="text-muted">· {edgeHovered.ownership ? 'owns · ' : ''}{n(edgeHovered.mix.total)} calls · {edgeHovered.mix.total ? `${pct(edgeHovered.mix.allow / edgeHovered.mix.total)} allowed, ${pct(edgeHovered.mix.ask / edgeHovered.mix.total)} asked, ${pct(edgeHovered.mix.refuse / edgeHovered.mix.total)} refused` : 'no calls'}</span></span>
          ) : (
            <span className="text-muted">Hover or tab to a box to trace its path. Click to open it, where your role can.</span>
          )}
        </div>

        {loading && !g ? (
          <div className="p-5"><Skeleton className="h-[460px]" /></div>
        ) : g && g.nodes.length === 0 ? (
          <EmptyState title={scope === 'high' ? 'No agent can call a high-impact tool' : 'No agents to map'} disc="registration">
            {scope === 'high' ? 'None of the agents shown has a tool tagged moves money, deletes, changes access or changes production.' : 'Add an agent to see who owns it and what it reaches.'}
          </EmptyState>
        ) : g && (
          <div className="overflow-x-auto">
            <svg viewBox={`0 0 ${g.W + 16} ${g.height}`} className={cn('block w-full', g.ncol === 5 ? 'min-w-[1100px]' : 'min-w-[900px]')} role="img" aria-label={`Map of ${g.columns[0].length} people, ${g.columns[1].length} agents, ${g.columns[2].length} tools and ${g.columns[3].length} systems${g.ncol === 5 ? ` and ${g.columns[4].length} counterparties` : ''}. A table of every connection follows.`}
              onMouseLeave={() => { setHover(undefined); setHoverEdge(undefined); }}>
              <g transform="translate(8,0)">
                {COLS.slice(0, g.ncol).map((c, i) => (
                  <g key={c.title} transform={`translate(${g.colX(i as Col)},18)`}>
                    <text className="fill-[rgb(var(--muted))]" style={{ font: '600 11px "IBM Plex Sans"', letterSpacing: '0.08em' }}>{c.title.toUpperCase()}</text>
                    <text x={NW} textAnchor="end" className="fill-[rgb(var(--subtle))]" style={{ font: '11px "IBM Plex Sans"' }}>{n(g.columns[i].length)} · {c.hint}</text>
                  </g>
                ))}

                {g.edges.map((e) => {
                  const a = g.xy.get(e.from)!, b = g.xy.get(e.to)!;
                  const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, mx = (x1 + x2) / 2;
                  const tone = toneOf(e.mix);
                  const st = e.receipts ? { stroke: 'rgb(var(--info))', dash: '6 3' } : e.ownership ? { stroke: 'rgb(var(--fg))', dash: undefined } : TONE_STYLE[tone];
                  const w = e.ownership ? 1.5 : e.receipts ? 1.5 + 5 * Math.sqrt(e.mix.total / g.maxR) : 1.5 + 9 * Math.sqrt(e.mix.total / g.maxW);
                  const on = !focus || focus.edges.has(e.id);
                  const d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
                  return (
                    <g key={e.id} onMouseEnter={() => { setHoverEdge(e.id); setHover(undefined); }}>
                      <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(12, w + 6)} />
                      <path d={d} fill="none" stroke={st.stroke} strokeWidth={w} strokeDasharray={st.dash} strokeOpacity={on ? (e.ownership ? 0.35 : 0.75) : 0.08} style={{ transition: 'stroke-opacity 120ms' }}>
                        <title>{`${nodeById(e.from)?.label} → ${nodeById(e.to)?.label}: ${mixText(e.mix)}`}</title>
                      </path>
                    </g>
                  );
                })}

                {g.nodes.map((node) => {
                  const p = g.xy.get(node.id)!;
                  const on = !focus || focus.nodes.has(node.id);
                  const label = node.label.length > 26 ? node.label.slice(0, 25) + '…' : node.label;
                  const mono = node.kind === 'tool' || node.kind === 'agent';
                  const link = opens(node.href);
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${p.x},${p.y})`}
                      tabIndex={0}
                      role={link ? 'link' : 'img'}
                      aria-label={node.kind === 'counterparty' ? `${node.label}, counterparty, ${node.sub}.${link ? ' Open the register.' : ''}` : `${node.label}, ${node.sub}, ${n(node.mix.total)} calls in 7 days.${link ? ' Open.' : ''}`}
                      className={cn('focus:outline-none group', link && 'cursor-pointer')}
                      style={{ opacity: on ? 1 : 0.28, transition: 'opacity 120ms' }}
                      onMouseEnter={() => { setHover(node.id); setHoverEdge(undefined); }}
                      onFocus={() => { setHover(node.id); setHoverEdge(undefined); }}
                      onBlur={() => setHover(undefined)}
                      onClick={() => { if (link) nav(node.href); }}
                      onKeyDown={(ev) => { if (link && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); nav(node.href); } }}
                    >
                      <rect width={NW} height={NH} fill="rgb(var(--surface))" stroke={hover === node.id || pinned === node.id ? 'rgb(var(--fg))' : 'rgb(var(--line-strong))'} strokeOpacity={hover === node.id || pinned === node.id ? 1 : 0.6} strokeWidth={hover === node.id || pinned === node.id ? 1.5 : 1} className="group-focus-visible:stroke-[rgb(var(--fg))]" />
                      {node.high && <rect width={3} height={NH} fill="rgb(var(--accent))" />}
                      {node.kind === 'person' && <rect x={8} y={10} width={20} height={20} fill="rgb(var(--fg))" fillOpacity={0.85} />}
                      {node.kind === 'person' && <text x={18} y={24} textAnchor="middle" style={{ font: '600 9px "IBM Plex Sans"' }} fill="rgb(var(--canvas))">{node.label.split(' ').filter((s) => !/^Dr$/.test(s)).map((s) => s[0]).slice(0, 2).join('')}</text>}
                      {node.paused && <rect x={NW - 10} y={6} width={4} height={NH - 12} fill="rgb(var(--held))" />}
                      <text x={node.kind === 'person' ? 36 : 10} y={17} style={{ font: `${mono ? '500 11.5px "IBM Plex Mono"' : '600 12.5px "IBM Plex Sans"'}` }} fill="rgb(var(--fg))">{label}</text>
                      <text x={node.kind === 'person' ? 36 : 10} y={31} style={{ font: '10.5px "IBM Plex Sans"' }} fill="rgb(var(--muted))">
                        {node.sub.length > 22 ? node.sub.slice(0, 21) + '…' : node.sub}
                        {node.kind !== 'person' && node.kind !== 'counterparty' && ` · ${n(node.mix.total)}`}
                      </text>
                      <title>{node.kind === 'counterparty' ? `${node.label} — ${node.sub}.` : `${node.label} — ${node.sub}. ${mixText(node.mix)}.`}</title>
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
        )}
        <div className="px-5 py-3 border-t border-line text-xs text-muted">
          Built from the last 7 days of decision receipts. Tools an agent called that no connector offers are shown under “No connector”; they are refused by default.{g?.ncol === 5 && ' Counterparty lines count every receipt issued to that counterparty, on the system the call reached.'}
        </div>
      </Panel>

      <div className="mt-6">
        <h2 className="text-lg font-semibold mb-3">Every connection{pinned ? ` for ${pinnedSlug}` : ''}</h2>
        <DataTable caption="Agent to tool connections with 7-day calls" columns={cols} rows={g ? connections : undefined} loading={loading} rowKey={(r) => r.id} initialSort={{ key: 'calls', dir: 'desc' }}
          onRowClick={opens('/connectors') ? (r) => { if (opens(r.toolNode.href)) nav(r.toolNode.href); } : undefined}
          empty={<EmptyState compact title="No agent-to-tool connection matches" disc="aperture" action={scope === 'high' || !includePaused || pinned ? <Button size="sm" variant="secondary" onClick={() => { setScope('all'); setIncludePaused(true); if (pinned) clearPin(); }}>Show everything</Button> : undefined}>
            {scope === 'high' ? 'No agent shown can call a high-impact tool.' : !includePaused ? 'Every agent with a connection is paused; include paused agents to see them.' : 'Add an agent and choose its tools to see what it reaches.'}
          </EmptyState>} />
      </div>
    </div>
  );
}
