"use client";

import { Download, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Pill } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, download } from "@/lib/client";

export type FrameworkOption = { id: string; shortName: string; jurisdiction: string; description: string; recommended: boolean };

function useToggle() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function toggle(framework: string, enabled: boolean, label: string) {
    setBusy(framework);
    try {
      await api("/api/compliance/frameworks", { framework, enabled });
      toast.ok(enabled ? `${label} is on.` : `${label} is off. Its evidence is kept.`);
      router.refresh();
      return true;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not change the framework.");
      return false;
    } finally {
      setBusy(null);
    }
  }
  return { busy, toggle };
}

/** Lists the frameworks that are not on yet, recommended ones first. */
export function AddFramework({ options, primary }: { options: FrameworkOption[]; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const { busy, toggle } = useToggle();
  const sorted = [...options].sort((a, b) => Number(b.recommended) - Number(a.recommended));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={primary ? "primary" : "secondary"}>
          <Plus /> Add framework
        </Button>
      </DialogTrigger>
      <DialogContent wide title="Add a framework" description="Turning one on adds it to the compliance map, the auditor pack and this page. You can turn it off again at any time.">
        {sorted.length ? (
          <ul className="grid gap-2">
            {sorted.map((f) => (
              <li key={f.id} className="flex flex-wrap items-start gap-3 rounded-lg border border-line p-3.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {f.shortName}
                    {f.recommended ? <Pill tone="accent">Recommended for you</Pill> : null}
                  </p>
                  <p className="mt-0.5 text-[13px] text-ink-3">{f.jurisdiction}</p>
                  <p className="mt-1 text-sm text-ink-2">{f.description}</p>
                </div>
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={async () => {
                    if ((await toggle(f.id, true, f.shortName)) && sorted.length === 1) setOpen(false);
                  }}
                >
                  {busy === f.id ? "Turning on…" : "Turn on"}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-2">Every framework in the library is already on.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function FrameworkSwitch({ id, label, enabled }: { id: string; label: string; enabled: boolean }) {
  const { busy, toggle } = useToggle();
  return (
    <Button variant={enabled ? "secondary" : "primary"} disabled={!!busy} onClick={() => toggle(id, !enabled, label)}>
      {busy ? (enabled ? "Turning off…" : "Turning on…") : enabled ? "Turn off" : "Turn on"}
    </Button>
  );
}

export function ReportButton({ framework }: { framework: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await download("/api/compliance/report", { framework }, `framework-report-${framework}.pdf`);
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : "The download failed.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Download /> {busy ? "Preparing…" : "Download framework report"}
    </Button>
  );
}
