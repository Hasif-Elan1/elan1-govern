"use client";

import { RISK_TAGS, RISK_TAG_LABELS, type RiskTag } from "@gate/core/browser";
import { Plus, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/fields";
import { EmptyState, Section } from "@/components/ui/layout";
import { Pill } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";
import { cn, relative } from "@/lib/utils";

export type UpstreamToolRow = { id: string; name: string; description: string; tags: string[]; enabled: boolean };
export type UpstreamRow = { id: string; slug: string; name: string; url: string; status: string; lastSyncedAt: string | null; error: string | null; tools: UpstreamToolRow[] };

type SyncResult = { ok: boolean; tools?: number; added?: number; error?: string };

function syncMessage(name: string, s: SyncResult) {
  if (!s.ok) return `${name} was saved, but Elan1 Govern could not list its tools: ${s.error ?? "unknown error"}. Fix it and press Sync tools.`;
  return `${name} has ${s.tools} tools${s.added ? `, ${s.added} new` : ""}. New tools stay off until you check their tags and switch them on.`;
}

function AddServer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ sync: SyncResult }>("/api/upstreams", { name, url, ...(auth ? { authHeader: auth } : {}) });
      if (r.sync.ok) toast.ok(syncMessage(name, r.sync));
      else toast.error(syncMessage(name, r.sync));
      setName("");
      setUrl("");
      setAuth("");
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add an MCP server" description="Elan1 Govern connects to the server, lists its tools and suggests a risk tag for each. Agents reach the tools only through Elan1 Govern, and only the ones you switch on.">
        <form className="grid gap-4" onSubmit={submit}>
          <Field label="Name" htmlFor="up-name" hint="Tool names start with it, for example crm.issue_refund.">
            <Input id="up-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM" />
          </Field>
          <Field label="URL" htmlFor="up-url" hint="The server's streamable HTTP address.">
            <Input id="up-url" required type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
          </Field>
          <Field label="Authorization header (optional)" htmlFor="up-auth" hint="Sent as the Authorization header, for example Bearer sk_live_…. Elan1 Govern stores it encrypted and never shows it again.">
            <Input id="up-auth" type="password" autoComplete="off" value={auth} onChange={(e) => setAuth(e.target.value)} />
          </Field>
          {error ? (
            <p role="alert" className="text-sm text-no">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Connecting…" : "Add server"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ToolRow({ server, tool, manage }: { server: UpstreamRow; tool: UpstreamToolRow; manage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function save(patch: { enabled?: boolean; tags?: RiskTag[] }) {
    setBusy(true);
    try {
      await api(`/api/upstreams/${server.id}/tools/${tool.id}`, patch, "PATCH");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not change the tool.");
    } finally {
      setBusy(false);
    }
  }
  const toggleTag = (t: RiskTag) => save({ tags: (tool.tags.includes(t) ? tool.tags.filter((x) => x !== t) : [...tool.tags, t]) as RiskTag[] });

  return (
    <li className="grid gap-2 px-4 py-3">
      <label className={cn("flex items-start gap-3", manage && "cursor-pointer")}>
        <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={tool.enabled} disabled={!manage || busy} onChange={(e) => save({ enabled: e.target.checked })} aria-label={`Agents can use ${tool.name}`} />
        <span className="min-w-0">
          <code className="font-mono text-[13px] text-ink">{tool.name}</code>
          {tool.description ? <span className="mt-0.5 block text-[13px] text-ink-3">{tool.description}</span> : null}
        </span>
      </label>
      <ul className="ml-7 flex flex-wrap gap-1.5" aria-label={`Risk tags for ${tool.name}`}>
        {RISK_TAGS.filter((t) => manage || tool.tags.includes(t)).map((t) => {
          const on = tool.tags.includes(t);
          return (
            <li key={t}>
              <button
                type="button"
                aria-pressed={on}
                disabled={!manage || busy}
                onClick={() => toggleTag(t)}
                className={cn(
                  "h-6 rounded-full border px-2 text-[12.5px] font-medium disabled:cursor-default",
                  on ? "border-accent-line bg-accent-soft text-accent" : "border-dashed border-line-2 text-ink-3 hover:text-ink-2",
                  manage && !busy && "cursor-pointer",
                )}
              >
                {RISK_TAG_LABELS[t]}
              </button>
            </li>
          );
        })}
        {!manage && !tool.tags.length ? <li className="text-[12.5px] text-ink-3">No risk tags</li> : null}
      </ul>
    </li>
  );
}

function ServerCard({ server, manage }: { server: UpstreamRow; manage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const on = server.tools.filter((t) => t.enabled).length;

  async function sync() {
    setBusy(true);
    try {
      const r = await api<SyncResult>(`/api/upstreams/${server.id}/sync`);
      toast.ok(syncMessage(server.name, { ...r, ok: true }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not sync the server.");
    } finally {
      setBusy(false);
      router.refresh();
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await api(`/api/upstreams/${server.id}`, undefined, "DELETE");
      toast.ok(`${server.name} removed. Agents can no longer use its tools.`);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not remove the server.");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-start gap-3 p-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sunken">
          <Server className="size-5 text-ink-2" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{server.name}</h3>
            {server.status === "ok" ? <Pill tone="ok">Connected</Pill> : server.status === "error" ? <Pill tone="no">Needs attention</Pill> : <Pill>Not synced</Pill>}
          </div>
          <p className="mt-0.5 truncate text-[13px] text-ink-3">
            {server.url.split("?")[0]} · {server.lastSyncedAt ? `synced ${relative(server.lastSyncedAt)}` : "never synced"} · {on} of {server.tools.length} tools on
          </p>
          {server.error ? <p className="mt-1 text-[13px] text-no">{server.error}</p> : null}
        </div>
        {manage ? (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={sync}>
              {busy ? "Syncing…" : "Sync tools"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>
              Remove
            </Button>
          </div>
        ) : null}
      </div>
      {server.tools.length ? (
        <ul className="divide-y divide-line border-t border-line">
          {server.tools.map((t) => (
            <ToolRow key={t.id} server={server} tool={t} manage={manage} />
          ))}
        </ul>
      ) : (
        <p className="border-t border-line px-5 py-4 text-sm text-ink-3">No tools listed yet. Press Sync tools once the server is reachable.</p>
      )}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title={`Remove ${server.name}?`} description={`Agents will be refused every ${server.slug}.* tool. Elan1 Govern deletes the stored auth header. Rules that name these tools stay in your rulebooks and simply stop matching.`}>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={remove}>
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function UpstreamServers({ servers, manage }: { servers: UpstreamRow[]; manage: boolean }) {
  const [adding, setAdding] = useState(false);
  const add = (
    <Button variant={servers.length ? "secondary" : "primary"} onClick={() => setAdding(true)}>
      <Plus /> Add an MCP server
    </Button>
  );
  return (
    <Section
      className="mt-10"
      title="Your MCP servers"
      description="Put any MCP server behind Elan1 Govern: a CRM, ticketing, health records, cloud tools. Tag each tool with what it can do, then write rules by tag."
      actions={manage && servers.length ? add : undefined}
    >
      {servers.length ? (
        <div className="grid gap-4">
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} manage={manage} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Server />}
          title="No MCP servers yet"
          body={manage ? "Add the address of an MCP server your agents use. Elan1 Govern lists its tools, and agents reach them only through your rules." : "An owner or admin can add an MCP server here."}
          action={manage ? add : undefined}
        />
      )}
      {manage ? <AddServer open={adding} onOpenChange={setAdding} /> : null}
    </Section>
  );
}
