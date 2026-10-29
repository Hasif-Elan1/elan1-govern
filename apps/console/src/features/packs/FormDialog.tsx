import { useEffect, useState, type ReactNode } from 'react';
import { Banner, Button, Checkbox, Dialog, Field, Input, Select, Textarea } from '@/components/ui';

export type FormField =
  | { id: string; kind: 'text'; label: string; hint?: ReactNode; placeholder?: string; initial?: string; min?: number; mono?: boolean }
  | { id: string; kind: 'textarea'; label: string; hint?: ReactNode; placeholder?: string; initial?: string; min?: number; rows?: number }
  | { id: string; kind: 'select'; label: string; hint?: ReactNode; options: { value: string; label: string }[]; initial?: string }
  | { id: string; kind: 'checkbox'; label: string; hint?: ReactNode; initial?: boolean }
  | { id: string; kind: 'number'; label: string; hint?: ReactNode; initial?: number; minValue?: number; maxValue?: number };

export type FormValues = Record<string, string | boolean>;

/**
 * One dialog for the pack factory's recorded steps: fields, a length check written for the person, the server's
 * own error in a banner, and a primary button that records the step (each is a receipt).
 */
export function FormDialog({ open, onClose, title, description, fields, submitLabel, intro, tone, onSubmit }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  fields: FormField[];
  submitLabel: string;
  intro?: ReactNode;
  tone?: 'danger';
  onSubmit: (v: FormValues) => Promise<void>;
}) {
  const [vals, setVals] = useState<FormValues>({});
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setErr(undefined);
    setVals(Object.fromEntries(fields.map((f) => [f.id, f.kind === 'checkbox' ? !!f.initial : f.kind === 'number' ? String(f.initial ?? '') : f.kind === 'select' ? f.initial ?? f.options[0]?.value ?? '' : f.initial ?? ''])));
    // fields are rebuilt by the caller on each render; reset only when the dialog opens
  }, [open]);
  const set = (id: string, v: string | boolean) => setVals((x) => ({ ...x, [id]: v }));
  const go = async () => {
    for (const f of fields) {
      if ((f.kind === 'text' || f.kind === 'textarea') && f.min && String(vals[f.id] ?? '').trim().length < f.min) { setErr(`${f.label}: at least ${f.min} characters.`); return; }
    }
    setBusy(true); setErr(undefined);
    try { await onSubmit(vals); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onClick={go}>{submitLabel}</Button></>}>
      <div className="space-y-4">
        {err && <Banner tone="bad" title="Not recorded">{err}</Banner>}
        {intro && <div className="text-sm">{intro}</div>}
        {fields.map((f) => {
          const id = `fd-${f.id}`;
          if (f.kind === 'checkbox') return <Checkbox key={f.id} id={id} checked={!!vals[f.id]} onChange={(v) => set(f.id, v)} label={f.label} description={f.hint} />;
          return (
            <Field key={f.id} label={f.label} htmlFor={id} hint={f.kind !== 'select' && 'min' in f && f.min ? <>{f.hint} {f.hint ? ' ' : ''}At least {f.min} characters.</> : f.hint}>
              {f.kind === 'text' ? <Input id={id} value={String(vals[f.id] ?? '')} placeholder={f.placeholder} mono={f.mono} onChange={(e) => set(f.id, e.target.value)} />
                : f.kind === 'textarea' ? <Textarea id={id} rows={f.rows ?? 4} value={String(vals[f.id] ?? '')} placeholder={f.placeholder} onChange={(e) => set(f.id, e.target.value)} />
                : f.kind === 'number' ? <Input id={id} type="number" inputMode="numeric" className="max-w-[180px] num" min={f.minValue} max={f.maxValue} value={String(vals[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)} />
                : <Select id={id} value={String(vals[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>}
            </Field>
          );
        })}
      </div>
    </Dialog>
  );
}
