"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";

/** The replay store switch. Turning it off deletes what is stored, so it asks first. */
export function ReplayStore({ on, disabled }: { on: boolean; disabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  async function set(next: boolean) {
    setBusy(true);
    try {
      await api("/api/settings", { replayStore: next }, "PATCH");
      toast.ok(next ? "Elan1 Govern will keep past actions for testing." : "Stored past actions are deleted.");
      setConfirm(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-4">
      <Switch checked={on} disabled={disabled || busy} onCheckedChange={(v) => (v ? void set(true) : setConfirm(true))} aria-label="Keep past actions for testing rules" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{on ? "On: kept for 30 days, then deleted" : "Off: nothing is kept"}</p>
        <p className="mt-1 text-ink-2">
          {on
            ? "Only Elan1 Govern's service can read them. They are used for one thing: showing what a draft rulebook would have decided."
            : "Testing a rulebook on past actions has nothing to work with. Turn this on to start keeping calls from now on."}
        </p>
        {disabled ? <p className="mt-1 text-[13px] text-ink-3">Only owners and admins can change this.</p> : null}
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title="Stop keeping past actions?" description="Everything stored so far is deleted now. Testing a rulebook on past actions will have nothing to work with until you turn this back on.">
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={() => void set(false)}>
              {busy ? "Deleting…" : "Turn off and delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
