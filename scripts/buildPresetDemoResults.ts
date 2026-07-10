import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { citationFromChunkId } from "../lib/cache/chunkMetadata";
import { runRulesEngine } from "../lib/rulesEngine";
import { ClinicalExtractionSchema, type AppealDraft, type Decision } from "../lib/schemas";

const PRESET_CASE_IDS = ["CASE-001", "CASE-004", "CASE-008", "CASE-017", "CASE-025"] as const;
const SOURCE_EVAL = "evals/results/2026-07-09T18-40-22-006Z.json";

type EvalCase = {
  id: string;
  actualOutcome: Decision["outcome"];
  actualExtraction: unknown;
  retrievedChunkIds: string[];
  decisionReasoning: string | null;
};

type PresetDemoResult = {
  presetCaseId: string;
  decision: Decision;
  appealDraft?: AppealDraft;
  retrievedChunks: Array<{ chunk_id: string; source_url: string }>;
};

function buildAppealDraft(citations: Decision["supportingCitations"]): AppealDraft {
  const citedClause = citations[0] ?? {
    payerName: "Unknown payer",
    documentTitle: "Policy citation unavailable",
    sourceChunkId: "none",
    clauseTextParaphrased: "No validated citation available.",
    requirementSummary: "Manual review required.",
  };

  return {
    draftText: [
      "To Whom It May Concern:",
      "",
      "We are requesting reconsideration of the prior authorization denial.",
      "The submitted documentation demonstrates medical necessity based on the cited policy clause.",
      "Please review the attached clinical record and policy references.",
      "",
      "Sincerely,",
      "Clinical Prior Authorization Team",
    ].join("\n"),
    citedClause,
    requiresHumanReview: true,
  };
}

function buildPresetCase(evalCase: EvalCase): PresetDemoResult {
  const extraction = ClinicalExtractionSchema.parse(evalCase.actualExtraction);
  const rulesResult = runRulesEngine(extraction);
  const chunkIds = evalCase.retrievedChunkIds.slice(0, 3);
  const supportingCitations = chunkIds.map((chunkId, index) =>
    citationFromChunkId(
      chunkId,
      index === 0
        ? "Primary medical necessity requirement referenced for this authorization request."
        : "Supporting coverage criterion from retrieved payer policy text.",
    ),
  );

  const decision: Decision = {
    outcome: evalCase.actualOutcome,
    confidence:
      evalCase.actualOutcome === "insufficient_info"
        ? "medium"
        : evalCase.actualOutcome === "likely_deny"
          ? "high"
          : "high",
    reasoningSummary:
      evalCase.decisionReasoning ??
      `Preset cached reasoning for ${evalCase.id}. Outcome ${evalCase.actualOutcome}.`,
    supportingCitations,
    rulesResult,
  };

  const result: PresetDemoResult = {
    presetCaseId: evalCase.id,
    decision,
    retrievedChunks: evalCase.retrievedChunkIds.map((chunk_id) => ({
      chunk_id,
      source_url: `https://example.com/policy/${chunk_id}`,
    })),
  };

  if (decision.outcome === "likely_deny") {
    result.appealDraft = buildAppealDraft(supportingCitations);
  }

  return result;
}

function main() {
  const evalRaw = readFileSync(SOURCE_EVAL, "utf8");
  const evalData = JSON.parse(evalRaw) as { perCase: EvalCase[] };
  const byId = new Map(evalData.perCase.map((item) => [item.id, item]));

  const presets = PRESET_CASE_IDS.map((caseId) => {
    const evalCase = byId.get(caseId);
    if (!evalCase) {
      throw new Error(`Missing eval case ${caseId} in ${SOURCE_EVAL}`);
    }
    return buildPresetCase(evalCase);
  });

  const outputPath = join(process.cwd(), "data", "presetDemoResults.json");
  writeFileSync(outputPath, `${JSON.stringify(presets, null, 2)}\n`, "utf8");
  console.log(`Wrote ${presets.length} preset demo results to ${outputPath}`);
}

main();
