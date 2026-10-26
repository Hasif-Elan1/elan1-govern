import { decide, publishProblems, riskTier, suggestRules, validateRulebook, type RiskAnswers, type Rulebook } from "../src";
import { describe, expect, it } from "vitest";
import {
  brokenMappings,
  CONTROLS,
  controlById,
  controlsFor,
  EVIDENCE_KEYS,
  EVIDENCE_LABELS,
  frameworkById,
  frameworkCoverage,
  FRAMEWORKS,
  isFrameworkId,
  mergeStarterRules,
  packById,
  packFor,
  PACKS,
  recommendedFrameworks,
  REGIONS,
  starterRulebook,
  type Counts,
} from "../src/frameworks";

const people = { agent: "test-agent", owner: "owner@example.com", approvers: ["approver@example.com"] };

describe("framework library", () => {
  it("has the ten frameworks, each with an official URL and requirements", () => {
    expect(FRAMEWORKS.map((f) => f.id).sort()).toEqual(["colorado-ai-act", "dpdp", "eu-ai-act", "gdpr", "hipaa", "iso-42001", "nist-ai-rmf", "nyc-ll144", "rbi-free-ai", "soc2"]);
    for (const f of FRAMEWORKS) {
      expect(f.url, f.id).toMatch(/^https:\/\//);
      expect(f.requirements.length, f.id).toBeGreaterThan(0);
      expect(f.description.length, f.id).toBeGreaterThan(20);
    }
  });

  it("requirement ids are unique within each framework and every one has a reference and summary", () => {
    for (const f of FRAMEWORKS) {
      const ids = f.requirements.map((r) => r.id);
      expect(new Set(ids).size, f.id).toBe(ids.length);
      for (const r of f.requirements) {
        expect(r.ref, `${f.id}/${r.id}`).not.toBe("");
        expect(r.summary, `${f.id}/${r.id}`).not.toBe("");
      }
    }
  });

  it("looks frameworks up by id", () => {
    expect(frameworkById("eu-ai-act")?.shortName).toBe("EU AI Act");
    expect(frameworkById("nope")).toBeUndefined();
    expect(isFrameworkId("gdpr")).toBe(true);
    expect(isFrameworkId("__proto__")).toBe(false);
  });
});

describe("controls catalogue", () => {
  it("keeps the ten original controls and adds the governance ones", () => {
    for (let i = 1; i <= 10; i++) expect(controlById(`GATE-${String(i).padStart(2, "0")}`), `GATE-${i}`).toBeDefined();
    expect(CONTROLS.find((c) => c.evidence === "systems")?.title).toBe("AI systems are inventoried");
    expect(CONTROLS.find((c) => c.evidence === "approved_assessments")?.title).toBe("Risk assessments are approved before go-live");
  });

  it("every control maps to framework requirements that exist", () => {
    expect(brokenMappings()).toEqual([]);
    for (const c of CONTROLS) {
      expect(c.mappings.length, c.id).toBeGreaterThan(0);
      for (const m of c.mappings) expect(frameworkById(m.framework)?.requirements.some((r) => r.id === m.requirement), `${c.id} → ${m.framework}/${m.requirement}`).toBe(true);
    }
  });

  it("ids are unique and every evidence key is known and labelled", () => {
    expect(new Set(CONTROLS.map((c) => c.id)).size).toBe(CONTROLS.length);
    for (const c of CONTROLS) expect(EVIDENCE_KEYS).toContain(c.evidence);
    for (const k of EVIDENCE_KEYS) expect(EVIDENCE_LABELS[k]).toBeTruthy();
  });

  it("lists the controls for one framework with only that framework's references", () => {
    const nyc = controlsFor("nyc-ll144");
    expect(nyc).toEqual([]);
    const hipaa = controlsFor("hipaa");
    expect(hipaa.length).toBeGreaterThan(0);
    for (const c of hipaa) expect(c.refs.every((r) => r.framework === "hipaa")).toBe(true);
  });
});

describe("coverage", () => {
  it("counts a requirement as covered only when a mapped control has live evidence", () => {
    const none = frameworkCoverage("eu-ai-act", {});
    expect(none.covered).toBe(0);
    expect(none.percent).toBe(0);
    expect(none.total).toBe(frameworkById("eu-ai-act")!.requirements.length);

    // Only approvals (GATE-02) have evidence: Art. 14 and Art. 26 are covered, Art. 12 is not.
    const some = frameworkCoverage("eu-ai-act", { approvals: 3 });
    const by = (id: string) => some.requirements.find((r) => r.requirement.id === id)!;
    expect(by("art-14").covered).toBe(true);
    expect(by("art-14").controls.find((c) => c.control.id === "GATE-02")?.evidence).toBe(3);
    expect(by("art-26").covered).toBe(true);
    expect(by("art-12").covered).toBe(false);
    expect(by("art-12").gap).toBe(false);
    expect(some.covered).toBe(2);
    expect(some.percent).toBe(Math.floor((2 / some.total) * 100));
  });

  it("calls out requirements no control covers", () => {
    const c = frameworkCoverage("eu-ai-act", {});
    const gap = c.requirements.find((r) => r.requirement.id === "art-4")!;
    expect(gap.gap).toBe(true);
    expect(gap.controls).toEqual([]);
    expect(frameworkCoverage("nyc-ll144", {}).requirements.every((r) => r.gap)).toBe(true);
  });

  it("reaches 100% only when every requirement has a backed control, and never rounds up", () => {
    const all = Object.fromEntries(EVIDENCE_KEYS.map((k) => [k, 1])) as Counts;
    for (const f of FRAMEWORKS) {
      const c = frameworkCoverage(f.id, all);
      const gaps = c.requirements.filter((r) => r.gap).length;
      expect(c.covered, f.id).toBe(c.total - gaps);
      expect(c.percent, f.id).toBe(gaps ? Math.floor(((c.total - gaps) / c.total) * 100) : 100);
      expect(c.percent).toBeLessThanOrEqual(100);
    }
  });

  it("lists a control once per requirement even with several notes", () => {
    const c = frameworkCoverage("gdpr", { decisions: 1 });
    const art5 = c.requirements.find((r) => r.requirement.id === "art-5")!;
    const ids = art5.controls.map((x) => x.control.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects unknown frameworks", () => expect(() => frameworkCoverage("nope", {})).toThrow(/unknown framework/));
});

describe("industry packs", () => {
  it("has the seven packs", () => {
    expect(PACKS.map((p) => p.id)).toEqual(["finance", "healthcare", "hr", "support", "sales", "engineering", "general"]);
  });

  for (const pack of PACKS) {
    describe(pack.name, () => {
      it("recommends frameworks and controls that exist", () => {
        for (const f of pack.frameworks) expect(isFrameworkId(f.framework), f.framework).toBe(true);
        for (const c of pack.controls) expect(controlById(c), c).toBeDefined();
        expect(pack.risks.length).toBeGreaterThan(0);
      });

      it("has a starter rulebook that validates and passes high-risk publishing checks", () => {
        const rb = validateRulebook(starterRulebook(pack, people));
        expect(rb.ok ? [] : rb.errors).toEqual([]);
        if (!rb.ok) return;
        expect(publishProblems(rb.rulebook, "high")).toEqual([]);
        expect(rb.rulebook.default).toBe("refuse");
      });

      it("merges with every questionnaire outcome into a valid rulebook", () => {
        const combos: RiskAnswers[] = [];
        for (const money of ["no", "yes"] as const)
          for (const external of ["no", "yes"] as const)
            for (const amount of ["small", "large"] as const) combos.push({ money, external, personal: "yes", amount, oversight: "sometimes" });
        for (const answers of combos) {
          const tier = riskTier(answers);
          const { rules, quotas } = mergeStarterRules(pack, suggestRules(answers, tier), answers, tier);
          const ids = rules.map((r) => r.id);
          expect(new Set(ids).size, `${pack.id} ${JSON.stringify(answers)}`).toBe(ids.length);
          const rb = validateRulebook({ ...starterRulebook(pack, people), approvers: { finance: [people.owner], [pack.approverGroup]: [people.owner] }, rules, quotas, limits: undefined });
          expect(rb.ok ? [] : rb.errors, `${pack.id} ${JSON.stringify(answers)}`).toEqual([]);
          if (rb.ok) expect(publishProblems(rb.rulebook, tier), `${pack.id} ${tier}`).toEqual([]);
        }
      });
    });
  }

  it("tag rules decide for tools from any connector", () => {
    const rb = validateRulebook(starterRulebook(packById("engineering")!, people));
    if (!rb.ok) throw new Error(rb.errors.join("; "));
    const registry = {
      get: (n: string) =>
        ({
          "deploy.release": { name: "deploy.release", connector: "deploy", label: "Release", description: "", tags: ["changes_production" as const], summaryFields: [], fields: ["service"] },
          "db.drop_table": { name: "db.drop_table", connector: "db", label: "Drop table", description: "", tags: ["deletes" as const], summaryFields: [], fields: ["table"] },
        })[n],
      list: () => [],
    };
    expect(decide(rb.rulebook as Rulebook, "deploy.release", { service: "api" }, { registry }).decision).toBe("ask");
    expect(decide(rb.rulebook as Rulebook, "db.drop_table", { table: "users" }, { registry }).decision).toBe("refuse");
  });

  it("a payment is never let through by a broad 'changes records' rule when the agent should not move money", () => {
    const answers: RiskAnswers = { money: "no", external: "no", personal: "no", amount: "small", oversight: "always" };
    const tier = riskTier(answers);
    const { rules, quotas } = mergeStarterRules(packById("general")!, suggestRules(answers, tier), answers, tier);
    const rb = validateRulebook({ ...starterRulebook(packById("general")!, people), rules, quotas });
    if (!rb.ok) throw new Error(rb.errors.join("; "));
    expect(decide(rb.rulebook, "zoho.record_bill_payment", { bill_id: "b1", amount_inr: 10 }).decision).toBe("refuse");
    expect(decide(rb.rulebook, "gmail.send_reply", { message_id: "m", to: "x@y.in", body: "hi" }).decision).toBe("refuse");
    expect(decide(rb.rulebook, "gmail.read_message", { message_id: "m" }).decision).toBe("allow");
  });

  it("the finance pack keeps the accounts-payable demo's rules", () => {
    const finance = packById("finance")!;
    expect(finance.starter.rules.map((r) => r.id)).toEqual(["read-mail", "search-mail", "open-attachments", "list-bills", "look-up-vendor", "draft-replies", "reply-vendor", "create-bills", "pay-small", "pay-large", "no-bank-change"]);
    const rb = validateRulebook(starterRulebook(finance, { ...people, agent: "ap-bot" }));
    if (!rb.ok) throw new Error(rb.errors.join("; "));
    expect(decide(rb.rulebook, "zoho.record_bill_payment", { bill_id: "b", amount_inr: 18000 }).decision).toBe("allow");
    expect(decide(rb.rulebook, "zoho.record_bill_payment", { bill_id: "b", amount_inr: 200000 }).decision).toBe("ask");
    expect(decide(rb.rulebook, "zoho.update_vendor", { vendor_id: "v", fields: { bank_account: "1" } }).decision).toBe("refuse");
  });

  it("high-risk agents ask before changing records with tag packs", () => {
    const answers: RiskAnswers = { money: "yes", external: "yes", personal: "yes", amount: "large", oversight: "never" };
    const { rules } = mergeStarterRules(packById("general")!, suggestRules(answers, "high"), answers, "high");
    expect(rules.find((r) => r.id === "change-records")?.decide).toBe("ask");
  });

  it("recommends frameworks by where the org operates", () => {
    const hr = packById("hr")!;
    expect(recommendedFrameworks(hr, ["us"])).toEqual(["iso-42001", "nist-ai-rmf", "nyc-ll144", "colorado-ai-act"]);
    expect(recommendedFrameworks(hr, ["eu", "india"])).toEqual(["iso-42001", "nist-ai-rmf", "eu-ai-act", "gdpr", "dpdp"]);
    expect(recommendedFrameworks(packById("finance")!, ["india"])).toEqual(["iso-42001", "nist-ai-rmf", "dpdp", "rbi-free-ai"]);
    expect(recommendedFrameworks(packById("healthcare")!, ["us"])).toContain("hipaa");
    expect(recommendedFrameworks(packById("general")!, ["other"])).toEqual(["iso-42001", "nist-ai-rmf"]);
    for (const p of PACKS) for (const region of REGIONS) expect(recommendedFrameworks(p, [region]).length).toBeGreaterThan(0);
  });

  it("falls back to the finance pack for orgs that have not picked an industry", () => {
    expect(packFor(null).id).toBe("finance");
    expect(packFor("unknown").id).toBe("finance");
    expect(packFor("healthcare").id).toBe("healthcare");
  });
});
