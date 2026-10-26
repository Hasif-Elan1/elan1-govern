"use client";

import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConnectAgent } from "@/components/connect-agent";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Card } from "@/components/ui/layout";
import { Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { Pill } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";
import { relative } from "@/lib/utils";

/** The kill switch. Pausing asks first, because it stops the agent mid-work. */
export function KillSwitch({ slug, name, paused }: { slug: string; name: string; paused: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = async (status: "active" | "paused") => {
    setBusy(true);
    try {
      await api(`/api/agents/${slug}/status`, { status });
      toast.ok(status === "paused" ? `${name} is paused. Every call is refused now.` : `${name} is running again.`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not change the agent.");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <>
      <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
        <Switch checked={!paused} disabled={busy} onCheckedChange={(on) => (on ? set("active") : setConfirm(true))} aria-label={paused ? "Resume agent" : "Pause agent"} />
        <span className="font-medium">{paused ? "Paused" : "Running"}</span>
      </label>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title={`Pause ${name}?`} description="Gate will refuse every call this agent makes, starting with its next one. Actions waiting for approval stay waiting.">
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Keep running</Button>
            <Button variant="danger" disabled={busy} onClick={() => set("paused")}>
              {busy ? "Pausing…" : "Pause agent"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

type Key = { id: string; label: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

function Keys({ slug, keys, manage, mcpUrl, gateUrl }: { slug: string; keys: Key[]; manage: boolean; mcpUrl: string; gateUrl: string }) {
  const router = useRouter();
  const toast = useToast();
  const [fresh, setFresh] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<Key | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ apiKey: string }>(`/api/agents/${slug}/keys`, {});
      setFresh(r.apiKey);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not create a key.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-8">
      {fresh ? (
        <Card className="border-accent-line p-5">
          <p className="mb-4 font-medium">New key created. Connect your agent with it:</p>
          <ConnectAgent mcpUrl={mcpUrl} gateUrl={gateUrl} apiKey={fresh} />
        </Card>
      ) : null}
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-sm text-ink-2">Gate stores only a hash of each key. A revoked key stops working at once.</p>
          {manage ? (
            <Button onClick={create} disabled={busy}>
              <KeyRound /> {busy ? "Creating…" : "Create key"}
            </Button>
          ) : null}
        </div>
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface text-sm">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <code className="font-mono text-[13px]">{k.prefix}…</code>
              <span className="text-ink-2">{k.label}</span>
              <span className="flex-1 text-[13px] text-ink-3">Last used {relative(k.lastUsedAt).toLowerCase()}</span>
              {k.revokedAt ? (
                <Pill>Revoked</Pill>
              ) : manage ? (
                <Button size="sm" variant="ghost" onClick={() => setRevoke(k)}>
                  Revoke
                </Button>
              ) : (
                <Pill tone="ok">Active</Pill>
              )}
            </li>
          ))}
        </ul>
      </div>
      {!fresh ? (
        <div>
          <p className="mb-3 font-medium">Connecting an agent</p>
          <ConnectAgent mcpUrl={mcpUrl} gateUrl={gateUrl} />
        </div>
      ) : null}
      <Dialog open={!!revoke} onOpenChange={(o) => !o && setRevoke(null)}>
        <DialogContent title="Revoke this key?" description={`Any agent using ${revoke?.prefix}… will be turned away immediately. This cannot be undone.`}>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRevoke(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/api/agents/${slug}/keys`, { revokeKeyId: revoke!.id });
                  toast.ok("Key revoked.");
                  router.refresh();
                } catch (e) {
                  toast.error(e instanceof ApiError ? e.message : "Could not revoke the key.");
                } finally {
                  setBusy(false);
                  setRevoke(null);
                }
              }}
            >
              Revoke key
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AgentTabs(props: { overview: React.ReactNode; rulebook: React.ReactNode; slug: string; manage: boolean; mcpUrl: string; gateUrl: string; keys: Key[] }) {
  return (
    <Tabs defaultValue="overview">
      <TabsList className="mb-6">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="rulebook">Rulebook</TabsTrigger>
        <TabsTrigger value="keys">Keys and connection</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">{props.overview}</TabsContent>
      <TabsContent value="rulebook">{props.rulebook}</TabsContent>
      <TabsContent value="keys">
        <Keys slug={props.slug} keys={props.keys} manage={props.manage} mcpUrl={props.mcpUrl} gateUrl={props.gateUrl} />
      </TabsContent>
    </Tabs>
  );
}
