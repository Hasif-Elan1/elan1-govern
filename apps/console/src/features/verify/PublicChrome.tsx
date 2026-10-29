import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';
import { useUi } from '@/store/ui';
import { useUser } from '@/store/session';
import { LEGAL_ENTITY } from '@/lib/company';
import { cn } from '@/lib/cn';
import { IconButton, ProductMark, Toaster } from '@/components/ui';

/**
 * Header and footer for the public pages (no sign-in needed). Pages render outside the console shell,
 * so this layout also mounts the toaster.
 */
export function PublicChrome({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:bg-fg focus:text-canvas focus:px-3 focus:py-2">Skip to content</a>
      <PublicHeader wide={wide} />
      <main id="main" className="flex-1">{children}</main>
      <PublicFooter wide={wide} />
      <Toaster />
    </div>
  );
}

export function PublicHeader({ wide }: { wide?: boolean }) {
  const { theme, setTheme } = useUi();
  const user = useUser();
  const dark = theme === 'dark' || (theme === 'system' && typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark');
  const link = ({ isActive }: { isActive: boolean }) =>
    cn('relative inline-flex items-center h-14 text-sm font-medium transition-colors', isActive ? 'text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-fg' : 'text-muted hover:text-fg');
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/95 backdrop-blur-[2px]">
      <div className={cn('mx-auto flex h-14 items-center gap-3 px-4 sm:gap-6 lg:px-8', wide ? 'max-w-[1480px]' : 'max-w-[1280px]')}>
        <Link to="/verify" className="shrink-0" aria-label="Elan1 Govern home">
          <span className="hidden sm:inline-flex"><ProductMark /></span>
          <span className="sm:hidden inline-flex"><ProductMark compact /></span>
        </Link>
        <nav aria-label="Public" className="ml-auto flex items-center gap-3 sm:gap-6 min-w-0">
          <NavLink to="/developers" className={link}>Developers</NavLink>
          <NavLink to="/verify" className={link}>Verify</NavLink>
          <NavLink to="/status" className={({ isActive }) => cn(link({ isActive }), 'hidden sm:inline-flex')}>Status</NavLink>
          {user ? (
            <Link to="/" className="text-sm font-medium text-muted hover:text-fg whitespace-nowrap">Console</Link>
          ) : (
            <Link to="/login" className="text-sm font-medium text-muted hover:text-fg whitespace-nowrap">Sign in</Link>
          )}
        </nav>
        <IconButton label={dark ? 'Use light theme' : 'Use dark theme'} onClick={() => setTheme(dark ? 'light' : 'dark')}>
          {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </IconButton>
      </div>
    </header>
  );
}

export function PublicFooter({ wide }: { wide?: boolean }) {
  return (
    <footer className="border-t border-line">
      <div className={cn('mx-auto flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-5 text-xs text-subtle lg:px-8', wide ? 'max-w-[1480px]' : 'max-w-[1280px]')}>
        <span>Elan1 Govern · {LEGAL_ENTITY}</span>
        <span className="flex flex-wrap gap-x-4 gap-y-1 sm:ml-auto">
          <Link to="/developers" className="hover:text-fg">Developers</Link>
          <Link to="/verify" className="hover:text-fg">Verify a receipt</Link>
          <Link to="/verify?input=disclosure" className="hover:text-fg">Verify a counterparty receipt</Link>
          <Link to="/status" className="hover:text-fg">Status</Link>
          <Link to="/developers/receipts" className="hover:text-fg">How receipts work</Link>
          <Link to="/developers/legal" className="hover:text-fg">Terms and DPA</Link>
          <Link to="/legal/privacy" className="hover:text-fg">Privacy</Link>
          <Link to="/legal/cookies" className="hover:text-fg">Cookies</Link>
          <Link to="/legal/sub-processors" className="hover:text-fg">Sub-processors</Link>
          <Link to="/login" className="hover:text-fg">Sign in</Link>
        </span>
      </div>
    </footer>
  );
}
