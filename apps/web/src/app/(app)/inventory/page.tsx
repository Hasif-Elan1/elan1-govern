import { DATA_CATEGORIES, labelOf, LIFECYCLES, SYSTEM_KINDS, SYSTEM_TIERS, values } from "@gate/core";
import { forOrg } from "@gate/db";
import { Boxes } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { LifecyclePill, ReviewDue, TierPill } from "@/components/inventory-bits";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { syncAgentSystems } from "@/server/inventory";
import { can } from "@/server/policy";
import { requireCtx } from "@/server/session";
import { InventoryFilters, type InventoryFilter } from "./filters";
import { SystemDialog } from "./system-form";

export const metadata: Metadata = { title: "Inventory" };

const pick = (v: string | undefined, allowed: string[]) => (v && allowed.includes(v) ? v : undefined);

export default async function Inventory({ searchParams }: { searchParams: Promise<InventoryFilter> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const filter: InventoryFilter = { kind: pick(sp.kind, values(SYSTEM_KINDS)), tier: pick(sp.tier, values(SYSTEM_TIERS)), lifecycle: pick(sp.lifecycle, values(LIFECYCLES)) };
  await syncAgentSystems(ctx.org.id);
  const db = forOrg(ctx.org.id);
  const where = { ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.tier ? { riskTier: filter.tier } : {}), ...(filter.lifecycle ? { lifecycle: filter.lifecycle } : {}) };
  const [systems, total] = await Promise.all([db.aiSystem.findMany({ where, orderBy: [{ name: "asc" }] }), db.aiSystem.count()]);
  const manage = can(ctx.role, "inventory:manage");
  const filtered = Object.values(filter).some(Boolean);

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Every AI system your company uses, including ones Gate does not guard: who owns it, what data it touches, how risky it is and when it is next reviewed."
        actions={manage && total > 0 ? <SystemDialog me={ctx.user.email} trigger="add" /> : null}
      />
      {total === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title="No AI systems yet"
          body={manage ? "Add the AI tools and models your teams use, such as a chat assistant, a resume screener or a forecasting model. Gate agents appear here on their own." : "An owner or admin can add the AI systems your company uses. Gate agents appear here on their own."}
          action={manage ? <SystemDialog me={ctx.user.email} trigger="add-first" /> : undefined}
        />
      ) : (
        <>
          <InventoryFilters filter={filter} />
          {systems.length === 0 && filtered ? (
            <EmptyState title="Nothing matches" body="No system has that kind, risk and stage. Try fewer filters." action={{ href: "/inventory", label: "Clear filters" }} />
          ) : (
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              <table className="w-full text-sm">
                <thead className="hidden border-b border-line bg-sunken/60 text-left text-[13px] whitespace-nowrap text-ink-3 md:table-header-group">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">System</th>
                    <th className="px-4 py-2.5 font-medium">Owner</th>
                    <th className="px-4 py-2.5 font-medium">Stage</th>
                    <th className="px-4 py-2.5 font-medium">Risk</th>
                    <th className="px-4 py-2.5 font-medium">Data</th>
                    <th className="px-4 py-2.5 font-medium">Next review</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {systems.map((s) => (
                    <tr key={s.id} className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3.5 hover:bg-sunken/50 md:table-row md:p-0">
                      <td className="col-span-2 md:px-4 md:py-3.5">
                        <Link href={`/inventory/${s.id}`} className="font-medium text-ink hover:underline">
                          {s.name}
                        </Link>
                        <p className="mt-0.5 text-[13px] text-ink-3">
                          {labelOf(SYSTEM_KINDS, s.kind)}
                          {s.vendor ? `, ${s.vendor}` : ""}
                        </p>
                      </td>
                      <td className="col-span-2 break-all text-ink-2 md:px-4 md:py-3.5">{s.ownerEmail}</td>
                      <td className="md:px-4 md:py-3.5">
                        <LifecyclePill lifecycle={s.lifecycle} />
                      </td>
                      <td className="md:px-4 md:py-3.5">
                        <TierPill tier={s.riskTier} />
                      </td>
                      <td className="col-span-2 text-ink-2 md:px-4 md:py-3.5">
                        <span className="text-ink-3 md:hidden">Data: </span>
                        {s.dataCategories.length ? s.dataCategories.map((c) => labelOf(DATA_CATEGORIES, c)).join(", ") : <span className="text-ink-3">Not recorded</span>}</td>
                      <td className="col-span-2 md:px-4 md:py-3.5">
                        <span className="text-ink-3 md:hidden">Next review: </span>
                        <ReviewDue at={s.nextReviewAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
