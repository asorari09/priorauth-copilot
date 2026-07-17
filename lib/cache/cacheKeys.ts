import { createHash } from "node:crypto";

export function hashCacheInput(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildCitationSynthesisCacheKey(
  procedureCode: string,
  retrievedChunkIds: string[],
): string {
  const sortedIds = [...retrievedChunkIds].sort();
  return hashCacheInput(`citations:${procedureCode}:${sortedIds.join(",")}`);
}

export function buildAppealDraftCacheKey(params: {
  procedureCode: string;
  diagnosisCodes: string[];
  outcome: string;
  failedCriteria: string[];
  citationChunkIds: string[];
  priorTreatmentsTried: string[];
  treatmentFailureDocumented: boolean;
}): string {
  const payload = {
    kind: "appeal_draft",
    procedureCode: params.procedureCode,
    diagnosisCodes: [...params.diagnosisCodes].sort(),
    outcome: params.outcome,
    failedCriteria: [...params.failedCriteria].sort(),
    citationChunkIds: [...params.citationChunkIds].sort(),
    priorTreatmentsTried: [...params.priorTreatmentsTried]
      .map((t) => t.trim().toLowerCase())
      .sort(),
    treatmentFailureDocumented: params.treatmentFailureDocumented,
  };
  return hashCacheInput(JSON.stringify(payload));
}
