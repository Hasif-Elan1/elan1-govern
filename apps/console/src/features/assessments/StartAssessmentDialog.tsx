import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import { useOrgLevel, useOrgId, useUser } from '@/store/session';
import type { AiSystem } from '@/types';
import { atLeast, LEVEL_INFO } from '@/lib/levels';
import { Banner, Button, Dialog, Field, RadioCards, Select, toast } from '@/components/ui';
import { VARIANTS, VARIANT_ORDER, bands, type VariantId } from './templates';
import { createAssessment } from './backend';

const GROUPS: { title: string; kinds: ('risk' | 'framework' | 'admission')[] }[] = [
  { title: 'Risk', kinds: ['risk'] },
  { title: 'Framework checks', kinds: ['framework'] },
  { title: 'Regulatory pack admission', kinds: ['admission'] },
];

/** Choose a system and a template; creates a draft in the organisation's record and records `assessment.started`. */
export function StartAssessmentDialog({ open, onClose, systems, systemId, suggested }: {
  open: boolean; onClose: () => void; systems: Pick<AiSystem, 'id' | 'name' | 'riskTier'>[]; systemId?: string; suggested?: VariantId;
}) {
  const orgId = useOrgId();
  const user = useUser();
  const nav = useNavigate();
  const level = useOrgLevel();
  const [sys, setSys] = useState(systemId ?? '');
  const [variant, setVariant] = useState<VariantId>(suggested ?? 'risk_triage');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setSys(systemId ?? systems.find((s) => s.riskTier === 'unassessed')?.id ?? systems[0]?.id ?? '');
    setVariant(suggested ?? 'risk_triage');
    setError(undefined);
    // reset only when the dialog opens, not when the parent re-renders
  }, [open]);

  const def = VARIANTS[variant];
  const blocked = def.level && !atLeast(level, def.level);

  const start = async () => {
    if (!user || !sys || blocked) return;
    setBusy(true);
    setError(undefined);
    try {
      const a = await createAssessment(orgId, { aiSystemId: sys, variant }, user.id);
      const name = systems.find((s) => s.id === sys)?.name ?? sys;
      toast.ok(`${def.label} started`, `Draft for ${name}. Every answer is saved to the organisation's record as you choose it.`);
      onClose();
      nav(`/assessments/${a.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Start an assessment"
      description="Pick the template. Every answer carries fixed points, so the same answers always give the same result."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<ClipboardList className="h-4 w-4" />} disabled={!sys || !!blocked} loading={busy} onClick={start}>Start draft</Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <Banner tone="bad" title="No draft was started">{error}</Banner>}
        {!systemId && (
          <Field label="AI system" htmlFor="start-sys" required>
            <Select id="start-sys" value={sys} onChange={(e) => setSys(e.target.value)}>
              {systems.map((s) => <option key={s.id} value={s.id}>{s.name}{s.riskTier === 'unassessed' ? ' — unassessed' : ''}</option>)}
            </Select>
          </Field>
        )}
        {GROUPS.map((g) => (
          <fieldset key={g.title}>
            <legend className="label mb-2">{g.title}</legend>
            <RadioCards
              name={`template-${g.title}`}
              cols={1}
              value={variant}
              onChange={setVariant}
              // templates above the organisation's plan are not offered
              options={VARIANT_ORDER.filter((v) => g.kinds.includes(VARIANTS[v].kind) && !(VARIANTS[v].level && !atLeast(level, VARIANTS[v].level!))).map((v) => {
                const t = VARIANTS[v];
                const b = bands(t.maxScore);
                const locked = false;
                return {
                  value: v,
                  label: t.label,
                  aside: <span className="text-xs text-muted num">{t.questions.length} {t.kind === 'admission' ? 'gates' : `questions · ${t.maxScore} points`}</span>,
                  description: (
                    <>
                      {t.purpose}
                      {t.kind !== 'admission' && <span className="block mt-1 num">Minimal {b[0].from}–{b[0].to} · Limited {b[1].from}–{b[1].to} · High {b[2].from}–{b[2].to}</span>}
                      {t.profileId && <span className="block mt-1 text-xs">Verifier profile <span className="font-mono">{t.profileId}</span></span>}
                      {!locked && t.liveFrom && !atLeast(level, t.liveFrom) && <span className="block mt-1 text-xs text-info-fg">A dry-run admission at {LEVEL_INFO[level].label}: the pack's checks run and report, with no regulatory claim until {LEVEL_INFO[t.liveFrom].label}.</span>}
                    </>
                  ),
                };
              })}
            />
          </fieldset>
        ))}
        {!blocked && def.kind === 'admission' && def.liveFrom && !atLeast(level, def.liveFrom) && (
          <Banner tone="info" title={`A dry-run admission, with no regulatory claim until ${LEVEL_INFO[def.liveFrom].label}`}>
            The admission checks the five requirements before the pack's rules apply to the agent. At {LEVEL_INFO[level].label} the pack's checks run on the agent's governed writes and report what they would have refused, without refusing anything.
          </Banner>
        )}
        <p className="text-xs text-muted">The draft is shared with everyone in the organisation. A different person must sign it off before it sets the system’s risk tier or admits a pack.</p>
      </div>
    </Dialog>
  );
}
