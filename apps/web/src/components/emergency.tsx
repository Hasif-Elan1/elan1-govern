"use client";

import { OctagonX } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ReauthDialog } from "@/components/approval-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/fields";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";
import { relative } from "@/lib/utils";

/** Runs a request that may need a fresh sign-in: on `reauth`, asks for the password and tries again. */
function useFresh() {
  const [pending, setPending] = useState<null | (() => Promise<void>)>(null);
  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.data.reauth) setPending(() => fn);
      else throw e;
    }
  };
  return { run, pending, clear: () => setPending(null) };
}

export function EmergencyStopButton({ agents, totpEnabled }: { agents: number; totpEnabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fresh = useFresh();

  const stop = async () => {
    const r = await api<{ paused: number }>("/api/emergency-stop", { confirm: typed.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) });
    setOpen(false);
    setTyped("");
    setReason("");
    toast.ok(`Emergency stop in place. ${r.paused === 1 ? "1 agent is" : `${r.paused} agents are`} paused.`);
    router.refresh();
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await fresh.run(stop);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        <OctagonX /> Emergency stop
      </Button>
      <Dialog open={open && !fresh.pending} onOpenChange={setOpen}>
        <DialogContent
          title="Stop every agent now?"
          description={`Elan1 Govern pauses all ${agents === 1 ? "1 running agent" : `${agents} running agents`} at once and refuses every call they make until someone resumes them. Actions waiting for approval stay waiting. Everyone who is an owner or admin gets an email.`}
        >
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Field label="Reason (optional)" htmlFor="stop-reason" hint="Goes on the receipt and the incident report.">
              <Input id="stop-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Field label="Type STOP to confirm" htmlFor="stop-confirm" error={error}>
              <Input id="stop-confirm" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={busy || typed.trim() !== "STOP"}>
                {busy ? "Stopping…" : "Stop all agents"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <ReauthDialog
        open={!!fresh.pending}
        needTotp={totpEnabled}
        description="The emergency stop pauses every agent, so Elan1 Govern asks for your password if you signed in more than 10 minutes ago."
        onCancel={fresh.clear}
        onDone={() => {
          const retry = fresh.pending;
          fresh.clear();
          if (retry) void retry().catch((e) => setError(e instanceof ApiError ? e.message : "That did not work."));
        }}
      />
    </>
  );
}

export interface IncidentBannerProps {
  startedBy: string;
  startedAt: string;
  paused: number;
  canResume: boolean;
  totpEnabled: boolean;
}

/** The red banner across the console while an emergency stop is in place. */
export function EmergencyBanner({ startedBy, startedAt, paused, canResume, totpEnabled }: IncidentBannerProps) {
  const router = useRouter();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const fresh = useFresh();

  const resume = async () => {
    const r = await api<{ resumed: number }>("/api/emergency-stop/resume", { confirm: true });
    setConfirm(false);
    toast.ok(`${r.resumed === 1 ? "1 agent is" : `${r.resumed} agents are`} running again.`);
    router.refresh();
  };
  const submit = async () => {
    setBusy(true);
    try {
      await fresh.run(resume);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not resume the agents.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="alert" className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-no bg-no px-4 py-3 text-on-solid">
      <OctagonX className="size-5 shrink-0" />
      <p className="min-w-0 flex-1 text-[14.5px]">
        <span className="font-semibold">Emergency stop in place.</span> {startedBy} paused {paused === 1 ? "1 agent" : `${paused} agents`} {relative(startedAt).toLowerCase()}. Every call they make is refused.
      </p>
      {canResume ? (
        <Button size="sm" className="bg-surface text-ink hover:bg-sunken" onClick={() => setConfirm(true)}>
          Resume agents
        </Button>
      ) : null}
      <Dialog open={confirm && !fresh.pending} onOpenChange={setConfirm}>
        <DialogContent title="Resume the agents?" description="Elan1 Govern starts again only the agents the emergency stop paused. Agents that were paused before it, or that someone paused since, stay paused. A receipt records it.">
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Keep stopped</Button>
            <Button variant="primary" disabled={busy} onClick={() => void submit()}>
              {busy ? "Resuming…" : "Resume agents"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ReauthDialog
        open={!!fresh.pending}
        needTotp={totpEnabled}
        description="Resuming lets every stopped agent act again, so Elan1 Govern asks for your password if you signed in more than 10 minutes ago."
        onCancel={fresh.clear}
        onDone={() => {
          const retry = fresh.pending;
          fresh.clear();
          if (retry) void retry().catch((e) => toast.error(e instanceof ApiError ? e.message : "Could not resume the agents."));
        }}
      />
    </div>
  );
}
