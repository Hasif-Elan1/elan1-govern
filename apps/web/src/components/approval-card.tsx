"use client";

import { formatINR } from "@gate/core/browser";
import { Clock, FileText, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { InvoicePreview, type InvoiceDoc } from "@/components/invoice";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/fields";
import { KeyValue } from "@/components/ui/layout";
import { Pill, Stamp } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";
import { cn, fmtDate, fmtDateTime, timeLeft } from "@/lib/utils";

export interface ApprovalView {
  id: string;
  agentName: string;
  agentSlug: string;
  action: string;
  ruleId: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "expired";
  expiresAt: string;
  createdAt: string;
  approvers: string[];
  resolvedBy: string | null;
  resolvedAt: string | null;
  note: string | null;
  selfApproval: boolean;
  setUpByYou: boolean;
  outcome: { status?: string; ref?: string; error?: string } | null;
  evidence: {
    vendor?: { name: string; email?: string; gstin?: string; bank?: string; ifsc?: string; city?: string };
    bill?: { number: string; date: string; due_date?: string; total_inr: number; balance_inr: number; status: string };
    invoice?: InvoiceDoc;
  };
  amount?: number;
}

function TimeLeft({ to }: { to: string }) {
  const [text, setText] = useState(() => timeLeft(to));
  useEffect(() => {
    const t = setInterval(() => setText(timeLeft(to)), 30_000);
    return () => clearInterval(t);
  }, [to]);
  return (
    <Pill tone="wait" icon={<Clock />}>
      {text}
    </Pill>
  );
}

export function ReauthDialog({
  open,
  onDone,
  onCancel,
  needTotp: initialTotp,
  description = "Approving moves money, so Gate asks for your password if you signed in more than 10 minutes ago.",
}: {
  open: boolean;
  onDone: () => void;
  onCancel: () => void;
  needTotp: boolean;
  description?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [needTotp, setNeedTotp] = useState(initialTotp);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent title="Confirm it's you" description={description}>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setError(null);
            try {
              const r = await api<{ ok?: boolean; needTotp?: boolean }>("/api/auth/session", { password: f.get("password"), totp: f.get("totp") ?? undefined });
              if (r.needTotp) setNeedTotp(true);
              else onDone();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "That did not work.");
              if (err instanceof ApiError && err.data.needTotp) setNeedTotp(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Password" htmlFor="reauth-password">
            <Input id="reauth-password" name="password" type="password" autoComplete="current-password" required autoFocus />
          </Field>
          {needTotp ? (
            <Field label="Code from your authenticator app" htmlFor="reauth-totp">
              <Input id="reauth-totp" name="totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
            </Field>
          ) : null}
          {error ? <p className="text-sm text-no">{error}</p> : null}
          <Button variant="primary" size="lg" disabled={busy}>
            {busy ? "Checking…" : "Confirm"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Decide({ a, token, totpEnabled }: { a: ApprovalView; token?: string; totpEnabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [reauth, setReauth] = useState<"approved" | "rejected" | null>(null);

  async function decide(result: "approved" | "rejected") {
    setBusy(result);
    try {
      const r = await api<{ status: string; outcome?: { status: string; ref?: string; error?: string } }>(`/api/approvals/${a.id}`, { result, note: note || undefined, token });
      if (result === "approved") {
        if (r.outcome?.status === "ok") toast.ok(`Approved. ${a.action} is done${r.outcome.ref ? ` (${r.outcome.ref})` : ""}.`);
        else if (r.outcome?.status === "not_run") toast.ok("Approved. The agent can go ahead.");
        else toast.error(`Approved, but it did not complete: ${r.outcome?.error ?? "unknown error"}`);
      } else toast.ok("Rejected. The agent was told not to do it.");
      router.replace(`/approvals/${a.id}`);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.data.reauth) setReauth(result);
      else toast.error(e instanceof ApiError ? e.message : "Could not reach Gate.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-3">
      <Field label="Note (optional)" htmlFor={`note-${a.id}`} hint="Saved with the decision. Visible to your team.">
        <Textarea id={`note-${a.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} placeholder="e.g. Checked the bank details with Sharma Traders on the phone." />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Button variant="reject" size="lg" disabled={!!busy} onClick={() => decide("rejected")}>
          {busy === "rejected" ? "Rejecting…" : "Reject"}
        </Button>
        <Button variant="approve" size="lg" disabled={!!busy} onClick={() => decide("approved")}>
          {busy === "approved" ? "Approving…" : "Approve"}
        </Button>
      </div>
      <ReauthDialog
        open={reauth !== null}
        needTotp={totpEnabled}
        onCancel={() => setReauth(null)}
        onDone={() => {
          const r = reauth;
          setReauth(null);
          if (r) void decide(r);
        }}
      />
    </div>
  );
}

export function ApprovalCard({ a, me, canDecide, token, totpEnabled, expanded }: { a: ApprovalView; me: string; canDecide: boolean; token?: string; totpEnabled: boolean; expanded?: boolean }) {
  const [showInvoice, setShowInvoice] = useState(!!expanded);
  const pending = a.status === "pending";
  const isApprover = a.approvers.includes(me);
  const others = a.approvers.filter((x) => x !== me);
  const v = a.evidence.vendor;
  const b = a.evidence.bill;

  return (
    <article className={cn("rounded-xl border bg-surface", pending ? "border-wait-line" : "border-line")}>
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink-3">
            <Link href={`/agents/${a.agentSlug}`} className="font-medium text-ink-2 hover:underline">
              {a.agentName}
            </Link>{" "}
            asks to
          </p>
          {pending ? <TimeLeft to={a.expiresAt} /> : <Stamp kind={a.status} animate={expanded} />}
        </div>
        <h2 className="mt-2 text-[22px] leading-snug font-semibold sm:text-2xl">
          {expanded ? a.action : <Link href={`/approvals/${a.id}`} className="hover:underline">{a.action}</Link>}
        </h2>
        <p className="mt-2 text-[14.5px] text-ink-2">
          {a.reason} <span className="whitespace-nowrap text-ink-3">Rule <code className="font-mono text-[13px] text-ink-2">{a.ruleId}</code></span>
        </p>

        {pending && a.setUpByYou && isApprover ? (
          <div role="note" className="mt-4 flex gap-2.5 rounded-lg border border-wait-line bg-wait-soft px-3.5 py-3 text-sm text-ink">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-wait" />
            <p>
              You set up this agent. You can still approve, but the receipt will show that you approved your own agent's action.
              {others.length ? ` If you can, ask ${others.join(" or ")} instead.` : ""}
            </p>
          </div>
        ) : null}

        {v || b ? (
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            {v ? (
              <div className="rounded-lg bg-sunken p-4">
                <p className="mb-2.5 text-[13px] font-medium text-ink-3">Vendor</p>
                <KeyValue
                  items={[
                    ["Name", v.name],
                    ...(v.gstin ? ([["GSTIN", <span key="g" className="font-mono text-[13px]">{v.gstin}</span>]] as [string, React.ReactNode][]) : []),
                    ...(v.bank ? ([["Bank account", `${v.bank}${v.ifsc ? `, ${v.ifsc}` : ""}`]] as [string, React.ReactNode][]) : []),
                    ...(v.email ? ([["Email", v.email]] as [string, React.ReactNode][]) : []),
                  ]}
                />
              </div>
            ) : null}
            {b ? (
              <div className="rounded-lg bg-sunken p-4">
                <p className="mb-2.5 text-[13px] font-medium text-ink-3">Bill in Zoho Books</p>
                <KeyValue
                  items={[
                    ["Bill", b.number],
                    ["Total", formatINR(b.total_inr)],
                    ["Still to pay", formatINR(b.balance_inr)],
                    ...(b.due_date ? ([["Due", fmtDate(b.due_date)]] as [string, React.ReactNode][]) : []),
                  ]}
                />
                {a.amount !== undefined && a.amount > b.balance_inr ? <p className="mt-2 text-sm text-no">This is more than what is still owed.</p> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {a.evidence.invoice ? (
          <div className="mt-4">
            {showInvoice ? (
              <InvoicePreview inv={a.evidence.invoice} />
            ) : (
              <button type="button" onClick={() => setShowInvoice(true)} className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-accent hover:underline">
                <FileText className="size-4" />
                Show the invoice ({a.evidence.invoice.filename})
              </button>
            )}
          </div>
        ) : null}
      </div>

      <div className={cn("border-t px-5 py-4 sm:px-6", pending ? "border-wait-line bg-wait-soft/40" : "border-line")}>
        {pending ? (
          canDecide && isApprover ? (
            <Decide a={a} token={token} totpEnabled={totpEnabled} />
          ) : (
            <p className="text-sm text-ink-2">Waiting for {a.approvers.join(" or ")}. Only the approvers named in the rule can decide.</p>
          )
        ) : (
          <div className="text-sm text-ink-2">
            {a.status === "expired" ? (
              <p>Nobody decided by {fmtDateTime(a.expiresAt)}, so it was refused.</p>
            ) : (
              <p>
                {a.status === "approved" ? "Approved" : "Rejected"} by <span className="text-ink">{a.resolvedBy}</span>
                {a.resolvedAt ? ` on ${fmtDateTime(a.resolvedAt)}` : ""}.
                {a.selfApproval ? <span className="text-wait"> They set up this agent.</span> : null}
                {a.outcome?.status === "ok" ? ` Done${a.outcome.ref ? `: ${a.outcome.ref}` : ""}.` : a.outcome?.status === "error" ? ` It did not complete: ${a.outcome.error}.` : ""}
              </p>
            )}
            {a.note ? <p className="mt-2 border-l-2 border-line-2 pl-3 text-ink">{a.note}</p> : null}
          </div>
        )}
      </div>
    </article>
  );
}
