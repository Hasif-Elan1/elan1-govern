import { parseRulebookYaml } from "@gate/core";
import { forOrg } from "@gate/db";
import { BookText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { Pill, RiskPill } from "@/components/ui/status";
import { fmtDate } from "@/lib/utils";
import { requireCtx } from "@/server/session";

export const metadata: Metadata = { title: "Rulebooks" };

export default async function Rulebooks() {
  const ctx = await requireCtx();
  const db = forOrg(ctx.org.id);
  const agents = await db.agent.findMany({ orderBy: { createdAt: "asc" } });
  const books = await db.rulebook.findMany({ where: { id: { in: agents.map((a) => a.activeRulebookId).filter((x): x is string => !!x) } } });
  return (
    <>
      <PageHeader title="Rulebooks" description="One signed rulebook per agent. It decides what the agent may do, and every receipt names the rule that decided." />
      {agents.length === 0 ? (
        <EmptyState icon={<BookText />} title="No rulebooks yet" body="Each agent gets a starter rulebook when you add it." action={{ href: "/agents/new", label: "Add an agent" }} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {agents.map((a) => {
            const rb = books.find((b) => b.id === a.activeRulebookId);
            const parsed = rb ? parseRulebookYaml(rb.yaml) : null;
            const rules = parsed?.ok ? parsed.rulebook.rules : [];
            const count = (d: string) => rules.filter((r) => r.decide === d).length;
            return (
              <li key={a.id}>
                <Link href={`/rulebooks/${a.slug}`} className="block rounded-lg border border-line bg-surface p-5 hover:border-line-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{a.name}</span>
                    <RiskPill tier={a.riskTier} />
                  </div>
                  <p className="mt-1 text-sm text-ink-3">{rb ? `Version ${rb.version}, signed ${fmtDate(rb.createdAt)} by ${rb.signedBy}` : "Not published. Everything is refused."}</p>
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    <Pill tone="ok">{count("allow")} allow</Pill>
                    <Pill tone="wait">{count("ask")} ask</Pill>
                    <Pill tone="no">{count("refuse")} refuse</Pill>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
