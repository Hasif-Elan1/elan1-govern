import { TOOLS, isKnownTool, parseRulebookYaml } from "@gate/core/browser";
import { Mail, ReceiptIndianRupee } from "lucide-react";
import { Pill } from "@/components/ui/status";

export function connectorsOf(yaml: string | undefined): ("gmail" | "zoho")[] {
  if (!yaml) return [];
  const p = parseRulebookYaml(yaml);
  if (!p.ok) return [];
  return [...new Set(p.rulebook.rules.filter((r) => r.decide !== "refuse" && isKnownTool(r.tool)).map((r) => TOOLS[r.tool as keyof typeof TOOLS].connector))];
}

export function ConnectorIcons({ kinds }: { kinds: ("gmail" | "zoho")[] }) {
  if (!kinds.length) return <span className="text-ink-3">None</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {kinds.map((k) => (
        <Pill key={k} icon={k === "gmail" ? <Mail /> : <ReceiptIndianRupee />}>
          {k === "gmail" ? "Gmail" : "Zoho Books"}
        </Pill>
      ))}
    </span>
  );
}

