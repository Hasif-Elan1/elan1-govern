import { cn } from "@/lib/utils";

export type YamlDiffLine = { type: "same" | "add" | "remove" | "gap"; text: string };

/** A line diff of two rulebook YAMLs: added lines green, removed red. Used by the history tab and suggestions. */
export function YamlDiff({ lines, className, testId = "diff" }: { lines: YamlDiffLine[]; className?: string; testId?: string }) {
  return (
    <pre className={cn("max-h-[420px] overflow-auto rounded-lg border border-line bg-sunken py-2 font-mono text-[12px] leading-relaxed", className)} data-testid={testId}>
      {lines.map((d, i) => (
        <div key={i} className={cn("px-3", d.type === "add" && "bg-ok-soft text-ok", d.type === "remove" && "bg-no-soft text-no", d.type === "gap" && "text-ink-3")}>
          {d.type === "add" ? "+ " : d.type === "remove" ? "- " : "  "}
          {d.text}
        </div>
      ))}
    </pre>
  );
}
