"use client";

import { TEMPLATES } from "@gate/core/browser";
import { ClipboardCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LegalReviewNote } from "@/components/inventory-bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";

/** Pick a template and open a new draft. */
export function StartAssessment({ systemId, label = "Start assessment" }: { systemId: string; label?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState<string>(TEMPLATES[0]!.key);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <ClipboardCheck /> {label}
      </Button>
      <DialogContent wide title="Start an assessment" description="Answers are saved as a draft. When you submit, someone else reviews and signs it off.">
        <fieldset className="grid gap-2.5">
          <legend className="sr-only">Template</legend>
          {TEMPLATES.map((t) => (
            <label key={t.key} className={cn("flex cursor-pointer gap-3 rounded-lg border p-4", key === t.key ? "border-accent bg-accent-soft" : "border-line-2 bg-surface hover:border-ink-3")}>
              <input type="radio" name="template" value={t.key} checked={key === t.key} onChange={() => setKey(t.key)} className="mt-1 accent-[var(--accent)]" />
              <span className="grid gap-1">
                <span className="font-medium">{t.name}</span>
                <span className="text-sm text-ink-2">{t.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <LegalReviewNote />
          <div className="flex gap-2">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api<{ id: string }>("/api/assessments", { systemId, templateKey: key });
                  router.push(`/assessments/${r.id}`);
                } catch (e) {
                  toast.error(e instanceof ApiError ? e.message : "Could not start the assessment.");
                  setBusy(false);
                }
              }}
            >
              {busy ? "Starting…" : "Start"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Retiring asks first. The system and its assessments stay in the record. */
export function RetireButton({ id, name, retired }: { id: string; name: string; retired: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = async (lifecycle: "retired" | "live") => {
    setBusy(true);
    try {
      await api(`/api/inventory/${id}`, { lifecycle }, "PATCH");
      toast.ok(lifecycle === "retired" ? `${name} is retired.` : `${name} is live again.`);
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not change the system.");
    } finally {
      setBusy(false);
    }
  };
  if (retired) {
    return (
      <Button onClick={() => set("live")} disabled={busy}>
        Bring back into use
      </Button>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Retire
      </Button>
      <DialogContent title={`Retire ${name}?`} description="It stays in the inventory with its assessments, marked as retired, and no new assessments can be started. You can bring it back later.">
        <div className="flex justify-end gap-2">
          <Button onClick={() => setOpen(false)}>Keep it</Button>
          <Button variant="danger" disabled={busy} onClick={() => set("retired")}>
            {busy ? "Retiring…" : "Retire system"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
