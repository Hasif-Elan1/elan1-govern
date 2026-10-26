"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ReceiptDialog, Timeline, useLiveItems, type Item } from "@/components/timeline";
import { Input, Select } from "@/components/ui/fields";
import { EmptyState } from "@/components/ui/layout";

type Filter = { agent?: string; decision?: string; tool?: string; from?: string; to?: string; q?: string };

export function ActivityView({ items, filter, agents, tools, openSeq }: { items: Item[]; filter: Filter; agents: { slug: string; name: string }[]; tools: { value: string; label: string }[]; openSeq: number | null }) {
  const router = useRouter();
  const path = usePathname();
  const [q, setQ] = useState(filter.q ?? "");
  const [open, setOpen] = useState<number | null>(openSeq);
  const query = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  const live = useLiveItems(items, query);
  const active = Object.values(filter).some(Boolean);

  const set = (patch: Filter) => {
    const next = { ...filter, ...patch };
    const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v) as [string, string][]).toString();
    router.replace(qs ? `${path}?${qs}` : path);
  };

  useEffect(() => {
    const t = setTimeout(() => {
      if ((filter.q ?? "") !== q) set({ q: q || undefined });
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <div className="mb-6 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr_auto_auto]">
        <label className="relative sm:col-span-2 lg:col-span-1">
          <span className="sr-only">Search</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names, rules, references…" className="pl-9" />
        </label>
        <Select aria-label="Agent" value={filter.agent ?? ""} onChange={(e) => set({ agent: e.target.value || undefined })}>
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Decision" value={filter.decision ?? ""} onChange={(e) => set({ decision: e.target.value || undefined })}>
          <option value="">All decisions</option>
          <option value="allow">Allowed</option>
          <option value="ask">Sent to a person</option>
          <option value="refuse">Refused</option>
          <option value="admin">Setup changes</option>
        </Select>
        <Select aria-label="Tool" value={filter.tool ?? ""} onChange={(e) => set({ tool: e.target.value || undefined })}>
          <option value="">All tools</option>
          {tools.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
        <Input type="date" aria-label="From" value={filter.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} />
        <Input type="date" aria-label="To" value={filter.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} />
      </div>
      {active ? (
        <button type="button" onClick={() => (setQ(""), router.replace(path))} className="-mt-3 mb-5 inline-flex cursor-pointer items-center gap-1 text-sm text-ink-3 hover:text-ink">
          <X className="size-3.5" /> Clear filters
        </button>
      ) : null}

      {live.length ? (
        <Timeline items={live} onOpen={setOpen} />
      ) : active ? (
        <EmptyState title="Nothing matches" body="Try a wider date range or fewer filters." action={<button type="button" onClick={() => (setQ(""), router.replace(path))} className="cursor-pointer text-sm font-medium text-accent hover:underline">Clear filters</button>} />
      ) : (
        <EmptyState title="No activity yet" body="When an agent calls a tool through Gate, each decision appears here as a signed receipt." action={{ href: "/agents", label: "Connect an agent" }} />
      )}
      <ReceiptDialog seq={open} onClose={() => setOpen(null)} />
    </>
  );
}
