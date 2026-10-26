"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/client";

export function AcceptInvite({ token, email, signedInAs }: { token: string; email: string; signedInAs: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (email !== signedInAs) return <p className="text-ink-2">This invite is for {email}, but you are signed in as {signedInAs}. Sign out and sign in with the invited address.</p>;
  return (
    <div className="grid gap-3">
      <Button
        variant="primary"
        size="lg"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api("/api/invites", { token });
            router.replace("/");
            router.refresh();
          } catch (e) {
            setError(e instanceof ApiError ? e.message : "Could not accept the invite.");
            setBusy(false);
          }
        }}
      >
        Accept and continue
      </Button>
      {error ? <p className="text-sm text-no">{error}</p> : null}
    </div>
  );
}
