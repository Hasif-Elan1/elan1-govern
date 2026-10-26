import { cn } from "@/lib/utils";

/** Share of requirements backed by live evidence. */
export function CoverageBar({ percent, className }: { percent: number; className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Coverage">
        <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
      <span className="w-10 text-right text-sm font-semibold tabular-nums">{percent}%</span>
    </div>
  );
}
