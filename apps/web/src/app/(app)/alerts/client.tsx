"use client";

import type { BehaviourSettings } from "@gate/core/browser";
import { FileDown, SlidersHorizontal } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/fields";
import { Switch } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, download } from "@/lib/client";

type Filter = { show: string; severity?: string; agent?: string };

export function AlertFilters({ filter, agents }: { filter: Filter; agents: { slug: string; name: string }[] }) {
  const router = useRouter();
  const path = usePathname();
  const set = (patch: Partial<Filter>) => {
    const next = { ...filter, ...patch };
    const qs = new URLSearchParams(Object.entries(next).filter(([k, v]) => v && !(k === "show" && v === "open")) as [string, string][]).toString();
    router.replace(qs ? `${path}?${qs}` : path);
  };
  return (
    <div className="mb-6 grid gap-2.5 sm:grid-cols-3 lg:max-w-2xl">
      <Select aria-label="Which alerts" value={filter.show} onChange={(e) => set({ show: e.target.value })}>
        <option value="open">Open and acknowledged</option>
        <option value="all">All, including resolved</option>
      </Select>
      <Select aria-label="Severity" value={filter.severity ?? ""} onChange={(e) => set({ severity: e.target.value || undefined })}>
        <option value="">Any severity</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </Select>
      <Select aria-label="Agent" value={filter.agent ?? ""} onChange={(e) => set({ agent: e.target.value || undefined })}>
        <option value="">All agents</option>
        {agents.map((a) => (
          <option key={a.slug} value={a.slug}>
            {a.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function AlertActions({ id, status }: { id: string; status: "open" | "acknowledged" | "resolved" }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (action: "acknowledge" | "resolve") => {
    setBusy(action);
    try {
      await api(`/api/alerts/${id}`, { action });
      toast.ok(action === "acknowledge" ? "Alert acknowledged." : "Alert resolved.");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not update the alert.");
    } finally {
      setBusy(null);
    }
  };
  if (status === "resolved") return null;
  return (
    <div className="flex flex-wrap gap-2">
      {status === "open" ? (
        <Button disabled={!!busy} onClick={() => act("acknowledge")}>
          {busy === "acknowledge" ? "Saving…" : "Acknowledge"}
        </Button>
      ) : null}
      <Button variant="primary" disabled={!!busy} onClick={() => act("resolve")}>
        {busy === "resolve" ? "Saving…" : "Resolve"}
      </Button>
    </div>
  );
}

export function IncidentReportButton({ id }: { id: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await download(`/api/incidents/${id}/report`, {}, `incident-report-${id}.pdf`);
        } catch (e) {
          toast.error(e instanceof ApiError ? e.message : "Could not build the report.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <FileDown /> {busy ? "Building…" : "Incident report"}
    </Button>
  );
}

type Toggle = { enabled: boolean };

/** The thresholds most people change. Everything else keeps its value. */
export function AlertSettingsButton({ settings }: { settings: BehaviourSettings }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [s, setS] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const num = (v: string) => (v === "" ? NaN : Number(v));
  const toggle = (k: keyof BehaviourSettings, label: string) => (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <Switch checked={(s[k] as Toggle).enabled} onCheckedChange={(on) => setS({ ...s, [k]: { ...(s[k] as object), enabled: on } })} aria-label={label} />
    </label>
  );
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <SlidersHorizontal /> Alert settings
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent wide title="Alert settings" description="These apply to every agent in the organisation. Changes are recorded on a receipt.">
          <form
            className="grid gap-5"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await api("/api/alerts/settings", s, "PUT");
                toast.ok("Alert settings saved.");
                setOpen(false);
                router.refresh();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "That did not work.");
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Learning period, in days" htmlFor="as-learning" hint="No alerts for an agent until it has been working this long.">
              <Input id="as-learning" type="number" min={0} max={30} value={Number.isNaN(s.learningDays) ? "" : s.learningDays} onChange={(e) => setS({ ...s, learningDays: num(e.target.value) })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Call spike: fewest calls in an hour" htmlFor="as-vol-min">
                <Input id="as-vol-min" type="number" min={1} value={Number.isNaN(s.volumeSpike.minCalls) ? "" : s.volumeSpike.minCalls} onChange={(e) => setS({ ...s, volumeSpike: { ...s.volumeSpike, minCalls: num(e.target.value) } })} />
              </Field>
              <Field label="Large amount: earlier actions needed" htmlFor="as-amt-min">
                <Input id="as-amt-min" type="number" min={2} value={Number.isNaN(s.amountOutlier.minSamples) ? "" : s.amountOutlier.minSamples} onChange={(e) => setS({ ...s, amountOutlier: { ...s.amountOutlier, minSamples: num(e.target.value) } })} />
              </Field>
              <Field label="Refusals: rise for a medium alert (%)" htmlFor="as-ref-med">
                <Input id="as-ref-med" type="number" min={0} max={100} value={Math.round(s.refusalSurge.medium * 100)} onChange={(e) => setS({ ...s, refusalSurge: { ...s.refusalSurge, medium: num(e.target.value) / 100 } })} />
              </Field>
              <Field label="Refusals: rise for a high alert (%)" htmlFor="as-ref-high">
                <Input id="as-ref-high" type="number" min={0} max={100} value={Math.round(s.refusalSurge.high * 100)} onChange={(e) => setS({ ...s, refusalSurge: { ...s.refusalSurge, high: num(e.target.value) / 100 } })} />
              </Field>
            </div>
            <fieldset className="grid gap-2.5">
              <legend className="mb-1 text-sm font-medium">Checks</legend>
              {toggle("volumeSpike", "Unusual number of calls")}
              {toggle("offHours", "Activity at an unusual time")}
              {toggle("newCounterparty", "New vendor, recipient or account")}
              {toggle("newTool", "First use of a tool")}
              {toggle("refusalSurge", "Many refused calls")}
              {toggle("amountOutlier", "Unusually large amount")}
            </fieldset>
            {error ? <p className="text-sm text-no">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={busy}>
                {busy ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
