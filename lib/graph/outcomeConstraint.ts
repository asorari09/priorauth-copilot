import type {
  ClinicalExtraction,
  Decision,
  PolicyCitation,
  RulesEngineResult,
} from "../schemas";

const OPTIONAL_RULE_DEPENDENCIES: Record<string, Array<keyof ClinicalExtraction>> = {
  AGE_MINIMUM_001: ["patientAge"],
  AGE_MINIMUM_002: ["patientAge"],
  QUANTITY_LIMIT_001: ["requestedUnits"],
  CONSERVATIVE_CARE_001: ["symptomDurationWeeks"],
  RED_FLAG_001: ["neurologicDeficitsPresent"],
  PRIOR_IMAGING_001: ["imagingFindingsPresent"],
};

const ENCODED_PROCEDURE_CODES = ["J1745", "27447", "70553"] as const;

export type OutcomeConstraint = {
  forcedOutcome: Decision["outcome"];
  reason: string;
};

export function isNoApplicableRulesFailure(rulesResult: RulesEngineResult): boolean {
  return (
    rulesResult.failedCriteria.length === 1 &&
    rulesResult.failedCriteria[0] === "NO_APPLICABLE_RULES"
  );
}

export function isMissingFieldDrivenRuleFailure(
  rulesResult: RulesEngineResult,
  extraction: ClinicalExtraction,
): boolean {
  if (rulesResult.failedCriteria.length === 0) {
    return false;
  }

  return rulesResult.failedCriteria.every((criterion) => {
    const ruleId = criterion.split(":")[0]?.trim();
    const deps = OPTIONAL_RULE_DEPENDENCIES[ruleId];
    if (!deps || deps.length === 0) {
      return false;
    }

    return deps.every((field) => extraction[field] === undefined);
  });
}

export function determineOutcomeConstraint(
  extraction: ClinicalExtraction,
  rulesResult: RulesEngineResult,
  citations: PolicyCitation[],
): OutcomeConstraint {
  if (citations.length === 0) {
    return {
      forcedOutcome: "insufficient_info",
      reason: "No validated citations available from retrieval.",
    };
  }

  if (isNoApplicableRulesFailure(rulesResult)) {
    const cpt = extraction.requestedProcedureCode;
    return {
      forcedOutcome: "insufficient_info",
      reason: `Procedure code ${cpt} is not in the encoded criteria set (${ENCODED_PROCEDURE_CODES.join(", ")}) — no deterministic evaluation possible; route to manual review.`,
    };
  }

  if (rulesResult.eligibleByRules) {
    return {
      forcedOutcome: "likely_approve",
      reason: "All deterministic rules passed.",
    };
  }

  if (isMissingFieldDrivenRuleFailure(rulesResult, extraction)) {
    return {
      forcedOutcome: "insufficient_info",
      reason:
        "All failed rules depend on optional fields that are absent in extraction.",
    };
  }

  return {
    forcedOutcome: "likely_deny",
    reason:
      "At least one failed rule is based on present data, so likely_deny is permitted.",
  };
}
