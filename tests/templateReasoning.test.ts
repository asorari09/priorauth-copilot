import { describe, expect, it } from "vitest";

import { buildAppealDraftCacheKey, buildCitationSynthesisCacheKey } from "../lib/cache/cacheKeys";
import { generateTemplateReasoningSummary } from "../lib/graph/templateReasoning";
import type { PolicyCitation, RulesEngineResult } from "../lib/schemas";

const baseExtraction = {
  patientAge: 29,
  diagnosisCodes: ["K50.90"],
  requestedProcedureCode: "J1745",
  priorTreatmentsTried: ["mesalamine", "azathioprine"],
  treatmentFailureDocumented: true,
  clinicalNotesSummary: "Adult Crohn disease with two failed therapies and dose within limit.",
  requestedUnits: 6,
};

const passedRules: RulesEngineResult = {
  eligibleByRules: true,
  failedCriteria: [],
  ruleIdsApplied: ["STEP_THERAPY_001", "AGE_MINIMUM_001"],
};

const gastroCitation: PolicyCitation = {
  payerName: "CareSource",
  documentTitle: "Infliximab UM Policy",
  sourceChunkId: "caresource-infliximab-p5-1",
  clauseTextParaphrased: "Must be prescribed by a gastroenterologist.",
  requirementSummary: "Prescriber must be a gastroenterologist or in consultation with one.",
};

describe("cache keys", () => {
  it("is stable regardless of chunk id order", () => {
    const a = buildCitationSynthesisCacheKey("J1745", ["chunk-b", "chunk-a"]);
    const b = buildCitationSynthesisCacheKey("J1745", ["chunk-a", "chunk-b"]);
    expect(a).toBe(b);
  });

  it("changes when CPT or chunk ids change", () => {
    const base = buildCitationSynthesisCacheKey("J1745", ["chunk-a"]);
    expect(buildCitationSynthesisCacheKey("70553", ["chunk-a"])).not.toBe(base);
    expect(buildCitationSynthesisCacheKey("J1745", ["chunk-b"])).not.toBe(base);
  });

  it("builds appeal cache keys from case content", () => {
    const key = buildAppealDraftCacheKey({
      procedureCode: "J1745",
      diagnosisCodes: ["K50.90"],
      outcome: "likely_deny",
      failedCriteria: ["AGE_MINIMUM_001: patient age 4 < 6"],
      citationChunkIds: ["chunk-a"],
    });
    expect(key).toHaveLength(64);
  });
});

describe("template reasoning", () => {
  it("lists gastroenterologist requirements as unverified", () => {
    const result = generateTemplateReasoningSummary({
      extraction: baseExtraction,
      rulesResult: passedRules,
      citations: [gastroCitation],
      forcedOutcome: "likely_approve",
      constraintReason: "All deterministic rules passed.",
    });

    expect(result.reasoningSummary).toContain("prescriber gastroenterologist specialty");
    expect(result.reasoningSummary).toContain("not presumed satisfied");
    expect(result.confidence).toBe("medium");
  });

  it("documents failed criteria for likely_deny outcomes", () => {
    const result = generateTemplateReasoningSummary({
      extraction: { ...baseExtraction, patientAge: 4 },
      rulesResult: {
        eligibleByRules: false,
        failedCriteria: ["AGE_MINIMUM_001: patient age 4 < 6"],
        ruleIdsApplied: ["AGE_MINIMUM_001", "STEP_THERAPY_001"],
      },
      citations: [gastroCitation],
      forcedOutcome: "likely_deny",
      constraintReason: "At least one failed rule is based on present data.",
    });

    expect(result.reasoningSummary).toContain("AGE_MINIMUM_001");
    expect(result.reasoningSummary).toContain("likely_deny");
    expect(result.confidence).toBe("medium");
  });
});
