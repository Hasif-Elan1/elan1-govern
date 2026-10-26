"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/fields";
import { Secret } from "@/components/ui/misc";
import { Pill } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";

const ROLE_OPTIONS = [
  ["owner", "Owner"],
  ["admin", "Admin"],
  ["approver", "Approver"],
  ["viewer", "Viewer"],
  ["auditor", "Auditor"],
] as const;

const RETENTION = [
  [365, "1 year"],
  [1095, "3 years"],
  [2555, "7 years"],
  [3650, "10 years"],
] as const;

function useAction() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.ok(ok);
      router.refresh();
      return true;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "That did not work.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function OrgForm({ name, notifyEmail, retentionDays, disabled }: { name: string; notifyEmail: string; retentionDays: number; disabled: boolean }) {
  const { busy, run } = useAction();
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void run(
          () => api("/api/settings", { name: f.get("name"), notifyEmail: String(f.get("notifyEmail") ?? "") || null, retentionDays: Number(f.get("retentionDays")) }, "PATCH"),
          "Settings saved.",
        );
      }}
    >
      <Field label="Name" htmlFor="org-name">
        <Input id="org-name" name="name" defaultValue={name} disabled={disabled} required minLength={2} maxLength={120} />
      </Field>
      <Field label="Notification email" htmlFor="org-notify" hint="Copied on approval emails and health alerts.">
        <Input id="org-notify" name="notifyEmail" type="email" defaultValue={notifyEmail} disabled={disabled} />
      </Field>
      <Field label="Keep records for" htmlFor="org-retention" hint="Receipts older than this can be archived. Ask your CA how long your records must be kept.">
        <Select id="org-retention" name="retentionDays" defaultValue={retentionDays} disabled={disabled}>
          {RETENTION.map(([d, l]) => (
            <option key={d} value={d}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      {!disabled ? (
        <div className="sm:col-span-2">
          <Button variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

export function MemberRow({ userId, name, email, role, twoStep, you, canManage, actorRole }: { userId: string; name: string; email: string; role: string; twoStep: boolean; you: boolean; canManage: boolean; actorRole: string }) {
  const { busy, run } = useAction();
  const [confirm, setConfirm] = useState(false);
  const ownerLocked = role === "owner" && actorRole !== "owner";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {name}
          {you ? <span className="ml-2 text-[13px] font-normal text-ink-3">you</span> : null}
        </p>
        <p className="truncate text-[13px] text-ink-3">{email}</p>
      </div>
      {twoStep ? <Pill tone="ok">Two-step on</Pill> : null}
      {canManage && !ownerLocked ? (
        <>
          <Select
            aria-label={`Role for ${email}`}
            className="h-9 w-36"
            value={role}
            disabled={busy}
            onChange={(e) => void run(() => api(`/api/members/${userId}`, { role: e.target.value }, "PATCH"), `${name} is now ${e.target.value}.`)}
          >
            {ROLE_OPTIONS.filter(([r]) => actorRole === "owner" || r !== "owner").map(([r, l]) => (
              <option key={r} value={r}>
                {l}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
            Remove
          </Button>
        </>
      ) : (
        <Pill>{ROLE_OPTIONS.find(([r]) => r === role)?.[1] ?? role}</Pill>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title={`Remove ${name}?`} description="They lose access to this organisation at once. Their past approvals stay on the receipts.">
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={() => void run(() => api(`/api/members/${userId}`, undefined, "DELETE"), `${name} was removed.`).then(() => setConfirm(false))}>
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function InviteForm({ actorRole }: { actorRole: string }) {
  const { busy, run } = useAction();
  const [link, setLink] = useState<string | null>(null);
  return (
    <div className="grid gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          let result: { link: string | null } | undefined;
          const ok = await run(async () => (result = await api<{ link: string | null }>("/api/members", { email: f.get("email"), role: f.get("role") })), "Invitation sent.");
          if (ok) {
            setLink(result?.link ?? null);
            form.reset();
          }
        }}
      >
        <Field label="Invite by email" htmlFor="invite-email">
          <Input id="invite-email" name="email" type="email" required className="w-72" placeholder="ca@yourfirm.in" />
        </Field>
        <Select aria-label="Role" name="role" defaultValue="approver" className="w-36">
          {ROLE_OPTIONS.filter(([r]) => actorRole === "owner" || r !== "owner").map(([r, l]) => (
            <option key={r} value={r}>
              {l}
            </option>
          ))}
        </Select>
        <Button disabled={busy}>{busy ? "Inviting…" : "Invite"}</Button>
      </form>
      {link ? (
        <div className="max-w-xl">
          <p className="mb-1.5 text-[13px] text-ink-2">We emailed this link. You can also send it yourself; it works once and lasts 7 days.</p>
          <Secret value={link} label="Copy link" />
        </div>
      ) : null}
    </div>
  );
}

export function TwoStep({ enabled }: { enabled: boolean }) {
  const { busy, run } = useAction();
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [needAuth, setNeedAuth] = useState(false);

  const start = async () => {
    try {
      setSetup(await api<{ qr: string; secret: string }>("/api/auth/totp", { action: "start" }));
    } catch (e) {
      if (e instanceof ApiError && e.data.reauth) setNeedAuth(true);
    }
  };

  if (needAuth) {
    return (
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const pw = new FormData(e.currentTarget).get("password");
          if (await run(() => api("/api/auth/session", { password: pw }))) {
            setNeedAuth(false);
            void start();
          }
        }}
      >
        <Field label="Confirm your password first" htmlFor="ts-pw">
          <Input id="ts-pw" name="password" type="password" required className="w-64" />
        </Field>
        <Button disabled={busy}>Confirm</Button>
      </form>
    );
  }

  if (enabled) {
    return (
      <div className="flex flex-wrap items-end gap-3">
        <p className="flex-1 text-sm">
          <Pill tone="ok">On</Pill> <span className="ml-2 text-ink-2">To turn it off, enter a current code.</span>
        </p>
        <Input aria-label="Current code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} className="w-32" placeholder="123456" />
        <Button disabled={busy || code.length !== 6} onClick={() => void run(() => api("/api/auth/totp", { action: "disable", code }), "Two-step sign-in is off.")}>
          Turn off
        </Button>
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-ink-2">Off. Recommended for anyone who approves payments.</p>
        <Button onClick={start}>Turn on two-step sign-in</Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
      <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} className="rounded-md border border-line bg-white p-1" />
      <div className="grid gap-3">
        <p className="text-sm text-ink-2">Scan the code with your authenticator app, or type this key into it:</p>
        <code className="font-mono text-[13px] break-all">{setup.secret}</code>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Code from the app" htmlFor="ts-code">
            <Input id="ts-code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} className="w-32" />
          </Field>
          <Button variant="primary" disabled={busy || code.length !== 6} onClick={() => void run(() => api("/api/auth/totp", { action: "enable", code }), "Two-step sign-in is on.")}>
            Turn on
          </Button>
        </div>
      </div>
    </div>
  );
}
