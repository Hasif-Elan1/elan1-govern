import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Ban, Eye, History, MoreHorizontal } from 'lucide-react';
import { WithdrawVersionDialog, WithdrawnChip } from '@/features/records/declarations';
import type { Rule, Rulebook, RulebookVersion } from '@/types';
import { Button, DataTable, Field, Hash, IconButton, Menu, Panel, Select, Switch, type Column } from '@/components/ui';
import { Person, When } from '@/components/domain';
import { useOrgLevel } from '@/store/session';
import { diffSummary, publishedOf, semDiff } from './lib';
import { SemanticDiffList, VersionStatus } from './parts';
import { LineDiff } from './LineDiff';

type Key = string; // version number as string, or 'working'

export function VersionsTab({ rb, working, draftVersionNo, canEdit, onRestore, onView }: {
  rb: Rulebook; working: { yaml: string; rules: Rule[]; dirty: boolean }; draftVersionNo: number; canEdit: boolean;
  onRestore: (v: RulebookVersion) => void; onView: (v: number) => void;
}) {
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided: an L1 version is "published".
  const sl = useOrgLevel() !== 'l1';
  const versions = useMemo(() => rb.versions.slice().sort((a, b) => b.version - a.version), [rb.versions]);
  const published = publishedOf(rb);
  const draft = versions.find((v) => v.status !== 'published');

  const defaults = (): [Key, Key] => {
    if (working.dirty) return [String(published?.version ?? versions[0].version), 'working'];
    if (draft && published) return [String(published.version), String(draft.version)];
    const pubs = versions.filter((v) => v.status === 'published');
    return pubs.length > 1 ? [String(pubs[1].version), String(pubs[0].version)] : [String(versions[0].version), String(versions[0].version)];
  };
  const [[left, right], setPair] = useState<[Key, Key]>(defaults);
  const [showAll, setShowAll] = useState(false);
  // withdrawing a declaration version (records area, features/records/declarations.tsx)
  const [withdrawV, setWithdrawV] = useState<number>();
  // keep the comparison valid as versions are saved and published
  useEffect(() => {
    const valid = (k: Key) => k === 'working' ? working.dirty : versions.some((v) => String(v.version) === k);
    if (!valid(left) || !valid(right)) setPair(defaults());
  }, [versions, working.dirty]);

  const resolve = (k: Key): { label: string; yaml: string; rules: Rule[] } => {
    if (k === 'working') return { label: `Working copy of v${draftVersionNo} (unsaved)`, yaml: working.yaml, rules: working.rules };
    const v = versions.find((x) => String(x.version) === k)!;
    return { label: `v${v.version} · ${v.status === 'published' ? 'published' : v.status === 'in_review' ? 'in review' : 'draft'}`, yaml: v.yaml, rules: v.rules };
  };
  const L = resolve(left);
  const R = resolve(right);
  const sem = semDiff(L.rules, R.rules);

  const options = [
    ...(working.dirty ? [{ value: 'working', label: `Working copy of v${draftVersionNo} (unsaved)` }] : []),
    ...versions.map((v) => ({ value: String(v.version), label: `v${v.version} — ${v.status === 'published' ? (v.version === rb.currentVersion ? 'published, live' : 'published') : v.status === 'in_review' ? 'in review' : 'draft'} — ${v.note}` })),
  ];

  const columns: Column<RulebookVersion>[] = [
    {
      key: 'v', header: 'Version', sort: (v) => v.version, width: 150,
      cell: (v) => (
        <span className="flex items-center gap-2">
          <span className="font-mono font-semibold">v{v.version}</span>
          {v.withdrawn ? <WithdrawnChip at={v.withdrawn.at} /> : v.version === rb.currentVersion ? <VersionStatus status="published" /> : v.status !== 'published' ? <VersionStatus status={v.status} /> : <span className="text-xs text-subtle">superseded</span>}
        </span>
      ),
    },
    { key: 'note', header: 'Note', cell: (v) => <span className="text-sm line-clamp-2 min-w-[160px]">{v.note}</span> },
    { key: 'by', header: 'Created by', cell: (v) => <span className="flex flex-col gap-0.5"><Person id={v.createdBy} size={20} /><When iso={v.createdAt} className="text-xs text-muted" /></span>, hideBelow: 'md' },
    { key: 'signed', header: sl ? 'Signed by' : 'Published by', cell: (v) => v.signedBy ? <span className="flex flex-col gap-0.5"><Person id={v.signedBy} size={20} /><When iso={v.signedAt} className="text-xs text-muted" /></span> : <span className="text-xs text-subtle">{sl ? 'Not signed' : 'Not published'}</span>, hideBelow: 'lg' },
    { key: 'rev', header: 'Reviewed by', cell: (v) => v.reviewedBy ? <Person id={v.reviewedBy} size={20} /> : <span className="text-xs text-subtle">{v.status === 'published' ? 'No review recorded' : '—'}</span>, hideBelow: 'lg' },
    { key: 'hash', header: 'Hash', cell: (v) => <Hash value={v.hash} len={10} />, hideBelow: 'sm' },
    {
      key: 'act', header: <span className="sr-only">Actions</span>, align: 'right', width: 52,
      cell: (v) => (
        <span className="inline-flex" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Menu width={240} trigger={({ toggle }) => <IconButton size="sm" label={`Actions for version ${v.version}`} onClick={toggle}><MoreHorizontal className="h-4 w-4" /></IconButton>} items={[
          { label: 'Read this version', icon: <Eye className="h-4 w-4" />, onSelect: () => onView(v.version) },
          { label: 'Compare with the live version', icon: <ArrowLeftRight className="h-4 w-4" />, disabled: v.version === rb.currentVersion, onSelect: () => setPair([String(rb.currentVersion), String(v.version)].sort((a, b) => Number(a) - Number(b)) as [Key, Key]) },
          // editing actions only for roles that edit rulebooks (hidden, not greyed out, for everyone else)
          ...(canEdit ? [
            { label: 'Copy into the draft', icon: <History className="h-4 w-4" />, disabled: v.status !== 'published' || !!v.withdrawn, hint: v.withdrawn ? 'Withdrawn' : undefined, onSelect: () => onRestore(v) },
            { label: 'Withdraw this version', icon: <Ban className="h-4 w-4" />, disabled: v.status !== 'published' || !!v.withdrawn, hint: v.withdrawn ? 'Already withdrawn' : undefined, onSelect: () => setWithdrawV(v.version) },
          ] : []),
        ]} />
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <DataTable columns={columns} rows={versions} rowKey={(v) => v.version} caption="Rulebook versions" onRowClick={(v) => onView(v.version)} selectedKey={rb.currentVersion} />
      <p className="text-xs text-muted -mt-3">Every published version is kept and {sl ? 'signed' : 'sealed'}. Rolling back means copying an earlier version into the draft and publishing it as a new version — history is never rewritten. A withdrawn version stays listed, but no call made after its withdrawal uses it.</p>
      {withdrawV !== undefined && <WithdrawVersionDialog rb={rb} version={withdrawV} onClose={() => setWithdrawV(undefined)} />}

      <Panel title="Compare 2 versions" kicker="Diff"
        actions={<span className="flex items-center gap-2 text-xs text-muted">All lines <Switch label="Show all lines" checked={showAll} onChange={setShowAll} showState={false} /></span>}>
        <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] items-end">
          <Field label="Before" htmlFor="cmp-left"><Select id="cmp-left" value={left} onChange={(e) => setPair([e.target.value, right])}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
          <Button variant="ghost" size="md" icon={<ArrowLeftRight className="h-4 w-4" />} aria-label="Swap" onClick={() => setPair([right, left])} className="justify-self-start">Swap</Button>
          <Field label="After" htmlFor="cmp-right"><Select id="cmp-right" value={right} onChange={(e) => setPair([left, e.target.value])}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-4 min-w-0">
            <p className="label mb-1">What changes</p>
            <p className="font-display text-xl font-semibold mb-3">{left === right ? 'Same version on both sides' : diffSummary(sem)}</p>
            <SemanticDiffList before={L.rules} after={R.rules} emptyText={left === right ? 'Choose two different versions.' : 'No rule changes. Wording, comments or lists may differ — see the line diff.'} />
          </div>
          <div className="lg:col-span-8 min-w-0">
            <LineDiff before={L.yaml} after={R.yaml} leftLabel={L.label} rightLabel={R.label} showAll={showAll} />
          </div>
        </div>
      </Panel>
    </div>
  );
}
