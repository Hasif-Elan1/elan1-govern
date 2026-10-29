import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';
import { useUi } from '@/store/ui';
import { useUser } from '@/store/session';
import { LEGAL_ENTITY } from '@/lib/company';
import { cn } from '@/lib/cn';
import { IconButton, ProductMark, Toaster } from '@/components/ui';

/** Public header and footer for the developer portal (renders outside the console shell, no sign-in). */
export function PublicChrome({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      <a href="#doc-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:bg-fg focus:text-canvas focus:px-3 focus:py-2">Skip to content</a>
      <PublicHeader />
      <main className="flex-1">{children}</main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1480px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-5 text-xs text-subtle lg:px-8">
          <span>Elan1 Govern · {LEGAL_ENTITY}</span>
          <span className="flex flex-wrap gap-x-4 gap-y-1 sm:ml-auto">
            <Link to="/developers" className="hover:text-fg">Developers</Link>
            <Link to="/developers/changelog" className="hover:text-fg">Changelog</Link>
            <Link to="/verify" className="hover:text-fg">Verify a receipt</Link>
            <Link to="/verify?input=disclosure" className="hover:text-fg">Verify a counterparty receipt</Link>
            <Link to="/status" className="hover:text-fg">Status</Link>
            <Link to="/developers/legal" className="hover:text-fg">Terms and DPA</Link>
            <Link to="/legal/privacy" className="hover:text-fg">Privacy</Link>
            <Link to="/legal/cookies" className="hover:text-fg">Cookies</Link>
            <Link to="/legal/sub-processors" className="hover:text-fg">Sub-processors</Link>
            <Link to="/login" className="hover:text-fg">Sign in</Link>
          </span>
        </div>
      </footer>
      <Toaster />
    </div>
  );
}

function PublicHeader() {
  const { theme, setTheme } = useUi();
  const user = useUser();
  const dark = theme === 'dark' || (theme === 'system' && typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark');
  const link = ({ isActive }: { isActive: boolean }) =>
    cn('relative inline-flex items-center h-14 text-sm font-medium transition-colors', isActive ? 'text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-fg' : 'text-muted hover:text-fg');
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/95 backdrop-blur-[2px]">
      <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-3 px-4 sm:gap-6 lg:px-8">
        <Link to="/developers" className="shrink-0 inline-flex items-center gap-3" aria-label="Elan1 Govern developers home">
          <span className="hidden sm:inline-flex"><ProductMark /></span>
          <span className="sm:hidden inline-flex"><ProductMark compact /></span>
          <span className="hidden md:inline label text-accent-fg">Docs</span>
        </Link>
        <nav aria-label="Public" className="ml-auto flex items-center gap-3 sm:gap-6">
          <NavLink to="/developers" className={link}>Developers</NavLink>
          <NavLink to="/verify" className={link}>Verify</NavLink>
          <NavLink to="/status" className={({ isActive }) => cn(link({ isActive }), 'hidden sm:inline-flex')}>Status</NavLink>
          {user
            ? <Link to="/" className="text-sm font-medium text-muted hover:text-fg">Console</Link>
            : <Link to="/login" className="text-sm font-medium text-muted hover:text-fg">Sign in</Link>}
        </nav>
        <IconButton label={dark ? 'Use light theme' : 'Use dark theme'} onClick={() => setTheme(dark ? 'light' : 'dark')}>
          {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </IconButton>
      </div>
    </header>
  );
}
