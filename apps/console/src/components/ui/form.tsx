import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/cn';

const control = 'w-full bg-surface border border-line-strong/70 text-fg placeholder:text-subtle transition-colors duration-100 hover:border-fg/60 focus:border-fg focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 disabled:opacity-50 disabled:bg-sunken';

export function Field({ label, hint, error, children, required, className, htmlFor, aside }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; required?: boolean; className?: string; htmlFor?: string; aside?: ReactNode }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
            {label}
            {required && <span className="text-bad-fg ml-0.5" aria-hidden>*</span>}
          </label>
          {aside}
        </div>
      )}
      {children}
      {hint && !error && <p className="text-xs text-muted leading-relaxed">{hint}</p>}
      {error && <p className="text-xs text-bad-fg" role="alert">{error}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; invalid?: boolean; leading?: ReactNode }>(
  function Input({ className, mono, invalid, leading, ...rest }, ref) {
    if (leading) {
      return (
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle pointer-events-none">{leading}</span>
          <input ref={ref} aria-invalid={invalid || undefined} className={cn(control, 'h-10 pl-9 pr-3 text-base', mono && 'font-mono text-sm', invalid && 'border-bad', className)} {...rest} />
        </div>
      );
    }
    return <input ref={ref} aria-invalid={invalid || undefined} className={cn(control, 'h-10 px-3 text-base', mono && 'font-mono text-sm', invalid && 'border-bad', className)} {...rest} />;
  },
);

export function SearchInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <Input leading={<Search className="h-4 w-4" aria-hidden />} className={cn('h-9 text-sm', className)} {...rest} />;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ className, invalid, ...rest }, ref) {
  return <textarea ref={ref} aria-invalid={invalid || undefined} className={cn(control, 'px-3 py-2 text-base min-h-[88px] leading-relaxed', invalid && 'border-bad', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { size_?: 'sm' | 'md' }>(function Select({ className, children, size_ = 'md', ...rest }, ref) {
  return (
    <div className="relative">
      <select ref={ref} className={cn(control, 'appearance-none pl-3 pr-8', size_ === 'sm' ? 'h-8 text-sm' : 'h-10 text-base', className)} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" aria-hidden />
    </div>
  );
});

export function Checkbox({ checked, onChange, label, description, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; id?: string }) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <label htmlFor={cid} className={cn('flex items-start gap-2.5 cursor-pointer select-none', disabled && 'opacity-50 cursor-not-allowed')}>
      <span className="relative mt-0.5 h-4 w-4 shrink-0">
        <input id={cid} type="checkbox" className="peer absolute inset-0 opacity-0 cursor-pointer" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className={cn('absolute inset-0 border transition-colors', checked ? 'bg-fg border-fg' : 'bg-surface border-line-strong', 'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-fg')} />
        {checked && <Check className="absolute inset-0 m-auto h-3 w-3 text-canvas" strokeWidth={3} aria-hidden />}
      </span>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-sm font-medium">{label}</span>}
          {description && <span className="block text-xs text-muted mt-0.5">{description}</span>}
        </span>
      )}
    </label>
  );
}

/** Square toggle — the system has no rounded corners; state is carried by position and the On/Off label. */
export function Switch({ checked, onChange, label, disabled, showState = true }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; showState?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('inline-flex items-center gap-2 group disabled:opacity-45 disabled:cursor-not-allowed')}
    >
      <span className={cn('relative h-5 w-9 border transition-colors duration-150', checked ? 'bg-fg border-fg' : 'bg-sunken border-line-strong')}>
        <span className={cn('absolute top-[2px] h-[14px] w-[14px] transition-transform duration-150 ease-std', checked ? 'translate-x-[18px] bg-canvas' : 'translate-x-[2px] bg-line-strong')} />
      </span>
      {showState && <span className="text-xs font-medium text-muted w-6 text-left">{checked ? 'On' : 'Off'}</span>}
    </button>
  );
}

export function RadioCards<T extends string>({ value, onChange, options, name, cols = 3 }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; description?: ReactNode; aside?: ReactNode; disabled?: boolean }[]; name: string; cols?: 1 | 2 | 3 | 4 }) {
  return (
    <div role="radiogroup" className={cn('grid gap-2', cols === 2 && 'sm:grid-cols-2', cols === 3 && 'sm:grid-cols-3', cols === 4 && 'sm:grid-cols-2 lg:grid-cols-4')}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <label key={o.value} className={cn('relative flex cursor-pointer flex-col gap-1 border p-3.5 transition-colors', on ? 'border-fg bg-surface shadow-[inset_0_0_0_1px_rgb(var(--fg))]' : 'border-line bg-surface hover:border-line-strong', o.disabled && 'opacity-50 cursor-not-allowed')}>
            <input type="radio" name={name} value={o.value} checked={on} disabled={o.disabled} onChange={() => onChange(o.value)} className="sr-only" />
            <span className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <span className={cn('h-3.5 w-3.5 border flex items-center justify-center', on ? 'border-fg' : 'border-line-strong')}>{on && <span className="h-1.5 w-1.5 bg-fg" />}</span>
                {o.label}
              </span>
              {o.aside}
            </span>
            {o.description && <span className="text-xs text-muted pl-5.5 leading-relaxed" style={{ paddingLeft: 22 }}>{o.description}</span>}
          </label>
        );
      })}
    </div>
  );
}

/** Segmented control for filters (All · Allowed · Asked · Refused). */
export function Segmented<T extends string>({ value, onChange, options, size = 'md', label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; size?: 'sm' | 'md'; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex border border-line bg-surface">
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn('inline-flex items-center gap-1.5 font-medium transition-colors', size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm', i > 0 && 'border-l border-line', on ? 'bg-fg text-canvas' : 'text-muted hover:text-fg hover:bg-sunken')}
          >
            {o.label}
            {o.count !== undefined && <span className={cn('num text-[11px]', on ? 'text-canvas/70' : 'text-subtle')}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
