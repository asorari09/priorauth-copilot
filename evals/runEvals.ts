import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runPriorAuthGraphCase } from "../lib/graph/buildGraph";
import { safeShutdownLangfuse } from "../lib/langfuse";
import { ClinicalExtractionSchema, type ClinicalExtraction } from "../lib/schemas";

type ExpectedOutcome = "likely_approve" | "likely_deny" | "insufficient_info";

type GoldenCase = {
  id: string;
  note: string;
  expectedOutcome: ExpectedOutcome;
  expectedExtraction: ClinicalExtraction;
};

type CaseEvalDetail = {
  id: string;
  expectedOutcome: ExpectedOutcome;
  actualOutcome: ExpectedOutcome | "missing";
  outcomeMatch: boolean;
  expectedExtraction: ClinicalExtraction;
  actualExtraction: ClinicalExtraction | null;
  extractionFieldAccuracy: number;
  extractionFieldBreakdown: Array<{
    field: keyof ClinicalExtraction;
    expected: unknown;
    actual: unknown;
    match: boolean;
  }>;
  citationsCount: number;
  validCitationCount: number;
  citationValidityRate: number;
  invalidCitationIds: string[];
  retrievedChunkIds: string[];
  latencyMs: number;
  decisionReasoning: string | null;
  overrideLog: string[];
};

type EvalResults = {
  timestamp: string;
  mode: "default" | "ablation";
  caseFilter: string | null;
  summary: {
    totalCases: number;
    decisionAccuracy: number;
    extractionFieldAccuracy: number;
    citationValidityRate: number;
    falseApproveRate: number;
    meanLatencyMs: number;
    mismatchedCaseIds: string[];
  };
  metricsNumerators: {
    decisionMatches: number;
    extractionFieldsCorrect: number;
    extractionFieldsTotal: number;
    validCitations: number;
    totalCitations: number;
    falseApproves: number;
    expectedDenies: number;
    totalLatencyMs: number;
  };
  perCase: CaseEvalDetail[];
};

const EXTRACTION_FIELDS: Array<keyof ClinicalExtraction> = [
  "patientAge",
  "diagnosisCodes",
  "requestedProcedureCode",
  "priorTreatmentsTried",
  "treatmentFailureDocumented",
  "clinicalNotesSummary",
  "requestedUnits",
  "symptomDurationWeeks",
  "imagingFindingsPresent",
  "neurologicDeficitsPresent",
];

function parseArgs(argv: string[]) {
  let caseFilter: string | null = null;
  let ablation = false;
  let disableInferenceCache = false;

  for (const arg of argv) {
    if (arg.startsWith("--case=")) {
      caseFilter = arg.slice("--case=".length);
    } else if (arg === "--ablation") {
      ablation = true;
    } else if (arg === "--no-cache") {
      disableInferenceCache = true;
    }
  }

  return { caseFilter, ablation, disableInferenceCache };
}

function loadGoldenCases(): GoldenCase[] {
  const raw = readFileSync("data/goldenCases.json", "utf8");
  const parsed = JSON.parse(raw) as GoldenCase[];
  return parsed.map((item) => ({
    ...item,
    expectedExtraction: ClinicalExtractionSchema.parse(item.expectedExtraction),
  }));
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function toPercent(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }
  return Number(((numerator / denominator) * 100).toFixed(2));
}

async function evaluateCase(
  item: GoldenCase,
  options: { ablation: boolean; disableInferenceCache: boolean },
): Promise<CaseEvalDetail> {
  const startedAt = Date.now();
  const result = await runPriorAuthGraphCase({
    rawNote: item.note,
    caseId: item.id,
    forceNoRetrieval: options.ablation,
    disableInferenceCache: options.disableInferenceCache,
  });
  const latencyMs = Date.now() - startedAt;

  const actualOutcome = result.decision?.outcome ?? "missing";
  const outcomeMatch = actualOutcome === item.expectedOutcome;
  const actualExtraction = result.extraction
    ? ClinicalExtractionSchema.parse(result.extraction)
    : null;

  const extractionFieldBreakdown = EXTRACTION_FIELDS.map((field) => {
    const expected = item.expectedExtraction[field];
    const actual = actualExtraction ? actualExtraction[field] : undefined;
    return {
      field,
      expected,
      actual,
      match: deepEqual(expected, actual),
    };
  });

  const extractionFieldsCorrect = extractionFieldBreakdown.filter((f) => f.match).length;
  const extractionFieldAccuracy = Number(
    ((extractionFieldsCorrect / extractionFieldBreakdown.length) * 100).toFixed(2),
  );

  const retrievedChunkIds = (result.retrievedChunks ?? []).map((c) => c.chunk_id);
  const retrievedSet = new Set(retrievedChunkIds);
  const citations = result.decision?.supportingCitations ?? [];
  const invalidCitationIds = citations
    .filter((citation) => !retrievedSet.has(citation.sourceChunkId))
    .map((citation) => citation.sourceChunkId);
  const validCitationCount = citations.length - invalidCitationIds.length;
  const citationValidityRate =
    citations.length === 0
      ? 100
      : Number(((validCitationCount / citations.length) * 100).toFixed(2));

  return {
    id: item.id,
    expectedOutcome: item.expectedOutcome,
    actualOutcome: actualOutcome as ExpectedOutcome | "missing",
    outcomeMatch,
    expectedExtraction: item.expectedExtraction,
    actualExtraction,
    extractionFieldAccuracy,
    extractionFieldBreakdown,
    citationsCount: citations.length,
    validCitationCount,
    citationValidityRate,
    invalidCitationIds,
    retrievedChunkIds,
    latencyMs,
    decisionReasoning: result.decision?.reasoningSummary ?? null,
    overrideLog: result.overrideLog ?? [],
  };
}

function summarize(details: CaseEvalDetail[]): EvalResults["summary"] {
  const totalCases = details.length;
  const decisionMatches = details.filter((d) => d.outcomeMatch).length;
  const extractionFieldsCorrect = details
    .flatMap((d) => d.extractionFieldBreakdown)
    .filter((f) => f.match).length;
  const extractionFieldsTotal = details.length * EXTRACTION_FIELDS.length;
  const totalCitations = details.reduce((acc, d) => acc + d.citationsCount, 0);
  const validCitations = details.reduce((acc, d) => acc + d.validCitationCount, 0);
  const expectedDenies = details.filter((d) => d.expectedOutcome === "likely_deny").length;
  const falseApproves = details.filter(
    (d) => d.expectedOutcome === "likely_deny" && d.actualOutcome === "likely_approve",
  ).length;
  const totalLatencyMs = details.reduce((acc, d) => acc + d.latencyMs, 0);

  return {
    totalCases,
    decisionAccuracy: toPercent(decisionMatches, totalCases),
    extractionFieldAccuracy: toPercent(extractionFieldsCorrect, extractionFieldsTotal),
    citationValidityRate: toPercent(validCitations, totalCitations || 1),
    falseApproveRate: toPercent(falseApproves, expectedDenies || 1),
    meanLatencyMs: Number((totalLatencyMs / Math.max(totalCases, 1)).toFixed(2)),
    mismatchedCaseIds: details.filter((d) => !d.outcomeMatch).map((d) => d.id),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allCases = loadGoldenCases();
  const selected = args.caseFilter
    ? allCases.filter((c) => c.id === args.caseFilter)
    : allCases;

  if (selected.length === 0) {
    throw new Error(`No cases found for filter: ${args.caseFilter}`);
  }

  const perCase: CaseEvalDetail[] = [];
  for (const item of selected) {
    // Sequential on purpose to keep each run stable and easier to debug.
    const detail = await evaluateCase(item, {
      ablation: args.ablation,
      disableInferenceCache: args.disableInferenceCache,
    });
    perCase.push(detail);
    console.log(
      `[${item.id}] expected=${detail.expectedOutcome} actual=${detail.actualOutcome} latencyMs=${detail.latencyMs} citations=${detail.citationsCount} extractionAcc=${detail.extractionFieldAccuracy}%`,
    );
  }

  const summary = summarize(perCase);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = join(process.cwd(), "evals", "results");
  mkdirSync(resultsDir, { recursive: true });
  const outputPath = join(resultsDir, `${timestamp}.json`);

  const metricsNumerators = {
    decisionMatches: perCase.filter((d) => d.outcomeMatch).length,
    extractionFieldsCorrect: perCase
      .flatMap((d) => d.extractionFieldBreakdown)
      .filter((f) => f.match).length,
    extractionFieldsTotal: perCase.length * EXTRACTION_FIELDS.length,
    validCitations: perCase.reduce((acc, d) => acc + d.validCitationCount, 0),
    totalCitations: perCase.reduce((acc, d) => acc + d.citationsCount, 0),
    falseApproves: perCase.filter(
      (d) => d.expectedOutcome === "likely_deny" && d.actualOutcome === "likely_approve",
    ).length,
    expectedDenies: perCase.filter((d) => d.expectedOutcome === "likely_deny").length,
    totalLatencyMs: perCase.reduce((acc, d) => acc + d.latencyMs, 0),
  };

  const output: EvalResults = {
    timestamp: new Date().toISOString(),
    mode: args.ablation ? "ablation" : "default",
    caseFilter: args.caseFilter,
    summary,
    metricsNumerators,
    perCase,
  };

  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`\nWrote eval results: ${outputPath}`);
  console.log(`Summary: ${JSON.stringify(summary)}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await safeShutdownLangfuse();
  });
