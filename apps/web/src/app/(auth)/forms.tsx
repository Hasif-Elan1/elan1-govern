"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/fields";
import { api, ApiError } from "@/lib/client";

function useSubmit() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not reach Gate. Check your connection.");
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run, setError };
}

export function LoginForm({ next, ssoError }: { next?: string; ssoError?: string }) {
  const router = useRouter();
  const { error, busy, run, setError } = useSubmit();
  const [needTotp, setNeedTotp] = useState(false);
  const [sso, setSso] = useState(false);
  const shownError = error ?? ssoError ?? null;

  if (sso) {
    return (
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const r = await run(() => api<{ url: string }>("/api/auth/sso/start", { email: f.get("email"), next }));
          if (r?.url) window.location.href = r.url;
        }}
      >
        <Field label="Work email" htmlFor="email" hint="We'll send you to your company's sign-in page.">
          <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
        </Field>
        {shownError ? (
          <p role="alert" className="rounded-md border border-no-line bg-no-soft px-3 py-2 text-sm text-no">
            {shownError}
          </p>
        ) : null}
        <Button variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
          {busy ? "Opening your sign-in page…" : "Continue with single sign-on"}
        </Button>
        <button type="button" className="cursor-pointer text-left text-sm font-medium text-accent hover:underline" onClick={() => (setSso(false), setError(null))}>
          Use a password instead
        </button>
      </form>
    );
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        let ssoRequired = false;
        const r = await run(async () => {
          try {
            return await api<{ next?: string; needTotp?: boolean }>("/api/auth/login", { email: f.get("email"), password: f.get("password"), totp: f.get("totp") ?? undefined, next });
          } catch (err) {
            if (err instanceof ApiError && err.data.sso) ssoRequired = true;
            throw err;
          }
        });
        if (ssoRequired) setSso(true);
        if (r?.needTotp) setNeedTotp(true);
        else if (r?.next) {
          router.replace(r.next);
          router.refresh();
        }
      }}
    >
      <Field label="Work email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      {needTotp ? (
        <Field label="Code from your authenticator app" htmlFor="totp" hint="Six digits. It changes every 30 seconds.">
          <Input id="totp" name="totp" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus />
        </Field>
      ) : null}
      {shownError ? (
        <p role="alert" className="rounded-md border border-no-line bg-no-soft px-3 py-2 text-sm text-no">
          {shownError}
        </p>
      ) : null}
      <Button variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
        {busy ? "Signing in…" : "Sign in"}
      </Button>
      <button type="button" className="cursor-pointer text-left text-sm font-medium text-accent hover:underline" onClick={() => (setSso(true), setError(null))}>
        Use single sign-on
      </button>
      <p className="text-sm text-ink-2">
        New to Gate?{" "}
        <Link href="/signup" className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  );
}

export function SignupForm({ invite, inviteEmail }: { invite?: string; inviteEmail?: string }) {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const r = await run(() => api<{ next: string }>("/api/auth/signup", { name: f.get("name"), email: f.get("email"), password: f.get("password"), ...(invite ? { invite } : {}) }));
        if (r) {
          router.replace(r.next);
          router.refresh();
        }
      }}
    >
      <Field label="Your name" htmlFor="name">
        <Input id="name" name="name" autoComplete="name" required autoFocus />
      </Field>
      <Field label="Work email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required defaultValue={inviteEmail} readOnly={!!inviteEmail} />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 12 characters. A short sentence works well.">
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      {error ? (
        <p role="alert" className="rounded-md border border-no-line bg-no-soft px-3 py-2 text-sm text-no">
          {error}
        </p>
      ) : null}
      <Button variant="primary" size="lg" disabled={busy} className="mt-1 w-full">
        {busy ? "Creating your account…" : "Create account"}
      </Button>
      <p className="text-sm text-ink-2">
        Already have an account?{" "}
        <Link href={invite ? `/login?next=/invite/${invite}` : "/login"} className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export function OrgForm() {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const r = await run(() => api("/api/orgs", { name: f.get("name") }));
        if (r) {
          router.replace("/onboarding?step=demo");
          router.refresh();
        }
      }}
    >
      <Field label="Company name" htmlFor="org" hint="As it appears on your invoices, e.g. Sharma Traders Pvt Ltd.">
        <Input id="org" name="name" required autoFocus minLength={2} maxLength={120} />
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-no">
          {error}
        </p>
      ) : null}
      <Button variant="primary" size="lg" disabled={busy} className="w-full">
        {busy ? "Setting up…" : "Continue"}
      </Button>
    </form>
  );
}

export function DemoStart() {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  return (
    <div className="grid gap-3">
      <Button
        variant="primary"
        size="lg"
        disabled={busy}
        className="w-full"
        onClick={async () => {
          const r = await run(() => api("/api/demo"));
          if (r) {
            router.replace("/?demo=1");
            router.refresh();
          }
        }}
      >
        {busy ? "Starting the demo agent…" : "Try the demo agent"}
      </Button>
      <Link href="/agents/new" className="text-center text-sm font-medium text-ink-2 hover:text-ink">
        Skip, and set up my own agent
      </Link>
      {error ? (
        <p role="alert" className="text-sm text-no">
          {error}
        </p>
      ) : null}
    </div>
  );
}
