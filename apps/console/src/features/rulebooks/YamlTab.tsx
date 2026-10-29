import { stringify } from 'yaml';
import { AlertTriangle, CheckCircle2, OctagonX, PencilRuler } from 'lucide-react';
import type { Rule } from '@/types';
import { cn } from '@/lib/cn';
import { useOrgLevel } from '@/store/session';
import { plural } from '@/lib/format';
import { Blocked, CopyButton, Panel } from '@/components/ui';
import { BUILDER_KEYS, type Problem } from './lib';
import type { Extras } from './yamlSync';
import { YamlEditor } from './YamlEditor';

export function YamlTab({ yaml, onChange, readOnly, readOnlyReason, problems, yamlOk, extras, rules, versionLabel }: {
  yaml: string; onChange: (v: string) => void; readOnly: boolean; readOnlyReason?: string; problems: Problem[]; yamlOk: boolean; extras: Extras; rules: Rule[]; versionLabel: string;
}) {
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided.
  const signedLevel = useOrgLevel() !== 'l1';
  const errors = problems.filter((p) => p.level === 'error');
  const warnings = problems.filter((p) => p.level === 'warning');
  // builder settings (escalation, minimum autonomy, pack lock) are shown by the builder, so they are not listed as edits
  const editedRules = Object.entries(extras.rules).map(([id, v]) => [id, Object.fromEntries(Object.entries(v).filter(([k]) => !BUILDER_KEYS.includes(k)))] as const).filter(([, v]) => Object.keys(v).length > 0);
  const showEdited = Object.keys(extras.top).length > 0 || editedRules.length > 0;
  return (
    <div className="grid gap-6 lg:grid-cols-12">
      <div className="lg:col-span-8 min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm" role="status" aria-live="polite">
            {yamlOk ? (
              <span className="inline-flex items-center gap-1.5 text-ok-fg"><CheckCircle2 className="h-4 w-4" aria-hidden />Valid — {plural(rules.length, 'rule')}, in sync with the builder</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-bad-fg"><OctagonX className="h-4 w-4" aria-hidden />{plural(errors.length, 'error')} — the builder shows the last valid version</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {readOnly && readOnlyReason && <Blocked>{readOnlyReason}</Blocked>}
            <CopyButton text={yaml} label="Copy YAML" />
          </div>
        </div>
        <div className={cn('border', yamlOk ? 'border-line' : 'border-bad/60')}>
          <div className="flex items-center justify-between gap-2 px-3 h-9 border-b border-line bg-sunken/60">
            <span className="label">rulebook.yaml · {versionLabel}</span>
            <span className="text-xs text-subtle hidden sm:inline">{readOnly ? 'Read only' : 'Edits sync to the builder as you type'}</span>
          </div>
          <YamlEditor value={yaml} onChange={readOnly ? undefined : onChange} readOnly={readOnly} label={`Rulebook YAML, ${versionLabel}`} />
        </div>
        {problems.length > 0 && (
          <ul className="border border-line bg-surface divide-y divide-line" aria-label="YAML problems">
            {[...errors, ...warnings].map((p, i) => (
              <li key={i} className="flex items-start gap-2.5 px-3 py-2 text-sm">
                {p.level === 'error' ? <OctagonX className="h-4 w-4 text-bad-fg mt-0.5 shrink-0" aria-label="Error" /> : <AlertTriangle className="h-4 w-4 text-held-fg mt-0.5 shrink-0" aria-label="Warning" />}
                {p.line && <span className="font-mono text-xs text-muted mt-0.5 w-14 shrink-0">line {p.line}</span>}
                <span>{p.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <aside className="lg:col-span-4 space-y-6 min-w-0">
        <Panel title="Rulebook YAML" kicker="Reference">
          <dl className="space-y-3 text-sm">
            <div><dt className="font-mono text-[12.5px] font-medium">default: refuse</dt><dd className="text-muted mt-0.5">Fixed. Anything no rule allows is refused.</dd></div>
            <div><dt className="font-mono text-[12.5px] font-medium">tool / tag</dt><dd className="text-muted mt-0.5">Each rule matches one tool name, or every tool carrying a risk tag. Never both.</dd></div>
            <div><dt className="font-mono text-[12.5px] font-medium">when / unless</dt><dd className="text-muted mt-0.5"><span className="font-mono">field: {'{op: value}'}</span> with eq, lt, lte, gt, gte, in, to_domain_in, fields_include. <span className="font-mono">unless</span> is for ask rules only.</dd></div>
            <div><dt className="font-mono text-[12.5px] font-medium">decide</dt><dd className="text-muted mt-0.5">allow, ask or refuse. Ask rules take approver, expires_in (max 30d) and approve_in_chat.</dd></div>
            <div><dt className="font-mono text-[12.5px] font-medium">quota</dt><dd className="text-muted mt-0.5"><span className="font-mono">max_count</span> or <span className="font-mono">max_sum</span> with <span className="font-mono">field</span>, and <span className="font-mono">per</span>: 30m, 1h, day or 7d.</dd></div>
            <div><dt className="font-mono text-[12.5px] font-medium">escalate_to / escalate_after</dt><dd className="text-muted mt-0.5">Ask rules: a backup approver group and when to re-route to it, such as 50% of the window or 2h. Re-routed once; a receipt names both groups.</dd></div>
            <div><dt className="font-mono text-[12.5px] font-medium">requires_autonomy</dt><dd className="text-muted mt-0.5">A0 to A3 (A4 and A5 are not yet available). The publish check warns when the agent's level for a tool this rule reaches is lower (earned autonomy by graduation, L3).</dd></div>
            <div><dt className="font-mono text-[12.5px] font-medium">lists</dt><dd className="text-muted mt-0.5">The organisation's named lists, such as approved_vendors. Edit them in the Rules tab; each change is a receipt.</dd></div>
          </dl>
        </Panel>
        {showEdited && (
          <Panel title="Edited in YAML" kicker="Kept as written" actions={<PencilRuler className="h-4 w-4 text-accent-fg" aria-hidden />}>
            <p className="text-sm text-muted mb-3">The builder cannot show these settings. They are kept exactly as written and {signedLevel ? 'signed' : 'sealed'} with the version; the decision step reads only the fields it knows.</p>
            <ul className="space-y-2">
              {Object.keys(extras.top).map((k) => <li key={k} className="text-sm"><span className="font-mono text-[12.5px]">{k}</span> <span className="text-muted">— top level</span></li>)}
              {editedRules.map(([id, v]) => <li key={id} className="text-sm"><span className="font-mono text-[12.5px]">{id}</span> <span className="text-muted">— {Object.keys(v).join(', ')}</span></li>)}
            </ul>
            {Object.keys(extras.top).length > 0 && <pre className="mt-3 text-[11.5px] font-mono bg-sunken/70 border border-line p-2 overflow-auto max-h-40">{stringify(extras.top, { lineWidth: 0 })}</pre>}
          </Panel>
        )}
      </aside>
    </div>
  );
}
