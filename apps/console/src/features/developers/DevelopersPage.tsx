import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { EmptyState, Input, Select } from '@/components/ui';
import { PublicChrome } from './PublicChrome';
import { LangProvider } from './docs';
import { DOC_FLAT, DOC_NAV } from './nav';
import { Overview, Quickstart, Mcp } from './sections/Start';
import { ApiReference } from './sections/Api';
import { Rulebooks, RiskTags } from './sections/Rules';
import { Webhooks, Receipts, Cli } from './sections/Evidence';
import { Sdks, Examples, Errors, Changelog } from './sections/More';
import { Seal, Anchors, Verifier, CrossOrg, Autonomy, Packs, Identity, Sovereign, StatusDoc, Legal } from './sections/Platform';
import { RefusalCodes, RefusalCodePage, Glossary, McpTools, Support } from './sections/Register';
import { Conformance, VerifierRelease, Standard, PathToProduction } from './sections/Production';

const SECTIONS: Record<string, ComponentType> = {
  overview: Overview, quickstart: Quickstart, mcp: Mcp, api: ApiReference, sdks: Sdks, examples: Examples,
  rulebooks: Rulebooks, 'risk-tags': RiskTags, webhooks: Webhooks, receipts: Receipts, cli: Cli, errors: Errors, changelog: Changelog,
  seal: Seal, anchors: Anchors, verifier: Verifier, 'cross-org': CrossOrg, autonomy: Autonomy, packs: Packs, identity: Identity, sovereign: Sovereign, status: StatusDoc, legal: Legal,
  'refusal-codes': RefusalCodes, glossary: Glossary, 'mcp-tools': McpTools, support: Support,
  conformance: Conformance, 'verifier-release': VerifierRelease, standard: Standard, 'path-to-production': PathToProduction,
};

/**
 * /developers/* — the documentation portal. Left: sections. Centre: the page. Right (wide screens): on this page.
 * Public; no sign-in.
 */
export default function DevelopersPage() {
  const params = useParams();
  const splat = (params['*'] ?? '').replace(/\/+$/, '');
  const parts = splat.split('/');
  // /developers/refusals/<CODE> is a page per refusal code; /developers/refusals alone is the register
  const code = parts[0] === 'refusals' ? parts[1] : undefined;
  const id = parts[0] === 'refusals' ? 'refusal-codes' : parts[0] || 'overview';
  const entry = DOC_FLAT.find((e) => e.id === id);
  const Section = entry ? SECTIONS[entry.id] : undefined;
  const loc = useLocation();
  const nav = useNavigate();
  const contentRef = useRef<HTMLDivElement>(null);
  const [toc, setToc] = useState<{ id: string; text: string; level: number }[]>([]);
  const [active, setActive] = useState<string>();

  useEffect(() => { document.title = `${code ? decodeURIComponent(code) : entry?.title ?? 'Not found'} · Elan1 Govern developers`; }, [entry, code]);

  // Scroll: to the anchor in the URL, or to the top when the section changes.
  useEffect(() => {
    const hash = decodeURIComponent(loc.hash.replace('#', ''));
    const t = window.setTimeout(() => {
      if (hash) document.getElementById(hash)?.scrollIntoView({ block: 'start' });
      else window.scrollTo(0, 0);
    }, 30);
    return () => window.clearTimeout(t);
  }, [id, code, loc.hash]);

  // Build "On this page" from the rendered headings and follow the reader.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const hs = Array.from(root.querySelectorAll<HTMLElement>('[data-toc]'));
    setToc(hs.map((h) => ({ id: h.id, text: h.textContent ?? '', level: Number(h.dataset.toc) })));
    setActive(hs[0]?.id);
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive((visible[0].target as HTMLElement).id);
    }, { rootMargin: '-72px 0px -70% 0px' });
    hs.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, [id, code]);

  const idx = entry ? DOC_FLAT.indexOf(entry) : -1;
  const prev = idx > 0 ? DOC_FLAT[idx - 1] : undefined;
  const next = idx >= 0 && idx < DOC_FLAT.length - 1 ? DOC_FLAT[idx + 1] : undefined;

  return (
    <PublicChrome>
      <LangProvider>
        <div className="mx-auto flex max-w-[1480px] gap-8 px-4 lg:px-8">
          <Sidebar current={id} />
          <article id="doc-content" ref={contentRef} className="min-w-0 flex-1 py-8 lg:py-10" tabIndex={-1}>
            <div className="mb-6 lg:hidden">
              <label htmlFor="doc-jump" className="label mb-1.5 block">Section</label>
              <Select id="doc-jump" value={entry?.id ?? ''} onChange={(e) => nav(`/developers/${e.target.value}`)}>
                {!entry && <option value="">Choose a section</option>}
                {DOC_NAV.map((g) => (
                  <optgroup key={g.group} label={g.group}>
                    {g.items.map((it) => <option key={it.id} value={it.id}>{it.title}</option>)}
                  </optgroup>
                ))}
              </Select>
            </div>
            <div className="max-w-[860px]">
              {code ? <RefusalCodePage key={code} code={code} /> : Section ? <Section key={id} /> : (
                <EmptyState title="That page is not in the docs" disc="aperture" action={<Link to="/developers" className="link">Go to the overview</Link>}>
                  There is no section called “{splat}”. Choose one from the list, or start with the overview.
                </EmptyState>
              )}
              {entry && (
                <nav aria-label="Previous and next" className="mt-14 grid gap-3 border-t border-line pt-6 sm:grid-cols-2">
                  {prev ? (
                    <Link to={`/developers/${prev.id}`} className="group border border-line bg-surface p-4 hover:border-line-strong">
                      <span className="label inline-flex items-center gap-1"><ArrowLeft className="h-3 w-3" aria-hidden />Previous</span>
                      <span className="mt-1 block font-semibold group-hover:underline underline-offset-2">{prev.title}</span>
                    </Link>
                  ) : <span />}
                  {next && (
                    <Link to={`/developers/${next.id}`} className="group border border-line bg-surface p-4 text-right hover:border-line-strong">
                      <span className="label inline-flex items-center gap-1">Next<ArrowRight className="h-3 w-3" aria-hidden /></span>
                      <span className="mt-1 block font-semibold group-hover:underline underline-offset-2">{next.title}</span>
                    </Link>
                  )}
                </nav>
              )}
            </div>
          </article>
          {toc.length > 1 && (
            <aside className="hidden xl:block w-56 shrink-0" aria-label="On this page">
              <div className="sticky top-14 max-h-[calc(100vh-56px)] overflow-y-auto py-10">
                <p className="label mb-3">On this page</p>
                <ul className="space-y-1 border-l border-line">
                  {toc.map((t) => (
                    <li key={t.id}>
                      <a href={`#${t.id}`} onClick={(e) => { e.preventDefault(); nav({ hash: t.id }, { replace: true }); document.getElementById(t.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActive(t.id); }}
                        className={cn('-ml-px block border-l py-1 text-sm leading-snug transition-colors', t.level === 3 ? 'pl-6' : 'pl-3',
                          active === t.id ? 'border-fg text-fg font-medium' : 'border-transparent text-muted hover:text-fg')}>
                        {t.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </aside>
          )}
        </div>
      </LangProvider>
    </PublicChrome>
  );
}

function Sidebar({ current }: { current: string }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return DOC_NAV;
    return DOC_NAV.map((g) => ({ ...g, items: g.items.filter((it) => (it.title + ' ' + it.keywords).toLowerCase().includes(needle)) })).filter((g) => g.items.length);
  }, [q]);
  return (
    <aside className="hidden lg:block w-60 shrink-0 border-r border-line" aria-label="Documentation">
      <div className="sticky top-14 max-h-[calc(100vh-56px)] overflow-y-auto py-8 pr-5">
        <div className="mb-5">
          <label htmlFor="doc-filter" className="sr-only">Filter the docs</label>
          <Input id="doc-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter the docs" className="h-9 text-sm" leading={<Search className="h-4 w-4" aria-hidden />} />
        </div>
        {groups.map((g) => (
          <div key={g.group} className="mb-5">
            <p className="label mb-1.5">{g.group}</p>
            <ul>
              {g.items.map((it) => (
                <li key={it.id}>
                  <NavLink to={`/developers/${it.id}`}
                    className={cn('-ml-px block border-l-2 py-1.5 pl-3 text-sm transition-colors', it.id === current ? 'border-fg font-medium text-fg' : 'border-transparent text-muted hover:text-fg')}>
                    {it.title}{it.level && <span className="ml-1.5 font-mono text-[10px] text-subtle" title={`Starts at ${it.level}`}>{it.level}</span>}
                  </NavLink>
                  {it.children && it.id === current && (
                    <ul className="mb-1 ml-3 border-l border-line">
                      {it.children.map((c) => (
                        <li key={c.anchor}>
                          <a href={`#${c.anchor}`} className="block py-1 pl-3 font-mono text-[12px] text-muted hover:text-fg">{c.title}</a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {!groups.length && <p className="text-sm text-muted">Nothing matches “{q}”.</p>}
        <div className="mt-6 border-t border-line pt-4 text-sm flex flex-col gap-2">
          <Link to="/verify" className="link">Verify a receipt</Link>
          <Link to="/status" className="link">Status</Link>
        </div>
      </div>
    </aside>
  );
}
