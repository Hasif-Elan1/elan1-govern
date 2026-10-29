import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, Pause } from 'lucide-react';
import { LEGAL_ENTITY } from '@/lib/company';
import { ProductMark } from '@/components/ui';

/** Full-page frame for system states outside the shell (maintenance, offline). Calm, paper, one mark. */
export function StatusFrame({ mark, kicker, title, lead, children, works, waits, actions }: {
  mark: ReactNode; kicker: string; title: string; lead: ReactNode; children?: ReactNode;
  works: string[]; waits: string[]; actions?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-canvas flex flex-col">
      <header className="h-16 border-b border-line bg-surface flex items-center px-4 sm:px-8">
        <ProductMark />
      </header>
      <main className="flex-1 px-4 sm:px-8 py-12 lg:py-20">
        <div className="mx-auto max-w-[760px]">
          {mark}
          <p className="label mt-8" role="status">{kicker}</p>
          <h1 className="mt-2 text-4xl sm:text-5xl font-bold tracking-tighter2 leading-[1.05]">{title}</h1>
          <div className="mt-4 text-md text-muted leading-relaxed max-w-[60ch]">{lead}</div>
          {children}
          {actions && <div className="mt-7 flex flex-wrap gap-2">{actions}</div>}

          <div className="mt-12 grid gap-px bg-line border border-line md:grid-cols-2">
            <section className="bg-surface p-5" aria-labelledby="works-h">
              <h2 id="works-h" className="label">What still works</h2>
              <ul className="mt-3 space-y-2.5">
                {works.map((w) => (
                  <li key={w} className="flex items-start gap-2.5 text-sm"><span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center border border-ok/40 bg-ok-bg"><Check className="h-3 w-3 text-ok-fg" strokeWidth={3} aria-hidden /></span>{w}</li>
                ))}
              </ul>
            </section>
            <section className="bg-surface p-5" aria-labelledby="waits-h">
              <h2 id="waits-h" className="label">What waits</h2>
              <ul className="mt-3 space-y-2.5">
                {waits.map((w) => (
                  <li key={w} className="flex items-start gap-2.5 text-sm text-muted"><span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center border border-line-strong/60"><Pause className="h-2.5 w-2.5" aria-hidden /></span>{w}</li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </main>
      <footer className="px-4 sm:px-8 py-4 border-t border-line text-xs text-subtle flex flex-wrap gap-x-6 gap-y-1">
        <span>Elan1 Govern · {LEGAL_ENTITY}</span>
        <span className="flex flex-wrap gap-x-4 gap-y-1 sm:ml-auto">
          <Link to="/status" className="hover:text-fg">Service status</Link>
          <Link to="/verify" className="hover:text-fg">Verify a bundle</Link>
          <a href="mailto:support@elan1.ai" className="hover:text-fg">support@elan1.ai</a>
        </span>
      </footer>
    </div>
  );
}
