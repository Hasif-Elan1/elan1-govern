import { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { Hash as HashIcon, Bot, ArrowRight, Moon, Sun, Keyboard, FileDown, Plus, OctagonX, Sparkles, Inbox, BookCheck } from 'lucide-react';
import { useUi } from '@/store/ui';
import { useOrgId, useOrgLevel, useRole } from '@/store/session';
import { db } from '@/api';
import { NAV_FOOT, PERSONAL, canSeePath, doorItems, doorsFor } from './nav';
import { useResolvedDark } from './TopBar';
import { DecisionChip, Kbd } from '@/components/ui/core';
import { seqLabel, relative } from '@/lib/format';

/**
 * Command palette. Accepts a receipt number (#4097 or 4097) or a hash prefix and jumps to it.
 * It never runs a dangerous action directly — the emergency stop opens its confirmation dialog.
 */
export function CommandPalette({ onStop, stopIncidentId }: { onStop: () => void; stopIncidentId?: string }) {
  const { commandOpen, setCommandOpen, setTheme, theme, setShortcutsOpen, openAsk } = useUi();
  const dark = useResolvedDark(theme);
  const orgId = useOrgId();
  const role = useRole();
  const level = useOrgLevel();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  // the one rule (src/shell/nav.ts): records, approvals and rulebooks are offered only where the role can open them
  const see = (path: string) => canSeePath(path, role, level);
  const stopOn = stopIncidentId !== undefined;

  useEffect(() => { if (!commandOpen) setQ(''); }, [commandOpen]);

  const { receipts, agents, approvals, rulebooks } = useMemo(() => {
    if (!commandOpen) return { receipts: [], agents: [], approvals: [], rulebooks: [] };
    const d = db.getDB(orgId);
    const needle = q.trim().toLowerCase().replace(/^#/, '').replace(/[,\s]/g, '');
    const receipts = needle.length >= 2 ? d.receipts.filter((r) => String(r.seq) === needle || (needle.length >= 4 && r.hash.startsWith(needle))).slice(0, 5) : [];
    return { receipts, agents: d.agents, approvals: d.approvals.filter((a) => a.status === 'pending').slice(0, 5), rulebooks: d.rulebooks };
  }, [commandOpen, q, orgId]);

  const go = (to: string) => { setCommandOpen(false); nav(to); };

  if (!commandOpen) return null;
  return (
    <div className="fixed inset-0 z-[80] bg-ink-900/50 flex items-start justify-center pt-[12vh] px-4 animate-fade-in" onMouseDown={(e) => e.target === e.currentTarget && setCommandOpen(false)}>
      <Command label="Command palette" className="w-full max-w-[640px] bg-surface border border-line shadow-e4 animate-rise-in" loop onKeyDown={(e) => e.key === 'Escape' && setCommandOpen(false)}>
        <div className="flex items-center gap-3 px-4 border-b border-line">
          <Sparkles className="h-4 w-4 text-subtle" aria-hidden />
          <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Type a page, an agent, a receipt number like #4097, or a hash prefix…" className="h-14 flex-1 bg-transparent text-md outline-none placeholder:text-subtle" />
          <Kbd>Esc</Kbd>
        </div>
        <Command.List className="max-h-[420px] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-8 text-center text-sm text-muted">No match. Try a receipt number, an agent name or a page.</Command.Empty>

          {receipts.length > 0 && see('/activity') && (
            <Command.Group heading="Receipts">
              {receipts.map((r) => (
                <Item key={r.seq} value={`receipt ${r.seq} ${r.hash}`} keywords={[`#${r.seq}`, seqLabel(r.seq), String(r.seq), q.trim()]} onSelect={() => go(`/activity/${r.seq}`)} icon={<HashIcon className="h-4 w-4" />}>
                  <span className="font-mono">{seqLabel(r.seq)}</span>
                  <span className="text-muted truncate">{r.agent ?? r.action} · {r.tool ?? r.kind} · {relative(r.ts)}</span>
                  {r.decision && <span className="ml-auto"><DecisionChip decision={r.decision} size="sm" short /></span>}
                </Item>
              ))}
            </Command.Group>
          )}

          {approvals.length > 0 && see('/approvals') && (
            <Command.Group heading="Waiting for a decision">
              {approvals.map((a) => (
                <Item key={a.id} value={`approval ${a.headline}`} onSelect={() => go(`/approvals/${a.id}`)} icon={<Inbox className="h-4 w-4" />}>
                  <span className="truncate">{a.headline}</span>
                </Item>
              ))}
            </Command.Group>
          )}

          {doorsFor(role, level).map((door) => (
            <Command.Group key={door.key} heading={`0${door.number} ${door.label} — ${door.question}`}>
              {doorItems(door, role, level).map((n) => (
                <Item key={n.to} value={`go ${door.label} ${n.label}`} onSelect={() => go(n.to)} icon={<n.icon className="h-4 w-4" />}>
                  {n.label}
                  {n.shortcut && <span className="ml-auto flex gap-1"><Kbd>G</Kbd><Kbd>{n.shortcut.toUpperCase()}</Kbd></span>}
                </Item>
              ))}
            </Command.Group>
          ))}
          <Command.Group heading="Elsewhere">
            {[...PERSONAL, ...NAV_FOOT].map((n) => (
              <Item key={n.to} value={`go ${n.label}`} onSelect={() => go(n.to)} icon={<n.icon className="h-4 w-4" />}>{n.label}</Item>
            ))}
          </Command.Group>

          {see('/agents') && <Command.Group heading="Agents">
            {agents.map((a) => (
              <Item key={a.slug} value={`agent ${a.slug} ${a.name}`} onSelect={() => go(`/agents/${a.slug}`)} icon={<Bot className="h-4 w-4" />}>
                {a.slug}<span className="text-muted">{a.name}</span>
              </Item>
            ))}
          </Command.Group>}

          {rulebooks.length > 0 && see('/rulebooks') && (
            <Command.Group heading="Rulebooks">
              {rulebooks.map((rb) => (
                <Item key={rb.id} value={`rulebook ${rb.slug} ${rb.name}`} onSelect={() => go(`/rulebooks/${rb.slug}`)} icon={<BookCheck className="h-4 w-4" />}>
                  <span className="font-mono">{rb.slug}</span><span className="text-muted truncate">Rulebook · version {rb.currentVersion}</span>
                </Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading="Actions">
            {(role === 'owner' || role === 'admin') && <Item value="add agent new" onSelect={() => go('/agents/new')} icon={<Plus className="h-4 w-4" />}>Add an agent</Item>}
            {(role === 'owner' || role === 'admin' || role === 'auditor') && see('/evidence') && <Item value="export auditor pack evidence" onSelect={() => go('/evidence?export=1')} icon={<FileDown className="h-4 w-4" />}>Export an auditor pack</Item>}
            <Item value="verify receipt" onSelect={() => go('/verify')} icon={<ArrowRight className="h-4 w-4" />}>Verify a receipt or pack</Item>
            <Item value="ask govern explain" onSelect={() => { setCommandOpen(false); openAsk({ kind: 'general', title: 'Ask Govern' }); }} icon={<Sparkles className="h-4 w-4" />}>Ask Govern to explain something</Item>
            <Item value="theme dark light" onSelect={() => { setTheme(dark ? 'light' : 'dark'); setCommandOpen(false); }} icon={dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}>Switch to {dark ? 'light' : 'dark'} theme</Item>
            <Item value="keyboard shortcuts" onSelect={() => { setCommandOpen(false); setShortcutsOpen(true); }} icon={<Keyboard className="h-4 w-4" />}>Keyboard shortcuts</Item>
            {(role === 'owner' || role === 'admin') && (stopOn ? (
              <Item value="emergency stop is on lift incident" onSelect={() => go(stopIncidentId ? `/incidents/${stopIncidentId}` : '/incidents')} icon={<OctagonX className="h-4 w-4 text-bad" />}>
                Stop is on: open its incident to lift it<span className="ml-auto text-xs text-muted">only one stop at a time</span>
              </Item>
            ) : (
              <Item value="emergency stop" onSelect={() => { setCommandOpen(false); onStop(); }} icon={<OctagonX className="h-4 w-4 text-bad" />}>
                Emergency stop…<span className="ml-auto text-xs text-muted">opens a confirmation</span>
              </Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

function Item({ children, onSelect, value, icon, keywords }: { children: React.ReactNode; onSelect: () => void; value: string; icon: React.ReactNode; keywords?: string[] }) {
  return (
    <Command.Item value={value} keywords={keywords} onSelect={onSelect} className="flex items-center gap-3 h-10 px-3 text-sm cursor-pointer data-[selected=true]:bg-sunken data-[selected=true]:shadow-[inset_3px_0_0_rgb(var(--fg))]">
      <span className="text-muted shrink-0">{icon}</span>
      <span className="flex flex-1 items-center gap-2 min-w-0">{children}</span>
    </Command.Item>
  );
}
