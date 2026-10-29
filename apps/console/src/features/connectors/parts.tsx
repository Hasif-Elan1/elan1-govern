/** Shared pieces for connectors: status chip, mode badge, live 7-day usage, the risk-tag editor and URL checks. */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, CircleSlash, FlaskConical, Tags } from 'lucide-react';
import type { Agent, Connector, LevelId, RiskTag } from '@/types';
import { tagLabel, HIGH_IMPACT_TAGS } from '@/lib/format';
import { atLeast } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { Badge, Button, Checkbox, Dialog, StatusChip, Tooltip } from '@/components/ui';
import { decisionsSince, emptyMix, addDecision, type Mix } from '@/features/agents/parts';

export const ALL_TAGS: RiskTag[] = ['reads_data', 'writes_data', 'moves_money', 'sends_external', 'personal_data', 'deletes', 'changes_access', 'changes_production'];

/** What demo mode means, and how to leave it. */
export const DEMO_NOTE = 'Calls run against seeded demonstration data. Connect a live account to switch.';

export function ConnectorStatus({ c }: { c: Pick<Connector, 'status'> }) {
  switch (c.status) {
    case 'connected': return <StatusChip tone="ok" size="sm" icon={<CheckCircle2 className="h-3 w-3" />}>Connected</StatusChip>;
    case 'demo': return <StatusChip tone="info" size="sm" icon={<FlaskConical className="h-3 w-3" />}>Demo mode</StatusChip>;
    case 'error': return <StatusChip tone="bad" size="sm" icon={<AlertTriangle className="h-3 w-3" />}>Connection error</StatusChip>;
    default: return <StatusChip tone="neutral" size="sm" icon={<CircleSlash className="h-3 w-3" />}>Disconnected</StatusChip>;
  }
}

export function ModeBadge({ c }: { c: Pick<Connector, 'mode'> }) {
  return c.mode === 'demo'
    ? <Tooltip content={DEMO_NOTE}><Badge tone="info">Demo mode</Badge></Tooltip>
    : <Badge>Live</Badge>;
}

export const kindLabel = (c: Pick<Connector, 'kind' | 'id'>) => (c.kind === 'gmail' ? 'Built-in · Gmail' : c.kind === 'zoho_books' ? 'Built-in · Zoho Books' : c.id.startsWith('con_pack_') ? `Pack connector · ${c.id.slice('con_pack_'.length)}` : 'Your MCP server');

/** Where the credential is held and in which residency domain, for the organisation's deployment and level. */
export function custodyOf(level: LevelId, deployment: 'hosted' | 'sovereign' | undefined, residency: string | undefined, secretsBackend?: string) {
  if (deployment === 'sovereign') return { holder: `Your ${secretsBackend ?? 'OpenBao'} secrets store`, detail: `On your cluster · ${residency ?? 'your data centre'}. Elan1 Govern reads it at call time; nothing leaves your network.` };
  if (atLeast(level, 'l2')) return { holder: 'Elan1 Govern vault, keys in AWS KMS', detail: `Envelope-encrypted with a KMS key in the residency domain ${residency ?? 'ap-south-1 Mumbai'}.` };
  return { holder: 'Elan1 Govern vault', detail: `Encrypted at rest in ${residency ?? 'ap-south-1 Mumbai'}.` };
}

/** 7-day decisions per tool from the signed chain (live), plus which agents use each tool. */
export function usageByTool(orgId: string) {
  const m = new Map<string, Mix>();
  for (const r of decisionsSince(orgId, 7)) {
    if (!r.tool) continue;
    if (!m.has(r.tool)) m.set(r.tool, emptyMix());
    addDecision(m.get(r.tool)!, r.decision, r.ts);
  }
  return m;
}

export function agentsUsing(agents: Agent[] | undefined, tool: string) {
  return (agents ?? []).filter((a) => a.tools.includes(tool));
}

export function agentsOnConnector(agents: Agent[] | undefined, c: Connector) {
  const names = c.tools.map((t) => t.name);
  return (agents ?? []).filter((a) => a.connectorIds.includes(c.id) || a.tools.some((t) => names.includes(t)));
}

// URL checks live in ./urls (no React, so the connector operations can use them on the server)
export { hostAllowed, outsideNetwork, upstreamUrlProblem, checkUpstreamUrl, serverSlug, type UpstreamUrlOpts } from './urls';

/* ── Risk-tag editor (multi-select of the 8 tags, in a dialog so tables never clip it) ── */

export function TagEditor({ tool, value, suggested, onSave, disabled, disabledReason }: { tool: string; value: RiskTag[]; suggested?: RiskTag[]; onSave: (tags: RiskTag[]) => void; disabled?: boolean; disabledReason?: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RiskTag[]>(value);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => { if (open) setDraft(valueRef.current); }, [open]);
  const same = draft.length === value.length && draft.every((t) => value.includes(t));
  const trigger = (
    <Button size="sm" variant="ghost" icon={<Tags className="h-3.5 w-3.5" />} disabled={disabled} onClick={() => setOpen(true)} aria-haspopup="dialog">Edit tags</Button>
  );
  return (
    <>
      {disabled && disabledReason ? <Tooltip content={disabledReason}>{trigger}</Tooltip> : trigger}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title="Risk tags"
        description={<>For <span className="font-mono">{tool}</span>. Tag rules match these tags; the change is recorded.</>}
        footer={
          <>
            {suggested?.length ? <Button size="sm" variant="ghost" className="mr-auto" onClick={() => setDraft(Array.from(new Set([...draft, ...suggested])))}>Add suggested</Button> : null}
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={same} onClick={() => { onSave(draft); setOpen(false); }}>Save tags</Button>
          </>
        }
      >
        <div className="space-y-2.5">
          {ALL_TAGS.map((t) => (
            <div key={t} className="flex items-center justify-between gap-2">
              <Checkbox checked={draft.includes(t)} onChange={(v) => setDraft((d) => (v ? [...d, t] : d.filter((x) => x !== t)))} label={tagLabel[t]} />
              <span className="flex items-center gap-2">
                {suggested?.includes(t) && <span className="text-[10px] uppercase tracking-label text-info-fg">Suggested</span>}
                {HIGH_IMPACT_TAGS.includes(t) && <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-label text-accent-fg"><span className={cn('h-3 w-[3px] bg-accent')} aria-hidden />High-impact</span>}
              </span>
            </div>
          ))}
        </div>
      </Dialog>
    </>
  );
}

