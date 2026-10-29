import { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BookOpen, LogIn, Search, ShieldCheck } from 'lucide-react';
import { useUi } from '@/store/ui';
import { useOrgLevel, useRole } from '@/store/session';
import { Button, Disc, Kbd } from '@/components/ui';
import { canSeePath, doorHome, doorsFor } from '@/shell/nav';
import { PublicChrome } from '@/features/verify/PublicChrome';

/** Outside the shell, for a visitor who is not signed in: no console links, only the public ways in. */
export function PublicNotFoundPage() {
  const loc = useLocation();
  const nav = useNavigate();
  const path = loc.pathname;
  useEffect(() => { document.title = 'Not found · Elan1 Govern'; }, []);
  const ways = [
    { to: '/login', icon: LogIn, label: 'Sign in', text: 'Open the console for your organisation.' },
    { to: '/verify', icon: ShieldCheck, label: 'Verify a receipt or pack', text: 'Check an auditor pack, an evidence bundle or a receipt, with no account.' },
    { to: '/developers', icon: BookOpen, label: 'Developers', text: 'Guides, the API reference and the refusal codes.' },
  ];
  return (
    <PublicChrome>
      <div className="mx-auto max-w-[1280px] px-4 lg:px-8 py-16 sm:py-24">
        <div className="w-full max-w-[640px]">
          <Disc kind="registration" size={64} title="Registration mark" />
          <p className="label mt-8">404 · Not found</p>
          <h1 className="mt-2 text-4xl font-bold tracking-tighter2">No page at this address</h1>
          <p className="mt-3 text-md text-muted leading-relaxed">
            <span className="font-mono text-[13px] text-fg bg-sunken border border-line px-1.5 py-0.5 break-all">{path}</span> is not a page on Elan1 Govern. It may have moved, or the link was mistyped. Nothing was changed.
          </p>
          <div className="mt-6">
            <Button variant="secondary" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => nav(-1)}>Go back</Button>
          </div>
          <nav aria-label="Where to go instead" className="mt-10 grid grid-cols-1 gap-px bg-line border border-line">
            {ways.map((w) => (
              <Link key={w.to} to={w.to} className="group bg-surface px-4 py-3.5 flex items-start gap-3 hover:bg-sunken/60">
                <w.icon className="h-4 w-4 mt-0.5 text-muted group-hover:text-fg shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{w.label}</span>
                  <span className="mt-0.5 block text-sm text-muted">{w.text}</span>
                </span>
                <ArrowRight className="h-3.5 w-3.5 mt-1 text-subtle group-hover:text-fg shrink-0" aria-hidden />
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </PublicChrome>
  );
}

/** Inside the shell: a calm dead end that offers the way back. */
export default function NotFoundPage() {
  const loc = useLocation();
  const nav = useNavigate();
  const role = useRole();
  const level = useOrgLevel();
  const setCommandOpen = useUi((s) => s.setCommandOpen);

  // A few addresses people guess. Point them at the real one.
  const path = loc.pathname;
  const seq = path.match(/(?:receipts?|seq)\/#?(\d+)/i)?.[1];
  const guess =
    seq ? { to: `/activity/${seq}`, label: `Receipt #${seq}` } :
    /^\/(approval|inbox)/i.test(path) ? { to: '/approvals', label: 'Approvals' } :
    /^\/(agent|bot)s?\b/i.test(path) ? { to: '/agents', label: 'Agents' } :
    /^\/(rule|polic)/i.test(path) ? { to: '/rulebooks', label: 'Rulebooks' } :
    /^\/(member|team|user|role)/i.test(path) ? { to: '/agents/people', label: 'People and roles, in the Agents door' } :
    /^\/(sso|org)/i.test(path) ? { to: '/agents/organisation', label: 'Organisation, in the Agents door' } :
    /^\/(api-)?key/i.test(path) ? { to: '/agents/keys', label: 'Keys, in the Agents door' } :
    /^\/webhook/i.test(path) ? { to: '/assurance/exports?tab=webhooks', label: 'Webhooks, under Exports in the Assurance door' } :
    /^\/(notification|channel)/i.test(path) ? { to: '/work/channels', label: 'Channels, in the Work door' } :
    /^\/(preference|profile|account)/i.test(path) ? { to: '/you', label: 'Your preferences' } :
    undefined;

  // only the doors and screens this role and plan can open (the menu's rule, src/shell/nav.ts)
  const doors = doorsFor(role, level).map((d) => ({ ...d, home: d.key === 'assurance' && role === 'auditor' ? '/auditor' : doorHome(d, role, level) }));
  const guessOk = guess ? canSeePath(guess.to, role, level) : false;

  return (
    <div className="min-h-[60vh] grid place-items-center py-10">
      <div className="w-full max-w-[640px]">
        <Disc kind="registration" size={64} title="Registration mark" />
        <p className="label mt-8">404 · Not found</p>
        <h1 className="mt-2 text-4xl font-bold tracking-tighter2">No page at this address</h1>
        <p className="mt-3 text-md text-muted leading-relaxed">
          <span className="font-mono text-[13px] text-fg bg-sunken border border-line px-1.5 py-0.5 break-all">{path}</span> is not part of the console. It may have moved, or the link was mistyped. Nothing was changed.
        </p>

        {guess && guessOk && (
          <p className="mt-5 text-md">Did you mean <Link to={guess.to} className="link font-medium">{guess.label}</Link>?</p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={<Search className="h-4 w-4" />} onClick={() => setCommandOpen(true)}>Search the console</Button>
          <Button variant="secondary" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => nav(-1)}>Go back</Button>
          <span className="text-sm text-muted inline-flex items-center gap-1.5">or press <Kbd>Ctrl</Kbd><Kbd>K</Kbd> to find an agent, receipt number or rulebook</span>
        </div>

        <nav aria-label="The four doors" className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-px bg-line border border-line">
          {doors.map((d) => (
            <Link key={d.key} to={d.home} className="group bg-surface px-4 py-3.5 flex items-start gap-3 hover:bg-sunken/60">
              <span className="font-mono text-xs text-subtle pt-0.5 num">{String(d.number).padStart(2, '0')}</span>
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-semibold"><d.icon className="h-4 w-4 text-muted group-hover:text-fg" aria-hidden />{d.label}</span>
                <span className="mt-0.5 block text-sm text-muted">{d.question}</span>
              </span>
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
