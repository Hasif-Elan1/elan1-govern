/** The Gate mark: two posts and a lintel, the lintel drawn as a closed bar. */
export function Logo({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="2.5" y="3" width="19" height="4" rx="1.2" fill="var(--accent)" />
      <rect x="4.5" y="8.5" width="3.5" height="12.5" rx="1" fill="currentColor" />
      <rect x="16" y="8.5" width="3.5" height="12.5" rx="1" fill="currentColor" />
      <rect x="9.25" y="12" width="5.5" height="2" rx="1" fill="currentColor" opacity="0.45" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 text-[17px] font-semibold tracking-tight">
      <Logo />
      Gate
    </span>
  );
}
