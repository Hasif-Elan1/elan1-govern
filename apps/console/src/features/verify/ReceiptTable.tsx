import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '@/store/session';
import { ORGS } from '@/mock/users';
import { ChevronLeft, ChevronRight, ExternalLink, Flag } from 'lucide-react';
import { canonical, receiptHash, verifySig, type ReceiptCheck } from '@/lib/crypto';
import { LEVEL_INFO } from '@/lib/levels';
import { cn } from '@/lib/cn';
import { dateTime, n, seqLabel } from '@/lib/format';
import type { Checkpoint, LevelId, Receipt } from '@/types';
import { Banner, Button, CopyButton, DecisionChip, Drawer, IconButton, JsonView, Panel, SearchInput, Segmented, Badge } from '@/components/ui';
import { StateMark } from './ResultView';
import { fingerprintOf } from './bundle';

const PAGE = 50;
type Filter = 'all' | 'failing' | 'checkpoints';
export interface RowCheck extends ReceiptCheck { checkpoint?: 'pass' | 'fail' }

export const rowFailed = (r: RowCheck) => r.schema === 'fail' || r.hash === 'fail' || r.signature === 'fail' || r.link === 'fail' || r.key === 'fail';

/**
 * Every receipt with its per-check state. Paginated at 50 rows; the failing row is highlighted and
 * scrolled into view when a run finishes or when "Show in the table" is pressed.
 */
export function ReceiptTable({ checks, receipts: list, publicKeys, checkpoints, levels, brokenAt, focus, orgId }: {
  checks: ReceiptCheck[]; receipts: Receipt[]; publicKeys: Record<string, string>; checkpoints: Checkpoint[];
  levels: { level: LevelId; firstSeq: number; lastSeq: number }[]; brokenAt?: number; focus?: { seq: number; nonce: number }; orgId?: string;
}) {
  const receipts = useMemo(() => new Map(list.map((r) => [r.seq, r])), [list]);
  const rowsAll = useMemo<RowCheck[]>(() => {
    const cps = new Map<number, 'pass' | 'fail'>();
    for (const cp of checkpoints) {
      const pub = publicKeys[cp.kid];
      const r = receipts.get(cp.seq);
      const ok = !!pub && verifySig(canonical({ org: cp.org, seq: cp.seq, hash: cp.hash, ts: cp.ts, kid: cp.kid }), cp.sig, pub) && (!r || r.hash === cp.hash);
      cps.set(cp.seq, ok ? 'pass' : 'fail');
    }
    return checks.map((c) => ({ ...c, checkpoint: cps.get(c.seq) }));
  }, [checks, checkpoints, publicKeys, receipts]);
  const levelOf = (seq: number) => levels.find((l) => seq >= l.firstSeq && seq <= l.lastSeq)?.level;
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number>();
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const rows = useMemo(() => {
    const needle = q.trim().replace(/[#,\s]/g, '');
    return rowsAll.filter((r) => (filter === 'all' || (filter === 'failing' ? rowFailed(r) : r.checkpoint !== undefined)) && (!needle || String(r.seq).includes(needle)));
  }, [rowsAll, filter, q]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const counts = useMemo(() => ({ all: rowsAll.length, failing: rowsAll.filter(rowFailed).length, checkpoints: rowsAll.filter((r) => r.checkpoint !== undefined).length }), [rowsAll]);

  // the page is reset in the filter and search handlers, not in an effect: an effect on [filter, q] would also fire
  // after "Show #N in the table" clears them, and send the table back to page 1 past the row it is meant to show
  useEffect(() => {
    if (!focus) return;
    setFilter('all');
    setQ('');
    const idx = rowsAll.findIndex((r) => r.seq === focus.seq);
    if (idx < 0) return;
    setPage(Math.floor(idx / PAGE));
    const t = window.setTimeout(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>(`[data-seq="${focus.seq}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(t);
  }, [focus, rowsAll]);

  const sel = open !== undefined ? receipts.get(open) : undefined;
  const selRow = open !== undefined ? rowsAll.find((r) => r.seq === open) : undefined;
  const prev = open !== undefined ? receipts.get(open - 1) : undefined;

  return (
    <Panel title="Receipts" kicker={`${n(rowsAll.length)} checked one by one`} flush actions={<span className="hidden sm:inline text-xs text-muted">Select a row to see its hashes</span>}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <Segmented<Filter> size="sm" label="Show receipts" value={filter} onChange={(v) => { setFilter(v); setPage(0); }} options={[
          { value: 'all', label: 'All', count: counts.all },
          { value: 'failing', label: 'Failing', count: counts.failing },
          { value: 'checkpoints', label: 'Checkpoint heads', count: counts.checkpoints },
        ]} />
        <div className="w-full sm:w-56 sm:ml-auto">
          <SearchInput value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }}placeholder="Find a sequence number" aria-label="Find a sequence number" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Receipts and the result of each check</caption>
          <thead className="bg-sunken/80">
            <tr className="border-b border-line">
              <th scope="col" className="h-9 px-3 text-left label">Seq</th>
              <th scope="col" className="h-9 px-3 text-left label hidden md:table-cell">Time</th>
              <th scope="col" className="h-9 px-3 text-left label hidden sm:table-cell">What</th>
              <th scope="col" className="h-9 px-2 text-left label hidden lg:table-cell">Level</th>
              <th scope="col" className="h-9 px-2 text-center label" title="Content hash">Hash</th>
              <th scope="col" className="h-9 px-2 text-center label" title="Ed25519 over the hash: the L1 seal, a signature from L2">Sig</th>
              <th scope="col" className="h-9 px-2 text-center label" title="Key valid when the receipt was written">Key</th>
              <th scope="col" className="h-9 px-2 text-center label" title="Previous-hash link">Link</th>
              <th scope="col" className="h-9 px-2 text-center label hidden sm:table-cell" title="Checkpoint at this receipt">Cp</th>
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {shown.map((row) => {
              const r = receipts.get(row.seq);
              const bad = rowFailed(row);
              const first = brokenAt === row.seq;
              const lv = levelOf(row.seq);
              return (
                <tr key={row.seq} data-seq={row.seq} tabIndex={0} onClick={() => setOpen(row.seq)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setOpen(row.seq);
                    if (e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus(); }
                    if (e.key === 'ArrowUp') { e.preventDefault(); (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus(); }
                  }}
                  aria-label={`Receipt ${seqLabel(row.seq)}${bad ? ', fails a check' : ''}`}
                  className={cn('h-11 border-b border-line last:border-b-0 cursor-pointer transition-colors focus:outline-none focus-visible:shadow-[inset_3px_0_0_rgb(var(--fg))]', bad ? 'bg-bad-bg/70 hover:bg-bad-bg' : 'hover:bg-sunken/60', first && 'shadow-[inset_4px_0_0_rgb(var(--bad))]')}>
                  <td className="px-3 whitespace-nowrap"><span className="inline-flex items-center gap-1.5 font-mono text-[12.5px]">{first && <Flag className="h-3.5 w-3.5 text-bad-fg" aria-label="First break" />}{seqLabel(row.seq)}</span></td>
                  <td className="px-3 hidden md:table-cell whitespace-nowrap text-muted num">{r?.ts ? dateTime(r.ts) : '—'}</td>
                  <td className="px-3 hidden sm:table-cell min-w-0">
                    <span className="flex items-center gap-2 min-w-0">
                      <Badge>{r?.kind ?? '—'}</Badge>
                      <span className="truncate max-w-[240px] text-fg/90">{subject(r)}</span>
                      {r?.decision && <span className="hidden xl:inline-flex"><DecisionChip decision={r.decision} size="sm" short /></span>}
                    </span>
                  </td>
                  <td className="px-2 hidden lg:table-cell">{lv ? <Badge tone={lv === 'l1' ? 'neutral' : 'info'}>{LEVEL_INFO[lv].tag}</Badge> : null}</td>
                  <td className="px-2 text-center"><StateMark size="sm" state={row.hash} label="Content hash" /></td>
                  <td className="px-2 text-center"><StateMark size="sm" state={row.signature} label={lv && lv !== 'l1' ? 'Signature' : 'Seal'} /></td>
                  <td className="px-2 text-center"><StateMark size="sm" state={row.key} label="Key" /></td>
                  <td className="px-2 text-center"><StateMark size="sm" state={row.link} label="Link" /></td>
                  <td className="px-2 text-center hidden sm:table-cell">{row.checkpoint ? <StateMark size="sm" state={row.checkpoint} label="Checkpoint" /> : <span className="text-subtle text-xs" aria-label="No checkpoint here">·</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!shown.length && <p className="px-5 py-10 text-center text-sm text-muted">{filter === 'failing' ? 'No receipt fails a check.' : 'No receipt matches that sequence number.'}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-2.5 text-sm text-muted">
        <span className="num">{rows.length ? `${n(page * PAGE + 1)}–${n(Math.min(rows.length, (page + 1) * PAGE))} of ${n(rows.length)}` : '0 rows'}</span>
        <span className="flex items-center gap-1">
          <IconButton label="Previous page" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></IconButton>
          <span className="num px-1">Page {page + 1} of {pages}</span>
          <IconButton label="Next page" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></IconButton>
        </span>
      </div>

      <Drawer open={!!sel} onClose={() => setOpen(undefined)} kicker="Receipt" title={sel ? seqLabel(sel.seq) : ''} width={620} footer={<Button variant="secondary" onClick={() => setOpen(undefined)}>Close</Button>}>
        {sel && selRow && <ReceiptDetail r={sel} row={selRow} prev={prev} pub={publicKeys[sel.kid]} level={levelOf(sel.seq)} orgId={orgId} />}
      </Drawer>
    </Panel>
  );
}

function subject(r?: Receipt) {
  if (!r) return '—';
  if (r.kind === 'admin') return r.action ?? 'admin';
  return [r.agent, r.tool].filter(Boolean).join(' · ') || r.kind;
}

function ReceiptDetail({ r, row, prev, pub, level, orgId }: { r: Receipt; row: RowCheck; prev?: Receipt; pub?: string; level?: LevelId; orgId?: string }) {
  const recomputed = (() => { try { return receiptHash(r); } catch { return 'could not be computed'; } })();
  // L1 records are "sealed in a hash chain", never "signed", until DR-017 is decided. L2 and above keep "signed".
  const signedLevel = !!level && level !== 'l1';
  const sealed = signedLevel ? 'signed' : 'sealed';
  const lines: { label: string; state: RowCheck['hash']; detail: string }[] = [
    { label: 'Content hash', state: row.hash, detail: r.redacted
      ? (row.hash === 'pass' ? `An erasure removed ${r.redacted.fields.join(', ')}, so the hash cannot be recomputed. The organisation’s redaction ${signedLevel ? 'signature' : 'seal'} (${r.redacted.kid ?? 'no key named'}) over every remaining field and the original hash verifies.` : `The erased receipt does not match its redaction ${signedLevel ? 'signature' : 'seal'}: a field was changed after the erasure.`)
      : row.hash === 'pass' ? 'The recomputed hash equals the stored hash.' : `The recomputed hash differs from the stored hash: this receipt was changed after it was ${sealed}.` },
    { label: signedLevel ? 'Signature' : 'Seal (Ed25519)', state: row.signature, detail: row.signature === 'pass' ? `Verifies against ${r.kid}.` : row.signature === 'fail' ? `Does not verify against ${r.kid}.` : 'Not checked: no key for this receipt.' },
    { label: `Key valid when ${sealed}`, state: row.key, detail: row.key === 'pass' ? `${r.kid} is in the bundle.` : `No public key for ${r.kid}.` },
    { label: 'Previous-hash link', state: row.link, detail: row.link === 'pass' ? (prev ? `prev_hash equals the hash of ${seqLabel(prev.seq)}.` : 'First receipt in this file; the link before it is outside the range.') : `prev_hash does not equal the hash of ${seqLabel(r.seq - 1)}, or the sequence has a gap.` },
  ];
  if (row.checkpoint) lines.push({ label: 'Checkpoint', state: row.checkpoint, detail: row.checkpoint === 'pass' ? 'A checkpoint names this receipt as the chain head, and its hash matches.' : 'A checkpoint names this receipt but does not verify or does not match.' });
  return (
    <div className="space-y-6">
      {row.hash === 'fail' && <Banner tone="bad" title={signedLevel ? 'Changed after signing' : 'Changed after sealing'}>{r.redacted ? `The organisation’s key ${sealed} this receipt as it was left by the erasure; it no longer matches.` : `The stored hash was ${sealed}; the content no longer produces it. Compare the two hashes below.`}</Banner>}
      {level && <p className="text-sm text-muted">Made at <span className="text-fg font-medium">{LEVEL_INFO[level].label}</span>{level === 'l1' ? ' — sealed in a hash chain by Elan1 Govern; no Seal v6 record and not yet externally timestamped.' : ' — signed, sealed with Seal v6 and placed in a timestamped batch.'}</p>}
      <ul className="divide-y divide-line border border-line">
        {lines.map((l) => (
          <li key={l.label} className="flex items-start gap-3 px-4 py-3">
            <StateMark state={l.state} label={l.label} />
            <div><p className="text-sm font-semibold">{l.label}</p><p className="text-sm text-muted">{l.detail}</p></div>
          </li>
        ))}
      </ul>
      <dl className="grid gap-3 text-sm">
        <HashRow label="Stored hash" value={r.hash} />
        {r.redacted ? <HashRow label="Recomputed hash" value="not recomputable: values removed by erasure" /> : <HashRow label="Recomputed hash" value={recomputed} bad={recomputed !== r.hash} />}
        <HashRow label="prev_hash" value={r.prev_hash} />
        {prev && <HashRow label={`Hash of ${seqLabel(prev.seq)}`} value={prev.hash} bad={prev.hash !== r.prev_hash} />}
        <div className="flex items-baseline justify-between gap-4 border-b border-line pb-2">
          <dt className="text-muted">Key</dt>
          <dd className="text-right font-mono text-[12.5px]">{r.kid}{pub ? <span className="text-muted"> · {fingerprintOf(pub)}</span> : ''}</dd>
        </div>
      </dl>
      <div>
        <p className="label mb-2">The receipt as {sealed}</p>
        <JsonView value={r} maxHeight={360} />
      </div>
      {orgId && <OpenInConsole orgId={orgId} seq={r.seq} />}
    </div>
  );
}

/**
 * 'Open it in the console' for a receipt from a demonstration organisation. A receipt number only means
 * something inside its own organisation, so the link opens that organisation: directly when it is the one
 * signed in, after switching when the person is a member of it, and never as the same number elsewhere.
 */
function OpenInConsole({ orgId, seq }: { orgId: string; seq: number }) {
  const nav = useNavigate();
  const { user, orgId: sessionOrg, switchOrg } = useSession();
  const orgName = ORGS.find((o) => o.id === orgId)?.name ?? 'its organisation';
  const to = `/activity/${seq}?org=${encodeURIComponent(orgId)}`;
  if (user && sessionOrg === orgId) {
    return (
      <p className="text-sm text-muted">
        This receipt comes from {orgName}, the organisation you are signed in to.{' '}
        <Link to={to} className="link inline-flex items-center gap-1">Open it in the console <ExternalLink className="h-3 w-3" aria-hidden /></Link>
      </p>
    );
  }
  if (user && user.orgIds.includes(orgId)) {
    return (
      <p className="text-sm text-muted">
        This receipt comes from {orgName}. You are signed in to another organisation.{' '}
        <button type="button" className="link inline-flex items-center gap-1" onClick={() => { switchOrg(orgId); nav(to); }}>Switch to {orgName} and open it <ExternalLink className="h-3 w-3" aria-hidden /></button>
      </p>
    );
  }
  if (user) {
    return <p className="text-sm text-muted">This receipt comes from {orgName}. You are not a member of it, so it cannot be opened in your console; the checks above are the whole of what this page can show.</p>;
  }
  return (
    <p className="text-sm text-muted">
      This receipt comes from a demonstration organisation, {orgName}.{' '}
      <Link to={`/login?next=${encodeURIComponent(to)}`} className="link inline-flex items-center gap-1">Sign in to {orgName} to open it <ExternalLink className="h-3 w-3" aria-hidden /></Link>
    </p>
  );
}

function HashRow({ label, value, bad }: { label: string; value?: string; bad?: boolean }) {
  return (
    <div className="flex flex-col gap-1 border-b border-line pb-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className={cn('shrink-0', bad ? 'text-bad-fg font-medium' : 'text-muted')}>{label}</dt>
      <dd className={cn('min-w-0 flex items-start gap-1 font-mono text-[12px] sm:justify-end', bad && 'text-bad-fg')}>
        <span className="break-all">{value ?? '—'}</span>
        {value && <CopyButton text={value} compact label={`Copy ${label}`} />}
      </dd>
    </div>
  );
}
