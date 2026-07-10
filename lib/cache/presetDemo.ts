import presetDemoResults from "../../data/presetDemoResults.json";
import type { AppealDraft, Decision } from "../schemas";

export type PresetDemoResult = {
  presetCaseId: string;
  decision: Decision;
  appealDraft?: AppealDraft;
  retrievedChunks: Array<{ chunk_id: string; source_url: string }>;
};

const PRESET_BY_ID = new Map(
  (presetDemoResults as PresetDemoResult[]).map((entry) => [entry.presetCaseId, entry]),
);

export const PRESET_CASE_IDS = Array.from(PRESET_BY_ID.keys());

export function getPresetDemoResult(presetCaseId: string): PresetDemoResult | null {
  return PRESET_BY_ID.get(presetCaseId) ?? null;
}

export function isPresetCaseId(presetCaseId: string): boolean {
  return PRESET_BY_ID.has(presetCaseId);
}
