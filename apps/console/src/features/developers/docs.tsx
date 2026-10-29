import { createContext, useContext, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Link2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Banner, CodeBlock, Tabs } from '@/components/ui';

/* ── Preferred language, shared by every code sample on the page (Stripe-style) ── */

export type Lang = 'curl' | 'typescript' | 'python';
const LANG_KEY = 'eg:docs-lang';
const LangCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'curl', setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, set] = useState<Lang>(() => {
    try { const v = localStorage.getItem(LANG_KEY); if (v === 'curl' || v === 'typescript' || v === 'python') return v; } catch { /* storage unavailable */ }
    return 'curl';
  });
  const setLang = (l: Lang) => { set(l); try { localStorage.setItem(LANG_KEY, l); } catch { /* fine */ } };
  return <LangCtx.Provider value={{ lang, setLang }}>{children}</LangCtx.Provider>;
}

export const useLang = () => useContext(LangCtx);

export interface Sample { key: string; label: string; code: string; title?: string; lang?: Lang }

/** Code with a tab per language or client. Choosing a language switches every sample on the page. */
export function CodeTabs({ samples, className, maxHeight }: { samples: Sample[]; className?: string; maxHeight?: number }) {
  const { lang, setLang } = useLang();
  const [local, setLocal] = useState(samples[0]?.key);
  const preferred = samples.find((s) => s.lang === lang);
  const active = samples.find((s) => s.key === local && !(preferred && s.lang && s.lang !== lang)) ?? preferred ?? samples[0];
  return (
    <div className={cn('my-5 border border-line bg-sunken/40', className)}>
      <div className="px-3">
        <Tabs<string>
          label="Code samples"
          value={active.key}
          onChange={(k) => { const s = samples.find((x) => x.key === k); setLocal(k); if (s?.lang) setLang(s.lang); }}
          items={samples.map((s) => ({ value: s.key, label: s.label }))}
          className="border-b-0 gap-5 overflow-y-hidden"
        />
      </div>
      <CodeBlock code={active.code} title={active.title ?? active.label} className="border-x-0 border-b-0" maxHeight={maxHeight} />
    </div>
  );
}

export function Code({ code, title, maxHeight }: { code: string; title?: string; maxHeight?: number }) {
  return <CodeBlock code={code} title={title} className="my-5" maxHeight={maxHeight} />;
}

/* ── Typography ───────────────────────────────────────────── */

export function DocTitle({ kicker, title, lead }: { kicker: string; title: string; lead: ReactNode }) {
  return (
    <header className="mb-8 border-b border-line pb-6">
      <p className="label text-accent-fg">{kicker}</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tighter2 leading-tight">{title}</h1>
      <p className="mt-3 max-w-[72ch] text-lg text-muted leading-relaxed">{lead}</p>
    </header>
  );
}

export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} data-toc="2" className="group mt-12 mb-3 scroll-mt-24 text-2xl font-semibold first:mt-0">
      {children}
      <a href={`#${id}`} aria-label="Link to this section" className="ml-2 inline-flex align-middle text-subtle opacity-0 transition-opacity hover:text-fg focus:opacity-100 group-hover:opacity-100">
        <Link2 className="h-4 w-4" aria-hidden />
      </a>
    </h2>
  );
}

export function H3({ id, children }: { id: string; children: ReactNode }) {
  return <h3 id={id} data-toc="3" className="mt-8 mb-2 scroll-mt-24 text-lg font-semibold">{children}</h3>;
}

export function P({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('mb-4 max-w-[72ch] text-md leading-7 text-fg/90', className)}>{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return <ul className="mb-4 max-w-[72ch] list-[square] space-y-1.5 pl-5 text-md leading-7 marker:text-accent">{children}</ul>;
}

export function OL({ children }: { children: ReactNode }) {
  return <ol className="mb-4 max-w-[72ch] list-decimal space-y-1.5 pl-5 text-md leading-7 marker:text-muted">{children}</ol>;
}

export function C({ children }: { children: ReactNode }) {
  return <code className="whitespace-nowrap border border-line bg-sunken px-1 py-px font-mono text-[12.5px]">{children}</code>;
}

export function DocLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="link">{children}</Link>;
}

export function Note({ tone = 'info', title, children }: { tone?: 'info' | 'held' | 'bad' | 'ok' | 'neutral'; title?: ReactNode; children: ReactNode }) {
  return <Banner tone={tone} title={title} className="my-5 max-w-[80ch]">{children}</Banner>;
}

/* ── Reference tables ─────────────────────────────────────── */

export interface FieldRow { name: string; type: string; required?: boolean; desc: ReactNode }

export function FieldsTable({ rows, caption, nameHeader = 'Field' }: { rows: FieldRow[]; caption: string; nameHeader?: string }) {
  return (
    <div className="my-5 overflow-x-auto border border-line">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-sunken/80">
          <tr className="border-b border-line">
            <th scope="col" className="h-9 px-3 text-left label">{nameHeader}</th>
            <th scope="col" className="h-9 px-3 text-left label">Type</th>
            <th scope="col" className="h-9 px-3 text-left label">Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-b border-line last:border-b-0 align-top">
              <td className="px-3 py-2.5 whitespace-nowrap">
                <span className="font-mono text-[12.5px] font-medium">{r.name}</span>
                {r.required && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-label text-accent-fg">required</span>}
              </td>
              <td className="px-3 py-2.5 whitespace-nowrap font-mono text-[12px] text-muted">{r.type}</td>
              <td className="px-3 py-2.5 text-fg/90 leading-relaxed min-w-[220px]">{r.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SimpleTable({ head, rows, caption }: { head: string[]; rows: ReactNode[][]; caption: string }) {
  return (
    <div className="my-5 overflow-x-auto border border-line">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-sunken/80">
          <tr className="border-b border-line">{head.map((h, i) => <th key={i} scope="col" className="h-9 px-3 text-left label whitespace-nowrap">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-b-0 align-top">
              {r.map((c, j) => <td key={j} className={cn('px-3 py-2.5 leading-relaxed', j === 0 && 'whitespace-nowrap')}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const METHOD_CLS: Record<string, string> = {
  GET: 'border-info/40 text-info-fg bg-info-bg',
  POST: 'border-fg/40 text-fg bg-surface',
  DELETE: 'border-bad/40 text-bad-fg bg-bad-bg',
};

export function Endpoint({ method, path, note }: { method: 'GET' | 'POST' | 'DELETE'; path: string; note?: ReactNode }) {
  return (
    <div className="my-4 flex flex-wrap items-center gap-3 border border-line bg-surface px-3 py-2.5">
      <span className={cn('inline-flex h-6 items-center border px-2 font-mono text-[11.5px] font-semibold', METHOD_CLS[method])}>{method}</span>
      <span className="font-mono text-[13.5px] font-medium break-all">{path}</span>
      {note && <span className="text-xs text-muted sm:ml-auto">{note}</span>}
    </div>
  );
}

export const BASE = 'https://govern.elan1.ai';
export const MCP_URL = `${BASE}/mcp/demo-traders/invoice-bot`;
export const TEST_KEY = 'sk_sbx_7Kq2mV9xR4tB1nP8'; // gitleaks:allow made-up sandbox key shown in the developer docs
export const LIVE_KEY = 'gk_••••••••••••';
