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

  it("routes missing patientAge through insufficient_info when age is the only failed rule", () => {
    const extraction = buildExtraction({
      requestedProcedureCode: "J1745",
      diagnosisCodes: ["K50.90"],
      patientAge: undefined,
      priorTreatmentsTried: ["mesalamine", "azathioprine"],
      treatmentFailureDocumented: true,
      requestedUnits: 6,
    });
    const rulesResult = runRulesEngine(extraction);
    expect(rulesResult.failedCriteria).toHaveLength(1);
    expect(rulesResult.failedCriteria[0]).toMatch(/^AGE_MINIMUM_001/);

    const constraint = determineOutcomeConstraint(extraction, rulesResult, [
      {
        payerName: "CareSource",
        documentTitle: "Infliximab UM",
        sourceChunkId: "caresource-infliximab-p1-1",
        requirementSummary: "Age and step therapy required.",
        clauseTextParaphrased: "Patient must meet age and step therapy.",
      },
    ]);

    expect(constraint.forcedOutcome).toBe("insufficient_info");
  });
});
