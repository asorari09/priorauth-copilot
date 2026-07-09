import { readFileSync } from "node:fs";

import {
  extractClinicalExtractionFromNote,
  ExtractionError,
} from "../lib/llm/openai";
import { ClinicalExtractionSchema } from "../lib/schemas";

type GoldenCase = {
  id: string;
  note: string;
  expectedExtraction: unknown;
};

const CASE_IDS = ["CASE-001", "CASE-008", "CASE-016"] as const;

function loadGoldenCases(): GoldenCase[] {
  const raw = readFileSync("data/goldenCases.json", "utf8");
  return JSON.parse(raw) as GoldenCase[];
}

function printSideBySide(
  caseId: string,
  extracted: unknown,
  expected: unknown,
): void {
  console.log(`\n================ ${caseId} ================`);
  console.log("EXTRACTED:");
  console.log(JSON.stringify(extracted, null, 2));
  console.log("EXPECTED:");
  console.log(JSON.stringify(expected, null, 2));
}

async function main() {
  const allCases = loadGoldenCases();
  const cases = CASE_IDS.map((id) => {
    const item = allCases.find((c) => c.id === id);
    if (!item) {
      throw new Error(`Missing ${id} in data/goldenCases.json`);
    }
    return item;
  });

  for (const item of cases) {
    try {
      const extracted = await extractClinicalExtractionFromNote(item.note);
      const parsedExtracted = ClinicalExtractionSchema.parse(extracted);
      const parsedExpected = ClinicalExtractionSchema.parse(item.expectedExtraction);
      printSideBySide(item.id, parsedExtracted, parsedExpected);
    } catch (error) {
      if (error instanceof ExtractionError) {
        console.error(
          `ExtractionError for ${item.id}: code=${error.code} message=${error.message}`,
        );
        if (error.cause && typeof error.cause === "object") {
          const cause = error.cause as {
            message?: string;
            status?: number;
            code?: string;
            type?: string;
          };
          console.error(
            `Cause: status=${cause.status ?? "n/a"} code=${cause.code ?? "n/a"} type=${cause.type ?? "n/a"} message=${cause.message ?? "n/a"}`,
          );
        }
      } else {
        console.error(`Unexpected error for ${item.id}:`, error);
      }
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
