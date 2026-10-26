import { evidenceCounts, forOrg, FRAMEWORKS } from "@gate/db";
import { ShieldCheck, ShieldX } from "lucide-react";
import type { Metadata } from "next";
import { Card, KeyValue, PageHeader, Section } from "@/components/ui/layout";
import { Pill } from "@/components/ui/status";
import { fmtDateTime, istDay, shortHash } from "@/lib/utils";
import { can } from "@/server/policy";
import { chainStatus } from "@/server/queries";
import { requireCtx } from "@/server/session";
import { CheckpointButton, ExportForm } from "./client";

export const metadata: Metadata = { title: "Evidence" };

export default async function Evidence() {
  const ctx = await requireCtx();
  const db = forOrg(ctx.org.id);
  const [chain, checkpoints, controls, counts] = await Promise.all([
    chainStatus(ctx.org.id),
    db.checkpoint.findMany({ orderBy: { seq: "desc" }, take: 8 }),
    db.control.findMany({ orderBy: { code: "asc" } }),
    evidenceCounts(ctx.org.id),
  ]);
  const today = istDay();
  const monthStart = `${today.slice(0, 8)}01`;

  return (
    <>
      <PageHeader title="Evidence" description="Proof of what your agents did, built from signed receipts. Auditors can check it offline, without an account." />

      <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-ink-3">Evidence chain</p>
              <p className={`mt-1 flex items-center gap-2 text-2xl font-semibold ${chain.ok ? "text-ok" : "text-no"}`}>
                {chain.ok ? <ShieldCheck className="size-6" /> : <ShieldX className="size-6" />}
                {chain.ok ? "Intact" : "Broken"}
              </p>
            </div>
            {can(ctx.role, "evidence:checkpoint") ? <CheckpointButton /> : null}
          </div>
          {chain.ok ? (
            <p className="mt-2 text-sm text-ink-2">All {chain.count} receipts link up and carry valid signatures.</p>
          ) : (
            <p className="mt-2 text-sm text-no">Receipt {chain.seq}: {chain.reason}.</p>
          )}
          <KeyValue
            className="mt-5"
            items={[
              ["Receipts", String(chain.ok ? chain.count : "—")],
              ["Signing key", <code key="k" className="font-mono text-[13px]">{chain.fingerprint}</code>],
              ["Last checkpoint", chain.lastCheckpoint ? `Receipt ${chain.lastCheckpoint.seq}, ${fmtDateTime(chain.lastCheckpoint.ts)}` : "None yet (one is signed every hour)"],
            ]}
          />
        </Card>

        <Card className="p-5">
          <h2 className="text-[17px] font-semibold">Download for your auditor</h2>
          <p className="mt-1 mb-4 text-sm text-ink-2">
            The auditor pack is a PDF summary and the signed receipts for the dates you pick. Anyone can check it with <code className="font-mono text-[13px]">gate verify</code>.
          </p>
          {can(ctx.role, "evidence:export") ? <ExportForm from={monthStart} to={today} /> : <p className="text-sm text-ink-3">Owners, admins and auditors can download evidence.</p>}
        </Card>
      </div>

      <Section title="Compliance map" className="mt-12" description="Each control Gate enforces, where a reviewer might look in each framework, and how many real receipts back it." actions={<Pill tone="wait">Draft — needs legal review</Pill>}>
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="border-b border-line bg-sunken/60 text-left text-[13px] text-ink-3">
              <tr>
                <th className="px-4 py-2.5 font-medium">Control</th>
                {FRAMEWORKS.map((f) => (
                  <th key={f} className="px-3 py-2.5 font-medium whitespace-nowrap">
                    {f}
                  </th>
                ))}
                <th className="px-4 py-2.5 text-right font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line align-top">
              {controls.map((c) => {
                const maps = c.mappings as { framework: string; clause: string; note: string }[];
                return (
                  <tr key={c.code}>
                    <td className="max-w-[300px] px-4 py-3">
                      <p className="font-medium">{c.title}</p>
                      <p className="mt-0.5 text-[13px] text-ink-3">{c.description}</p>
                    </td>
                    {FRAMEWORKS.map((f) => {
                      const m = maps.filter((x) => x.framework === f);
                      return (
                        <td key={f} className="px-3 py-3">
                          {m.length ? (
                            m.map((x) => (
                              <span key={x.clause} title={x.note} className="mb-1 block text-[13px]">
                                <span className="font-medium">{x.clause}</span>
                                <span className="block text-ink-3">{x.note}</span>
                              </span>
                            ))
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{counts[c.evidence as keyof typeof counts] ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 max-w-[72ch] text-[13px] text-ink-3">
          These references are starting points written by the Gate team, not legal advice and not a claim of compliance. Have your counsel or CA review them. They live in <code className="font-mono">packages/db/src/controls.ts</code>.
        </p>
      </Section>

      <Section title="Checkpoints" className="mt-12" description="Every hour Gate signs the latest receipt number and hash, so a removed receipt is noticed even at the end of the chain.">
        {checkpoints.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface text-sm">
            {checkpoints.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                <span className="font-medium">Receipt {c.seq}</span>
                <code className="flex-1 font-mono text-[12.5px] text-ink-3" title={c.hash}>
                  {shortHash(c.hash)}
                </code>
                <span className="text-ink-3">{fmtDateTime(c.ts)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-3">No checkpoints yet. The first one is signed within the hour, or sign one now.</p>
        )}
      </Section>
    </>
  );
}
