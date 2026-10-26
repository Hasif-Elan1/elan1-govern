import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkAnswers,
  DATA_PROTECTION,
  explainResult,
  getTemplate,
  highestTier,
  IMPACT,
  nextReviewDate,
  nextStatus,
  questionsOf,
  reviewProblem,
  scoreAssessment,
  TEMPLATES,
  tierForScore,
  TRIAGE,
  type Answers,
  type AssessmentTemplate,
} from "../src/assessments";
import { DATA_CATEGORIES, labelOf, SYSTEM_KINDS, values } from "../src/inventory";

/** The lowest-scoring answer to every question. */
function calmest(t: AssessmentTemplate): Answers {
  const a: Answers = {};
  for (const q of questionsOf(t)) {
    if (q.type === "text") a[q.id] = "Reviewed by the operations lead.";
    else {
      const o = [...q.options!].sort((x, y) => x.weight - y.weight)[0]!;
      a[q.id] = q.type === "multi" ? [o.value] : o.value;
    }
  }
  return a;
}

describe("templates", () => {
  it("ships three templates with unique keys, sections and question ids", () => {
    expect(TEMPLATES.map((t) => t.key)).toEqual(["triage", "impact", "data-protection"]);
    for (const t of TEMPLATES) {
      const ids = questionsOf(t).map((q) => q.id);
      expect(new Set(ids).size, t.key).toBe(ids.length);
      expect(new Set(t.sections.map((s) => s.id)).size).toBe(t.sections.length);
      expect(t.thresholds.medium).toBeLessThan(t.thresholds.high);
      for (const q of questionsOf(t)) {
        if (q.type === "text") expect(q.options).toBeUndefined();
        else {
          expect(q.options!.length, q.id).toBeGreaterThanOrEqual(2);
          expect(new Set(q.options!.map((o) => o.value)).size).toBe(q.options!.length);
        }
        if (q.type === "yes_no") expect(q.options!.map((o) => o.value)).toEqual(["yes", "no"]);
        // Plain English, sentence case: no all-caps words in the copy.
        expect(q.text).not.toMatch(/\b[A-Z]{4,}\b/);
      }
    }
  });

  it("looks templates up by key", () => {
    expect(getTemplate("impact")).toBe(IMPACT);
    expect(getTemplate("nope")).toBeUndefined();
  });

  it("describes the impact and data protection templates as inspired by, not compliant with, the law", () => {
    expect(IMPACT.description).toMatch(/Inspired by/);
    expect(IMPACT.description).toMatch(/does not on its own meet/);
    expect(DATA_PROTECTION.description).toMatch(/not legal advice/);
  });

  it("covers the data protection topics", () => {
    const ids = questionsOf(DATA_PROTECTION).map((q) => q.id);
    for (const id of ["lawful_basis", "notice", "minimal", "retention", "transfer", "children_consent"]) expect(ids).toContain(id);
  });
});

describe("checking answers", () => {
  it("accepts a complete set", () => {
    for (const t of TEMPLATES) expect(checkAnswers(t, calmest(t)), t.key).toEqual({ errors: [], missing: [] });
  });

  it("lists required questions that are missing, but not optional ones", () => {
    const { errors, missing } = checkAnswers(TRIAGE, { autonomy: "informs", areas: [], notes: "" });
    expect(errors).toEqual([]);
    expect(missing).toContain("areas");
    expect(missing).not.toContain("autonomy");
    expect(missing).not.toContain("notes");
    expect(checkAnswers(IMPACT, { process: "   " }).missing).toContain("process");
  });

  it("refuses unknown questions, unknown choices and wrong shapes", () => {
    const errs = (a: Answers) => checkAnswers(TRIAGE, a).errors;
    expect(errs({ bogus: "x" })[0]).toMatch(/not a question/);
    expect(errs({ autonomy: "maybe" })[0]).toMatch(/not one of the choices/);
    expect(errs({ autonomy: ["informs"] })[0]).toMatch(/not one of the choices/);
    expect(errs({ areas: "employment" })[0]).toMatch(/not one of the choices/);
    expect(errs({ areas: ["employment", "nope"] })[0]).toMatch(/not one of the choices/);
    expect(errs({ areas: ["employment", "employment"] })[0]).toMatch(/twice/);
    expect(errs({ areas: ["none", "employment"] })[0]).toMatch(/cannot be combined/);
    expect(errs({ notes: ["x"] })[0]).toMatch(/written answer/);
    expect(errs({ notes: "x".repeat(2001) })[0]).toMatch(/at most 2000/);
    expect(errs({ areas: ["none"], notes: "x".repeat(2000) })).toEqual([]);
  });
});

describe("scoring", () => {
  it("scores the calmest answers as low", () => {
    for (const t of TEMPLATES) {
      const r = scoreAssessment(t, calmest(t));
      expect(r, t.key).toMatchObject({ score: t.key === "impact" ? 1 : 0, tier: "low", forcedBy: [] });
      expect(r.maxScore).toBeGreaterThan(t.thresholds.high);
    }
  });

  it("scores a customer chatbot as medium, with the reasons highest first", () => {
    const r = scoreAssessment(TRIAGE, {
      autonomy: "informs",
      areas: ["none"],
      external: "yes",
      affected: ["customers"],
      data: ["personal"],
      oversight: "sampled",
      appeal: "yes",
      supplier: "documented",
    });
    expect(r.score).toBe(7);
    expect(r.tier).toBe("medium");
    expect(r.reasons.map((x) => x.points)).toEqual([2, 2, 1, 1, 1]);
    expect(r.reasons[0]).toMatchObject({ questionId: "external", answer: "Yes", points: 2 });
    expect(explainResult(TRIAGE, r)).toBe("Score 7 of 56. Medium starts at 5 and high at 11.");
  });

  it("an accounts-payable agent that pays on its own is high", () => {
    const r = scoreAssessment(TRIAGE, { autonomy: "decides", areas: ["none"], external: "yes", affected: ["employees"], data: ["personal", "financial"], oversight: "sampled", appeal: "yes", supplier: "documented" });
    expect(r.score).toBe(11);
    expect(r.tier).toBe("high");
    expect(r.forcedBy).toEqual([]);
  });

  it("a high-risk area forces high whatever the score, and says why", () => {
    const a = { ...calmest(TRIAGE), areas: ["employment"] };
    const r = scoreAssessment(TRIAGE, a);
    expect(r.score).toBe(3);
    expect(tierForScore(TRIAGE, r.score)).toBe("low");
    expect(r.tier).toBe("high");
    expect(r.forcedBy).toEqual([expect.objectContaining({ questionId: "areas", forces: "high" })]);
    expect(explainResult(TRIAGE, r)).toMatch(/The result is high because of the answer "Hiring, promotion, performance or firing"\./);
  });

  it("forced options in the other templates", () => {
    expect(scoreAssessment(IMPACT, { ...calmest(IMPACT), severity: "severe" }).tier).toBe("high");
    expect(scoreAssessment(DATA_PROTECTION, { ...calmest(DATA_PROTECTION), children_consent: "no" }).tier).toBe("high");
  });

  it("does not repeat the forced explanation when the score is already high", () => {
    const worst: Answers = {};
    for (const q of questionsOf(IMPACT)) {
      if (q.type === "multi") worst[q.id] = q.options!.filter((o) => !o.exclusive).map((o) => o.value);
      else if (q.type !== "text") worst[q.id] = [...q.options!].sort((x, y) => y.weight - x.weight)[0]!.value;
    }
    const r = scoreAssessment(IMPACT, worst);
    expect(r.score).toBe(r.maxScore);
    expect(r.tier).toBe("high");
    expect(explainResult(IMPACT, r)).not.toMatch(/because of/);
  });

  it("ignores unanswered questions and unknown choices", () => {
    expect(scoreAssessment(TRIAGE, {}).score).toBe(0);
    expect(scoreAssessment(TRIAGE, { autonomy: "nope", areas: ["nope"] }).score).toBe(0);
  });

  it("thresholds are inclusive", () => {
    expect(tierForScore(TRIAGE, 4)).toBe("low");
    expect(tierForScore(TRIAGE, 5)).toBe("medium");
    expect(tierForScore(TRIAGE, 10)).toBe("medium");
    expect(tierForScore(TRIAGE, 11)).toBe("high");
  });

  it("is deterministic and never above the maximum (property)", () => {
    for (const t of TEMPLATES) {
      const qs = questionsOf(t).filter((q) => q.type !== "text");
      const arb = fc.record(
        Object.fromEntries(
          qs.map((q) => {
            const vals = q.options!.map((o) => o.value);
            return [q.id, q.type === "multi" ? fc.subarray(vals) : fc.constantFrom(...vals)];
          }),
        ) as Record<string, fc.Arbitrary<string | string[]>>,
      );
      fc.assert(
        fc.property(arb, (a) => {
          const r1 = scoreAssessment(t, a);
          const r2 = scoreAssessment(t, JSON.parse(JSON.stringify(a)));
          expect(r2).toEqual(r1);
          expect(r1.score).toBeGreaterThanOrEqual(0);
          expect(r1.score).toBeLessThanOrEqual(r1.maxScore);
          // The tier is never lower than the score alone would give.
          expect(highestTier([r1.tier, tierForScore(t, r1.score)])).toBe(r1.tier);
        }),
        { numRuns: 200 },
      );
    }
  });
});

describe("tiers, reviews and status", () => {
  it("picks the highest tier", () => {
    expect(highestTier([])).toBe("low");
    expect(highestTier(["low", "medium"])).toBe("medium");
    expect(highestTier(["high", "low", "medium"])).toBe("high");
  });

  it("schedules the next review: high in 6 months, medium 12, low 24", () => {
    const from = new Date("2026-10-26T10:00:00Z");
    expect(nextReviewDate("high", from).toISOString()).toBe("2027-04-26T10:00:00.000Z");
    expect(nextReviewDate("medium", from).toISOString()).toBe("2027-10-26T10:00:00.000Z");
    expect(nextReviewDate("low", from).toISOString()).toBe("2028-10-26T10:00:00.000Z");
    expect(nextReviewDate("high", new Date("2026-08-31T00:00:00Z")).toISOString()).toBe("2027-02-28T00:00:00.000Z");
    expect(from.toISOString()).toBe("2026-10-26T10:00:00.000Z");
  });

  it("moves through draft, submitted, approved or changes requested", () => {
    expect(nextStatus("draft", "save")).toBe("draft");
    expect(nextStatus("changes_requested", "save")).toBe("changes_requested");
    expect(nextStatus("draft", "submit")).toBe("submitted");
    expect(nextStatus("changes_requested", "submit")).toBe("submitted");
    expect(nextStatus("submitted", "approve")).toBe("approved");
    expect(nextStatus("submitted", "request_changes")).toBe("changes_requested");
    expect(nextStatus("submitted", "save")).toBeNull();
    expect(nextStatus("submitted", "submit")).toBeNull();
    expect(nextStatus("draft", "approve")).toBeNull();
    expect(nextStatus("approved", "save")).toBeNull();
    expect(nextStatus("approved", "request_changes")).toBeNull();
  });

  it("separation of duties: the submitter cannot review their own assessment", () => {
    expect(reviewProblem({ status: "submitted", submittedById: "u1" }, "u1")).toMatch(/someone else/);
    expect(reviewProblem({ status: "submitted", submittedById: "u1" }, "u2")).toBeNull();
    expect(reviewProblem({ status: "draft", submittedById: null }, "u2")).toMatch(/Only a submitted/);
    expect(reviewProblem({ status: "approved", submittedById: "u1" }, "u2")).toMatch(/Only a submitted/);
  });
});

describe("inventory vocabulary", () => {
  it("gives values and labels", () => {
    expect(values(SYSTEM_KINDS)).toEqual(["agent", "model", "vendor_tool", "internal_app"]);
    expect(labelOf(DATA_CATEGORIES, "children")).toBe("Children's");
    expect(labelOf(DATA_CATEGORIES, "other")).toBe("other");
  });
});
