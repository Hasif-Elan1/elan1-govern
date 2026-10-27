"use client";

import {
  builtinRegistry,
  canonicalize,
  createRegistry,
  mergeRegistries,
  specFromJsonSchema,
  type ToolRegistry,
  type ToolSpec,
  decide,
  describeRule,
  diffLines,
  isKnownTool,
  parseRulebookYaml,
  publishProblems,
  rulebookToYaml,
  TOOLS,
  TOOL_NAMES,
  validateRulebook,
  VENDOR_FIELDS,
  type DecisionResult,
  type Rule,
  type Rulebook,
  type RiskTier,
  type ToolName,
  RISK_TAGS,
  RISK_TAG_LABELS,
  type RiskTag,
} from "@gate/core/browser";
import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/fields";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { Pill, Stamp } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/client";
import { cn, fmtDate, shortHash } from "@/lib/utils";
import { replaySummary, type ReplayReport } from "@/lib/replay";
import { ReplayCounts, ReplayPanel } from "./replay-panel";

type Version = { version: number; yaml: string; hash: string; signedBy: string; createdAt: string };
type Draft = Omit<Rulebook, "signature">;
/** A tool from one of the org's MCP servers, as stored by Elan1 Govern. */
export type ExtraTool = { name: string; connector: string; description: string; inputSchema: Record<string, unknown>; tags: RiskTag[] };

const FIELD_LABEL: Record<string, string> = { name: "name", email: "email", phone: "phone", address: "address", gstin: "GSTIN", bank_account: "bank account", ifsc: "IFSC" };
const EXPIRY = [["1h", "1 hour"], ["4h", "4 hours"], ["24h", "24 hours"], ["3d", "3 days"], ["7d", "7 days"]] as const;
const AMOUNT_TOOLS: ToolName[] = ["zoho.record_bill_payment", "zoho.create_bill"];

function toDraft(yaml: string | undefined, slug: string, owner: string, registry: ToolRegistry): Draft {
  if (yaml) {
    const p = parseRulebookYaml(yaml, registry);
    if (p.ok) {
      const { signature: _s, ...rest } = p.rulebook;
      return rest;
    }
  }
  return { version: 1, agent: slug, owner, default: "refuse", approvers: { finance: [owner] }, rules: [] };
}

// ---- Conditions in plain controls ----

type CondKind = "always" | "number" | "recipient" | "fields" | "custom";
const NUMBER_OPS = ["gt", "gte", "lt", "lte"];
const FIELD_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/** Number-typed arguments: amount_inr for the built-in tools, number fields of the input schema for the rest. */
function numberFields(spec: ToolSpec | undefined): string[] {
  if (!spec) return [];
  if (spec.schema) return AMOUNT_TOOLS.includes(spec.name as ToolName) ? ["amount_inr"] : [];
  const props = (spec.inputSchema?.properties ?? {}) as Record<string, { type?: unknown }>;
  return Object.entries(props)
    .filter(([f, p]) => FIELD_RE.test(f) && [p?.type].flat().some((t) => t === "number" || t === "integer"))
    .map(([f]) => f);
}

/** For a tag rule, the number fields of every tool with that tag. */
function numberFieldsFor(rule: Rule, registry: ToolRegistry): string[] {
  if (rule.tool !== undefined) return numberFields(registry.get(rule.tool));
  return [...new Set(registry.list().filter((t) => rule.tag && t.tags.includes(rule.tag)).flatMap(numberFields))];
}

function condKind(rule: Rule, numbers: string[]): CondKind {
  const keys = Object.keys(rule.when ?? {});
  if (!keys.length) return "always";
  if (keys.length === 1 && numbers.includes(keys[0]!)) {
    const c = rule.when![keys[0]!] as Record<string, unknown>;
    if (Object.keys(c).length === 1 && NUMBER_OPS.includes(Object.keys(c)[0]!)) return "number";
  }
  if (keys.length === 1 && keys[0] === "to_domain_in" && rule.when!.to_domain_in === "vendor_domains") return "recipient";
  if (keys.length === 1 && keys[0] === "fields_include") return "fields";
  return "custom";
}

function NumberCondition({ rule, numbers, onChange, disabled }: { rule: Rule; numbers: string[]; onChange: (when: Rule["when"]) => void; disabled: boolean }) {
  const [field, raw] = Object.entries(rule.when ?? {})[0] ?? [numbers[0]!, {}];
  const c = raw as Record<string, number>;
  const op = Object.keys(c)[0] ?? "any";
  const rupees = field === "amount_inr";
  const words = (f: string) => (f === "amount_inr" ? "the amount" : f.replace(/_/g, " "));
  const single = numbers.length === 1;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {op !== "any" && !single ? (
        <Select aria-label="Field" className="h-9 w-auto" value={field} disabled={disabled} onChange={(e) => onChange({ [e.target.value]: c })}>
          {numbers.map((f) => (
            <option key={f} value={f}>
              when {words(f)} is
            </option>
          ))}
        </Select>
      ) : null}
      <Select
        aria-label={rupees ? "Amount condition" : "Number condition"}
        className="h-9 w-auto"
        value={op}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "any" ? undefined : { [field]: { [e.target.value]: c[op] ?? (rupees ? 50000 : 100) } })}
      >
        <option value="any">{rupees ? "for any amount" : single ? `for any ${words(field)}` : "for any values"}</option>
        {[["lte", "up to"], ["lt", "under"], ["gt", "over"], ["gte", "at least"]].map(([v, l]) => (
          <option key={v} value={v}>
            {rupees || !single ? l : `when ${words(field)} is ${l}`}
          </option>
        ))}
      </Select>
      {op !== "any" ? (
        <span className="relative">
          {rupees ? <span className="absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-3">₹</span> : null}
          <Input
            aria-label={rupees ? "Amount in rupees" : `Value of ${field}`}
            type="number"
            step={rupees ? 1000 : "any"}
            className={cn("h-9 w-36", rupees && "pl-7")}
            value={c[op] ?? 0}
            disabled={disabled}
            onChange={(e) => onChange({ [field]: { [op]: Number(e.target.value) } })}
          />
        </span>
      ) : null}
    </span>
  );
}

function Condition({ rule, registry, onChange, disabled }: { rule: Rule; registry: ToolRegistry; onChange: (when: Rule["when"]) => void; disabled: boolean }) {
  const tool = rule.tool as ToolName;
  const numbers = numberFieldsFor(rule, registry);
  const kind = condKind(rule, numbers);
  if (kind === "custom") return <span className="text-sm text-ink-3">{rule.tool === undefined ? "when a condition holds" : "a custom condition"} (edit it in YAML)</span>;
  if (kind !== "recipient" && kind !== "fields" && numbers.length) return <NumberCondition rule={rule} numbers={numbers} disabled={disabled} onChange={onChange} />;
  if (rule.tool === undefined) return <span className="text-sm text-ink-3">every time</span>;
  if (tool === "gmail.send_reply") {
    return (
      <Select aria-label="Recipient" className="h-9 w-auto" value={kind === "recipient" ? "vendor" : "any"} disabled={disabled} onChange={(e) => onChange(e.target.value === "vendor" ? { to_domain_in: "vendor_domains" } : undefined)}>
        <option value="any">to anyone</option>
        <option value="vendor">to a known vendor</option>
      </Select>
    );
  }
  if (tool === "zoho.update_vendor") {
    const fields = (rule.when?.fields_include as string[] | undefined) ?? [];
    return (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        <span className="text-ink-2">{fields.length ? "that changes any of" : "any change, or only if it changes"}</span>
        {VENDOR_FIELDS.map((f) => (
          <label key={f} className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              className="accent-[var(--accent)]"
              disabled={disabled}
              checked={fields.includes(f)}
              onChange={(e) => {
                const next = e.target.checked ? [...fields, f] : fields.filter((x) => x !== f);
                onChange(next.length ? { fields_include: next } : undefined);
              }}
            />
            {FIELD_LABEL[f]}
          </label>
        ))}
      </span>
    );
  }
  return <span className="text-sm text-ink-3">every time</span>;
}

const DECIDE_STYLES = {
  allow: "data-[on=true]:border-ok data-[on=true]:bg-ok-soft data-[on=true]:text-ok",
  ask: "data-[on=true]:border-wait data-[on=true]:bg-wait-soft data-[on=true]:text-wait",
  refuse: "data-[on=true]:border-no data-[on=true]:bg-no-soft data-[on=true]:text-no",
};

function RuleRow({ rule, groups, registry, onChange, onRemove, disabled, index }: { rule: Rule; groups: string[]; registry: ToolRegistry; onChange: (r: Rule) => void; onRemove: () => void; disabled: boolean; index: number }) {
  const extra = registry.list().filter((t) => !isKnownTool(t.name));
  const set = (patch: Partial<Rule>) => {
    const next: Rule = { ...rule, ...patch };
    if (next.decide !== "ask") {
      delete next.approver;
      delete next.expires_in;
    } else if (!next.approver) next.approver = groups[0];
    if (!next.when || !Object.keys(next.when).length) delete next.when;
    onChange(next);
  };
  return (
    <li className="rounded-lg border border-line bg-surface p-4" data-testid={`rule-${index}`}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[15px]">
        <span className="text-ink-3">When the agent wants to</span>
        <Select
          aria-label="Tool"
          className="h-9 w-auto"
          value={rule.tool ?? `tag:${rule.tag}`}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("tag:")) set({ tool: undefined, tag: v.slice(4) as RiskTag, when: undefined });
            else set({ tool: v, tag: undefined, when: undefined });
          }}
        >
          <optgroup label="One tool">
            {TOOL_NAMES.map((t) => (
              <option key={t} value={t}>
                {TOOLS[t].label.toLowerCase()} ({TOOLS[t].connector === "gmail" ? "Gmail" : "Zoho"})
              </option>
            ))}
            {rule.tool !== undefined && !registry.get(rule.tool) ? <option value={rule.tool}>{rule.tool}</option> : null}
          </optgroup>
          {extra.length ? (
            <optgroup label="Your MCP servers">
              {extra.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.label.toLowerCase()} ({t.connector})
                </option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label="Any action that…">
            {RISK_TAGS.map((t) => (
              <option key={t} value={`tag:${t}`}>
                {RISK_TAG_LABELS[t]}
              </option>
            ))}
          </optgroup>
        </Select>
        <Condition rule={rule} registry={registry} disabled={disabled} onChange={(when) => set({ when })} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[15px]">
        <span className="text-ink-3">then</span>
        <span className="inline-flex overflow-hidden rounded-md border border-line-2" role="radiogroup" aria-label="Decision">
          {(["allow", "ask", "refuse"] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={rule.decide === d}
              data-on={rule.decide === d}
              disabled={disabled}
              onClick={() => set({ decide: d })}
              className={cn("-ml-px cursor-pointer border-l border-line-2 px-3 py-1.5 text-sm font-medium text-ink-2 first:ml-0 first:border-l-0", DECIDE_STYLES[d])}
            >
              {d === "allow" ? "Allow" : d === "ask" ? "Ask" : "Refuse"}
            </button>
          ))}
        </span>
        {rule.decide === "ask" ? (
          <>
            <Select aria-label="Approver group" className="h-9 w-auto" value={rule.approver ?? ""} disabled={disabled} onChange={(e) => set({ approver: e.target.value })}>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
            <Select aria-label="Expires after" className="h-9 w-auto" value={rule.expires_in ?? "24h"} disabled={disabled} onChange={(e) => set({ expires_in: e.target.value })}>
              {EXPIRY.map(([v, l]) => (
                <option key={v} value={v}>
                  refuse after {l}
                </option>
              ))}
            </Select>
          </>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <label className="sr-only" htmlFor={`rule-id-${index}`}>
            Rule id
          </label>
          <input
            id={`rule-id-${index}`}
            value={rule.id}
            disabled={disabled}
            onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
            className="h-8 w-40 rounded-md border border-transparent bg-transparent px-2 font-mono text-[12.5px] text-ink-3 hover:border-line focus:border-accent focus:outline-none"
          />
          {!disabled ? (
            <button type="button" onClick={onRemove} className="cursor-pointer rounded-md p-1.5 text-ink-3 hover:bg-no-soft hover:text-no" aria-label={`Remove rule ${rule.id}`}>
              <Trash2 className="size-4" />
            </button>
          ) : null}
        </span>
      </div>
      {rule.when ? <p className="mt-2 text-[13px] text-ink-3">{describeRule(rule)}</p> : null}
    </li>
  );
}

// ---- Try an action ----

function TestPanel({ draft, vendorDomains, registry }: { draft: Draft; vendorDomains: string[]; registry: ToolRegistry }) {
  const [tool, setTool] = useState<string>("zoho.record_bill_payment");
  const [unknownName, setUnknownName] = useState("gmail.delete_message");
  const [amount, setAmount] = useState(200000);
  const [paid, setPaid] = useState(0);
  const [to, setTo] = useState("accounts@sharmatraders.in");
  const [fields, setFields] = useState<string[]>(["bank_account"]);
  const [numbers, setNumbers] = useState<Record<string, number>>({});
  const name = tool === "__unknown" ? unknownName : tool;
  const extra = registry.list().filter((t) => !isKnownTool(t.name));
  const extraNumbers = useMemo(() => (isKnownTool(tool) ? [] : numberFields(registry.get(tool))), [registry, tool]);

  const result: DecisionResult | null = useMemo(() => {
    const args: Record<string, unknown> =
      tool === "zoho.record_bill_payment"
        ? { bill_id: "bill_test", amount_inr: amount }
        : tool === "zoho.create_bill"
          ? { vendor_id: "v_test", bill_number: "TEST-1", bill_date: "2026-01-01", amount_inr: amount }
          : tool === "gmail.send_reply"
            ? { message_id: "m_test", to, body: "" }
            : tool === "zoho.update_vendor"
              ? { vendor_id: "v_test", fields: Object.fromEntries(fields.map((f) => [f, "new value"])) }
              : Object.fromEntries(extraNumbers.map((f) => [f, numbers[f] ?? 0]));
    return decide({ ...draft, signature: undefined } as Rulebook, name, args, { registry, lists: { vendor_domains: vendorDomains }, usage: { daily_payments_inr: paid } });
  }, [draft, tool, name, amount, to, fields, paid, vendorDomains, registry, numbers, extraNumbers]);

  return (
    <div className="grid gap-4">
      <Field label="Action" htmlFor="try-tool">
        <Select id="try-tool" value={tool} onChange={(e) => setTool(e.target.value)}>
          {TOOL_NAMES.map((t) => (
            <option key={t} value={t}>
              {TOOLS[t].label}
            </option>
          ))}
          {extra.map((t) => (
            <option key={t.name} value={t.name}>
              {t.label} ({t.connector})
            </option>
          ))}
          <option value="__unknown">A tool Elan1 Govern doesn't know</option>
        </Select>
      </Field>
      {tool === "__unknown" ? (
        <Field label="Tool name" htmlFor="try-unknown">
          <Input id="try-unknown" value={unknownName} onChange={(e) => setUnknownName(e.target.value)} />
        </Field>
      ) : null}
      {extraNumbers.map((f) => (
        <Field key={f} label={f.replace(/_/g, " ")} htmlFor={`try-${f}`}>
          <Input id={`try-${f}`} type="number" value={numbers[f] ?? 0} onChange={(e) => setNumbers({ ...numbers, [f]: Number(e.target.value) })} />
        </Field>
      ))}
      {AMOUNT_TOOLS.includes(tool as ToolName) ? (
        <Field label="Amount (₹)" htmlFor="try-amount">
          <Input id="try-amount" type="number" min={0} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
        </Field>
      ) : null}
      {tool === "zoho.record_bill_payment" && draft.limits?.daily_payments_inr ? (
        <Field label="Already paid today (₹)" htmlFor="try-paid" hint={`The daily limit is ₹${draft.limits.daily_payments_inr.toLocaleString("en-IN")}.`}>
          <Input id="try-paid" type="number" min={0} value={paid} onChange={(e) => setPaid(Number(e.target.value))} />
        </Field>
      ) : null}
      {tool === "gmail.send_reply" ? (
        <Field label="Reply to" htmlFor="try-to">
          <Input id="try-to" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      ) : null}
      {tool === "zoho.update_vendor" ? (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-sm font-medium">Fields it changes</legend>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
            {VENDOR_FIELDS.map((f) => (
              <label key={f} className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-[var(--accent)]" checked={fields.includes(f)} onChange={(e) => setFields(e.target.checked ? [...fields, f] : fields.filter((x) => x !== f))} />
                {FIELD_LABEL[f]}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {result ? (
        <div className="slip px-4 pt-5 pb-4" data-testid="test-result">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-ink-2">
              {result.ruleId === "default" ? "No rule matches" : (
                <>
                  Rule <code className="font-mono text-[13px] text-ink">{result.ruleId}</code> decides
                </>
              )}
            </span>
            <Stamp kind={result.decision} />
          </div>
          <p className="mt-3 text-sm">{result.reason}</p>
          {result.matched.length > 1 ? (
            <p className="mt-2 text-[13px] text-ink-3">
              {result.matched.length} rules matched ({result.matched.join(", ")}). The strictest one wins.
            </p>
          ) : null}
          {result.approvers?.length ? <p className="mt-2 text-[13px] text-ink-3">Approvers: {result.approvers.join(", ")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---- History ----

function History({ versions, onRestore, canPublish }: { versions: Version[]; onRestore: (yaml: string) => void; canPublish: boolean }) {
  const [a, setA] = useState(versions[1]?.version ?? versions[0]?.version ?? 0);
  const [b, setB] = useState(versions[0]?.version ?? 0);
  if (!versions.length) return <p className="text-sm text-ink-3">Nothing published yet. Your first publish becomes version 1.</p>;
  const va = versions.find((v) => v.version === a);
  const vb = versions.find((v) => v.version === b);
  const strip = (y?: string) => (y ?? "").replace(/^signature:.*$/m, "").trimEnd();
  const diff = va && vb ? diffLines(strip(va.yaml), strip(vb.yaml)) : [];
  return (
    <div className="grid gap-4">
      <ul className="divide-y divide-line rounded-lg border border-line text-sm">
        {versions.map((v) => (
          <li key={v.version} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
            <span className="font-medium">v{v.version}</span>
            <span className="flex-1 text-ink-3">
              {fmtDate(v.createdAt)}, {v.signedBy}
            </span>
            <code className="font-mono text-[12px] text-ink-3" title={v.hash}>
              {shortHash(v.hash)}
            </code>
            {canPublish && v.version !== versions[0]?.version ? (
              <button type="button" className="cursor-pointer text-[13px] font-medium text-accent hover:underline" onClick={() => onRestore(v.yaml)}>
                Load into editor
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {versions.length > 1 ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            Compare
            <Select aria-label="Older version" className="h-9 w-auto" value={a} onChange={(e) => setA(Number(e.target.value))}>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                </option>
              ))}
            </Select>
            with
            <Select aria-label="Newer version" className="h-9 w-auto" value={b} onChange={(e) => setB(Number(e.target.value))}>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                </option>
              ))}
            </Select>
          </div>
          <pre className="max-h-[420px] overflow-auto rounded-lg border border-line bg-sunken py-2 font-mono text-[12px] leading-relaxed" data-testid="diff">
            {diff.map((d, i) => (
              <div key={i} className={cn("px-3", d.type === "add" && "bg-ok-soft text-ok", d.type === "remove" && "bg-no-soft text-no")}>
                {d.type === "add" ? "+ " : d.type === "remove" ? "- " : "  "}
                {d.text}
              </div>
            ))}
          </pre>
        </>
      ) : null}
    </div>
  );
}

// ---- The builder ----

export function Builder({
  slug,
  owner,
  tier,
  canPublish,
  approverEmails,
  vendorDomains,
  versions,
  extraTools,
}: {
  slug: string;
  owner: string;
  tier: RiskTier;
  canPublish: boolean;
  approverEmails: string[];
  vendorDomains: string[];
  versions: Version[];
  extraTools: ExtraTool[];
}) {
  // The built-in tools plus the org's enabled MCP server tools, the same set Elan1 Govern checks against.
  const [registry] = useState<ToolRegistry>(() => (extraTools.length ? mergeRegistries(builtinRegistry, createRegistry(extraTools.map(specFromJsonSchema))) : builtinRegistry));
  const router = useRouter();
  const toast = useToast();
  const latest = versions[0];
  const [draft, setDraftState] = useState<Draft>(() => toDraft(latest?.yaml, slug, owner, registry));
  const [yamlText, setYamlText] = useState(() => rulebookToYaml(toDraft(latest?.yaml, slug, owner, registry) as Rulebook));
  const [yamlErrors, setYamlErrors] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [replay, setReplay] = useState<{ yaml: string; report: ReplayReport } | null>(null);
  const readOnly = !canPublish;

  const setDraft = (d: Draft) => {
    setDraftState(d);
    setYamlText(rulebookToYaml(d as Rulebook));
    setYamlErrors([]);
    setServerErrors([]);
  };
  const onYaml = (text: string) => {
    setYamlText(text);
    const p = parseRulebookYaml(text, registry);
    if (p.ok) {
      const { signature: _s, ...rest } = p.rulebook;
      setDraftState(rest);
      setYamlErrors([]);
    } else setYamlErrors(p.errors);
  };

  const validation = validateRulebook(draft, registry);
  const problems = validation.ok ? publishProblems(validation.rulebook, tier, registry) : [];
  const errors = [...yamlErrors, ...(validation.ok ? [] : validation.errors), ...problems, ...serverErrors];
  const groups = Object.keys(draft.approvers);
  const original = latest ? toDraft(latest.yaml, slug, owner, registry) : null;
  const changed = !original || canonicalize({ ...original, version: 0 }) !== canonicalize({ ...draft, version: 0 });
  const draftYaml = rulebookToYaml(draft as Rulebook);
  const replayForDraft = replay && replay.yaml === draftYaml && replay.report.total > 0 ? replay.report : null;

  const updateRule = (i: number, r: Rule) => setDraft({ ...draft, rules: draft.rules.map((x, j) => (j === i ? r : x)) });
  const addRule = () => {
    let n = draft.rules.length + 1;
    while (draft.rules.some((r) => r.id === `rule-${n}`)) n++;
    setDraft({ ...draft, rules: [...draft.rules, { id: `rule-${n}`, tool: "gmail.read_message", decide: "allow" }] });
  };

  async function publish() {
    setPublishing(true);
    setServerErrors([]);
    try {
      const r = await api<{ version: number }>(`/api/rulebooks/${slug}`, { yaml: rulebookToYaml(draft as Rulebook) });
      toast.ok(`Version ${r.version} is signed and live.`);
      setConfirm(false);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.data.errors)) setServerErrors(e.data.errors as string[]);
      toast.error(e instanceof ApiError ? e.message : "Could not publish.");
      setConfirm(false);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="grid content-start gap-6">
        {readOnly ? <p className="rounded-lg border border-line bg-sunken px-4 py-3 text-sm text-ink-2">You can read these rules and try actions. Only owners and admins can publish changes.</p> : null}

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[17px] font-semibold">Rules</h2>
            <span className="text-sm text-ink-3">{draft.rules.length} rules, everything else refused</span>
          </div>
          {draft.rules.length ? (
            <ol className="grid gap-3">
              {draft.rules.map((r, i) => (
                <RuleRow key={i} index={i} rule={r} groups={groups} registry={registry} disabled={readOnly} onChange={(x) => updateRule(i, x)} onRemove={() => setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })} />
              ))}
            </ol>
          ) : (
            <p className="rounded-lg border border-dashed border-line-2 px-4 py-8 text-center text-sm text-ink-2">No rules yet, so this agent can do nothing. Add a rule to allow its first action.</p>
          )}
          {!readOnly ? (
            <Button className="mt-3" onClick={addRule}>
              <Plus /> Add a rule
            </Button>
          ) : null}
        </section>

        <section className="grid gap-4 rounded-lg border border-line bg-surface p-5">
          <h2 className="text-[17px] font-semibold">Approvers and limits</h2>
          {Object.entries(draft.approvers).map(([g, emails]) => (
            <div key={g} className="grid gap-2 sm:grid-cols-[160px_1fr] sm:items-start">
              <Field label="Group" htmlFor={`group-${g}`}>
                <Input id={`group-${g}`} value={g} disabled readOnly />
              </Field>
              <Field label="Who can approve" htmlFor={`group-emails-${g}`} hint={approverEmails.length ? `Approvers in this organisation: ${approverEmails.join(", ")}` : undefined}>
                <Input
                  id={`group-emails-${g}`}
                  value={emails.join(", ")}
                  disabled={readOnly}
                  onChange={(e) => setDraft({ ...draft, approvers: { ...draft.approvers, [g]: e.target.value.split(/[,\s]+/).filter(Boolean) } })}
                />
              </Field>
            </div>
          ))}
          <label className="flex flex-wrap items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="accent-[var(--accent)]"
              disabled={readOnly}
              checked={draft.limits?.daily_payments_inr !== undefined}
              onChange={(e) => setDraft({ ...draft, limits: e.target.checked ? { daily_payments_inr: 500000 } : undefined })}
            />
            Daily payment limit
            {draft.limits?.daily_payments_inr !== undefined ? (
              <span className="relative">
                <span className="absolute top-1/2 left-3 -translate-y-1/2 text-ink-3">₹</span>
                <Input aria-label="Daily payment limit" type="number" min={1} step={10000} className="h-9 w-40 pl-7" disabled={readOnly} value={draft.limits.daily_payments_inr} onChange={(e) => setDraft({ ...draft, limits: { daily_payments_inr: Number(e.target.value) } })} />
              </span>
            ) : null}
            <span className="text-ink-3">Past the limit, allowed payments wait for an approver.</span>
          </label>
        </section>

        {errors.length ? (
          <div role="alert" className="rounded-lg border border-no-line bg-no-soft px-4 py-3 text-sm">
            <p className="font-medium text-no">{problems.length && !yamlErrors.length && validation.ok ? "Publishing is blocked" : "Fix these before publishing"}</p>
            <ul className="mt-1.5 list-disc pl-5 text-ink">
              {[...new Set(errors)].map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {!readOnly ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" disabled={!!errors.length || !changed || publishing} onClick={() => setConfirm(true)}>
              Sign and publish
            </Button>
            <span className="text-sm text-ink-3">{changed ? `Will become version ${(latest?.version ?? 0) + 1}.` : "No changes since the published version."}</span>
          </div>
        ) : null}
      </div>

      <aside className="xl:sticky xl:top-8 xl:self-start">
        <Tabs defaultValue="yaml">
          <TabsList className="mb-4">
            <TabsTrigger value="yaml">YAML</TabsTrigger>
            <TabsTrigger value="try">Try an action</TabsTrigger>
            <TabsTrigger value="replay">Test on past actions</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="yaml">
            <Textarea
              aria-label="Rulebook YAML"
              data-testid="yaml"
              spellCheck={false}
              readOnly={readOnly}
              value={yamlText}
              onChange={(e) => onYaml(e.target.value)}
              className={cn("min-h-[520px] font-mono text-[12.5px] leading-relaxed", yamlErrors.length && "border-no")}
            />
            <p className="mt-2 text-[13px] text-ink-3">Edits here and in the rules on the left stay in sync. Elan1 Govern adds the version and signature when you publish.</p>
          </TabsContent>
          <TabsContent value="try">
            <TestPanel draft={draft} vendorDomains={vendorDomains} registry={registry} />
          </TabsContent>
          <TabsContent value="replay">
            <ReplayPanel slug={slug} yaml={yamlErrors.length || !validation.ok ? null : draftYaml} ready={!yamlErrors.length && validation.ok} canRun={canPublish} result={replay} onResult={setReplay} />
          </TabsContent>
          <TabsContent value="history">
            <History versions={versions} canPublish={canPublish} onRestore={(y) => onYaml(rulebookToYaml(toDraft(y, slug, owner, registry) as Rulebook))} />
          </TabsContent>
        </Tabs>
      </aside>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title={`Sign and publish version ${(latest?.version ?? 0) + 1}?`} description="Elan1 Govern signs the rulebook with your organisation's key and uses it for the agent's next call. The old version stays in the history.">
          <ul className="mb-5 grid gap-1.5 text-sm">
            <li className="flex gap-2"><Pill tone="ok">{draft.rules.filter((r) => r.decide === "allow").length}</Pill> rules allow</li>
            <li className="flex gap-2"><Pill tone="wait">{draft.rules.filter((r) => r.decide === "ask").length}</Pill> rules ask a person</li>
            <li className="flex gap-2"><Pill tone="no">{draft.rules.filter((r) => r.decide === "refuse").length}</Pill> rules refuse</li>
          </ul>
          {replayForDraft ? (
            <div className="mb-5 grid gap-2 rounded-lg border border-line bg-sunken p-3 text-sm" data-testid="publish-replay">
              <p className="font-medium">On the last {replayForDraft.days} days of past actions</p>
              <p className="text-ink-2">{replaySummary(replayForDraft)}</p>
              <ReplayCounts report={replayForDraft} />
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="primary" disabled={publishing} onClick={publish}>
              {publishing ? "Signing…" : "Sign and publish"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
