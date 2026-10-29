import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle2, AlertTriangle, Info, OctagonX } from 'lucide-react';
import { create } from 'zustand';
import { cn } from '@/lib/cn';
import { IconButton } from './core';

/** Open modal layers, innermost last. Only the top layer handles Escape when focus is on nothing in particular. */
const modalStack: HTMLElement[] = [];

/**
 * Focus trap for modal layers (Dialog, Drawer, the mobile navigation sheet).
 * The effect depends on `open` only: callers pass inline onClose functions, and re-running the
 * effect on every parent render would pull focus back to the first field while the user types.
 * Escape and Tab are handled only when the key press happens inside this layer, so a palette
 * or menu opened on top of a dialog gets its own Escape first.
 */
export function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el) modalStack.push(el);
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),textarea,input:not([disabled]),select,[tabindex]:not([tabindex="-1"])') ?? []);
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0];
    const t = window.setTimeout(() => first?.focus(), 20);
    const inside = (e: KeyboardEvent) => {
      const target = e.target as Node | null;
      if (el && target && el.contains(target)) return true;
      // nothing focused (focus fell back to the body): the top-most layer owns the key
      const nothingFocused = !target || target === document.body || target === document.documentElement;
      return nothingFocused && modalStack[modalStack.length - 1] === el;
    };
    const onKey = (e: KeyboardEvent) => {
      if (!inside(e)) return;
      if (e.key === 'Escape') { e.stopPropagation(); cb.current(); return; }
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const a = f[0], z = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.style.overflow = 'hidden';
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      const i = el ? modalStack.lastIndexOf(el) : -1;
      if (i >= 0) modalStack.splice(i, 1);
      if (!modalStack.length) document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [open]);
  return ref;
}

/** True while any Dialog, Drawer or sheet that uses the focus trap is open. Global shortcuts check it. */
export function isModalOpen() {
  return modalStack.length > 0;
}

export function Dialog({ open, onClose, title, description, children, footer, size = 'md', tone }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; tone?: 'danger';
}) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  const w = { sm: 'max-w-[420px]', md: 'max-w-[560px]', lg: 'max-w-[760px]', xl: 'max-w-[1040px]' }[size];
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-ink-900/55 p-4 pt-[10vh] animate-fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className={cn('w-full bg-surface border border-line shadow-e4 animate-rise-in', w, tone === 'danger' && 'border-t-[3px] border-t-bad')}>
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-line">
          <div>
            <h2 className="text-xl font-semibold">{title}</h2>
            {description && <p className="mt-1 text-sm text-muted leading-relaxed">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose} size="sm"><X className="h-4 w-4" /></IconButton>
        </div>
        {children && <div className="px-6 py-5">{children}</div>}
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 px-6 py-4 border-t border-line bg-sunken/40">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ open, onClose, title, kicker, children, footer, width = 560, actions }: {
  open: boolean; onClose: () => void; title: ReactNode; kicker?: string; children: ReactNode; footer?: ReactNode; width?: number; actions?: ReactNode;
}) {
  const ref = useFocusTrap(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end bg-ink-900/35 animate-fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" className="h-full bg-surface border-l border-line shadow-e4 flex flex-col animate-slide-in-right max-w-full" style={{ width }}>
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-line">
          <div className="min-w-0">
            {kicker && <p className="label mb-1">{kicker}</p>}
            <h2 className="text-xl font-semibold truncate">{title}</h2>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {actions}
            <IconButton label="Close" onClick={onClose} size="sm"><X className="h-4 w-4" /></IconButton>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-line bg-sunken/40 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ── Dropdown menu ────────────────────────────────────────── */

export function Menu({ trigger, items, align = 'right', width = 240 }: {
  trigger: (p: { open: boolean; toggle: () => void }) => ReactNode;
  items: ({ label: ReactNode; onSelect: () => void; icon?: ReactNode; danger?: boolean; hint?: ReactNode; disabled?: boolean } | 'sep' | { heading: string })[];
  align?: 'left' | 'right'; width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div role="menu" className={cn('absolute z-50 mt-1 bg-surface border border-line shadow-e3 py-1 animate-fade-in', align === 'right' ? 'right-0' : 'left-0')} style={{ width }}>
          {items.map((it, i) =>
            it === 'sep' ? <div key={i} className="my-1 h-px bg-line" /> :
            'heading' in it ? <p key={i} className="label px-3 pt-2 pb-1">{it.heading}</p> : (
              <button key={i} role="menuitem" disabled={it.disabled} onClick={() => { setOpen(false); it.onSelect(); }} className={cn('w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-sunken disabled:opacity-40', it.danger ? 'text-bad-fg' : 'text-fg')}>
                {it.icon && <span className="text-muted shrink-0">{it.icon}</span>}
                <span className="flex-1 min-w-0">{it.label}</span>
                {it.hint && <span className="text-xs text-subtle">{it.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/* ── Toasts ───────────────────────────────────────────────── */

interface Toast { id: number; tone: 'ok' | 'bad' | 'info' | 'held'; title: string; body?: ReactNode; action?: { label: string; onClick: () => void } }
const useToasts = create<{ items: Toast[]; push: (t: Omit<Toast, 'id'>) => void; dismiss: (id: number) => void }>((set) => ({
  items: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items.slice(-3), { ...t, id }] }));
    window.setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== id) })), t.action ? 7000 : 4500);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

export const toast = {
  ok: (title: string, body?: ReactNode, action?: Toast['action']) => useToasts.getState().push({ tone: 'ok', title, body, action }),
  bad: (title: string, body?: ReactNode) => useToasts.getState().push({ tone: 'bad', title, body }),
  info: (title: string, body?: ReactNode, action?: Toast['action']) => useToasts.getState().push({ tone: 'info', title, body, action }),
  held: (title: string, body?: ReactNode) => useToasts.getState().push({ tone: 'held', title, body }),
};

export function Toaster() {
  const { items, dismiss } = useToasts();
  const icon = { ok: <CheckCircle2 className="h-4 w-4 text-ok" />, bad: <OctagonX className="h-4 w-4 text-bad" />, info: <Info className="h-4 w-4 text-info" />, held: <AlertTriangle className="h-4 w-4 text-held" /> };
  return createPortal(
    <div aria-live="polite" className="fixed bottom-4 right-4 z-[90] flex flex-col gap-2 w-[380px] max-w-[calc(100vw-2rem)]">
      {items.map((t) => (
        <div key={t.id} className="flex items-start gap-3 bg-ink-800 text-paper border border-ink-700 shadow-e4 px-4 py-3 animate-rise-in">
          <span className="mt-0.5">{icon[t.tone]}</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">{t.title}</p>
            {t.body && <div className="text-sm text-ink-200 mt-0.5">{t.body}</div>}
            {t.action && <button className="mt-2 text-sm font-semibold text-ember underline underline-offset-2" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
          </div>
          <button aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-ink-300 hover:text-paper"><X className="h-4 w-4" /></button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/* ── Tooltip (hover/focus) ────────────────────────────────── */

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' }) {
  return (
    <span className="relative inline-flex group/tt">
      {children}
      <span role="tooltip" className={cn('pointer-events-none absolute left-1/2 -translate-x-1/2 z-50 w-max max-w-[280px] bg-ink-800 text-paper text-xs px-2.5 py-1.5 opacity-0 group-hover/tt:opacity-100 group-focus-within/tt:opacity-100 transition-opacity delay-150', side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5')}>
        {content}
      </span>
    </span>
  );
}
