import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CACHED_PRESET_CASE_IDS,
  canServeCachedPreset,
  getPresetDemoResult,
  isLiveOnlyPreset,
} from "../lib/cache/presetDemo";
import { evalSummaryPassesGate, formatEvalGateFailure } from "../lib/evalGate";

const EXPECTED_PRESETS = ["CASE-001", "CASE-004", "CASE-008", "CASE-017", "CASE-025"];

describe("preset demo data", () => {
  it("serves all five presets from verified persisted citations", () => {
    expect(CACHED_PRESET_CASE_IDS.sort()).toEqual(EXPECTED_PRESETS.sort());
    for (const presetId of EXPECTED_PRESETS) {
      const preset = getPresetDemoResult(presetId);
      expect(preset).not.toBeNull();
      expect(preset?.sourceCaseId).toBeTruthy();
      expect(preset?.decision.supportingCitations.length).toBeGreaterThan(0);
      for (const citation of preset?.decision.supportingCitations ?? []) {
        expect(citation.payerName).not.toBe("Blue");
        expect(citation.requirementSummary).not.toContain(
          "referenced for this authorization request",
        );
      }
      for (const chunk of preset?.retrievedChunks ?? []) {
        expect(chunk.source_url).not.toContain("example.com");
        expect(chunk.source_url.length).toBeGreaterThan(0);
      }
    }
  });

  it("CASE-004 preset includes a real appeal draft", () => {
    const preset = getPresetDemoResult("CASE-004");
    expect(preset?.appealDraft?.draftText.length).toBeGreaterThan(100);
    expect(preset?.appealDraft?.requiresHumanReview).toBe(true);
    expect(preset?.appealDraft?.citedClause.sourceChunkId).toBeTruthy();
  });

  it("has no live-only presets after rebuild", () => {
    for (const presetId of EXPECTED_PRESETS) {
      expect(isLiveOnlyPreset(presetId)).toBe(false);
      expect(canServeCachedPreset(presetId)).toBe(true);
    }
    const liveOnly = JSON.parse(
      readFileSync(join(process.cwd(), "data", "liveOnlyPresets.json"), "utf8"),
    ) as string[];
    expect(liveOnly).toEqual([]);
  });
});

describe("eval regression gate", () => {
  it("passes only at 100/0/100", () => {
    expect(
      evalSummaryPassesGate({
        decisionAccuracy: 100,
        falseApproveRate: 0,
        citationValidityRate: 100,
      }),
    ).toBe(true);
  });

  it("fails on any metric miss", () => {
    const summary = {
      decisionAccuracy: 96.15,
      falseApproveRate: 0,
      citationValidityRate: 0,
    };
    expect(evalSummaryPassesGate(summary)).toBe(false);
    expect(formatEvalGateFailure(summary)).toContain("decisionAccuracy=96.15");
    expect(formatEvalGateFailure(summary)).toContain("citationValidityRate=0");
  });
});
