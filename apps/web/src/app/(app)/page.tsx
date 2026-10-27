import { describeAction } from "@gate/core";
import { forOrg } from "@gate/db";
import { Inbox, ShieldCheck, ShieldX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, EmptyState, Section } from "@/components/ui/layout";
import { cn, timeLeft } from "@/lib/utils";
import { can } from "@/server/policy";
import { activity, chainStatus, todayStats } from "@/server/queries";
import { requireCtx } from "@/server/session";
import { suggestionTotals, totalsLine } from "@/server/suggestions";
import { DemoButton, LiveFeed } from "./today-client";

export const metadata: Metadata = { title: "Today" };

function greeting() {
  const h = Number(new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function Stat({ label, value, tone, href }: { label: string; value: React.ReactNode; tone?: "ok" | "wait" | "no"; href?: string }) {
  const body = (
    <>
      <span className="text-[13px] text-ink-3">{label}</span>
      <span className={cn("mt-1 block text-2xl font-semibold tabular-nums", tone === "ok" && "text-ok", tone === "wait" && "text-wait", tone === "no" && "text-no")}>{value}</span>
    </>
  );
  return href ? (
    <Link href={href} className="rounded-lg border border-line bg-surface px-4 py-3.5 hover:border-line-2">
      {body}
    </Link>
  ) : (
    <div className="rounded-lg border border-line bg-surface px-4 py-3.5">{body}</div>
  );
}

export default async function Today() {
  const ctx = await requireCtx();
  const db = forOrg(ctx.org.id);
  const mineWhere = { status: "pending" as const, expiresAt: { gt: new Date() }, approvers: { has: ctx.user.email } };
  const [stats, chain, feed, agents, mine, mineCount, suggested] = await Promise.all([
    todayStats(ctx.org.id),
    chainStatus(ctx.org.id),
    activity(ctx.org.id, { limit: 25 }),
    db.agent.count(),
    db.approval.findMany({ where: mineWhere, orderBy: { createdAt: "asc" }, take: 3 }),
    db.approval.count({ where: mineWhere }),
    suggestionTotals(ctx.org.id),
  ]);
  const suggestionLine = totalsLine(suggested);
  const first = ctx.user.name.split(" ")[0];
  const canDecide = can(ctx.role, "approvals:decide");
  const date = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" });

  return (
    <>
      <header className="mb-8">
        <p className="text-sm text-ink-3">{date}</p>
        <h1 className="mt-1 text-[28px] leading-tight font-semibold">
          {greeting()}, {first}
        </h1>
      </header>

      {agents === 0 ? (
        <EmptyState
          title="No agents yet"
          body="Elan1 Govern sits between an AI agent and your tools. Start with the demo agent: it pays invoices from a pretend inbox, so you can see what Elan1 Govern allows, holds and stops."
          action={can(ctx.role, "demo:run") ? <DemoButton /> : { href: "/agents", label: "See agents" }}
        />
      ) : (
        <>
          <Card className={cn("overflow-hidden", mine.length ? "border-wait-line" : "")}>
            <div className={cn("flex flex-wrap items-center gap-4 px-5 py-5 sm:px-6", mine.length ? "bg-wait-soft" : "")}>
              <div className={cn("flex size-11 items-center justify-center rounded-full", mine.length ? "bg-surface text-wait" : "bg-sunken text-ink-3")}>
                <Inbox className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xl font-semibold">
                  {mineCount ? `${mineCount === 1 ? "1 action is" : `${mineCount} actions are`} waiting for you` : stats.waiting ? `${stats.waiting} waiting for other approvers` : "Nothing is waiting for you"}
                </p>
                <p className="mt-0.5 text-sm text-ink-2">
                  {mine.length ? "Your agents stopped and asked before doing these." : "When a rule needs a person, it shows up here and in your email."}
                </p>
              </div>
              {mine.length && canDecide ? (
                <Link href={mineCount === 1 ? `/approvals/${mine[0]!.id}` : "/approvals"} className={buttonVariants({ variant: "primary", size: "lg" })}>
                  Review {mineCount === 1 ? "it" : "them"}
                </Link>
              ) : null}
            </div>
            {mine.length ? (
              <ul className="divide-y divide-line border-t border-wait-line">
                {mine.map((a) => (
                  <li key={a.id}>
                    <Link href={`/approvals/${a.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[14.5px] hover:bg-sunken sm:px-6">
                      <span className="font-medium">{describeAction(a.tool, a.argsSummary as Record<string, unknown>)}</span>
                      <span className="text-[13px] text-ink-3">{timeLeft(a.expiresAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Actions today" value={stats.total} href="/activity" />
            <Stat label="Allowed" value={stats.allowed} tone="ok" href="/activity?decision=allow" />
            <Stat label="Waiting" value={stats.waiting} tone="wait" href="/approvals" />
            <Stat label="Refused" value={stats.refused} tone="no" href="/activity?decision=refuse" />
            <Link href="/evidence" className="col-span-2 rounded-lg border border-line bg-surface px-4 py-3.5 hover:border-line-2 sm:col-span-1">
              <span className="text-[13px] text-ink-3">Evidence chain</span>
              <span className={cn("mt-1 flex items-center gap-1.5 text-xl font-semibold", chain.ok ? "text-ok" : "text-no")}>
                {chain.ok ? <ShieldCheck className="size-5" /> : <ShieldX className="size-5" />}
                {chain.ok ? "Intact" : `Broken at ${chain.seq}`}
              </span>
            </Link>
          </div>

          {suggestionLine ? (
            <p className="mt-5 text-sm text-ink-2" data-testid="suggestions-line">
              {suggestionLine}{" "}
              <Link href="/rulebooks" className="font-medium text-accent hover:underline">
                See suggestions
              </Link>
            </p>
          ) : null}

          <Section title="Live activity" description="Every action your agents try, as it happens." className="mt-10" actions={<Link href="/activity" className="text-sm font-medium text-accent hover:underline">All activity</Link>}>
            <LiveFeed initial={feed} />
          </Section>
        </>
      )}
    </>
  );
}
