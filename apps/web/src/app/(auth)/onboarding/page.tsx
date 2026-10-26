import { packFor } from "@gate/core/frameworks";
import { forOrg } from "@gate/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { can } from "@/server/policy";
import { currentCtx } from "@/server/session";
import { DemoStart, IndustryForm, OrgForm } from "../forms";

export const metadata: Metadata = { title: "Get started" };

const STEPS = ["Your company", "Your industry", "Try it out"];

export default async function Onboarding({ searchParams }: { searchParams: Promise<{ step?: string; then?: string }> }) {
  const ctx = await currentCtx();
  if (ctx === null) redirect("/login");
  const { step, then } = await searchParams;
  if (ctx === "no-org") return <Flow active={0} />;
  if (step === "industry") {
    if (!can(ctx.role, "compliance:manage")) redirect("/compliance");
    const org = await forOrg(ctx.org.id).org.findFirstOrThrow();
    // From the Compliance page ("Change"): no step list, and back to Compliance afterwards.
    const changing = then === "compliance";
    return <Flow active={1} hideSteps={changing} industry={org.industry} regions={org.regions} next={changing ? "/compliance" : "/onboarding?step=demo"} />;
  }
  if (step === "demo") {
    const org = await forOrg(ctx.org.id).org.findFirstOrThrow();
    return <Flow active={2} industry={org.industry} />;
  }
  redirect("/");
}

function Flow({ active, hideSteps, industry, regions, next }: { active: number; hideSteps?: boolean; industry?: string | null; regions?: string[]; next?: string }) {
  return (
    <>
      {hideSteps ? null : (
        <ol className="mb-8 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {STEPS.map((s, i) => (
            <li key={s} className={active === i ? "font-medium text-ink" : "text-ink-3"}>
              <span className={`mr-2 inline-flex size-5 items-center justify-center rounded-full text-xs ${active === i ? "bg-accent text-accent-ink" : "border border-line-2"}`}>{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      )}
      {active === 0 ? (
        <>
          <h1 className="text-2xl font-semibold">What's your company called?</h1>
          <p className="mt-1.5 mb-7 text-ink-2">Gate creates a signing key for it. Every receipt your agents produce is signed with this key.</p>
          <OrgForm />
        </>
      ) : active === 1 ? (
        <>
          <h1 className="text-2xl font-semibold">What will your agents work on?</h1>
          <p className="mt-1.5 mb-7 text-ink-2">Gate turns on the frameworks that usually apply, and new agents start from rules that suit the work. You can change all of it later.</p>
          <IndustryForm industry={industry ?? null} regions={regions ?? []} next={next ?? "/onboarding?step=demo"} />
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold">See Gate stop an agent</h1>
          <p className="mt-1.5 text-ink-2">The demo agent pays vendor invoices using a pretend Gmail inbox and Zoho Books. In about ten seconds it will:</p>
          <ul className="mt-4 mb-4 grid gap-2 text-[15px]">
            <li className="flex gap-3"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-ok" />read three invoice emails, and pay ₹18,000 on its own</li>
            <li className="flex gap-3"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-wait" />ask you before paying ₹2,00,000</li>
            <li className="flex gap-3"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-no" />be stopped when it tries to change a vendor's bank account</li>
          </ul>
          {industry && industry !== "finance" ? (
            <p className="mb-7 text-sm text-ink-2">The demo is about accounts payable, but the checks work the same way for any work. Your own agents start from the {packFor(industry).name.toLowerCase()} rules.</p>
          ) : (
            <div className="mb-3" />
          )}
          <DemoStart />
        </>
      )}
    </>
  );
}
