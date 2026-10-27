import { parseRulebookYaml } from "@gate/core";
import { forOrg } from "@gate/db";
import { BookText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { LookForSuggestions, SuggestionCard } from "@/components/suggestion-card";
import { EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { Pill, RiskPill } from "@/components/ui/status";
import { fmtDate } from "@/lib/utils";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { openSuggestions } from "@/server/suggestions";

export const metadata: Metadata = { title: "Rulebooks" };

export default async function Rulebooks() {
  const ctx = await requireCtx();
  const db = forOrg(ctx.org.id);
  const agents = await db.agent.findMany({ orderBy: { createdAt: "asc" } });
  const books = await db.rulebook.findMany({ where: { id: { in: agents.map((a) => a.activeRulebookId).filter((x): x is string => !!x) } } });
  const suggestions = await openSuggestions(ctx.org.id);
  const canManage = can(ctx.role, "suggestions:manage");
  return (
    <>
      <PageHeader title="Rulebooks" description="One signed rulebook per agent. It decides what the agent may do, and every receipt names the rule that decided." />
      {agents.length === 0 ? (
        <EmptyState icon={<BookText />} title="No rulebooks yet" body="Each agent gets a starter rulebook when you add it." action={{ href: "/agents/new", label: "Add an agent" }} />
      ) : (
        <>
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
                    {suggestions.some((s) => s.agentSlug === a.slug) ? (
                      <Pill tone="accent">
                        {suggestions.filter((s) => s.agentSlug === a.slug).length === 1 ? "1 suggestion" : `${suggestions.filter((s) => s.agentSlug === a.slug).length} suggestions`}
                      </Pill>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
        <Section
          title="Suggestions"
          description="Actions people approve every time, which a rule could allow instead. Opening one makes a draft; nothing changes until someone signs and publishes it."
          actions={canManage ? <LookForSuggestions /> : undefined}
          className="mt-10"
        >
          {suggestions.length ? (
            <ul className="grid gap-4" data-testid="suggestions">
              {suggestions.map((s) => (
                <SuggestionCard key={s.id} s={s} canManage={canManage} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-3">No suggestions right now. Elan1 Govern looks at the last 30 days of approvals every night.</p>
          )}
        </Section>
        </>
      )}
    </>
  );
}
