/**
 * Rebuild data/presetDemoResults.json from persisted Supabase case rows.
 * Zero LLM calls — uses real citations/decision/appeal_draft jsonb only.
 *
 * Usage: tsx scripts/rebuildPresetDemoResults.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { supabaseAdmin } from "../lib/supabase";
import type { AppealDraft, Decision } from "../lib/schemas";

const PRESET_CASE_IDS = ["CASE-001", "CASE-004", "CASE-008", "CASE-017", "CASE-025"] as const;
const FALLBACK_EVAL = "evals/results/2026-07-09T18-40-22-006Z.json";

type GoldenCase = { id: string; note: string; expectedOutcome: string };
type PresetDemoResult = {
  presetCaseId: string;
  sourceCaseId: string;
  decision: Decision;
  appealDraft?: AppealDraft;
  retrievedChunks: Array<{ chunk_id: string; source_url: string }>;
};

type EvalCase = {
  id: string;
  retrievedChunkIds: string[];
};

type CaseRow = {
  id: string;
  raw_note: string;
  citations: Decision["supportingCitations"] | null;
  decision: Decision | null;
  appeal_draft: AppealDraft | null;
};

async function loadGoldenCases(): Promise<GoldenCase[]> {
  const raw = readFileSync(join(process.cwd(), "data", "goldenCases.json"), "utf8");
  return JSON.parse(raw) as GoldenCase[];
}

function loadEvalChunkIds(): Map<string, string[]> {
  const raw = readFileSync(join(process.cwd(), FALLBACK_EVAL), "utf8");
  const data = JSON.parse(raw) as { perCase: EvalCase[] };
  return new Map(data.perCase.map((item) => [item.id, item.retrievedChunkIds]));
}

function citationsLookVerified(citations: Decision["supportingCitations"]): boolean {
  if (!citations.length) return false;
  return citations.every(
    (citation) =>
      citation.payerName !== "Blue" &&
      citation.payerName !== "Caresource" &&
      !citation.requirementSummary.includes("referenced for this authorization request") &&
      !citation.requirementSummary.includes("Supporting coverage criterion from retrieved"),
  );
}

async function findPersistedCase(
  golden: GoldenCase,
): Promise<CaseRow | null> {
  const { data, error } = await supabaseAdmin
    .from("cases")
    .select("id, raw_note, citations, decision, appeal_draft")
    .eq("status", "done")
    .ilike("raw_note", `${golden.note.slice(0, 72)}%`)
    .not("citations", "is", null)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Supabase query failed for ${golden.id}: ${error.message}`);
  }

  const rows = (data ?? []) as CaseRow[];
  const withCitations = rows.filter(
    (row) =>
      Array.isArray(row.citations) &&
      row.citations.length > 0 &&
      row.decision &&
      citationsLookVerified(row.citations),
  );

  const outcomeMatch = withCitations.find(
    (row) => row.decision?.outcome === golden.expectedOutcome,
  );
  return outcomeMatch ?? withCitations[0] ?? null;
}

async function loadChunkUrls(chunkIds: string[]): Promise<Map<string, string>> {
  if (chunkIds.length === 0) return new Map();

  const { data, error } = await supabaseAdmin
    .from("policy_chunks")
    .select("chunk_id, source_url")
    .in("chunk_id", chunkIds);

  if (error) {
    throw new Error(`policy_chunks lookup failed: ${error.message}`);
  }

  return new Map(
    (data ?? []).map((row) => [row.chunk_id as string, row.source_url as string]),
  );
}

function assertRealCitations(citations: Decision["supportingCitations"], presetId: string) {
  if (!citationsLookVerified(citations)) {
    throw new Error(`${presetId}: citations failed verification checks`);
  }
}

async function buildPreset(
  golden: GoldenCase,
  evalChunkIds: Map<string, string[]>,
): Promise<PresetDemoResult | null> {
  const row = await findPersistedCase(golden);
  if (!row?.decision || !row.citations?.length) {
    console.warn(`[${golden.id}] No persisted case with real citations — live-only`);
    return null;
  }

  const decision = row.decision;
  const supportingCitations = row.citations;
  assertRealCitations(supportingCitations, golden.id);

  const chunkIdSet = new Set<string>([
    ...evalChunkIds.get(golden.id) ?? [],
    ...supportingCitations.map((c) => c.sourceChunkId),
  ]);
  const urlByChunk = await loadChunkUrls([...chunkIdSet]);

  const retrievedChunks = [...chunkIdSet].map((chunk_id) => ({
    chunk_id,
    source_url: urlByChunk.get(chunk_id) ?? "",
  }));

  if (retrievedChunks.some((chunk) => !chunk.source_url || chunk.source_url.includes("example.com"))) {
    throw new Error(`${golden.id}: missing real source_url for one or more chunks`);
  }

  const preset: PresetDemoResult = {
    presetCaseId: golden.id,
    sourceCaseId: row.id,
    decision: {
      ...decision,
      supportingCitations,
    },
    retrievedChunks,
  };

  if (row.appeal_draft) {
    preset.appealDraft = row.appeal_draft;
  }

  return preset;
}

async function main() {
  const goldenCases = await loadGoldenCases();
  const evalChunkIds = loadEvalChunkIds();
  const presets: PresetDemoResult[] = [];
  const liveOnly: string[] = [];

  for (const presetId of PRESET_CASE_IDS) {
    const golden = goldenCases.find((item) => item.id === presetId);
    if (!golden) {
      throw new Error(`Missing golden case ${presetId}`);
    }
    const preset = await buildPreset(golden, evalChunkIds);
    if (preset) {
      presets.push(preset);
      console.log(`[${presetId}] cached from case ${preset.sourceCaseId}`);
    } else {
      liveOnly.push(presetId);
    }
  }

  const presetPath = join(process.cwd(), "data", "presetDemoResults.json");
  const liveOnlyPath = join(process.cwd(), "data", "liveOnlyPresets.json");

  writeFileSync(presetPath, `${JSON.stringify(presets, null, 2)}\n`, "utf8");
  writeFileSync(liveOnlyPath, `${JSON.stringify(liveOnly, null, 2)}\n`, "utf8");

  console.log(`Wrote ${presets.length} cached presets to ${presetPath}`);
  console.log(`Wrote ${liveOnly.length} live-only presets to ${liveOnlyPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
