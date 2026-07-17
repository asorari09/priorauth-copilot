import type {
  ClinicalExtraction,
  Decision,
  PolicyCitation,
  RulesEngineResult,
} from "../schemas";

export type ReasoningMode = "template" | "llm";

const UNVERIFIED_REQUIREMENT_CHECKS: Array<{
  pattern: RegExp;
  label: string;
}> = [
  {
    pattern: /gastroenterolog/i,
    label: "prescriber gastroenterologist specialty",
  },
  {
    pattern: /prescriber specialty|prescribed by.*specialist|in consultation with/i,
    label: "prescriber specialty documentation",
  },
];

export function getReasoningMode(): ReasoningMode {
  const mode = process.env.REASONING_MODE?.toLowerCase();
  if (mode === "llm") {
    return "llm";
  }
  return "template";
}

export function detectUnverifiedRequirements(citations: PolicyCitation[]): string[] {
  const unverified = new Set<string>();

  for (const citation of citations) {
    const text = `${citation.requirementSummary} ${citation.clauseTextParaphrased}`;
    for (const check of UNVERIFIED_REQUIREMENT_CHECKS) {
      if (check.pattern.test(text)) {
        unverified.add(check.label);
      }
    }
  }

  return Array.from(unverified);
}

function deriveConfidence(
  forcedOutcome: Decision["outcome"],
  rulesResult: RulesEngineResult,
  citations: PolicyCitation[],
  unverified: string[],
): Decision["confidence"] {
  if (forcedOutcome === "insufficient_info") {
    if (citations.length === 0) {
      return "low";
    }
    if (rulesResult.failedCriteria.length > 0 && unverified.length === 0) {
      return "medium";
    }
    return unverified.length > 0 ? "medium" : "low";
  }

  if (unverified.length > 0) {
    return "medium";
  }

  return forcedOutcome === "likely_deny" && rulesResult.failedCriteria.length > 0
    ? "high"
    : "high";
}

function formatRuleLine(criterion: string): string {
  const [ruleId, detail] = criterion.split(":", 2);
  if (detail) {
    return `- ${ruleId.trim()}: ${detail.trim()}`;
  }
  return `- ${ruleId.trim()}`;
}

export function generateTemplateReasoningSummary(params: {
  extraction: ClinicalExtraction;
  rulesResult: RulesEngineResult;
  citations: PolicyCitation[];
  forcedOutcome: Decision["outcome"];
  constraintReason: string;
}): { confidence: Decision["confidence"]; reasoningSummary: string } {
  const { extraction, rulesResult, citations, forcedOutcome, constraintReason } = params;
  const unverified = detectUnverifiedRequirements(citations);
  const confidence = deriveConfidence(forcedOutcome, rulesResult, citations, unverified);

  const lines: string[] = [
    `Outcome ${forcedOutcome} was determined by deterministic guardrails (${constraintReason}).`,
    "",
    `Clinical context: patient age ${extraction.patientAge ?? "not documented"}; diagnosis ${extraction.diagnosisCodes.join(", ")}; requested procedure ${extraction.requestedProcedureCode}.`,
    "",
    `Rules applied (${rulesResult.ruleIdsApplied.length}): ${rulesResult.ruleIdsApplied.join(", ") || "none"}.`,
  ];

  if (rulesResult.failedCriteria.length > 0) {
    lines.push("", "Failed criteria:");
    lines.push(...rulesResult.failedCriteria.map(formatRuleLine));
  } else {
    lines.push("", "All applied deterministic rules passed.");
  }

  if (citations.length > 0) {
    lines.push("", "Validated policy citations:");
    for (const citation of citations) {
      lines.push(`- ${citation.payerName}: ${citation.requirementSummary}`);
    }
  } else {
    lines.push("", "No validated policy citations were available from retrieval.");
  }

  if (unverified.length > 0) {
    lines.push(
      "",
      "Unverified items requiring confirmation (not presumed satisfied):",
      ...unverified.map((item) => `- ${item}`),
    );
  }

  return {
    confidence,
    reasoningSummary: lines.join("\n"),
  };
}
