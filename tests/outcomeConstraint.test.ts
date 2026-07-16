import { describe, expect, it } from "vitest";

import { determineOutcomeConstraint } from "../lib/graph/outcomeConstraint";
import { runRulesEngine } from "../lib/rulesEngine";
import type { ClinicalExtraction, PolicyCitation } from "../lib/schemas";

function buildExtraction(
  overrides: Partial<ClinicalExtraction> = {},
): ClinicalExtraction {
  return {
    patientAge: 25,
    diagnosisCodes: ["Z99.89"],
    requestedProcedureCode: "J9999",
    priorTreatmentsTried: ["therapy alpha", "therapy beta", "therapy gamma"],
    treatmentFailureDocumented: true,
    clinicalNotesSummary: "Canary note",
    ...overrides,
  };
}

const stubCitation: PolicyCitation = {
  payerName: "Meridian Health Plan (SYNTHETIC CANARY)",
  documentTitle: "J9999 Prior Authorization Policy",
  sourceChunkId: "meridian-health-plan-j9999-synthetic-canary-p1-1",
  requirementSummary: "Synthetic canary criterion.",
  clauseTextParaphrased: "Exactly three prior therapies and age >= 21.",
};

describe("determineOutcomeConstraint — NO_APPLICABLE_RULES", () => {
  it("forces insufficient_info when failedCriteria is exactly NO_APPLICABLE_RULES", () => {
    const extraction = buildExtraction();
    const rulesResult = runRulesEngine(extraction);

    expect(rulesResult.failedCriteria).toEqual(["NO_APPLICABLE_RULES"]);

    const constraint = determineOutcomeConstraint(extraction, rulesResult, [stubCitation]);

    expect(constraint.forcedOutcome).toBe("insufficient_info");
    expect(constraint.reason).toBe(
      "Procedure code J9999 is not in the encoded criteria set (J1745, 27447, 70553) — no deterministic evaluation possible; route to manual review.",
    );
  });

  it("does not permit likely_deny for out-of-scope CPT even when citations exist", () => {
    const extraction = buildExtraction({ requestedProcedureCode: "99999" });
    const rulesResult = runRulesEngine(extraction);
    const constraint = determineOutcomeConstraint(extraction, rulesResult, [stubCitation]);

    expect(constraint.forcedOutcome).toBe("insufficient_info");
    expect(constraint.forcedOutcome).not.toBe("likely_deny");
  });
});
