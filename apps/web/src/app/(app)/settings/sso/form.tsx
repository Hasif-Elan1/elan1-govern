"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/fields";
import { Card } from "@/components/ui/layout";
import { Secret, Switch } from "@/components/ui/misc";
import { Pill } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";

type Current = { issuer: string; clientId: string; domains: string[]; verifiedDomains: string[]; enforce: boolean; defaultRole: string; enabled: boolean; verifyToken: string } | null;

export function SsoForm({ current, callbackUrl }: { current: Current; callbackUrl: string; webUrl: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [enforce, setEnforce] = useState(current?.enforce ?? false);
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const [needAuth, setNeedAuth] = useState(false);

  async function save(form: HTMLFormElement) {
    const f = new FormData(form);
    setBusy(true);
    try {
      await api(
        "/api/settings/sso",
        {
          issuer: f.get("issuer"),
          clientId: f.get("clientId"),
          ...(f.get("clientSecret") ? { clientSecret: f.get("clientSecret") } : {}),
          domains: String(f.get("domains") ?? "")
            .split(/[\s,]+/)
            .filter(Boolean),
          enforce,
          defaultRole: f.get("defaultRole"),
          enabled,
        },
        "PUT",
      );
      toast.ok("Single sign-on saved.");
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.data.reauth) setNeedAuth(true);
      toast.error(e instanceof ApiError ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6">
      <Card className="p-5">
        <p className="mb-2 text-sm font-medium">In your identity provider, create an OIDC web app with this redirect URL:</p>
        <Secret value={callbackUrl} />
        <p className="mt-2 text-[13px] text-ink-3">Scopes: openid, email, profile. Then copy its issuer URL, client ID and client secret below.</p>
      </Card>

      {needAuth ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/api/auth/session", { password: new FormData(e.currentTarget).get("password") });
              setNeedAuth(false);
              toast.ok("Confirmed. Save again.");
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : "That did not work.");
            }
          }}
        >
          <Field label="Confirm your password to change sign-in settings" htmlFor="sso-pw">
            <Input id="sso-pw" name="password" type="password" required className="w-72" />
          </Field>
          <Button>Confirm</Button>
        </form>
      ) : null}

      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save(e.currentTarget);
        }}
      >
        <Field label="Issuer URL" htmlFor="issuer" hint="For example https://acme.okta.com or https://login.microsoftonline.com/<tenant>/v2.0">
          <Input id="issuer" name="issuer" type="url" required defaultValue={current?.issuer} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client ID" htmlFor="clientId">
            <Input id="clientId" name="clientId" required defaultValue={current?.clientId} />
          </Field>
          <Field label="Client secret" htmlFor="clientSecret" hint={current ? "Leave empty to keep the saved secret." : "Stored encrypted. Never shown again."}>
            <Input id="clientSecret" name="clientSecret" type="password" autoComplete="off" required={!current} />
          </Field>
        </div>
        <Field label="Email domains" htmlFor="domains" hint="People with these email addresses sign in through your identity provider. Separate with commas.">
          <Input id="domains" name="domains" required defaultValue={current?.domains.join(", ")} placeholder="acme.com" />
        </Field>
        <Field label="Role for people who sign in for the first time" htmlFor="defaultRole">
          <Select id="defaultRole" name="defaultRole" defaultValue={current?.defaultRole ?? "viewer"}>
            <option value="viewer">Viewer</option>
            <option value="approver">Approver</option>
            <option value="auditor">Auditor</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Single sign-on on" />
          Single sign-on is {enabled ? "on" : "off"}
        </label>
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={enforce} onCheckedChange={setEnforce} aria-label="Require single sign-on" />
          Require single sign-on for verified domains (password sign-in stops working for them)
        </label>
        <div>
          <Button variant="primary" disabled={busy}>
            {busy ? "Checking your identity provider…" : "Save"}
          </Button>
        </div>
      </form>

      {current ? (
        <Card className="p-5">
          <p className="font-medium">Prove you own each domain</p>
          <p className="mt-1 mb-3 text-sm text-ink-2">Add this TXT record to each domain&apos;s DNS, then press Verify. Single sign-on only works for verified domains.</p>
          <Secret value={`gate-verify=${current.verifyToken}`} />
          <ul className="mt-4 divide-y divide-line rounded-lg border border-line text-sm">
            {current.domains.map((d) => (
              <DomainRow key={d} domain={d} verified={current.verifiedDomains.includes(d)} />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function DomainRow({ domain, verified }: { domain: string; verified: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <span className="flex-1 font-medium">{domain}</span>
      {verified ? (
        <Pill tone="ok">Verified</Pill>
      ) : (
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("/api/settings/sso", { domain });
              toast.ok(`${domain} is verified.`);
              router.refresh();
            } catch (e) {
              toast.error(e instanceof ApiError ? e.message : "Could not verify.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Checking…" : "Verify"}
        </Button>
      )}
    </li>
  );
}
