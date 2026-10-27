"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ReauthDialog } from "@/components/approval-card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/fields";
import { Secret } from "@/components/ui/misc";
import { Pill } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";

type Kind = "slack" | "whatsapp";
const LABEL: Record<Kind, string> = { slack: "Slack", whatsapp: "WhatsApp" };
const REAUTH = "Connecting a chat channel lets people approve actions from it, so Elan1 Govern asks for your password if you signed in more than 10 minutes ago.";

/** Runs a change that needs a recent sign-in, asking for the password first when it is stale. */
function useFresh(totpEnabled: boolean) {
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null);
  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.data.reauth) setPending(() => fn);
      else throw e;
    }
  };
  const dialog = (
    <ReauthDialog
      open={pending !== null}
      needTotp={totpEnabled}
      description={REAUTH}
      onCancel={() => setPending(null)}
      onDone={() => {
        const fn = pending;
        setPending(null);
        if (fn) void fn().catch(() => undefined);
      }}
    />
  );
  return { run, dialog };
}

export function ChannelForm({ kind, totpEnabled }: { kind: Kind; totpEnabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ url?: string; verifyToken?: string } | null>(null);
  const fresh = useFresh(totpEnabled);

  if (done) {
    return (
      <div className="grid gap-3 text-sm">
        <p className="font-medium">{LABEL[kind]} is connected.</p>
        {kind === "slack" ? (
          <p className="text-ink-2">
            In your Slack app, turn on Interactivity and set the request URL to <code className="font-mono break-all">{done.url}</code>, then invite the app to the channel.
          </p>
        ) : (
          <>
            <p className="text-ink-2">
              In your Meta app, under WhatsApp → Configuration, set the callback URL to <code className="font-mono break-all">{done.url}</code>, paste this verify token, and subscribe to the messages field. Copy it now: Elan1 Govern
              will not show it again.
            </p>
            <Secret value={done.verifyToken ?? ""} label="Copy verify token" />
          </>
        )}
        <div>
          <Button onClick={() => router.refresh()}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="grid gap-4"
      data-testid={`${kind}-form`}
      onSubmit={async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
        setBusy(true);
        setError(null);
        try {
          await fresh.run(async () => {
            const r = await api<{ url?: string; verifyToken?: string }>(`/api/notifications/${kind}`, data);
            setDone(r);
            toast.ok(`${LABEL[kind]} connected.`);
          });
        } catch (err) {
          setError(err instanceof ApiError ? err.message : "That did not work.");
        } finally {
          setBusy(false);
        }
      }}
    >
      {kind === "slack" ? (
        <>
          <Field label="Bot token" htmlFor="slack-token" hint="OAuth & Permissions → Bot User OAuth Token. Scopes: chat:write, users:read, users:read.email.">
            <Input id="slack-token" name="botToken" type="password" autoComplete="off" required placeholder="xoxb-…" />
          </Field>
          <Field label="Signing secret" htmlFor="slack-secret" hint="Basic Information → App Credentials.">
            <Input id="slack-secret" name="signingSecret" type="password" autoComplete="off" required />
          </Field>
          <Field label="Channel ID" htmlFor="slack-channel" hint="Open the channel's details in Slack; the ID is at the bottom.">
            <Input id="slack-channel" name="channelId" required placeholder="C0123456789" />
          </Field>
        </>
      ) : (
        <>
          <Field label="Phone-number ID" htmlFor="wa-pnid" hint="WhatsApp → API Setup in your Meta app. Not the phone number itself.">
            <Input id="wa-pnid" name="phoneNumberId" required inputMode="numeric" />
          </Field>
          <Field label="Access token" htmlFor="wa-token" hint="A system-user token with the whatsapp_business_messaging permission.">
            <Input id="wa-token" name="accessToken" type="password" autoComplete="off" required />
          </Field>
          <Field label="App secret" htmlFor="wa-secret" hint="App settings → Basic. Used to check that messages really come from Meta.">
            <Input id="wa-secret" name="appSecret" type="password" autoComplete="off" required />
          </Field>
          <Field label="Approval template (optional)" htmlFor="wa-template" hint="An approved template with two quick-reply buttons, needed to reach approvers outside Meta's 24-hour window.">
            <Input id="wa-template" name="templateName" placeholder="approval_waiting" />
          </Field>
          <Field label="Template language" htmlFor="wa-lang">
            <Input id="wa-lang" name="templateLanguage" placeholder="en" />
          </Field>
          <Field label="Code template (optional)" htmlFor="wa-verify" hint="An approved authentication template for the 6-digit number check.">
            <Input id="wa-verify" name="verifyTemplateName" placeholder="govern_code" />
          </Field>
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-no">
          {error}
        </p>
      ) : null}
      <div>
        <Button variant="primary" disabled={busy}>
          {busy ? "Connecting…" : `Connect ${LABEL[kind]}`}
        </Button>
      </div>
      {fresh.dialog}
    </form>
  );
}

export function Disconnect({ kind, totpEnabled }: { kind: Kind; totpEnabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const fresh = useFresh(totpEnabled);
  return (
    <div>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await fresh.run(async () => {
              await api(`/api/notifications/${kind}`, undefined, "DELETE");
              toast.ok(`${LABEL[kind]} disconnected. Elan1 Govern deleted the stored secrets.`);
              router.refresh();
            });
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : "Could not disconnect.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Disconnect {LABEL[kind]}
      </Button>
      {fresh.dialog}
    </div>
  );
}

export function MyNumber({ connected, current }: { connected: boolean; current: { masked: string; verified: boolean } | null }) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<"idle" | "code">(current && !current.verified ? "code" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const call = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };
  if (!connected) return <p className="text-sm text-ink-3">WhatsApp is not connected for this organisation yet.</p>;
  return (
    <div className="grid gap-4 text-sm">
      {current ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono">{current.masked}</span>
          {current.verified ? <Pill tone="ok">Verified</Pill> : <Pill tone="wait">Waiting for the code</Pill>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => call(async () => {
            await api("/api/notifications/whatsapp/number", undefined, "DELETE");
            toast.ok("Number removed.");
            setStep("idle");
            router.refresh();
          })}>
            Remove
          </Button>
        </div>
      ) : null}
      {step === "code" ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const code = String(new FormData(e.currentTarget).get("code") ?? "");
            void call(async () => {
              await api("/api/notifications/whatsapp/number", { code }, "PUT");
              toast.ok("Your WhatsApp number is verified.");
              setStep("idle");
              router.refresh();
            });
          }}
        >
          <Field label="6-digit code" htmlFor="wa-code">
            <Input id="wa-code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required className="w-40" />
          </Field>
          <Button variant="primary" disabled={busy}>Verify</Button>
        </form>
      ) : (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const number = String(new FormData(e.currentTarget).get("number") ?? "");
            void call(async () => {
              await api("/api/notifications/whatsapp/number", { number });
              toast.ok("Code sent on WhatsApp.");
              setStep("code");
              router.refresh();
            });
          }}
        >
          <Field label={current ? "Change number" : "WhatsApp number"} htmlFor="wa-number" hint="With the country code, for example +91 98765 43210.">
            <Input id="wa-number" name="number" type="tel" required className="w-60" />
          </Field>
          <Button disabled={busy}>Send code</Button>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-no">
          {error}
        </p>
      ) : null}
    </div>
  );
}
