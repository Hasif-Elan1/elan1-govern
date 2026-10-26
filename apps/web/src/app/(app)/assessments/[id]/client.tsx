"use client";

import { checkAnswers, explainResult, scoreAssessment, type Answers, type AssessmentTemplate, type Question } from "@gate/core/browser";
import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { TierPill } from "@/components/inventory-bits";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/fields";
import { Card } from "@/components/ui/layout";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";

function Choice({ type, name, on, disabled, onChange, children }: { type: "radio" | "checkbox"; name: string; on: boolean; disabled: boolean; onChange: () => void; children: React.ReactNode }) {
  return (
    <label
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3.5 py-2 text-sm",
        on ? "border-accent bg-accent-soft text-ink" : "border-line-2 bg-surface",
        disabled ? "cursor-default opacity-80" : "cursor-pointer hover:border-ink-3",
      )}
    >
      <input type={type} className="sr-only" name={name} checked={on} disabled={disabled} onChange={onChange} />
      {on ? <Check className="mt-0.5 size-3.5 shrink-0 text-accent" /> : null}
      {children}
    </label>
  );
}

function QuestionField({ q, value, disabled, missing, onChange }: { q: Question; value: string | string[] | undefined; disabled: boolean; missing: boolean; onChange: (v: string | string[]) => void }) {
  const id = `q-${q.id}`;
  return (
    <fieldset id={id} className={cn("scroll-mt-20 rounded-lg", missing && "outline-2 outline-offset-4 outline-no-line")} aria-describedby={q.help ? `${id}-help` : undefined}>
      <legend className="mb-1 font-medium">
        {q.text}
        {q.optional ? <span className="ml-1.5 text-sm font-normal text-ink-3">(optional)</span> : null}
      </legend>
      {q.help ? (
        <p id={`${id}-help`} className="mb-2.5 text-[13px] text-ink-3">
          {q.help}
        </p>
      ) : (
        <div className="mb-2.5" />
      )}
      {q.type === "text" ? (
        <Textarea aria-label={q.text} value={typeof value === "string" ? value : ""} disabled={disabled} maxLength={2000} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <div className={cn("flex flex-wrap gap-2", q.type === "multi" || (q.options?.some((o) => o.label.length > 40) ?? false) ? "flex-col sm:flex-row" : "")}>
          {q.options!.map((o) => {
            const list = Array.isArray(value) ? value : [];
            const on = q.type === "multi" ? list.includes(o.value) : value === o.value;
            const toggle = () => {
              if (q.type !== "multi") return onChange(o.value);
              if (on) return onChange(list.filter((x) => x !== o.value));
              if (o.exclusive) return onChange([o.value]);
              const exclusive = q.options!.filter((x) => x.exclusive).map((x) => x.value);
              onChange([...list.filter((x) => !exclusive.includes(x)), o.value]);
            };
            return (
              <Choice key={o.value} type={q.type === "multi" ? "checkbox" : "radio"} name={q.id} on={on} disabled={disabled} onChange={toggle}>
                {o.label}
              </Choice>
            );
          })}
        </div>
      )}
      {missing ? (
        <p className="mt-2 text-[13px] text-no" role="alert">
          Answer this question to submit.
        </p>
      ) : null}
    </fieldset>
  );
}

/** The score and why, updated as you answer. */
export function ResultCard({ template, answers, final }: { template: AssessmentTemplate; answers: Answers; final: boolean }) {
  const r = scoreAssessment(template, answers);
  return (
    <Card className="p-5">
      <p className="mb-2 text-sm text-ink-3">{final ? "Result" : "Result so far"}</p>
      <div className="mb-3 flex items-center gap-2">
        <TierPill tier={r.tier} />
        <span className="text-sm text-ink-2">
          {r.score} of {r.maxScore} points
        </span>
      </div>
      <p className="text-sm text-ink-2">{explainResult(template, r)}</p>
      {r.reasons.length ? (
        <>
          <p className="mt-4 mb-1.5 text-sm font-medium">What added to the score</p>
          <ul className="grid gap-1.5 text-[13px]">
            {r.reasons.slice(0, 8).map((x, i) => (
              <li key={`${x.questionId}-${i}`} className="flex justify-between gap-3">
                <span className="text-ink-2">{x.answer}</span>
                <span className="shrink-0 font-medium">{x.forces ? `${x.points ? `+${x.points}, ` : ""}makes it ${x.forces}` : `+${x.points}`}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-3 text-[13px] text-ink-3">Nothing has added to the score yet.</p>
      )}
    </Card>
  );
}

export function Questionnaire({ id, template, initial, editable }: { id: string; template: AssessmentTemplate; initial: Answers; editable: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [answers, setAnswers] = useState<Answers>(initial);
  const [busy, setBusy] = useState<"save" | "submit" | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  const missing = useMemo(() => new Set(checkAnswers(template, answers).missing), [template, answers]);
  const total = template.sections.reduce((n, s) => n + s.questions.filter((q) => !q.optional).length, 0);

  const send = async (kind: "save" | "submit") => {
    if (kind === "submit" && missing.size) {
      setShowMissing(true);
      document.getElementById(`q-${[...missing][0]}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      toast.error(`${missing.size === 1 ? "One question is" : `${missing.size} questions are`} still open.`);
      return;
    }
    setBusy(kind);
    try {
      if (kind === "save") {
        await api(`/api/assessments/${id}`, { answers }, "PATCH");
        toast.ok("Draft saved.");
      } else {
        await api(`/api/assessments/${id}/submit`, { answers });
        toast.ok("Submitted. Someone else will review it.");
      }
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save the assessment.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
      <div className="grid content-start gap-10">
        {template.sections.map((s, i) => (
          <section key={s.id}>
            <h2 className="mb-1 text-[17px] font-semibold">
              {i + 1}. {s.title}
            </h2>
            {s.description ? <p className="mb-4 text-sm text-ink-2">{s.description}</p> : <div className="mb-4" />}
            <div className="grid gap-7">
              {s.questions.map((q) => (
                <QuestionField key={q.id} q={q} value={answers[q.id]} disabled={!editable} missing={editable && showMissing && missing.has(q.id)} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />
              ))}
            </div>
          </section>
        ))}
        {editable ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-6">
            <Button variant="primary" size="lg" disabled={!!busy} onClick={() => send("submit")}>
              {busy === "submit" ? "Submitting…" : "Submit for review"}
            </Button>
            <Button size="lg" disabled={!!busy} onClick={() => send("save")}>
              {busy === "save" ? "Saving…" : "Save draft"}
            </Button>
            <span className="text-sm text-ink-3">
              {total - missing.size} of {total} answered
            </span>
          </div>
        ) : null}
      </div>
      <aside className="lg:sticky lg:top-8 lg:self-start">
        <ResultCard template={template} answers={answers} final={!editable} />
      </aside>
    </div>
  );
}

/** Approve, or send back with a note. Shown only to someone allowed to review. */
export function ReviewPanel({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "request_changes" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: "approve" | "request_changes") => {
    if (decision === "request_changes" && note.trim().length < 3) {
      setError("Say what needs to change.");
      return;
    }
    setBusy(decision);
    setError(null);
    try {
      await api(`/api/assessments/${id}/review`, { decision, ...(note.trim() ? { note: note.trim() } : {}) });
      toast.ok(decision === "approve" ? "Approved. The system's risk tier is updated." : "Sent back with your note.");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not record the review.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="border-accent-line p-5">
      <h2 className="mb-1 text-[17px] font-semibold">Your review</h2>
      <p className="mb-4 text-sm text-ink-2">Approving sets the system's risk tier to this result and schedules its next review. Both are recorded as a signed receipt.</p>
      <Field label="Note" htmlFor="review-note" hint="Needed when you ask for changes." error={error}>
        <Textarea id="review-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} aria-invalid={!!error} />
      </Field>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="approve" disabled={!!busy} onClick={() => decide("approve")}>
          {busy === "approve" ? "Approving…" : "Approve"}
        </Button>
        <Button variant="reject" disabled={!!busy} onClick={() => decide("request_changes")}>
          {busy === "request_changes" ? "Sending…" : "Request changes"}
        </Button>
      </div>
    </Card>
  );
}
