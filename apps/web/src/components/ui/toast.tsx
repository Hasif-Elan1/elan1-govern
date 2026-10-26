"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

type Toast = { id: number; tone: "ok" | "no"; text: string };
const Ctx = React.createContext<(tone: Toast["tone"], text: string) => void>(() => {});

export function Toaster({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<Toast[]>([]);
  const push = React.useCallback((tone: Toast["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { id, tone, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === "no" ? 7000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:right-4 sm:left-auto sm:items-end">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn("pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border bg-surface px-3.5 py-2.5 text-sm shadow-lg", t.tone === "ok" ? "border-ok-line" : "border-no-line")}
          >
            {t.tone === "ok" ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-no" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const push = React.useContext(Ctx);
  return React.useMemo(() => ({ ok: (t: string) => push("ok", t), error: (t: string) => push("no", t) }), [push]);
}
