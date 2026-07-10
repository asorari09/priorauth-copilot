import { describe, expect, it } from "vitest";

import {
  CLIENT_UPSTREAM_ERROR_MESSAGE,
  INTERNAL_ERROR_CODES,
  containsUpstreamLeak,
  sanitizeClientError,
  sanitizeDecisionForClient,
  sanitizePriorAuthStateForClient,
  sanitizeReasoningSummary,
} from "../lib/clientErrors";
import type { Decision } from "../lib/schemas";

describe("clientErrors", () => {
  it("detects upstream leak patterns", () => {
    expect(
      containsUpstreamLeak(
        "Decision node failed closed: Claude structured output failed after 1 retry. Last error: Your credit balance is too low; request_id=req_abc123",
      ),
    ).toBe(true);
    expect(
      containsUpstreamLeak(
        "All rules passed. Prescriber gastroenterologist involvement is unverified and requires confirmation.",
      ),
    ).toBe(false);
  });

  it("sanitizes leaked node errors for clients", () => {
    const sanitized = sanitizeClientError(
      "decision node failed: billing hard limit reached; request_id=req_deadbeef",
    );

    expect(sanitized).toEqual({
      message: CLIENT_UPSTREAM_ERROR_MESSAGE,
      code: INTERNAL_ERROR_CODES.UPSTREAM_SERVICE,
    });
  });

  it("preserves non-upstream operational messages", () => {
    const sanitized = sanitizeClientError("rulesCheck node missing extraction");

    expect(sanitized.message).toBe("rulesCheck node missing extraction");
    expect(sanitized.code).toBe(INTERNAL_ERROR_CODES.UPSTREAM_SERVICE);
  });

  it("sanitizes failed-closed reasoning summaries", () => {
    const reasoning = sanitizeReasoningSummary(
      "Decision node failed closed: 429 rate limit exceeded for anthropic api",
    );

    expect(reasoning).toBe(CLIENT_UPSTREAM_ERROR_MESSAGE);
  });

  it("preserves clinical reasoning with unverified policy items", () => {
    const clinicalReasoning =
      "All rules passed. Gastroenterologist involvement is unverified and requires confirmation before approval.";

    expect(sanitizeReasoningSummary(clinicalReasoning)).toBe(clinicalReasoning);
  });

  it("sanitizes graph state before client persistence", () => {
    const decision: Decision = {
      outcome: "insufficient_info",
      confidence: "low",
      reasoningSummary:
        "Decision node failed closed: insufficient_quota; billing details exposed",
      supportingCitations: [],
      rulesResult: {
        eligibleByRules: true,
        failedCriteria: [],
        ruleIdsApplied: ["STEP_THERAPY_001"],
      },
    };

    const sanitized = sanitizePriorAuthStateForClient({
      rawNote: "note",
      error: "policyRag node failed: OpenAI API error status=402",
      decision,
    });

    expect(sanitized.error).toBe(CLIENT_UPSTREAM_ERROR_MESSAGE);
    expect(sanitized.decision?.reasoningSummary).toBe(
      CLIENT_UPSTREAM_ERROR_MESSAGE,
    );
    expect(sanitizeDecisionForClient(decision).reasoningSummary).toBe(
      CLIENT_UPSTREAM_ERROR_MESSAGE,
    );
  });
});
