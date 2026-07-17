import type {
  AppealDraft,
  ClinicalExtraction,
  PolicyCitation,
  RulesEngineResult,
} from "../schemas";

export function normalizeTreatmentName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function claimedTreatmentsAreAllowed(
  claimedTreatments: string[],
  priorTreatmentsTried: string[],
): { ok: true } | { ok: false; disallowed: string[] } {
  const allowed = new Set(priorTreatmentsTried.map(normalizeTreatmentName));
  const disallowed = claimedTreatments.filter(
    (name) => !allowed.has(normalizeTreatmentName(name)),
  );
  if (disallowed.length === 0) {
    return { ok: true };
  }
  return { ok: false, disallowed };
}

/** True when draft asserts a forbidden therapy was tried/failed/attempted/completed. */
export function draftClaimsForbiddenTherapyTried(
  draftText: string,
  forbiddenTherapies: string[],
): string | null {
  const text = draftText.toLowerCase();
  for (const therapy of forbiddenTherapies) {
    const name = normalizeTreatmentName(therapy);
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const claimRe = new RegExp(
      [
        // "tried/attempted/failed budesonide"
        `\\b(?:tried|attempted|failed|completed|trialed|initiated)\\s+(?:and\\s+)?${escaped}\\b`,
        // "budesonide was tried/failed/attempted"
        `\\b${escaped}\\s+was\\s+(?:tried|attempted|failed|completed|initiated)\\b`,
        // "budesonide trial/failure"
        `\\b${escaped}\\s+(?:trial|failure)\\b`,
        // "failure of budesonide" / "trial of budesonide"
        `\\b(?:trial|failure|course)\\s+of\\s+${escaped}\\b`,
      ].join("|"),
      "i",
    );
    if (claimRe.test(text)) {
      return therapy;
    }
  }
  return null;
}

export function buildTemplateAppealDraft(citedClause: PolicyCitation): AppealDraft {
  return {
    draftText:
      "We request reconsideration and guidance on required documentation for this prior authorization. " +
      "Based on the validated clinical extraction available at this time, we cannot assert additional therapy trials beyond what is documented. " +
      "Please advise on the qualifying documentation needed for an exception or further review. " +
      "[FLAGGED FOR HUMAN COMPLETION]",
    citedClause,
    requiresHumanReview: true,
  };
}

export function buildAppealUserPrompt(params: {
  extraction: ClinicalExtraction;
  rulesResult: RulesEngineResult;
  citations: PolicyCitation[];
  correction?: string;
}): string {
  const { extraction, rulesResult, citations, correction } = params;
  const lines = [
    "Structured extraction (ONLY allowed clinical facts):",
    JSON.stringify({
      patientAge: extraction.patientAge,
      diagnosisCodes: extraction.diagnosisCodes,
      requestedProcedureCode: extraction.requestedProcedureCode,
      priorTreatmentsTried: extraction.priorTreatmentsTried,
      treatmentFailureDocumented: extraction.treatmentFailureDocumented,
      requestedUnits: extraction.requestedUnits,
      clinicalNotesSummary: extraction.clinicalNotesSummary,
    }),
    "",
    "Rules result:",
    JSON.stringify(rulesResult),
    "",
    "Validated citations:",
    JSON.stringify(citations),
    "",
    "Allowed treatments for claimedTreatments (exact list):",
    JSON.stringify(extraction.priorTreatmentsTried),
    "",
    "Use one of the validated citations as citedClause.",
    "Populate claimedTreatments with every therapy you assert was tried or failed in draftText.",
    "Set requiresHumanReview to true.",
  ];
  if (correction) {
    lines.push("", correction);
  }
  return lines.join("\n");
}
