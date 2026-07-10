import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  canServeCachedPreset,
  getPresetDemoResult,
  isLiveOnlyPreset,
} from "../lib/cache/presetDemo";
import { evalSummaryPassesGate, formatEvalGateFailure } from "../lib/evalGate";

describe("preset demo data", () => {
  it("serves CASE-001 from verified persisted citations", () => {
    const preset = getPresetDemoResult("CASE-001");
    expect(preset).not.toBeNull();
    expect(preset?.sourceCaseId).toBeTruthy();
    expect(preset?.decision.supportingCitations.length).toBeGreaterThan(0);
    for (const citation of preset?.decision.supportingCitations ?? []) {
      expect(citation.payerName).not.toBe("Blue");
      expect(citation.requirementSummary).not.toContain("referenced for this authorization request");
    }
    for (const chunk of preset?.retrievedChunks ?? []) {
      expect(chunk.source_url).not.toContain("example.com");
      expect(chunk.source_url.length).toBeGreaterThan(0);
    }
  });

  it("marks scenarios without stored results as live-only", () => {
    expect(isLiveOnlyPreset("CASE-004")).toBe(true);
    expect(isLiveOnlyPreset("CASE-025")).toBe(true);
    expect(canServeCachedPreset("CASE-004")).toBe(false);
    expect(canServeCachedPreset("CASE-001")).toBe(true);
    expect(getPresetDemoResult("CASE-004")).toBeNull();
  });

  it("live-only manifest matches golden preset ids", () => {
    const liveOnly = JSON.parse(
      readFileSync(join(process.cwd(), "data", "liveOnlyPresets.json"), "utf8"),
    ) as string[];
    expect(liveOnly).toEqual(["CASE-004", "CASE-008", "CASE-017", "CASE-025"]);
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
