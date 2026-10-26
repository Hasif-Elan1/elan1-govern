"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ReceiptDialog, Timeline, useLiveItems, type Item } from "@/components/timeline";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";

export function LiveFeed({ initial }: { initial: Item[] }) {
  const items = useLiveItems(initial);
  const [open, setOpen] = useState<number | null>(null);
  const router = useRouter();
  // Refresh counts (waiting card, stats) when something new arrives.
  useEffect(() => {
    if (items !== initial && items[0]?.seq !== initial[0]?.seq) router.refresh();
  }, [items, initial, router]);
  if (!items.length) return <p className="text-sm text-ink-3">Nothing yet today. Actions appear here the moment an agent tries them.</p>;
  return (
    <>
      <Timeline items={items} onOpen={setOpen} />
      <ReceiptDialog seq={open} onClose={() => setOpen(null)} />
    </>
  );
}

export function DemoButton() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api("/api/demo");
          toast.ok("The demo agent is running. Watch it below.");
          router.refresh();
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : "Could not start the demo agent.");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Starting…" : "Try the demo agent"}
    </Button>
  );
}
