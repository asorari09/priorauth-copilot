import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  isRetryableClaudeApiError,
  isSuccessfulResponseParseFailure,
  shouldRetryClaudeStructuredCall,
} from "../lib/llm/claude";

describe("claude retry policy", () => {
  it("retries retryable API errors once", () => {
    const error = { status: 429, message: "rate limited" };
    expect(isRetryableClaudeApiError(error)).toBe(true);
    expect(shouldRetryClaudeStructuredCall(error, 1)).toBe(true);
    expect(shouldRetryClaudeStructuredCall(error, 2)).toBe(false);
  });

  it("does not retry non-retryable 4xx API errors", () => {
    const error = {
      status: 400,
      message:
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}',
    };
    expect(isRetryableClaudeApiError(error)).toBe(false);
    expect(shouldRetryClaudeStructuredCall(error, 1)).toBe(false);
  });

  it("retries schema parse failures on an otherwise successful response", () => {
    const error = z.object({ ok: z.literal(true) }).safeParse({ ok: false }).error;
    expect(isSuccessfulResponseParseFailure(error)).toBe(true);
    expect(shouldRetryClaudeStructuredCall(error, 1)).toBe(true);
    expect(shouldRetryClaudeStructuredCall(error, 2)).toBe(false);
  });

  it("retries missing tool_use blocks once", () => {
    const error = new Error(
      "Claude did not return the required tool_use block (stop_reason=end_turn).",
    );
    expect(isSuccessfulResponseParseFailure(error)).toBe(true);
    expect(shouldRetryClaudeStructuredCall(error, 1)).toBe(true);
  });
});
