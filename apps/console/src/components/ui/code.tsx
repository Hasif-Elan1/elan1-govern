import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return { copied, copy };
}

export function CopyButton({ text, label = 'Copy', className, compact }: { text: string; label?: string; className?: string; compact?: boolean }) {
  const { copied, copy } = useCopy();
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); copy(text); }} aria-label={copied ? 'Copied' : label} title={copied ? 'Copied' : label}
      className={cn('inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-fg transition-colors', compact ? 'h-6 w-6 justify-center' : 'h-7 px-2 border border-line bg-surface hover:border-line-strong', className)}>
      {copied ? <Check className="h-3.5 w-3.5 text-ok" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      {!compact && (copied ? 'Copied' : label)}
    </button>
  );
}

/** A hash shown short, full value on hover and copy. Hashes are always monospaced. */
export function Hash({ value, len = 12, className, copy = true }: { value?: string; len?: number; className?: string; copy?: boolean }) {
  if (!value) return <span className="text-subtle">—</span>;
  return (
    <span className={cn('inline-flex items-center gap-1 font-mono text-[12px] text-muted', className)} title={value}>
      <span>{value.slice(0, len)}{value.length > len && '…'}</span>
      {copy && <CopyButton text={value} compact label="Copy hash" />}
    </span>
  );
}

export function CodeBlock({ code, language, title, className, maxHeight, wrap }: { code: string; language?: string; title?: ReactNode; className?: string; maxHeight?: number; wrap?: boolean }) {
  return (
    <div className={cn('border border-line bg-sunken/70', className)}>
      <div className="flex items-center justify-between gap-2 px-3 h-9 border-b border-line">
        <span className="label">{title ?? language ?? 'Code'}</span>
        <CopyButton text={code} />
      </div>
      <pre className={cn('overflow-auto p-4 text-[12.5px] leading-[1.65] font-mono text-fg', wrap && 'whitespace-pre-wrap break-all')} style={{ maxHeight }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Pretty JSON with key colouring in the house palette (ink keys, kiln strings, cobalt numbers). */
export function JsonView({ value, className, maxHeight }: { value: unknown; className?: string; maxHeight?: number }) {
  const json = JSON.stringify(value, null, 2);
  const html = json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (m) => {
      let cls = 'text-info-fg';
      if (m.startsWith('"')) cls = m.endsWith(':') ? 'text-fg font-medium' : 'text-accent-fg';
      else if (/true|false|null/.test(m)) cls = 'text-held-fg';
      return `<span class="${cls}">${m}</span>`;
    });
  return (
    <div className={cn('relative border border-line bg-sunken/70', className)}>
      <div className="absolute right-2 top-2"><CopyButton text={json} /></div>
      <pre className="overflow-auto p-4 pr-20 text-[12px] leading-[1.6] font-mono" style={{ maxHeight }} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return <code className="px-1 py-px bg-sunken border border-line text-[12.5px] font-mono">{children}</code>;
}
