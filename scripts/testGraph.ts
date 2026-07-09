import { readFileSync } from "node:fs";

import { runPriorAuthGraphCase } from "../lib/graph/buildGraph";
import { safeShutdownLangfuse } from "../lib/langfuse";

type GoldenCase = {
  id: string;
  note: string;
};

function loadCaseMap(): Map<string, GoldenCase> {
  const raw = readFileSync("data/goldenCases.json", "utf8");
  const parsed = JSON.parse(raw) as GoldenCase[];
  return new Map(parsed.map((c) => [c.id, c]));
}

function printCaseResult(result: Record<string, unknown>) {
  const decision = result.decision as
    | {
        outcome: string;
        confidence: string;
        reasoningSummary: string;
        supportingCitations?: Array<{
          sourceChunkId: string;
          payerName: string;
          documentTitle: string;
          requirementSummary: string;
        }>;
      }
    | undefined;

  console.log(`Outcome: ${decision?.outcome ?? "missing"}`);
  console.log(`Confidence: ${decision?.confidence ?? "missing"}`);
  console.log(`Reasoning: ${decision?.reasoningSummary ?? "missing"}`);
  console.log("Citations:");
  for (const citation of decision?.supportingCitations ?? []) {
    console.log(
      `- ${citation.sourceChunkId} | ${citation.payerName} | ${citation.documentTitle} | ${citation.requirementSummary}`,
    );
  }
}

async function run() {
  const allIds = ["CASE-001", "CASE-004", "CASE-008"] as const;
  type CaseId = (typeof allIds)[number];
  const cliCaseId = process.argv[2];
  const ids: CaseId[] =
    typeof cliCaseId === "string"
      ? allIds.includes(cliCaseId as CaseId)
        ? [cliCaseId as CaseId]
        : []
      : Array.from(allIds);
  if (cliCaseId && ids.length === 0) {
    throw new Error(
      `Unsupported case id "${cliCaseId}". Use one of: ${allIds.join(", ")}`,
    );
  }
  const expected: Record<CaseId, string> = {
    "CASE-001": "likely_approve",
    "CASE-004": "likely_deny",
    "CASE-008": "insufficient_info",
  };

  const caseMap = loadCaseMap();

  let mismatchFound = false;
  for (const id of ids) {
    const sample = caseMap.get(id);
    if (!sample) {
      throw new Error(`Missing ${id} in goldenCases.json`);
    }

    const result = (await runPriorAuthGraphCase({
      rawNote: sample.note,
      caseId: id,
    })) as unknown as Record<string, unknown>;

    const outcome = (result.decision as { outcome?: string } | undefined)?.outcome;
    console.log(`\n========== ${id} ==========`);
    printCaseResult(result);
    if (outcome !== expected[id]) {
      mismatchFound = true;
      console.log("\nOutcome mismatch diagnostics:");
      console.log(`expected=${expected[id]} actual=${outcome ?? "missing"}`);
      console.log(
        JSON.stringify(
          {
            rulesResult: result.rulesResult ?? null,
            retrievedChunkIds:
              (
                result.retrievedChunks as
                  | Array<{ chunk_id?: string }>
                  | undefined
              )?.map((c) => c.chunk_id) ?? [],
            citations:
              (
                result.citations as
                  | Array<{
                      sourceChunkId?: string;
                      payerName?: string;
                      documentTitle?: string;
                    }>
                  | undefined
              ) ?? [],
            overrideLog: result.overrideLog ?? [],
          },
          null,
          2,
        ),
      );
    }

    if (id === "CASE-004") {
      console.log("\nAppeal Draft:");
      console.log(
        (
          result.appealDraft as
            | {
                draftText?: string;
                citedClause?: { sourceChunkId?: string };
                requiresHumanReview?: boolean;
              }
            | undefined
        )?.draftText ?? "missing",
      );
      console.log(
        `requiresHumanReview: ${
          (result.appealDraft as { requiresHumanReview?: boolean } | undefined)
            ?.requiresHumanReview ?? "missing"
        }`,
      );
      console.log(
        `appeal cited sourceChunkId: ${
          (
            result.appealDraft as
              | { citedClause?: { sourceChunkId?: string } }
              | undefined
          )?.citedClause?.sourceChunkId ?? "missing"
        }`,
      );
    }
  }

  if (mismatchFound) {
    process.exitCode = 1;
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await safeShutdownLangfuse();
  });
