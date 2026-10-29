import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CircleDashed, CircleSlash, ShieldCheck, TriangleAlert, Unlink, FileSearch, CircleCheck, CircleX } from 'lucide-react';
import { api } from '@/api';
import { useMutation, useQuery } from '@/hooks/useQuery';
import { useCan, useOrgId, useOrgLevel, useUser } from '@/store/session';
import { useState } from 'react';
import type { Control, Framework, ProfileRunResult } from '@/types';
import { Drawer, KeyValue, StatusChip, Badge, Banner, Button, Skeleton, Tooltip, toast } from '@/components/ui';
import { ReceiptLink, When } from '@/components/domain';
import { n } from '@/lib/format';
import { atLeast } from '@/lib/levels';
import { REQ_STATUS_LABEL, requirementsOf, type LiveControl, type ReqStatus } from './evidence';
import { PROFILE_FOR } from './regimes';
import { PlanUpsell, SmartLink, useCanSee } from '@/shell/access';

/** The verifier profile for a framework: id, version, last run, and a working "verify with this profile" (L2+). */
export function ProfileVerify({ frameworkId, compact }: { frameworkId: string; compact?: boolean }) {
  const orgId = useOrgId();
  const user = useUser();
  const level = useOrgLevel();
  const l2 = atLeast(level, 'l2');
  const canExport = useCan('evidence.export');
  const canManage = useCan('compliance.manage');
  const canRun = canExport || canManage;
  const profileId = PROFILE_FOR[frameworkId];
  const q = useQuery((o) => api.profiles(o), [level], { kinds: ['receipt', 'level', 'pack'] });
  const run = useMutation(() => api.runProfile(orgId, profileId!, user!.id));
  const [ran, setRan] = useState<ProfileRunResult>();
  if (!profileId) return compact ? <span className="text-xs text-subtle">No verifier profile</span> : <p className="text-sm text-muted">No verifier profile is published for this framework yet; coverage is the only measure here.</p>;
  // verifier profiles are part of L2: below it the line is left out (owners see one line on the plan instead)
  if (!l2) return compact ? null : <PlanUpsell to="l2" what="Verifier profiles are part of L2 Attested." />;
  const p = q.data?.find((x) => x.id === profileId);
  const last: ProfileRunResult | undefined = ran ?? p?.lastRun;
  if (compact) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted">
        Profile <SmartLink to={`/assurance/profiles?profile=${profileId}`} plainClassName="font-mono" className="font-mono underline underline-offset-2 hover:text-fg" onClick={(e) => e.stopPropagation()}>{profileId}{p ? ` v${p.version}` : ''}</SmartLink>
        {last && <StatusChip size="sm" tone={last.result === 'pass' ? 'ok' : 'bad'} icon={last.result === 'pass' ? <CircleCheck className="h-3 w-3" /> : <CircleX className="h-3 w-3" />}>{last.result === 'pass' ? 'Passed' : 'Failed'}</StatusChip>}
      </span>
    );
  }
  const go = async () => {
    try {
      const r = await run.mutate();
      setRan(r);
      toast[r.result === 'pass' ? 'ok' : 'held'](r.result === 'pass' ? 'Profile passed' : 'Profile failed', `${r.rules.filter((x) => x.state === 'pass').length} of ${r.rules.length} rules pass over ${n(r.range.count)} receipts.${r.seq ? ` Receipt #${r.seq}.` : ''}`);
    } catch (e) { toast.bad('The profile did not run', (e as Error).message); }
  };
  return (
    <div className="space-y-3">
      {q.error && <Banner tone="bad" title="Profiles did not load" actions={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</Banner>}
      {q.loading ? <Skeleton className="h-16" /> : p ? (
        <KeyValue items={[
          { k: 'Profile', v: <SmartLink to={`/assurance/profiles?profile=${p.id}`} plainClassName="font-mono" className="font-mono underline underline-offset-2">{p.id} v{p.version}</SmartLink> },
          { k: 'Regime', v: <span className="text-sm">{p.regime}</span> },
          { k: 'Rules', v: n(p.rules.length) },
          { k: 'Retention', v: `${p.retentionYears} years` },
          { k: 'Last run', v: last ? <span className="inline-flex flex-wrap items-center gap-2"><StatusChip size="sm" tone={last.result === 'pass' ? 'ok' : 'bad'} icon={last.result === 'pass' ? <CircleCheck className="h-3 w-3" /> : <CircleX className="h-3 w-3" />}>{last.result === 'pass' ? 'Passed' : 'Failed'}</StatusChip><When iso={last.ranAt} className="text-xs text-muted" />{last.seq ? <ReceiptLink seq={last.seq} /> : null}</span> : <span className="text-muted">Not run</span> },
        ]} />
      ) : null}
      {last && last.result === 'fail' && (
        <ul className="text-xs space-y-1">
          {last.rules.filter((r) => r.state === 'fail').slice(0, 3).map((r) => <li key={r.id} className="text-bad-fg"><span className="font-mono">{r.id}</span> {r.text} — {r.detail}</li>)}
        </ul>
      )}
      {/* owners, admins and auditors run profiles; viewers read the last run */}
      {canRun && (
        <Tooltip content="Run every rule of the profile against the whole chain; the run is a receipt">
          <Button size="sm" variant="secondary" icon={<FileSearch className="h-3.5 w-3.5" />} loading={run.pending} onClick={go}>Verify with this profile</Button>
        </Tooltip>
      )}
    </div>
  );
}

const ic = 'h-3.5 w-3.5 shrink-0';

export function ControlStatusChip({ status, size = 'sm' }: { status: Control['status']; size?: 'sm' | 'md' }) {
  if (status === 'evidenced') return <StatusChip tone="ok" size={size} icon={<ShieldCheck className={ic} aria-hidden />}>Evidenced</StatusChip>;
  if (status === 'partial') return <StatusChip tone="held" size={size} icon={<TriangleAlert className={ic} aria-hidden />}>Partial</StatusChip>;
  return <StatusChip tone="bad" size={size} icon={<CircleSlash className={ic} aria-hidden />}>No evidence</StatusChip>;
}

export function ReqStatusChip({ status, size = 'sm' }: { status: ReqStatus; size?: 'sm' | 'md' }) {
  const m = {
    covered: { tone: 'ok' as const, icon: <ShieldCheck className={ic} aria-hidden /> },
    partial: { tone: 'held' as const, icon: <TriangleAlert className={ic} aria-hidden /> },
    unevidenced: { tone: 'neutral' as const, icon: <CircleDashed className={ic} aria-hidden /> },
    gap: { tone: 'bad' as const, icon: <Unlink className={ic} aria-hidden /> },
  }[status];
  return <StatusChip tone={m.tone} size={size} icon={m.icon}>{REQ_STATUS_LABEL[status]}</StatusChip>;
}

export function ControlChip({ id, status, onClick }: { id: string; status?: Control['status']; onClick?: () => void }) {
  const edge = status === 'evidenced' ? 'border-l-ok' : status === 'partial' ? 'border-l-held' : 'border-l-bad';
  const cls = `inline-flex items-center h-6 px-1.5 font-mono text-[11.5px] border border-line border-l-[3px] ${edge} bg-surface hover:border-fg`;
  const title = status === 'evidenced' ? 'Evidenced' : status === 'partial' ? 'Partial evidence' : 'No evidence';
  if (onClick) return <button type="button" title={`${id} — ${title}`} onClick={(e) => { e.stopPropagation(); onClick(); }} className={cls}>{id}</button>;
  return <SmartLink to={`/compliance?control=${id}`} title={`${id} — ${title}`} onClick={(e) => e.stopPropagation()} className={cls} plainClassName={cls}>{id}</SmartLink>;
}

/** Everything about one control: what counts as evidence, how much there is, and which requirements it serves. */
export function ControlDrawer({ control, frameworks, onClose }: { control?: LiveControl; frameworks: Framework[]; onClose: () => void }) {
  const nav = useNavigate();
  // the footer only leads somewhere this role and plan can open (auditors have no Work screens, viewers no Exports)
  const canOpen = useCanSee(control?.activity ?? '/');
  const openable = !!control && canOpen;
  const byId = control ? { [control.id]: control } : {};
  const maps = control ? frameworks.flatMap((f) => requirementsOf(f, byId).filter((r) => r.controlIds.includes(control.id)).map((r) => ({ f, r }))) : [];
  return (
    <Drawer open={!!control} onClose={onClose} kicker={control?.id} title={control?.name ?? ''} width={560}
      footer={openable && <Button variant="secondary" iconRight={<ArrowRight className="h-4 w-4" />} onClick={() => nav(control.activity)}>{control.activityLabel}</Button>}>
      {control && (
        <div className="space-y-6">
          <p className="text-sm text-muted leading-relaxed">{control.description}</p>
          <KeyValue items={[
            { k: 'Status', v: <ControlStatusChip status={control.status} /> },
            { k: 'Counts as evidence', v: control.evidenceKind },
            { k: 'Evidence on the chain', v: <span className="num font-medium">{n(control.evidenceCount)}</span> },
            { k: 'Last evidence', v: <When iso={control.lastEvidenceAt} /> },
          ]} />
          {control.note && <p className="border-l-[3px] border-held pl-3 text-sm">{control.note}</p>}
          <div>
            <p className="label mb-2">Latest example receipts</p>
            {control.examples.length ? (
              <div className="flex flex-wrap gap-3">{control.examples.map((s) => <ReceiptLink key={s} seq={s} />)}</div>
            ) : <p className="text-sm text-muted">{openable ? <>No single receipt stands for this control; open {control.activityLabel.toLowerCase()} instead.</> : 'No single receipt stands for this control.'}</p>}
          </div>
          <div>
            <p className="label mb-2">Requirements this control maps to ({maps.length})</p>
            {maps.length ? (
              <ul className="border border-line divide-y divide-line">
                {maps.map(({ f, r }) => (
                  <li key={f.id + r.id}>
                    <Link to={`/compliance/${f.id}?control=${control.id}`} onClick={onClose} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-sunken/60 text-sm">
                      <span className="min-w-0"><span className="font-mono text-xs text-muted mr-2">{r.id}</span>{r.title}</span>
                      <span className="shrink-0 flex items-center gap-1.5"><Badge>{f.short}</Badge>{!f.enabled && <Badge>Off</Badge>}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">No framework requirement maps to this control yet.</p>}
          </div>
          <p className="text-xs text-subtle">Evidence is a count of receipts, not a test that the control works.</p>
        </div>
      )}
    </Drawer>
  );
}
