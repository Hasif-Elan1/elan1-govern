"use client";

import { Button } from "@/components/ui/button";

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="max-w-[520px] py-10">
      <h1 className="text-2xl font-semibold">This page could not load</h1>
      <p className="mt-2 text-ink-2">Gate could not reach its database or the gate service. Nothing was changed. If it keeps happening, check that both are running.</p>
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
