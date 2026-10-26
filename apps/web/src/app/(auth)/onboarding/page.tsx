import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentCtx } from "@/server/session";
import { DemoStart, OrgForm } from "../forms";

export const metadata: Metadata = { title: "Get started" };

const STEPS = ["Your company", "Try it out"];

export default async function Onboarding({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const ctx = await currentCtx();
  if (ctx === null) redirect("/login");
  const { step } = await searchParams;
  const onDemo = ctx !== "no-org" && step === "demo";
  if (ctx !== "no-org" && !onDemo) redirect("/");

  return (
    <>
      <ol className="mb-8 flex gap-6 text-sm">
        {STEPS.map((s, i) => {
          const active = (onDemo ? 1 : 0) === i;
          return (
            <li key={s} className={active ? "font-medium text-ink" : "text-ink-3"}>
              <span className={`mr-2 inline-flex size-5 items-center justify-center rounded-full text-xs ${active ? "bg-accent text-accent-ink" : "border border-line-2"}`}>{i + 1}</span>
              {s}
            </li>
          );
        })}
      </ol>
      {onDemo ? (
        <>
          <h1 className="text-2xl font-semibold">See Gate stop an agent</h1>
          <p className="mt-1.5 text-ink-2">The demo agent pays vendor invoices using a pretend Gmail inbox and Zoho Books. In about ten seconds it will:</p>
          <ul className="mt-4 mb-7 grid gap-2 text-[15px]">
            <li className="flex gap-3"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-ok" />read three invoice emails, and pay ₹18,000 on its own</li>
            <li className="flex gap-3"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-wait" />ask you before paying ₹2,00,000</li>
            <li className="flex gap-3"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-no" />be stopped when it tries to change a vendor's bank account</li>
          </ul>
          <DemoStart />
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold">What's your company called?</h1>
          <p className="mt-1.5 mb-7 text-ink-2">Gate creates a signing key for it. Every receipt your agents produce is signed with this key.</p>
          <OrgForm />
        </>
      )}
    </>
  );
}
