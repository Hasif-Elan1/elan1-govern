import { useMemo, useState } from 'react';
import { ArrowRight, FlaskConical, RefreshCw, AlertTriangle } from 'lucide-react';
import type { Decision, Rule } from '@/types';
import { api } from '@/api';
import type { ReplayResult } from '@/lib/evaluate';
import { useOrgId, useOrgLevel } from '@/store/session';
import { useQuery } from '@/hooks/useQuery';
import { orgApi } from '@/features/settings/orgApi';
import { n, relative } from '@/lib/format';
import { Banner, Button, DataTable, EmptyState, Panel, Segmented, Skeleton, type Column } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { replayHeadline } from './lib';
import { OutcomeChip, SemanticDiffList } from './parts';
import { SmartLink } from '@/shell/access';

export interface TestRun { days: 7 | 30; result: ReplayResult; key: string; at: number }

/** true when the organisation's replay store is switched off (Settings › Data), so Test on past actions cannot run. */
export function useReplayOff(): boolean {
  const q = useQuery(async (o) => orgApi.replayOn(o), [], { kinds: ['settings'] });
  return q.data === false;
}

type Changed = ReplayResult['changed'][number];
type Filter = 'all' | 'moreRefused' | 'moreAsk' | 'fewerAsk' | 'moreAllow';

const CAP = 200;

export function TestTab({ slug, rules, rulesKey, publishedRules, publishedVersion, draftVersionNo, run, onRun }: {
  slug: string; rules: Rule[]; rulesKey: string; publishedRules?: Rule[]; publishedVersion?: number; draftVersionNo: number;
  run?: TestRun; onRun: (r: TestRun) => void;
}) {
  const orgId = useOrgId();
  // L1 copy says "sealed in a hash chain", never "signed", until DR-017 is decided: an L1 version is "published".
  const sl = useOrgLevel() !== 'l1';
  const [days, setDays] = useState<7 | 30>(run?.days ?? 30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<Filter>('all');
  const stale = run && run.key !== rulesKey;
  // with the replay store off there are no stored arguments: Test is disabled, and publishing records that no test was possible
  const replayOff = useReplayOff();

  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.testOnPast(orgId, slug, rules, days);
      onRun({ days, result, key: rulesKey, at: Date.now() });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo(() => {
    if (!run) return [];
    const f: Record<Filter, (c: Changed) => boolean> = {
      all: () => true,
      moreRefused: (c) => c.to === 'refuse',
      moreAsk: (c) => c.to === 'ask',
      fewerAsk: (c) => c.from === 'ask',
      moreAllow: (c) => c.to === 'allow',
    };
    return run.result.changed.filter(f[filter]).slice().reverse();
  }, [run, filter]);

  const columns: Column<Changed>[] = [
    { key: 'seq', header: 'Receipt', cell: (r) => <ReceiptLink seq={r.seq} />, sort: (r) => r.seq, width: 100 },
    { key: 'ts', header: 'When', cell: (r) => <When iso={r.ts} className="text-muted" />, sort: (r) => r.ts, hideBelow: 'md', width: 130 },
    { key: 'tool', header: 'Tool', cell: (r) => <span className="font-mono text-[12.5px] break-all">{r.tool}</span>, sort: (r) => r.tool },
    {
      key: 'change', header: 'Decision', cell: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <OutcomeChip decision={r.from} />
          <ArrowRight className="h-3.5 w-3.5 text-muted" aria-label="would become" />
          <OutcomeChip decision={r.to} />
        </span>
      ),
    },
    { key: 'rule', header: 'Rule', cell: (r) => <span className="font-mono text-[12px] text-muted whitespace-nowrap">{r.ruleFrom ?? '—'} → <span className="text-fg">{r.ruleTo}</span></span>, hideBelow: 'lg' },
  ];

  const c = run?.result.counts;
  const tiles: { key: Filter; label: string; value: number; to?: Decision }[] = c ? [
    { key: 'moreRefused', label: 'More refused', value: c.moreRefused, to: 'refuse' },
    { key: 'moreAsk', label: 'More ask a person', value: c.moreAsk, to: 'ask' },
    { key: 'fewerAsk', label: 'Fewer ask a person', value: c.fewerAsk },
    { key: 'moreAllow', label: 'More allowed', value: c.moreAllow, to: 'allow' },
  ] : [];

  return (
    <div className="space-y-6">
      <Panel>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 max-w-[72ch]">
            <p className="label mb-1">Test on past actions</p>
            <h2 className="text-xl font-semibold">Re-decide real calls under draft v{draftVersionNo}</h2>
            <p className="mt-1 text-sm text-muted">Each past decision by <span className="font-mono">{slug}</span> is decided again with the draft rules and compared with what was decided at the time. Nothing runs, nothing is {sl ? 'signed' : 'published'} and no receipt is written.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented label="Window" value={String(days) as '7' | '30'} onChange={(v) => setDays(Number(v) as 7 | 30)} options={[{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }]} />
            <Button variant="primary" icon={run ? <RefreshCw className="h-4 w-4" /> : <FlaskConical className="h-4 w-4" />} loading={busy} disabled={replayOff} title={replayOff ? 'The replay store is off, so there is nothing to replay.' : undefined} onClick={go}>{run ? 'Run again' : 'Run the test'}</Button>
          </div>
        </div>
      </Panel>

      {replayOff && (
        <Banner tone="neutral" title="Test on past actions is off: the replay store is switched off" actions={<SmartLink to="/assurance/exports?tab=data" hideWhenBlocked className="text-sm underline underline-offset-2">Data and retention</SmartLink>}>
          No past arguments are kept, so no call can be decided again. You can still send the draft for review and {sl ? 'sign and publish' : 'publish'} it: the {sl ? 'signed' : 'published'} version’s receipt records that no replay test was possible. An owner or admin can switch the store on; calls made after that can be tested.
        </Banner>
      )}
      {error && !replayOff && <Banner tone="bad" title="The test did not run">{error}</Banner>}
      {stale && !busy && (
        <Banner tone="held" title="The rules changed after this test" actions={<Button size="sm" variant="secondary" onClick={go}>Run again</Button>}>
          These results describe an earlier version of the draft. Publishing needs a test of the rules as they are now.
        </Banner>
      )}

      {busy && !run && (
        <div className="grid gap-px bg-line border border-line sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-surface p-5"><Skeleton className="h-3 w-24" /><Skeleton className="h-8 w-16 mt-3" /></div>)}</div>
      )}

      {!run && !busy && !replayOff && (
        <div className="border border-line bg-surface">
          <EmptyState title="No test yet for this draft" disc="trail" action={<Button variant="primary" icon={<FlaskConical className="h-4 w-4" />} onClick={go}>Run the test</Button>}>
            A test is required before a version can be {sl ? 'signed and published' : 'published'}. It covers the most recent calls in the window you choose and lists up to {CAP} that would change.
          </EmptyState>
        </div>
      )}

      {run && (
        <>
          <section aria-live="polite" className={stale ? 'opacity-60' : undefined}>
            <div className="border border-line bg-surface px-5 py-5">
              <p className="label mb-2">Result · last {run.days} days · run {relative(new Date(run.at).toISOString())}</p>
              <p className="font-display text-2xl font-semibold tracking-tightish leading-snug max-w-[60ch]">{replayHeadline(run.result)}</p>
              <p className="mt-2 text-sm text-muted">{n(run.result.judged)} of {n(run.result.total)} calls judged. A call cannot be judged when its receipt does not carry the arguments a rule reads.</p>
            </div>
            <div className="grid gap-px bg-line border-x border-b border-line grid-cols-2 lg:grid-cols-5">
              {tiles.map((t) => (
                <button key={t.key} type="button" onClick={() => setFilter(filter === t.key ? 'all' : t.key)} aria-pressed={filter === t.key}
                  className={`text-left bg-surface p-4 hover:bg-sunken/60 transition-colors ${filter === t.key ? 'shadow-[inset_0_-2px_0_rgb(var(--fg))]' : ''}`}>
                  <p className="label">{t.label}</p>
                  <p className="mt-1 font-display text-3xl font-semibold num">{n(t.value)}</p>
                </button>
              ))}
              <div className="bg-surface p-4 col-span-2 lg:col-span-1">
                <p className="label">Could not be judged</p>
                <p className="mt-1 font-display text-3xl font-semibold num">{n(run.result.unjudged)}</p>
              </div>
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-12">
            <div className="lg:col-span-8 min-w-0 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-lg font-semibold">Calls that would change</h3>
                <span className="text-sm text-muted num">{rows.length > CAP ? `Showing the latest ${CAP} of ${n(rows.length)}` : `${n(rows.length)} ${rows.length === 1 ? 'call' : 'calls'}`}{filter !== 'all' && <> · <button className="link" onClick={() => setFilter('all')}>show all</button></>}</span>
              </div>
              <DataTable columns={columns} rows={rows.slice(0, CAP)} rowKey={(r) => r.seq} maxHeight={520} caption="Past calls whose decision would change under the draft"
                empty={<EmptyState compact disc="aperture" title={filter === 'all' ? 'No call would change' : 'None of this kind'}>{filter === 'all' ? 'Every judged call would be decided the same way under the draft.' : 'Choose another count above to see those calls.'}</EmptyState>} />
            </div>
            <div className="lg:col-span-4 space-y-6 min-w-0">
              <Panel title={`Draft v${draftVersionNo} against published v${publishedVersion ?? '—'}`} kicker="Semantic diff">
                {publishedRules ? <SemanticDiffList before={publishedRules} after={rules} emptyText="The draft makes no rule changes." /> : <p className="text-sm text-muted">No published version to compare with.</p>}
              </Panel>
              {run.result.counts.moreAllow > 0 && (
                <Banner tone="neutral" title={`${n(run.result.counts.moreAllow)} past calls would now run without a person`}>
                  <span className="inline-flex items-start gap-1.5"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />Read them before publishing. A person still {sl ? 'signs and publishes' : 'publishes'} the version; nothing changes on its own.</span>
                </Banner>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
