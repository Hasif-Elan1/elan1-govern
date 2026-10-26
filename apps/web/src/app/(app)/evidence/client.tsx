"use client";

import { Download, Stamp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/fields";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, download } from "@/lib/client";

export function ExportForm({ from: f0, to: t0 }: { from: string; to: string }) {
  const toast = useToast();
  const [from, setFrom] = useState(f0);
  const [to, setTo] = useState(t0);
  const [busy, setBusy] = useState<"pack" | "bundle" | null>(null);
  const go = async (kind: "pack" | "bundle") => {
    setBusy(kind);
    try {
      await download("/api/evidence/export", { from, to, kind }, `${kind}.zip`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The download failed.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="From" htmlFor="ev-from">
          <Input id="ev-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" htmlFor="ev-to">
          <Input id="ev-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!!busy} onClick={() => go("pack")}>
          <Download /> {busy === "pack" ? "Preparing…" : "Download auditor pack"}
        </Button>
        <Button disabled={!!busy} onClick={() => go("bundle")}>
          {busy === "bundle" ? "Preparing…" : "Evidence bundle only"}
        </Button>
      </div>
    </div>
  );
}

export function CheckpointButton() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ seq: number | null }>("/api/evidence/checkpoint");
          toast.ok(r.seq ? `Checkpoint signed at receipt ${r.seq}.` : "Already up to date: the latest receipt is checkpointed.");
          router.refresh();
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : "Could not sign a checkpoint.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Stamp /> {busy ? "Signing…" : "Sign checkpoint now"}
    </Button>
  );
}
