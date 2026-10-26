"use client";

import { Check, Copy } from "lucide-react";
import { Switch as S, Tabs as T } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: React.ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn("relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-line-2 bg-sunken transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent", className)}
      {...props}
    >
      <S.Thumb className="block size-4.5 translate-x-0.5 rounded-full bg-surface shadow-sm transition-transform data-[state=checked]:translate-x-[18px]" />
    </S.Root>
  );
}

export const Tabs = T.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof T.List>) {
  return <T.List className={cn("flex gap-1 overflow-x-auto border-b border-line", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        "-mb-px cursor-pointer whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-3 hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink",
        className,
      )}
      {...props}
    />
  );
}

export const TabsContent = T.Content;

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <button
      type="button"
      className={cn("inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-surface px-2.5 text-[13px] font-medium text-ink-2 hover:text-ink", className)}
      onClick={async () => {
        await navigator.clipboard.writeText(value).catch(() => undefined);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      {done ? "Copied" : label}
    </button>
  );
}

export function Secret({ value, label }: { value: string; label?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-sunken p-2 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink" title={value}>
        {value}
      </code>
      <CopyButton value={value} label={label} />
    </div>
  );
}
