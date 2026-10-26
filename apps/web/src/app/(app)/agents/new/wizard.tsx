"use client";

import { describeRule, RISK_QUESTIONS, riskTier, suggestRules, type RiskAnswers } from "@gate/core/browser";
import { Check } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ConnectAgent } from "@/components/connect-agent";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/fields";
import { Card } from "@/components/ui/layout";
import { Pill, RiskPill } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";
import { ConnectorCard, type ConnectorRow } from "../../connectors/card";

const STEPS = ["Name and purpose", "Risk", "Connect"];

export function Wizard({ me, connectors, mcpUrl, gateUrl, liveAvailable }: { me: string; connectors: ConnectorRow[]; mcpUrl: string; gateUrl: string; liveAvailable: Record<"gmail" | "zoho", boolean> }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [owner, setOwner] = useState(me);
  const [answers, setAnswers] = useState<Partial<RiskAnswers>>({});
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ slug: string; apiKey: string } | null>(null);

  const complete = RISK_QUESTIONS.every((q) => answers[q.id]);
  const tier = complete ? riskTier(answers as RiskAnswers) : null;
  const rules = useMemo(() => (tier ? suggestRules(answers as RiskAnswers, tier) : []), [answers, tier]);

  async function create() {
    setBusy(true);
    try {
      const r = await api<{ slug: string; apiKey: string }>("/api/agents", { name, purpose, ownerEmail: owner, answers, keepRules: rules.filter((x) => !dropped.has(x.id)).map((x) => x.id) });
      setCreated(r);
      toast.ok(`${name} is ready.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not create the agent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ol className="mb-8 grid grid-cols-3 gap-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={cn("border-t-2 pt-2 text-[13px]", i <= step ? "border-accent font-medium text-ink" : "border-line text-ink-3")} aria-current={i === step ? "step" : undefined}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            setStep(1);
          }}
        >
          <Field label="Name" htmlFor="agent-name" hint="What your team calls it, e.g. AP bot.">
            <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} autoFocus />
          </Field>
          <Field label="What does it do?" htmlFor="agent-purpose" hint="One or two sentences. This goes in the registry and the auditor pack.">
            <Textarea id="agent-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} required minLength={5} maxLength={500} placeholder="Reads vendor invoices from Gmail, creates bills in Zoho Books and records payments." />
          </Field>
          <Field label="Owner" htmlFor="agent-owner" hint="The person answerable for this agent.">
            <Input id="agent-owner" type="email" value={owner} onChange={(e) => setOwner(e.target.value)} required />
          </Field>
          <div>
            <Button variant="primary" size="lg">
              Continue
            </Button>
          </div>
        </form>
      ) : null}

      {step === 1 ? (
        <div className="grid gap-7">
          {RISK_QUESTIONS.map((q) => (
            <fieldset key={q.id}>
              <legend className="mb-2.5 font-medium">{q.text}</legend>
              <div className="flex flex-wrap gap-2">
                {q.options.map(([value, label]) => {
                  const on = answers[q.id] === value;
                  return (
                    <label key={value} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-3.5 py-2 text-sm", on ? "border-accent bg-accent-soft text-ink" : "border-line-2 bg-surface hover:border-ink-3")}>
                      <input type="radio" className="sr-only" name={q.id} value={value} checked={on} onChange={() => setAnswers((a) => ({ ...a, [q.id]: value }))} />
                      {on ? <Check className="size-3.5 text-accent" /> : null}
                      {label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}

          {tier ? (
            <Card className="p-5">
              <div className="mb-1 flex items-center gap-2">
                <RiskPill tier={tier} />
              </div>
              <p className="mb-4 text-sm text-ink-2">
                {tier === "high" ? "High-risk agents must ask a person before every payment over a small amount." : tier === "medium" ? "Medium-risk agents ask before larger actions." : "Low-risk agents can do routine work on their own."} Here are starter rules. Untick any you don't want; you can change all of them later.
              </p>
              <ul className="grid gap-1.5">
                {rules.map((r) => (
                  <li key={r.id}>
                    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 accent-[var(--accent)]"
                        checked={!dropped.has(r.id)}
                        onChange={(e) =>
                          setDropped((d) => {
                            const n = new Set(d);
                            if (e.target.checked) n.delete(r.id);
                            else n.add(r.id);
                            return n;
                          })
                        }
                      />
                      <span className="flex-1">{describeRule(r)}</span>
                      <Pill tone={r.decide === "allow" ? "ok" : r.decide === "ask" ? "wait" : "no"}>{r.decide === "allow" ? "Allow" : r.decide === "ask" ? "Ask" : "Refuse"}</Pill>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[13px] text-ink-3">Anything not on this list is refused.</p>
            </Card>
          ) : null}

          <div className="flex gap-2">
            <Button size="lg" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button variant="primary" size="lg" disabled={!complete} onClick={() => setStep(2)}>
              Continue
            </Button>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        created ? (
          <div className="grid gap-6">
            <Card className="border-ok-line p-5">
              <p className="font-medium">{name} is registered, with a signed starter rulebook.</p>
              <p className="mt-1 text-sm text-ink-2">Give your agent this address and key. Until it connects, nothing happens.</p>
            </Card>
            <ConnectAgent mcpUrl={mcpUrl} gateUrl={gateUrl} apiKey={created.apiKey} />
            <div className="flex flex-wrap gap-2">
              <Link href={`/agents/${created.slug}`} className={buttonVariants({ variant: "primary", size: "lg" })}>
                Open {name}
              </Link>
              <Link href={`/rulebooks/${created.slug}`} className={buttonVariants({ size: "lg" })}>
                Adjust the rules
              </Link>
            </div>
          </div>
        ) : (
          <div className="grid gap-6">
            <p className="text-ink-2">The agent reaches Gmail and Zoho Books only through Gate. Connect them here; their tokens stay inside Gate.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {(["gmail", "zoho"] as const).map((k) => (
                <ConnectorCard key={k} kind={k} row={connectors.find((c) => c.kind === k)} manage liveAvailable={liveAvailable[k]} compact />
              ))}
            </div>
            <div className="flex gap-2">
              <Button size="lg" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button variant="primary" size="lg" disabled={busy} onClick={create}>
                {busy ? "Creating…" : "Create agent and get the key"}
              </Button>
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}
