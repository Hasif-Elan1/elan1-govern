import { cn } from '@/lib/cn';
import { useUi } from '@/store/ui';

/**
 * Disc derivations from the Brand Book (04.4). One derivation per surface; always a true circle,
 * flat clay, no internal detail; travels on the 50° bearing.
 */
export type DiscKind = 'mark' | 'gate' | 'aperture' | 'orbit' | 'trail' | 'eclipse' | 'progress' | 'control-plane' | 'registration';

const CLAY = 'rgb(var(--accent))';
const INK = 'rgb(var(--fg))';
const LINE = 'rgb(var(--line-strong) / 0.6)';

export function Disc({ kind = 'mark', size = 48, value = 0.62, className, title }: { kind?: DiscKind; size?: number; value?: number; className?: string; title?: string }) {
  const s = size;
  const r = s * 0.3;
  const c = s / 2;
  const label = title ?? `${kind} disc`;
  const common = { width: s, height: s, viewBox: `0 0 ${s} ${s}`, role: 'img' as const, 'aria-label': label, className: cn('shrink-0', className) };
  switch (kind) {
    case 'gate':
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={r} fill={CLAY} />
          <line x1={c} y1={c - r - 1} x2={c} y2={c + r + 1} stroke="rgb(var(--canvas))" strokeWidth={Math.max(1.5, s * 0.04)} />
        </svg>
      );
    case 'aperture':
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={s * 0.44} fill="none" stroke={CLAY} strokeWidth={1} />
          <circle cx={c} cy={c} r={s * 0.31} fill="none" stroke={CLAY} strokeWidth={1} />
          <circle cx={c} cy={c} r={s * 0.16} fill={CLAY} />
        </svg>
      );
    case 'orbit':
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={s * 0.36} fill="none" stroke={INK} strokeWidth={1} />
          <g className="origin-center animate-orbit" style={{ transformOrigin: `${c}px ${c}px` }}>
            <circle cx={c + s * 0.36 * Math.cos((-50 * Math.PI) / 180)} cy={c + s * 0.36 * Math.sin((-50 * Math.PI) / 180)} r={s * 0.09} fill={CLAY} />
          </g>
        </svg>
      );
    case 'trail': {
      const pts = [0.18, 0.34, 0.54].map((t, i) => ({ x: s * (0.18 + t), y: s * (0.82 - t * 1.19), r: s * (0.06 + i * 0.035), o: 0.35 + i * 0.32 }));
      return (
        <svg {...common}>
          {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={p.r} fill={CLAY} opacity={p.o} />)}
        </svg>
      );
    }
    case 'eclipse':
      return (
        <svg {...common}>
          <circle cx={s * 0.4} cy={c} r={r} fill={INK} />
          <circle cx={s * 0.6} cy={c} r={r} fill={CLAY} opacity={0.9} />
        </svg>
      );
    case 'progress': {
      const rr = s * 0.38;
      const circ = 2 * Math.PI * rr;
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={rr} fill="none" stroke={LINE} strokeWidth={s * 0.1} />
          <circle cx={c} cy={c} r={rr} fill="none" stroke={CLAY} strokeWidth={s * 0.1} strokeDasharray={`${circ * value} ${circ}`} transform={`rotate(-90 ${c} ${c})`} />
        </svg>
      );
    }
    case 'control-plane':
      return (
        <svg {...common}>
          <line x1={s * 0.08} y1={s * 0.62} x2={s * 0.92} y2={s * 0.62} stroke={INK} strokeWidth={1} />
          {Array.from({ length: 10 }).map((_, i) => <circle key={i} cx={s * (0.1 + i * 0.089)} cy={s * 0.48} r={s * 0.032} fill={i === 0 ? CLAY : 'rgb(var(--subtle))'} />)}
        </svg>
      );
    case 'registration':
      return (
        <svg {...common}>
          <line x1={0} y1={c} x2={s} y2={c} stroke={LINE} strokeWidth={1} />
          <line x1={c} y1={0} x2={c} y2={s} stroke={LINE} strokeWidth={1} />
          <circle cx={c} cy={c} r={r} fill="none" stroke={CLAY} strokeWidth={1.5} />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx={c} cy={c} r={r} fill={CLAY} />
        </svg>
      );
  }
}

/** Progress arc with a centred figure — the coverage device. */
export function ProgressArc({ value, size = 72, label }: { value: number; size?: number; label?: string }) {
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <Disc kind="progress" size={size} value={value} title={label ?? `${Math.round(value * 100)}%`} />
      <span className="absolute font-display font-semibold num" style={{ fontSize: size * 0.24 }}>{Math.round(value * 100)}%</span>
    </div>
  );
}

/** The supplied lockup artwork — never re-typeset. */
export function Logo({ height = 22, variant, className }: { height?: number; variant?: 'navy' | 'white'; className?: string }) {
  const theme = useUi((s) => s.theme);
  const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
  const v = variant ?? (dark || theme === 'dark' ? 'white' : 'navy');
  return <img src={v === 'white' ? '/logo-white.png' : '/logo-navy.png'} alt="elan1" style={{ height }} className={cn('w-auto select-none', className)} draggable={false} />;
}

/** "Elan1 Govern" product wordmark set in type next to the supplied lockup — an app is never given its own logo. */
export function ProductMark({ inverse, compact }: { inverse?: boolean; compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Logo height={compact ? 18 : 20} variant={inverse ? 'white' : undefined} />
      {!compact && <span className={cn('font-display text-[15px] font-semibold tracking-tightish pl-2.5 border-l', inverse ? 'text-paper border-ink-600' : 'text-fg border-line')}>Govern</span>}
    </span>
  );
}
