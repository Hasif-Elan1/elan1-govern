"use client";

import { frameworkById, PACKS, recommendedFrameworks, REGION_LABELS, REGIONS, packById, type Region } from "@gate/core/frameworks";
import { Check } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/fields";
import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";

function useSubmit() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not reach Elan1 Govern. Check your connection.");
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
        New to Elan1 Govern?{" "}
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
          router.replace("/onboarding?step=industry");
          router.refresh();
        }
      }}
    >
      <Field label="Company name" htmlFor="org" hint="Its legal or trading name, e.g. Sharma Traders Pvt Ltd.">
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

const choice = (on: boolean) =>
  cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent", on ? "border-accent bg-accent-soft text-ink" : "border-line-2 bg-surface hover:border-ink-3");

/** Onboarding step 2: the industry pack and where the org operates. */
export function IndustryForm({ industry, regions: initialRegions, next }: { industry: string | null; regions: string[]; next: string }) {
  const router = useRouter();
  const { error, busy, run } = useSubmit();
  const [pack, setPack] = useState<string | null>(industry);
  const [regions, setRegions] = useState<Region[]>(initialRegions.filter((r): r is Region => (REGIONS as readonly string[]).includes(r)));
  const chosen = packById(pack);
  const frameworks = chosen && regions.length ? recommendedFrameworks(chosen, regions).map((id) => frameworkById(id)!.shortName) : [];
  return (
    <form
      className="grid gap-7"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(() => api("/api/compliance/profile", { industry: pack, regions }, "PUT"));
        if (r) {
          router.replace(next);
          router.refresh();
        }
      }}
    >
      <fieldset>
        <legend className="mb-2.5 font-medium">The kind of work</legend>
        <div className="grid gap-2">
          {PACKS.map((p) => (
            <label key={p.id} className={choice(pack === p.id)}>
              <input type="radio" className="sr-only" name="industry" value={p.id} checked={pack === p.id} onChange={() => setPack(p.id)} />
              <Check className={cn("mt-0.5 size-4 shrink-0", pack === p.id ? "text-accent" : "invisible")} />
              <span>
                <span className="block font-medium">{p.name}</span>
                <span className="block text-[13px] text-ink-3">{p.summary}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2.5 font-medium">Where you operate</legend>
        <div className="flex flex-wrap gap-2">
          {REGIONS.map((r) => {
            const on = regions.includes(r);
            return (
              <label key={r} className={choice(on)}>
                <input type="checkbox" className="sr-only" name="regions" value={r} checked={on} onChange={() => setRegions((rs) => (on ? rs.filter((x) => x !== r) : [...rs, r]))} />
                {on ? <Check className="size-4 text-accent" /> : null}
                {REGION_LABELS[r]}
              </label>
            );
          })}
        </div>
        <p className="mt-2 text-[13px] text-ink-3">Pick every place where you have customers, staff or operations.</p>
      </fieldset>
      {frameworks.length ? (
        <p className="text-sm text-ink-2">
          Elan1 Govern will turn on: <span className="font-medium text-ink">{frameworks.join(", ")}</span>.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-no">
          {error}
        </p>
      ) : null}
      <Button variant="primary" size="lg" disabled={busy || !pack || !regions.length} className="w-full">
        {busy ? "Saving…" : "Continue"}
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
