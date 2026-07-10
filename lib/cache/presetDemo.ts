import presetDemoResults from "../../data/presetDemoResults.json";
import liveOnlyPresets from "../../data/liveOnlyPresets.json";
import type { AppealDraft, Decision } from "../schemas";

export type PresetDemoResult = {
  presetCaseId: string;
  sourceCaseId?: string;
  decision: Decision;
  appealDraft?: AppealDraft;
  retrievedChunks: Array<{ chunk_id: string; source_url: string }>;
};

const PRESET_BY_ID = new Map(
  (presetDemoResults as PresetDemoResult[]).map((entry) => [entry.presetCaseId, entry]),
);

const LIVE_ONLY_SET = new Set(liveOnlyPresets as string[]);

export const PRESET_CASE_IDS = ["CASE-001", "CASE-004", "CASE-008", "CASE-017", "CASE-025"] as const;

export const CACHED_PRESET_CASE_IDS = Array.from(PRESET_BY_ID.keys());

export function getPresetDemoResult(presetCaseId: string): PresetDemoResult | null {
  return PRESET_BY_ID.get(presetCaseId) ?? null;
}

export function isLiveOnlyPreset(presetCaseId: string): boolean {
  return LIVE_ONLY_SET.has(presetCaseId);
}

export function isPresetCaseId(presetCaseId: string): boolean {
  return (PRESET_CASE_IDS as readonly string[]).includes(presetCaseId);
}

export function canServeCachedPreset(presetCaseId: string): boolean {
  return !isLiveOnlyPreset(presetCaseId) && PRESET_BY_ID.has(presetCaseId);
}
