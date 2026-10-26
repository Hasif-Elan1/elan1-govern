"use client";

import { TOOLS, TOOL_NAMES } from "@gate/core/browser";
import { Mail, ReceiptIndianRupee } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Pill } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";

export type ConnectorRow = { kind: string; status: string; mode: string; accountLabel: string | null };

const META = {
  gmail: { name: "Gmail", icon: Mail, about: "Reads vendor invoices and replies on existing threads. No deleting, forwarding or settings." },
  zoho: { name: "Zoho Books", icon: ReceiptIndianRupee, about: "Creates bills and records payments in your Zoho Books organisation (India data centre)." },
};

export function ConnectorCard({ kind, row, manage, liveAvailable, compact }: { kind: "gmail" | "zoho"; row?: ConnectorRow; manage: boolean; liveAvailable: boolean; compact?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const m = META[kind];
  const connected = row?.status === "connected";
  const tools = TOOL_NAMES.filter((t) => TOOLS[t].connector === kind);

  async function act(action: "connect" | "disconnect", mode?: "mock" | "live") {
    setBusy(true);
    try {
      const r = await api<{ status: string | null; redirect: string | null }>(`/api/connectors/${kind}`, { action, ...(mode ? { mode } : {}) });
      if (r.redirect) {
        window.location.href = r.redirect;
        return;
      }
      toast.ok(action === "connect" ? `${m.name} connected.` : `${m.name} disconnected. Agents can no longer use it.`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `Could not change ${m.name}.`);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  return (
    <div className={cn("flex flex-col rounded-lg border bg-surface p-5", connected ? "border-line" : "border-dashed border-line-2")}>
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sunken">
          <m.icon className="size-5 text-ink-2" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{m.name}</h3>
            {connected ? <Pill tone="ok">Connected</Pill> : <Pill>Not connected</Pill>}
          </div>
          <p className="mt-0.5 truncate text-[13px] text-ink-3">{connected ? `${row?.accountLabel ?? ""}${row?.mode === "mock" ? "" : ", live account"}` : m.about}</p>
        </div>
      </div>

      {!compact ? (
        <div className="mt-4">
          <p className="mb-2 text-[13px] text-ink-3">Tools agents can ask for</p>
          <ul className="flex flex-wrap gap-1.5">
            {tools.map((t) => (
              <li key={t}>
                <code className="rounded border border-line bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-ink-2" title={TOOLS[t].description}>
                  {t}
                </code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {manage ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {connected ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>
              Disconnect
            </Button>
          ) : (
            <>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => act("connect", "mock")}>
                Use demo data
              </Button>
              <Button size="sm" disabled={busy || !liveAvailable} onClick={() => act("connect", "live")} title={liveAvailable ? undefined : "Add the OAuth client to Gate's settings first (see the README)."}>
                Connect {kind === "gmail" ? "a Google account" : "Zoho Books"}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {!connected && manage && !liveAvailable && !compact ? <p className="mt-2 text-[12.5px] text-ink-3">Real accounts need an OAuth client set up on the server. The README explains how.</p> : null}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title={`Disconnect ${m.name}?`} description={`Agents will get an error for every ${m.name} tool until you connect it again. Gate deletes the stored access tokens.`}>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={() => act("disconnect")}>
              Disconnect
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
