"use client";

import { LIFECYCLES, SYSTEM_KINDS, SYSTEM_TIERS } from "@gate/core/browser";
import { X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Select } from "@/components/ui/fields";

export type InventoryFilter = { kind?: string; tier?: string; lifecycle?: string };

export function InventoryFilters({ filter }: { filter: InventoryFilter }) {
  const router = useRouter();
  const path = usePathname();
  const set = (patch: InventoryFilter) => {
    const qs = new URLSearchParams(Object.entries({ ...filter, ...patch }).filter(([, v]) => v) as [string, string][]).toString();
    router.replace(qs ? `${path}?${qs}` : path);
  };
  const select = (key: keyof InventoryFilter, label: string, all: string, options: readonly (readonly [string, string])[]) => (
    <Select aria-label={label} value={filter[key] ?? ""} onChange={(e) => set({ [key]: e.target.value || undefined })}>
      <option value="">{all}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </Select>
  );
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2.5">
      <div className="grid w-full gap-2.5 sm:w-auto sm:grid-cols-3">
        {select("kind", "Kind", "All kinds", SYSTEM_KINDS)}
        {select("tier", "Risk", "Any risk", SYSTEM_TIERS)}
        {select("lifecycle", "Stage", "Any stage", LIFECYCLES)}
      </div>
      {Object.values(filter).some(Boolean) ? (
        <button type="button" onClick={() => router.replace(path)} className="inline-flex cursor-pointer items-center gap-1 text-sm text-ink-3 hover:text-ink">
          <X className="size-3.5" /> Clear filters
        </button>
      ) : null}
    </div>
  );
}
