import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { Check, Eye, EyeOff, Minus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Input } from '@/components/ui';

/** Built rule: passwords are at least 12 characters (argon2id on the server). The other checks are guidance. */
export const MIN_PASSWORD = 12;

const COMMON = ['password', 'qwerty', '123456', 'letmein', 'welcome', 'admin', 'iloveyou', 'monkey', 'dragon', 'elan1', 'govern'];

export interface PasswordCheck { id: string; label: string; ok: boolean; required: boolean }

export function passwordChecks(pw: string, context: { email?: string; name?: string } = {}): PasswordCheck[] {
  const lower = pw.toLowerCase();
  const local = context.email?.split('@')[0]?.toLowerCase() ?? '';
  const nameParts = (context.name ?? '').toLowerCase().split(/\s+/).filter((p) => p.length >= 3);
  const personal = (local.length >= 3 && lower.includes(local)) || nameParts.some((p) => lower.includes(p));
  return [
    { id: 'length', label: `At least ${MIN_PASSWORD} characters`, ok: pw.length >= MIN_PASSWORD, required: true },
    { id: 'personal', label: 'Does not contain your email or name', ok: pw.length > 0 && !personal, required: true },
    { id: 'common', label: 'Not a common password or the product name', ok: pw.length > 0 && !COMMON.some((c) => lower.includes(c)), required: true },
    { id: 'mix', label: 'Mixes letters with numbers or symbols (recommended)', ok: /[a-z]/i.test(pw) && /[^a-z]/i.test(pw), required: false },
  ];
}

export function passwordOk(pw: string, context?: { email?: string; name?: string }) {
  return passwordChecks(pw, context).every((c) => !c.required || c.ok);
}

/** Live checklist under a new-password field. Each line carries an icon and words — never colour alone. */
export function PasswordChecklist({ checks, id }: { checks: PasswordCheck[]; id?: string }) {
  return (
    <ul id={id} className="mt-2 space-y-1" aria-live="polite">
      {checks.map((c) => (
        <li key={c.id} className={cn('flex items-center gap-2 text-xs', c.ok ? 'text-ok-fg' : 'text-muted')}>
          <span className={cn('inline-flex h-4 w-4 items-center justify-center border', c.ok ? 'border-ok/50 bg-ok-bg' : 'border-line-strong/50')} aria-hidden>
            {c.ok ? <Check className="h-3 w-3" strokeWidth={3} /> : <Minus className="h-3 w-3" />}
          </span>
          <span>{c.label}</span>
          <span className="sr-only">{c.ok ? '— met' : '— not met yet'}</span>
        </li>
      ))}
    </ul>
  );
}

/** Password input with a show/hide toggle. The toggle is a real button with a label that names its state. */
export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function PasswordInput({ className, invalid, ...rest }, ref) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input ref={ref} type={show ? 'text' : 'password'} invalid={invalid} className={cn('pr-11', className)} {...rest} />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
        className="absolute right-0 top-0 h-10 w-10 inline-flex items-center justify-center text-muted hover:text-fg"
      >
        {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  );
});

const FREE_MAIL = ['gmail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'rediffmail.com', 'proton.me', 'protonmail.com'];

export function emailProblem(email: string, work = false): string | undefined {
  const e = email.trim();
  if (!e) return 'Enter your email address.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'Enter an email address like name@company.com.';
  if (work && FREE_MAIL.includes(e.split('@')[1].toLowerCase())) return 'Use your work address. A personal email domain cannot own an organisation.';
  return undefined;
}
