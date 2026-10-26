"use client";

import { X } from "lucide-react";
import { Dialog as D } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({ className, children, title, description, wide, ...props }: React.ComponentProps<typeof D.Content> & { title: string; description?: React.ReactNode; wide?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/40 data-[state=open]:animate-[fade-in_120ms_ease-out]" />
      <D.Content
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] overflow-y-auto rounded-t-xl border border-line bg-surface p-5 shadow-xl sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-full sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:p-6",
          wide ? "sm:max-w-2xl" : "sm:max-w-md",
          className,
        )}
        {...props}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <D.Title className="text-lg font-semibold">{title}</D.Title>
            {description ? <D.Description className="mt-1 text-sm text-ink-2">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
          </div>
          <D.Close className="-mt-1 -mr-1 rounded-md p-1.5 text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Close">
            <X className="size-4" />
          </D.Close>
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}
