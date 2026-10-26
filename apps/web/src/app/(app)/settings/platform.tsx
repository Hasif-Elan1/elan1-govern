"use client";

import { KeyRound, Send, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ReauthDialog } from "@/components/approval-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/fields";
import { Card } from "@/components/ui/layout";
import { Secret } from "@/components/ui/misc";
import { Pill, type Tone } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";
import { relative } from "@/lib/utils";
import { DELIVERY_LABELS, displayUrl, WEBHOOK_EVENT_LABELS, WEBHOOK_EVENTS, type WebhookEvent } from "@/lib/webhooks";

// ---- Webhooks ----

export function WebhookForm() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<WebhookEvent[]>(["receipt.created"]);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  return (
    <div className="grid gap-4">
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          setBusy(true);
          setError(null);
          try {
            const r = await api<{ secret: string }>("/api/webhooks", { url: String(new FormData(form).get("url") ?? ""), events });
            setSecret(r.secret);
            form.reset();
            toast.ok("Endpoint added.");
            router.refresh();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "That did not work.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Endpoint URL" htmlFor="wh-url" hint="Elan1 Govern sends a signed POST with a JSON body. Use https in production." error={error}>
          <Input id="wh-url" name="url" type="url" required maxLength={2000} placeholder="https://siem.example.com/gate" />
        </Field>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Events to send</legend>
          {WEBHOOK_EVENTS.map((ev) => (
            <label key={ev} className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--accent)]"
                checked={events.includes(ev)}
                onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))}
              />
              <span>
                <span className="font-medium">{WEBHOOK_EVENT_LABELS[ev].label}</span>
                <span className="block text-[13px] text-ink-3">{WEBHOOK_EVENT_LABELS[ev].hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div>
          <Button variant="primary" disabled={busy || !events.length}>
            {busy ? "Adding…" : "Add endpoint"}
          </Button>
        </div>
      </form>
      {secret ? (
        <div className="max-w-xl">
          <p className="mb-1.5 text-[13px] text-ink-2">This is the signing secret. Copy it now: Elan1 Govern will not show it again. Use it to check the gate-signature header on each request.</p>
          <Secret value={secret} label="Copy secret" />
        </div>
      ) : null}
    </div>
  );
}

export interface WebhookView {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  deliveries: { id: string; event: string; status: string; attempts: number; lastError: string | null; responseStatus: number | null; createdAt: string; deliveredAt: string | null }[];
}

const DELIVERY_TONE: Record<string, Tone> = { delivered: "ok", pending: "wait", failed: "no" };

export function WebhookRow({ hook }: { hook: WebhookView }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<"test" | "delete" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const shown = displayUrl(hook.url);

  const sendTest = async () => {
    setBusy("test");
    try {
      const r = await api<{ outcome?: string }>(`/api/webhooks/${hook.id}/test`);
      if (r.outcome === "delivered") toast.ok("Test event delivered.");
      else toast.error("The test event did not get through. Elan1 Govern will retry it; see the latest delivery below.");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not send the test event.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("delete");
    try {
      await api(`/api/webhooks/${hook.id}`, undefined, "DELETE");
      toast.ok("Endpoint deleted.");
      setConfirm(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not delete the endpoint.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[13px]" title={shown}>
            {shown}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-3">
            {hook.events.map((e) => WEBHOOK_EVENT_LABELS[e as WebhookEvent]?.label ?? e).join(", ")} · added {relative(hook.createdAt).toLowerCase()}
          </p>
        </div>
        {!hook.active ? <Pill>Turned off</Pill> : null}
        <Button size="sm" disabled={!!busy} onClick={sendTest}>
          <Send /> {busy === "test" ? "Sending…" : "Send a test event"}
        </Button>
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirm(true)}>
          <Trash2 /> Delete
        </Button>
      </div>
      {hook.deliveries.length ? (
        <ul className="mt-3 divide-y divide-line rounded-md border border-line text-[13px]">
          {hook.deliveries.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <Pill tone={DELIVERY_TONE[d.status] ?? "neutral"}>{DELIVERY_LABELS[d.status] ?? d.status}</Pill>
              <span className="font-mono text-ink-2">{d.event}</span>
              <span className="flex-1 text-ink-3">{d.lastError ? `${d.lastError.charAt(0).toUpperCase()}${d.lastError.slice(1)}${d.status === "pending" ? `, attempt ${d.attempts} of 8` : ""}` : d.responseStatus ? `HTTP ${d.responseStatus}` : ""}</span>
              <span className="text-ink-3">{relative(d.deliveredAt ?? d.createdAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[13px] text-ink-3">No deliveries yet. Send a test event to check the endpoint.</p>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title="Delete this endpoint?" description={`Elan1 Govern stops sending events to ${shown} at once, and its delivery history is removed. A receipt records the change.`}>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" disabled={!!busy} onClick={remove}>
              {busy === "delete" ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---- Signing key rotation ----

export function RotateKey({ current, totpEnabled }: { current: string; totpEnabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [busy, setBusy] = useState(false);

  const rotate = async () => {
    setBusy(true);
    try {
      const r = await api<{ kid: string }>("/api/signing-key", { confirm: true });
      setConfirm(false);
      toast.ok(`New signing key ${r.kid} is in use. The old one is kept for checking older receipts.`);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.data.reauth) setReauth(true);
      else toast.error(e instanceof ApiError ? e.message : "Could not rotate the key.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" onClick={() => setConfirm(true)}>
        <KeyRound /> Rotate signing key
      </Button>
      <Dialog open={confirm && !reauth} onOpenChange={setConfirm}>
        <DialogContent
          title="Rotate the signing key?"
          description={
            <>
              Elan1 Govern makes a new key and signs everything with it from now on. The current key, <code className="font-mono">{current}</code>, is retired but kept, so older receipts and evidence still check out. The handover is itself
              written to a receipt signed by the old key.
            </>
          }
        >
          <p className="mb-4 text-sm text-ink-2">Anyone who pinned the old key fingerprint, such as your auditor, will need the new one. Evidence bundles include every key.</p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={rotate}>
              {busy ? "Rotating…" : "Rotate key"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ReauthDialog
        open={reauth}
        needTotp={totpEnabled}
        description="Rotating the signing key changes how evidence is checked, so Elan1 Govern asks for your password if you signed in more than 10 minutes ago."
        onCancel={() => setReauth(false)}
        onDone={() => {
          setReauth(false);
          void rotate();
        }}
      />
    </>
  );
}
