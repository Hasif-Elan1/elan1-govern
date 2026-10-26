"use client";

import { AFFECTED_PEOPLE, DATA_CATEGORIES, DECISION_IMPACTS, LIFECYCLES, SYSTEM_KINDS } from "@gate/core/browser";
import { Check, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/fields";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";

export type SystemValues = {
  name: string;
  kind: string;
  vendor: string;
  purpose: string;
  ownerEmail: string;
  businessUnit: string;
  lifecycle: string;
  dataCategories: string[];
  affectedPeople: string[];
  decisionImpact: string;
};

/** A row of toggle chips for a multi-choice field. `exclusive` clears the others when picked. */
export function Chips({ name, options, value, onChange, exclusive }: { name: string; options: readonly (readonly [string, string])[]; value: string[]; onChange: (v: string[]) => void; exclusive?: string }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={name}>
      {options.map(([v, label]) => {
        const on = value.includes(v);
        return (
          <label key={v} className={cn("flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm", on ? "border-accent bg-accent-soft text-ink" : "border-line-2 bg-surface hover:border-ink-3")}>
            <input
              type="checkbox"
              className="sr-only"
              checked={on}
              onChange={() => {
                if (on) onChange(value.filter((x) => x !== v));
                else if (v === exclusive) onChange([v]);
                else onChange([...value.filter((x) => x !== exclusive), v]);
              }}
            />
            {on ? <Check className="size-3.5 text-accent" /> : null}
            {label}
          </label>
        );
      })}
    </div>
  );
}

const EMPTY: SystemValues = { name: "", kind: "vendor_tool", vendor: "", purpose: "", ownerEmail: "", businessUnit: "", lifecycle: "proposed", dataCategories: [], affectedPeople: [], decisionImpact: "supports_humans" };

/** Add or edit an AI system. With `id` it edits; otherwise it adds and opens the new system. */
export function SystemDialog({ id, initial, me, linkedAgent, trigger }: { id?: string; initial?: SystemValues; me: string; linkedAgent?: boolean; trigger: "add" | "edit" | "add-first" }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<SystemValues>(initial ?? { ...EMPTY, ownerEmail: me });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof SystemValues>(k: K, x: SystemValues[K]) => setV((p) => ({ ...p, [k]: x }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (id) {
        await api(`/api/inventory/${id}`, v, "PATCH");
        toast.ok("Saved.");
        setOpen(false);
        router.refresh();
      } else {
        const r = await api<{ id: string }>("/api/inventory", v);
        toast.ok(`${v.name} is in the inventory.`);
        router.push(`/inventory/${r.id}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the system.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setV(initial ?? { ...EMPTY, ownerEmail: me });
      }}
    >
      {trigger === "edit" ? (
        <Button onClick={() => setOpen(true)}>Edit details</Button>
      ) : (
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Plus /> {trigger === "add-first" ? "Add your first AI system" : "Add AI system"}
        </Button>
      )}
      <DialogContent wide title={id ? `Edit ${initial?.name ?? "system"}` : "Add an AI system"} description={id ? undefined : "Any AI your company uses: a model, a vendor tool, an internal app or an agent outside Elan1 Govern. You can assess it next."}>
        <form className="grid gap-5" onSubmit={save}>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name" htmlFor="sys-name">
              <Input id="sys-name" value={v.name} onChange={(e) => set("name", e.target.value)} required minLength={2} maxLength={120} autoFocus />
            </Field>
            <Field label="Kind" htmlFor="sys-kind" hint={linkedAgent ? "Linked to an Elan1 Govern agent, so it stays an agent." : undefined}>
              <Select id="sys-kind" value={v.kind} onChange={(e) => set("kind", e.target.value)} disabled={linkedAgent}>
                {SYSTEM_KINDS.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="What is it used for?" htmlFor="sys-purpose" hint="One or two sentences, in plain words.">
            <Textarea id="sys-purpose" value={v.purpose} onChange={(e) => set("purpose", e.target.value)} required minLength={5} maxLength={1000} placeholder="Screens job applications and ranks candidates for the recruiting team." />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Vendor" htmlFor="sys-vendor" hint="Leave empty if you built it.">
              <Input id="sys-vendor" value={v.vendor} onChange={(e) => set("vendor", e.target.value)} maxLength={120} />
            </Field>
            <Field label="Business unit" htmlFor="sys-unit">
              <Input id="sys-unit" value={v.businessUnit} onChange={(e) => set("businessUnit", e.target.value)} maxLength={120} placeholder="Finance" />
            </Field>
            <Field label="Owner" htmlFor="sys-owner" hint="The person answerable for it.">
              <Input id="sys-owner" type="email" value={v.ownerEmail} onChange={(e) => set("ownerEmail", e.target.value)} required />
            </Field>
            <Field label="Stage" htmlFor="sys-lifecycle">
              <Select id="sys-lifecycle" value={v.lifecycle} onChange={(e) => set("lifecycle", e.target.value)}>
                {LIFECYCLES.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="What data does it use?">
            <Chips name="Data" options={DATA_CATEGORIES} value={v.dataCategories} onChange={(x) => set("dataCategories", x)} exclusive="none" />
          </Field>
          <Field label="Who does it affect?">
            <Chips name="People affected" options={AFFECTED_PEOPLE} value={v.affectedPeople} onChange={(x) => set("affectedPeople", x)} />
          </Field>
          <Field label="Does it make decisions?" htmlFor="sys-impact">
            <Select id="sys-impact" value={v.decisionImpact} onChange={(e) => set("decisionImpact", e.target.value)}>
              {DECISION_IMPACTS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          {error ? (
            <p className="text-sm text-no" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy}>
              {busy ? "Saving…" : id ? "Save changes" : "Add to inventory"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
