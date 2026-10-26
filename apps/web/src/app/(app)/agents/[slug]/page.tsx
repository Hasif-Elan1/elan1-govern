import { builtinRegistry, describeRule, lenientRegistry, parseRulebookYaml, RISK_QUESTIONS } from "@gate/core";
import { forOrg, prisma } from "@gate/db";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectorIcons, connectorsOf } from "@/components/agent-bits";
import { buttonVariants } from "@/components/ui/button";
import { Card, KeyValue, PageHeader, Section } from "@/components/ui/layout";
import { Pill, RiskPill } from "@/components/ui/status";
import { fmtDate, relative } from "@/lib/utils";
import { env } from "@/server/env";
import { can } from "@/server/policy";
import { activity } from "@/server/queries";
import { requireCtx } from "@/server/session";
import { AgentTabs, KillSwitch } from "./client";

export const metadata: Metadata = { title: "Agent" };

export default async function AgentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireCtx();
  const db = forOrg(ctx.org.id);
  const agent = await db.agent.findFirst({ where: { slug } });
  if (!agent) notFound();
  const [rb, keys, recent, creator] = await Promise.all([
    agent.activeRulebookId ? db.rulebook.findFirst({ where: { id: agent.activeRulebookId } }) : null,
    db.apiKey.findMany({ where: { agentId: agent.id }, orderBy: { createdAt: "desc" } }),
    activity(ctx.org.id, { agent: agent.slug, limit: 12 }),
    agent.createdById ? prisma.user.findUnique({ where: { id: agent.createdById }, select: { email: true } }) : null,
  ]);
  const parsed = rb ? parseRulebookYaml(rb.yaml, lenientRegistry(builtinRegistry)) : null; // upstream tools are not in the built-in registry
  const rules = parsed?.ok ? parsed.rulebook.rules : [];
  const answers = (agent.riskAnswers ?? {}) as Record<string, string>;
  const manage = can(ctx.role, "agents:manage");

  const overview = (
    <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr]">
      <div className="grid content-start gap-8">
        <Section title="About">
          <Card className="p-5">
            <p className="mb-5 text-[15px]">{agent.purpose}</p>
            <KeyValue
              items={[
                ["Owner", agent.ownerEmail],
                ["Set up by", creator?.email ?? "Unknown"],
                ["Added", fmtDate(agent.createdAt)],
                ["Last action", relative(agent.lastActionAt)],
                ["Connectors", <ConnectorIcons key="c" kinds={connectorsOf(rb?.yaml)} />],
                ["Rulebook", rb ? `Version ${rb.version}, signed by ${rb.signedBy}` : "None published"],
              ]}
            />
          </Card>
        </Section>
        <Section title="Risk">
          <Card className="p-5">
            <div className="mb-4 flex items-center gap-2">
              <RiskPill tier={agent.riskTier} />
              <span className="text-sm text-ink-3">from the setup questions</span>
            </div>
            <ul className="grid gap-2 text-sm">
              {RISK_QUESTIONS.map((q) => {
                const opt = q.options.find(([v]) => v === answers[q.id]);
                return (
                  <li key={q.id} className="flex justify-between gap-4">
                    <span className="text-ink-2">{q.text}</span>
                    <span className="shrink-0 font-medium">{opt ? opt[1] : "—"}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        </Section>
      </div>
      <Section title="Recent activity" actions={<Link href={`/activity?agent=${agent.slug}`} className="text-sm font-medium text-accent hover:underline">All</Link>}>
        {recent.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface text-sm">
            {recent.map((r) => (
              <li key={r.seq}>
                <Link href={`/activity?r=${r.seq}&agent=${agent.slug}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-sunken">
                  <span className="min-w-0 truncate">{r.title}</span>
                  <span className="shrink-0 text-[13px] text-ink-3">{relative(r.ts)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-3">Nothing yet. Connect the agent using its MCP address and key.</p>
        )}
      </Section>
    </div>
  );

  const rulebook = (
    <div className="grid gap-6">
      {rb ? (
        <>
          <p className="text-sm text-ink-2">
            Version {rb.version}, signed by {rb.signedBy} on {fmtDate(rb.createdAt)}. Anything not listed is refused.
          </p>
          <ul className="grid gap-2">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-4 py-3">
                <span className="text-[14.5px]">{describeRule(r)}</span>
                <code className="font-mono text-[12.5px] text-ink-3">{r.id}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-ink-2">No rulebook yet, so every action is refused.</p>
      )}
      <div>
        <Link href={`/rulebooks/${agent.slug}`} className={buttonVariants({ variant: manage ? "primary" : "secondary" })}>
          {manage ? "Edit rules" : "Open the rulebook"}
        </Link>
      </div>
    </div>
  );

  return (
    <>
      <PageHeader
        back={{ href: "/agents", label: "Agents" }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {agent.name}
            {agent.status === "active" ? <Pill tone="ok">Active</Pill> : <Pill tone="no">Paused</Pill>}
          </span>
        }
        description={`${agent.slug}, owned by ${agent.ownerEmail}`}
        actions={manage ? <KillSwitch slug={agent.slug} name={agent.name} paused={agent.status === "paused"} /> : null}
      />
      {agent.status === "paused" ? (
        <p className="-mt-2 mb-6 rounded-lg border border-no-line bg-no-soft px-4 py-3 text-sm text-ink">This agent is paused. Elan1 Govern refuses every call it makes until someone resumes it.</p>
      ) : null}
      <AgentTabs
        overview={overview}
        rulebook={rulebook}
        slug={agent.slug}
        manage={manage}
        mcpUrl={`${env().GATE_PUBLIC_URL}/mcp`}
        gateUrl={env().GATE_PUBLIC_URL}
        keys={keys.map((k) => ({ id: k.id, label: k.label, prefix: k.prefix, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null }))}
      />
    </>
  );
}
