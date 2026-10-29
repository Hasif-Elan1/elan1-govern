/**
 * Builds an organisation's receipt chain from simulated agent traffic.
 * Every receipt is canonical-JSON hashed (SHA-256), linked to the one before, and signed with Ed25519,
 * so the in-browser verifier genuinely verifies it. Approvals, checkpoints and agent statistics are
 * derived from the same events, so every number in the console traces back to a receipt.
 */
import type { Agent, Approval, ApproverGroup, Channel, Checkpoint, Receipt, Rulebook } from '@/types';
import { makeRand } from '@/lib/prng';
import { GENESIS, canonical, sha256Hex, signCheckpoint, signReceipt, type KeyPair } from '@/lib/crypto';
import { SCENARIOS, RATE, type Call } from './scenarios';
import { APPROVER_GROUPS } from './users';

const H = 3_600_000;
const D = 24 * H;

export interface AdminEvent {
  at: number;
  actor: string;
  action: string;
  details: Record<string, string | number | boolean>;
  agent?: string;
}

export interface ChainConfig {
  orgId: string;
  seed: number;
  days: number;
  startSeq: number;
  now: number;
  agents: (Agent & { scenarioKey: string })[];
  rulebooks: Rulebook[];
  keys: { key: KeyPair; from: number }[]; // key active from timestamp
  admin: AdminEvent[];
  stopWindows: { from: number; to: number; reason: string }[];
  pausedFrom: Record<string, { at: number; by: 'owner' | 'auto-pause' }>;
  createdAt: Record<string, number>;
  injected?: { at: number; agent: string; call: Call; forcePending?: boolean }[];
  volume?: number;
  /** Approver groups of this organisation (defaults to Demo Traders' groups). */
  groups?: ApproverGroup[];
  /** Traffic before `at` runs at `factor` of the usual rate, so a long history stays small. */
  sparseBefore?: { at: number; factor: number };
  /** Rewrites seeded text (headlines, effects) for this organisation, e.g. mail domains. */
  rewrite?: (s: string) => string;
  /** Sovereign (deny-all egress): no Slack or WhatsApp; approvals are notified and decided in the console, by email or phone link. */
  noChat?: boolean;
}

export interface ChainResult {
  receipts: Receipt[];
  approvals: Approval[];
  checkpoints: Checkpoint[];
}

interface Ev {
  at: number;
  order: number;
  build: (seq: number) => Omit<Receipt, 'seq' | 'prev_hash' | 'kid' | 'hash' | 'sig' | 'org'>;
  onSeq?: (seq: number) => void;
}

function istHour(t: number) {
  const d = new Date(t + 5.5 * H);
  return { hour: d.getUTCHours(), dow: d.getUTCDay() };
}

function activity(t: number) {
  const { hour, dow } = istHour(t);
  const weekend = dow === 0 || dow === 6;
  let f = hour >= 9 && hour < 19 ? 1 : hour >= 19 && hour < 23 ? 0.18 : hour >= 7 && hour < 9 ? 0.3 : 0.04;
  if (weekend) f *= 0.22;
  return f;
}

/** Only the values the rules inspected; email addresses become domains. Full arguments are never stored. */
export function summarise(args: Record<string, string | number | boolean>) {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'to' && typeof v === 'string' && v.includes('@')) out.to_domain = v.split('@')[1];
    else if (['subject', 'attachments', 'unread', 'page'].includes(k)) continue;
    else out[k] = v;
  }
  return out;
}

/**
 * The rulebook version in force at `t`: the newest one signed at or before it. None before the first signature —
 * a call then is refused with no-rulebook, never stamped with a version signed later.
 */
export function rulebookAt(rb: Rulebook | undefined, t: number) {
  if (!rb) return undefined;
  // a withdrawn version is never used by a call made after its withdrawal (records area, mock/records.ts)
  const published = rb.versions.filter((v) => v.status === 'published' && v.signedAt && new Date(v.signedAt).getTime() <= t && !(v.withdrawn && new Date(v.withdrawn.at).getTime() <= t)).sort((a, b) => a.signedAt!.localeCompare(b.signedAt!));
  return published[published.length - 1];
}

const pickChannel = (r: ReturnType<typeof makeRand>, chat: boolean): Channel =>
  chat
    ? r.weighted([['web', 40], ['slack', 30], ['whatsapp', 18], ['email', 8], ['phone_link', 4]] as const)
    : r.weighted([['web', 70], ['email', 18], ['phone_link', 12]] as const);

export function generateChain(cfg: ChainConfig): ChainResult {
  const r = makeRand(cfg.seed);
  const start = cfg.now - cfg.days * D;
  const evs: Ev[] = [];
  const approvals: Approval[] = [];
  let order = 0;
  let apprN = 0;

  const rbFor = (agent: Agent) => cfg.rulebooks.find((b) => b.id === agent.rulebookId);

  const pushCall = (agent: Agent & { scenarioKey: string }, at: number, rawCall: Call, forcePending = false) => {
    const rw = cfg.rewrite ?? ((s: string) => s);
    const call: Call = cfg.rewrite ? { ...rawCall, args: JSON.parse(rw(JSON.stringify(rawCall.args))) } : rawCall;
    const rb = rulebookAt(rbFor(agent), at);
    const stop = cfg.stopWindows.find((w) => at >= w.from && at < w.to);
    const paused = cfg.pausedFrom[agent.slug] && at >= cfg.pausedFrom[agent.slug].at;
    const advisory = agent.route !== 'mcp';
    const argsHash = sha256Hex(canonical({ tool: call.tool, args: call.args }));
    const summary = summarise(call.args);
    const headline = call.headline ? rw(call.headline.replace(/^[\w-]+ wants/, `${agent.slug} wants`)) : undefined;

    if (!rb && !stop && !paused) {
      evs.push({
        at, order: order++,
        build: () => ({
          ts: new Date(at).toISOString(), kind: 'decision', agent: agent.slug, tool: call.tool, args_summary: summary, args_hash: argsHash,
          rule_id: 'no-rulebook', decision: 'refuse', reason: 'No published rulebook version. Every call is refused until a version is published.',
          outcome: { status: 'not_run' }, details: { route: agent.route, mode: advisory ? 'check_and_record' : 'governed_run' },
        }),
      });
      return;
    }
    if (stop || paused) {
      evs.push({
        at, order: order++,
        build: () => ({
          ts: new Date(at).toISOString(), kind: 'decision', agent: agent.slug, tool: call.tool, args_summary: summary, args_hash: argsHash,
          rulebook: rb ? { version: rb.version, hash: rb.hash } : undefined, rule_id: 'agent-paused', decision: 'refuse',
          reason: stop ? `Emergency stop engaged: ${stop.reason}` : cfg.pausedFrom[agent.slug].by === 'auto-pause' ? 'Agent paused by auto-pause after a high-severity alert.' : 'Agent paused by its owner.',
          outcome: { status: 'not_run' }, details: { route: agent.route, mode: advisory ? 'check_and_record' : 'governed_run' },
        }),
      });
      return;
    }

    if (call.decision !== 'ask') {
      const ok = r.chance(0.985);
      evs.push({
        at, order: order++,
        build: () => ({
          ts: new Date(at).toISOString(), kind: 'decision', agent: agent.slug, tool: call.tool, args_summary: summary, args_hash: argsHash,
          rulebook: rb ? { version: rb.version, hash: rb.hash } : undefined, rule_id: call.ruleId, decision: call.decision, reason: call.reason,
          outcome: call.decision === 'allow'
            ? advisory ? undefined : { status: ok ? 'ok' : 'error', ref: `${call.connector.split(' ')[0].toLowerCase()}:${r.int(100000, 999999)}`, ms: r.int(90, 1400) }
            : { status: 'not_run' },
          details: { route: agent.route, mode: advisory ? 'check_and_record' : 'governed_run', ...(call.tags.length ? { tags: call.tags.join(',') } : {}) },
        }),
      });
      if (call.decision === 'allow' && advisory && r.chance(0.7)) {
        const t2 = at + r.int(2, 40) * 1000;
        let decisionSeq = 0;
        evs[evs.length - 1].onSeq = (s) => (decisionSeq = s);
        evs.push({
          at: t2, order: order++,
          build: () => ({ ts: new Date(t2).toISOString(), kind: 'outcome', agent: agent.slug, tool: call.tool, ref_seq: decisionSeq, outcome: { status: 'ok', ref: `agent-reported`, ms: r.int(120, 2400) }, details: { reported_by: 'agent', mode: 'check_and_record' } }),
        });
      }
      return;
    }

    // ask a person
    const id = `apr_${(cfg.seed % 997).toString(36)}${(++apprN).toString(36).padStart(4, '0')}`;
    const expiresAt = at + (call.expiresInH ?? 24) * H;
    const groups = cfg.groups ?? APPROVER_GROUPS;
    const group = groups.find((g) => g.id === call.approverGroup) ?? groups[0];
    const stillOpen = expiresAt > cfg.now;
    const pending = forcePending || (stillOpen && cfg.now - at < 20 * H && r.chance(0.75));
    const approval: Approval = {
      id, seq: 0, agentSlug: agent.slug, tool: call.tool, connector: call.connector, headline: headline ?? `${agent.slug} wants to call ${call.tool}`,
      ruleId: call.ruleId, ruleReason: call.reason, triggeredBy: call.triggeredBy ?? '', approverGroup: group.name, args: call.args,
      effect: rw(call.effect ?? ''), riskTags: call.tags, status: 'pending', createdAt: new Date(at).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
      similar: { approved: r.int(4, 46), rejected: r.int(0, 5), reversed: r.chance(0.2) ? 1 : 0 }, approveInChat: !!call.approveInChat,
      amount: call.amount, counterparty: call.counterparty, notified: call.approveInChat && !cfg.noChat ? ['web', 'slack', 'whatsapp'] : ['web', 'email'],
    };
    approvals.push(approval);
    evs.push({
      at, order: order++,
      onSeq: (s) => (approval.seq = s),
      build: () => ({
        ts: new Date(at).toISOString(), kind: 'decision', agent: agent.slug, tool: call.tool, args_summary: summary, args_hash: argsHash,
        rulebook: rb ? { version: rb.version, hash: rb.hash } : undefined, rule_id: call.ruleId, decision: 'ask', reason: call.reason,
        approval: { id, status: 'pending' }, details: { route: agent.route, mode: advisory ? 'check_and_record' : 'governed_run', approver_group: group.id, expires_in: `${call.expiresInH ?? 24}h` },
      }),
    });
    if (pending) return;

    const willExpire = !r.chance(0.92) || (!stillOpen && r.chance(0.05));
    const approved = !willExpire && r.chance(call.approveP ?? 0.8);
    const decidedAt = willExpire ? expiresAt : Math.min(expiresAt - 60_000, at + r.int(2, Math.min(240, (call.expiresInH ?? 24) * 50)) * 60_000);
    if (decidedAt > cfg.now) {
      return; // still pending
    }
    const approver = willExpire ? undefined : r.pick(group.members);
    const channel = willExpire ? undefined : pickChannel(r, !!call.approveInChat && !cfg.noChat);
    const runFailed = approved && r.chance(0.03);
    approval.status = willExpire ? 'expired' : approved ? (runFailed ? 'approved_run_failed' : 'approved') : 'rejected';
    approval.decidedAt = new Date(decidedAt).toISOString();
    approval.decidedBy = approver;
    approval.channel = channel;
    approval.decisionReason = willExpire ? 'No one decided within the expiry. Expiry is a refusal.' : approved
      ? r.pick(['Matches the PO and GRN.', 'Confirmed with the vendor by phone.', 'Within this month\'s budget.', 'Reviewed — fine.', 'Checked the change window with on-call.'])
      : r.pick(['Bank details changed last week — confirming by phone first.', 'Duplicate of an earlier payment.', 'Not on the approved vendor list.', 'Wrong environment.', 'Hold until month end.']);
    evs.push({
      at: decidedAt, order: order++,
      onSeq: (s) => (approval.resultSeq = s),
      build: () => ({
        ts: new Date(decidedAt).toISOString(), kind: 'approval', agent: agent.slug, tool: call.tool, ref_seq: approval.seq,
        approval: { id, status: approval.status, approver, channel, self_approval: false },
        decision: approved ? 'allow' : 'refuse', reason: approval.decisionReason,
        outcome: approved ? (advisory ? undefined : { status: runFailed ? 'error' : 'ok', ref: `${call.connector.split(' ')[0].toLowerCase()}:${r.int(100000, 999999)}`, ms: r.int(200, 1600) }) : { status: 'not_run' },
        actor: approver ?? 'system',
        details: { channel: channel ?? 'expiry', mode: advisory ? 'check_and_record' : 'governed_run' },
      }),
    });
  };

  // traffic
  for (const agent of cfg.agents) {
    const scen = SCENARIOS[agent.scenarioKey];
    const baseRate = (RATE[agent.scenarioKey] ?? 0.3) * (cfg.volume ?? 1);
    const born = cfg.createdAt[agent.slug] ?? start;
    for (let t = Math.max(start, born); t < cfg.now; t += H) {
      const rate = cfg.sparseBefore && t < cfg.sparseBefore.at ? baseRate * cfg.sparseBefore.factor : baseRate;
      const expected = rate * activity(t);
      let count = Math.floor(expected);
      if (r.next() < expected - count) count++;
      for (let i = 0; i < count; i++) {
        const at = t + Math.floor(r.next() * H);
        if (at >= cfg.now) continue;
        const sc = r.weighted(scen.map((s) => [s, s.weight] as const));
        pushCall(agent, at, sc.make(r, agent.slug));
      }
    }
  }
  for (const inj of cfg.injected ?? []) {
    const agent = cfg.agents.find((a) => a.slug === inj.agent);
    if (agent) pushCall(agent, inj.at, inj.call, inj.forcePending);
  }

  // admin receipts
  for (const a of cfg.admin) {
    if (a.at < start || a.at > cfg.now) continue;
    evs.push({ at: a.at, order: order++, build: () => ({ ts: new Date(a.at).toISOString(), kind: 'admin', actor: a.actor, action: a.action, agent: a.agent, details: a.details }) });
  }

  evs.sort((x, y) => x.at - y.at || x.order - y.order);

  // seal
  const receipts: Receipt[] = [];
  let prev = sha256Hex(`${cfg.orgId}:chain-before-window`);
  let seq = cfg.startSeq;
  for (const ev of evs) {
    // dependent receipts (approval → decision) are built after their parent has a seq
    ev.onSeq?.(seq);
    const key = [...cfg.keys].reverse().find((k) => ev.at >= k.from) ?? cfg.keys[0];
    const body = { seq, org: cfg.orgId, ...ev.build(seq), prev_hash: prev, kid: key.key.kid };
    const signed = signReceipt(body as Omit<Receipt, 'hash' | 'sig'>, key.key);
    receipts.push(signed);
    prev = signed.hash;
    seq++;
  }

  // hourly checkpoints, when the chain moved
  const checkpoints: Checkpoint[] = [];
  let idx = 0;
  let lastSeq = -1;
  const firstHour = Math.ceil(start / H) * H;
  for (let t = firstHour; t <= cfg.now; t += H) {
    while (idx < receipts.length && new Date(receipts[idx].ts).getTime() < t) idx++;
    const head = receipts[idx - 1];
    if (!head || head.seq === lastSeq) continue;
    lastSeq = head.seq;
    const key = [...cfg.keys].reverse().find((k) => t >= k.from) ?? cfg.keys[0];
    checkpoints.push(signCheckpoint({ id: `cp_${head.seq}`, org: cfg.orgId, seq: head.seq, hash: head.hash, ts: new Date(t).toISOString(), kid: key.key.kid }, key.key));
  }

  return { receipts, approvals, checkpoints };
}

export { H, D, GENESIS };
