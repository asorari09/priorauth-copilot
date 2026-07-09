import { describe, expect, it } from "vitest";

import type { ClinicalExtraction } from "../lib/schemas";
import { RULES, runRulesEngine } from "../lib/rulesEngine";

function buildExtraction(
  overrides: Partial<ClinicalExtraction> = {},
): ClinicalExtraction {
  return {
    patientAge: 35,
    diagnosisCodes: ["K50.90"],
    requestedProcedureCode: "J1745",
    priorTreatmentsTried: ["methotrexate", "sulfasalazine"],
    treatmentFailureDocumented: true,
    clinicalNotesSummary: "Synthetic summary",
    requestedUnits: 4,
    symptomDurationWeeks: 16,
    imagingFindingsPresent: true,
    neurologicDeficitsPresent: false,
    ...overrides,
  };
}

describe("runRulesEngine", () => {
  it("returns failure when no CPT-specific rules exist", () => {
    const result = runRulesEngine(
      buildExtraction({ requestedProcedureCode: "99999" }),
    );

    expect(result).toEqual({
      eligibleByRules: false,
      failedCriteria: ["NO_APPLICABLE_RULES"],
      ruleIdsApplied: [],
    });
  });

  it("passes all J1745 rules for a qualifying synthetic case", () => {
    const result = runRulesEngine(buildExtraction());

    expect(result.eligibleByRules).toBe(true);
    expect(result.failedCriteria).toEqual([]);
    expect(result.ruleIdsApplied).toEqual([
      "STEP_THERAPY_001",
      "AGE_MINIMUM_001",
      "DIAGNOSIS_MATCH_001",
      "QUANTITY_LIMIT_001",
    ]);
  });

  it("fails targeted J1745 rules when criteria are missing", () => {
    const result = runRulesEngine(
      buildExtraction({
        patientAge: 5,
        diagnosisCodes: ["M54.5"],
        priorTreatmentsTried: ["methotrexate"],
        treatmentFailureDocumented: false,
        requestedUnits: 12,
      }),
    );

    expect(result.eligibleByRules).toBe(false);
    expect(result.failedCriteria).toEqual([
      "STEP_THERAPY_001: Requires at least 2 failed conventional therapies",
      "AGE_MINIMUM_001: Patient must be 6 or older per Crohn's disease initial therapy criteria",
      "DIAGNOSIS_MATCH_001: Diagnosis must match an approved inflammatory condition",
      "QUANTITY_LIMIT_001: Requested units may not exceed 8 per authorization period",
    ]);
  });

  it("fails J1745 quantity rule when requested units are missing", () => {
    const result = runRulesEngine(
      buildExtraction({
        requestedUnits: undefined,
      }),
    );

    expect(result.eligibleByRules).toBe(false);
    expect(result.failedCriteria).toContain(
      "QUANTITY_LIMIT_001: Requested units may not exceed 8 per authorization period",
    );
  });

  it("evaluates knee arthroplasty (27447) conservative care rules", () => {
    const passing = runRulesEngine(
      buildExtraction({
        requestedProcedureCode: "27447",
        patientAge: 62,
        priorTreatmentsTried: ["physical therapy", "nsaid", "weight loss"],
        symptomDurationWeeks: 20,
        treatmentFailureDocumented: true,
      }),
    );

    expect(passing.eligibleByRules).toBe(true);
    expect(passing.ruleIdsApplied).toEqual([
      "AGE_MINIMUM_002",
      "CONSERVATIVE_CARE_001",
    ]);

    const failing = runRulesEngine(
      buildExtraction({
        requestedProcedureCode: "27447",
        patientAge: 45,
        priorTreatmentsTried: ["acetaminophen"],
        symptomDurationWeeks: 6,
        treatmentFailureDocumented: false,
      }),
    );

    expect(failing.eligibleByRules).toBe(false);
    expect(failing.failedCriteria).toEqual([
      "AGE_MINIMUM_002: Patient must be 50 or older for synthetic joint-replacement criteria",
      "CONSERVATIVE_CARE_001: Requires >= 12 weeks of failed conservative care including PT and NSAID use",
    ]);
  });

  it("evaluates brain MRI (70553) via neurologic deficit OR diagnosis red flag", () => {
    const viaDeficit = runRulesEngine(
      buildExtraction({
        requestedProcedureCode: "70553",
        neurologicDeficitsPresent: true,
        imagingFindingsPresent: true,
        diagnosisCodes: [],
      }),
    );

    expect(viaDeficit.eligibleByRules).toBe(true);
    expect(viaDeficit.ruleIdsApplied).toEqual([
      "RED_FLAG_001",
      "PRIOR_IMAGING_001",
    ]);

    const viaDiagnosis = runRulesEngine(
      buildExtraction({
        requestedProcedureCode: "70553",
        neurologicDeficitsPresent: false,
        diagnosisCodes: ["r56.9"],
        imagingFindingsPresent: true,
      }),
    );
    expect(viaDiagnosis.eligibleByRules).toBe(true);

    const failing = runRulesEngine(
      buildExtraction({
        requestedProcedureCode: "70553",
        neurologicDeficitsPresent: false,
        diagnosisCodes: ["R42"],
        imagingFindingsPresent: false,
      }),
    );

    expect(failing.eligibleByRules).toBe(false);
    expect(failing.failedCriteria).toEqual([
      "RED_FLAG_001: Requires neurologic deficit or qualifying red-flag diagnosis code",
      "PRIOR_IMAGING_001: Prior non-advanced imaging or focal findings must be documented",
    ]);
  });
});

describe("RULES", () => {
  it("implements 8 rules across exactly 3 CPT codes", () => {
    expect(RULES).toHaveLength(8);

    const cptCodes = new Set(RULES.flatMap((rule) => rule.appliesToCpt));
    expect(Array.from(cptCodes).sort()).toEqual(["27447", "70553", "J1745"]);
  });
});
