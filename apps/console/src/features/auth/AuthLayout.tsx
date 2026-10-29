import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { LEGAL_ENTITY } from '@/lib/company';
import { Logo, Toaster } from '@/components/ui';

/**
 * The public split layout for sign-in, sign-up, recovery and invitations.
 * Left: an ink field with the lockup, the descriptor, one statement and one field-crop clay disc that
 * enters from the bottom edge. The disc lives in its own region below the text, so it never sits behind words.
 * Right: a paper panel with the form. Below `lg` the ink field collapses into a header.
 */
export function AuthLayout({ statement, sub, children, footer, wide }: {
  statement: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 40);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="min-h-screen bg-canvas lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* ink field */}
      <aside className="relative overflow-hidden bg-ink-800 text-paper lg:sticky lg:top-0 lg:h-screen lg:flex lg:flex-col">
        <div className="relative z-10 px-4 py-5 sm:px-8 lg:px-14 lg:pt-12 flex items-center justify-between gap-4 lg:block">
          <Link to="/login" className="inline-flex items-center focus-visible:outline-paper" aria-label="elan1 — sign in">
            <Logo variant="white" height={24} />
          </Link>
          <p className="text-[12px] lg:text-sm text-ink-300 lg:mt-4 tracking-tightish text-right lg:text-left">The agentic transformation company</p>
        </div>

        <div className="relative z-10 hidden lg:block px-14 pt-[9vh]">
          <p className="label !text-ember mb-5">Elan1 Govern</p>
          <h1 className="font-display !text-paper text-[56px] xl:text-[68px] leading-[0.98] font-semibold tracking-[-0.035em] max-w-[11ch]">{statement}</h1>
          {sub && <div className="mt-6 max-w-[44ch] text-md text-ink-200 leading-relaxed">{sub}</div>}
        </div>

        {/* the one disc: a field crop entering from the bottom edge, in a region that carries no text */}
        <div className="relative hidden lg:block flex-1 min-h-[220px]" aria-hidden>
          <div
            className="absolute rounded-full bg-accent transition-transform duration-[1100ms] ease-std"
            style={{
              width: 'min(78vh, 92%)',
              aspectRatio: '1 / 1',
              right: '-14%',
              top: '22%',
              transform: entered ? 'translateY(0)' : 'translateY(18%)',
            }}
          />
        </div>
      </aside>

      {/* paper panel */}
      <main className="flex min-h-[calc(100vh-64px)] lg:min-h-screen flex-col">
        <div className="flex-1 flex items-start lg:items-center justify-center px-4 sm:px-8 py-10 lg:py-14">
          <div className={cn('w-full', wide ? 'max-w-[520px]' : 'max-w-[420px]')}>
            <div className="lg:hidden mb-8">
              <p className="label text-accent-fg mb-2">Elan1 Govern</p>
              <p className="font-display text-3xl font-semibold tracking-tighter2 leading-tight">{statement}</p>
            </div>
            {children}
          </div>
        </div>
        <footer className="px-4 sm:px-8 py-5 border-t border-line text-xs text-subtle flex flex-wrap items-center gap-x-5 gap-y-1">
          <span>{LEGAL_ENTITY}</span>
          {footer}
          <Link to="/verify" className="hover:text-fg underline-offset-2 hover:underline">Verify a receipt</Link>
          <Link to="/verify?input=disclosure" className="hover:text-fg underline-offset-2 hover:underline">Verify a counterparty receipt</Link>
          <Link to="/status" className="hover:text-fg underline-offset-2 hover:underline">Status</Link>
          <Link to="/developers" className="hover:text-fg underline-offset-2 hover:underline">Developers</Link>
          <Link to="/legal/privacy" className="hover:text-fg underline-offset-2 hover:underline">Privacy</Link>
          <Link to="/legal/cookies" className="hover:text-fg underline-offset-2 hover:underline">Cookies</Link>
          <Link to="/legal/sub-processors" className="hover:text-fg underline-offset-2 hover:underline">Sub-processors</Link>
          <a href="mailto:support@elan1.ai" className="sm:ml-auto hover:text-fg underline-offset-2 hover:underline">support@elan1.ai</a>
        </footer>
      </main>
      <Toaster />
    </div>
  );
}

/** Heading block at the top of each auth form. */
export function AuthHeading({ kicker, title, children }: { kicker?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-7">
      {kicker && <p className="label mb-2">{kicker}</p>}
      <h2 className="text-2xl font-semibold tracking-tighter2">{title}</h2>
      {children && <p className="mt-2 text-md text-muted leading-relaxed">{children}</p>}
    </div>
  );
}

/** A full-width divider with a word in the middle. */
export function OrRule({ children = 'or' }: { children?: ReactNode }) {
  return (
    <div className="my-6 flex items-center gap-3" role="separator">
      <span className="h-px flex-1 bg-line" />
      <span className="label">{children}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
