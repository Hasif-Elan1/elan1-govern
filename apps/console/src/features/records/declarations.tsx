/**
 * Withdrawing a rulebook version (Records › Declarations, rulebook tab, and the rulebook's Versions tab). The agent
 * declaration decl.<agent> and pack declarations decl.<pack> are withdrawn through mock/recordsDecl.ts on the same
 * page. A withdrawn version stays in the history but
 * no call made after the withdrawal uses it; when it was the version in force, the newest version not withdrawn
 * takes over. Recorded as rulebook.version_withdrawn.
 */
import { useState } from 'react';
import { Ban } from 'lucide-react';
import type { Rulebook } from '@/types';
import { api } from '@/api';
import { useOrgId, useOrgLevel, useUser } from '@/store/session';
import { fallbackFor } from '@/mock/records';
import { rulebookAt } from '@/mock/chain';
import { date } from '@/lib/format';
import { Banner, Button, Dialog, Field, StatusChip, Textarea, toast } from '@/components/ui';
import { SemanticDiffList } from '@/features/rulebooks/parts';
import { diffSummary, semDiff } from '@/features/rulebooks/lib';
import { userName } from '@/mock/users';

/** A small chip for a withdrawn version. */
export function WithdrawnChip({ at }: { at?: string }) {
  return <StatusChip size="sm" tone="bad" icon={<Ban className="h-3 w-3" />}>Withdrawn{at ? ` ${date(at)}` : ''}</StatusChip>;
}

export function WithdrawVersionDialog({ rb, version, onClose, onDone }: { rb: Rulebook; version: number; onClose: () => void; onDone?: () => void }) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const v = rb.versions.find((x) => x.version === version);
  const live = rulebookAt(rb, Date.now());
  const inForce = live?.version === version;
  const fallback = fallbackFor(rb, version);
  const blocked = !v ? 'No such version.' : v.status !== 'published' ? 'Only a published version can be withdrawn.' : v.withdrawn ? `Already withdrawn ${date(v.withdrawn.at)}.` : inForce && !fallback ? `Version ${version} is the only version in force. Publish a replacement first, or pause the agent.` : undefined;
  const sem = inForce && v && fallback ? semDiff(v.rules, fallback.rules) : [];
  const looser = sem.filter((d) => d.change === 'looser' || d.change === 'removed').length;
  const submit = async () => {
    if (!user) return;
    setBusy(true); setErr(undefined);
    try {
      const r = await api.records.withdrawVersion(orgId, rb.id, version, reason, user.id);
      toast.ok(`Version ${version} withdrawn`, r.wasInForce ? `New calls use version ${r.nowInForce}. Recorded on the chain.` : 'It can no longer be used or copied into a draft. Recorded on the chain.');
      onDone?.();
      onClose();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} size="lg" tone="danger" title={`Withdraw ${rb.slug} v${version}`}
      description="The version stays in the history and every receipt that used it keeps verifying. No call made from now on uses it."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" icon={<Ban className="h-4 w-4" />} loading={busy} disabled={!!blocked || reason.trim().length < 8} onClick={submit}>Withdraw the version</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Not withdrawn">{err}</Banner>}
        {blocked && <Banner tone="held" title="This version cannot be withdrawn now">{blocked}</Banner>}
        {!blocked && v && (
          <>
            <dl className="grid gap-3 sm:grid-cols-3 text-sm">
              <div><dt className="label">Version</dt><dd className="font-mono">v{v.version} · {v.rules.length} rules</dd></div>
              <div><dt className="label">{level === 'l1' ? 'Published' : 'Signed'}</dt><dd>{userName(v.signedBy)} · {v.signedAt ? date(v.signedAt) : '—'}</dd></div>
              <div><dt className="label">Now</dt><dd>{inForce ? 'In force for new calls' : 'Superseded'}</dd></div>
            </dl>
            {inForce && fallback ? (
              <Banner tone={looser ? 'held' : 'info'} title={`Version ${fallback.version} takes over for new calls`}>
                {diffSummary(sem) === 'No changes' ? `Version ${fallback.version} has the same rules.` : `Going back to v${fallback.version}: ${diffSummary(sem)}.`} {looser ? 'Some rules become looser — publish a new version instead if the older rules are not acceptable.' : ''}
              </Banner>
            ) : (
              <p className="text-sm text-muted">It is not in force, so calls do not change. Withdrawing it stops anyone copying it back into a draft and records why it must not return.</p>
            )}
            {inForce && fallback && <div className="border border-line p-3"><SemanticDiffList before={v.rules} after={fallback.rules} compact emptyText="No rule changes." /></div>}
          </>
        )}
        <Field label="Why it is withdrawn" required htmlFor="wv-r" hint="A sentence. It goes on the receipt as written."><Textarea id="wv-r" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="This version let vendor bank details change without a second person." data-autofocus /></Field>
        <p className="text-xs text-muted">Recorded as <span className="font-mono">rulebook.version_withdrawn</span>, {level === 'l1' ? 'sealed in the hash chain' : 'signed with the organisation’s key'}.</p>
      </div>
    </Dialog>
  );
}
