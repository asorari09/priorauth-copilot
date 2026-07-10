import type { PriorAuthGraphState } from "./graph/nodes";
import type { Decision } from "./schemas";

export const CLIENT_UPSTREAM_ERROR_MESSAGE =
  "An upstream service error occurred; the case was failed closed.";

export const INTERNAL_ERROR_CODES = {
  UPSTREAM_SERVICE: "ERR_UPSTREAM_SERVICE",
  GRAPH_EXECUTION: "ERR_GRAPH_EXECUTION",
} as const;

export type InternalErrorCode =
  (typeof INTERNAL_ERROR_CODES)[keyof typeof INTERNAL_ERROR_CODES];

export type SanitizedClientError = {
  message: string;
  code: InternalErrorCode;
};

const UPSTREAM_LEAK_PATTERNS: RegExp[] = [
  /billing/i,
  /credit balance/i,
  /insufficient[_\s-]?quota/i,
  /request[_\s-]?id/i,
  /\breq_[a-z0-9]+\b/i,
  /\b(api[_\s-]?key|invalid[_\s-]?api[_\s-]?key)\b/i,
  /\banthropic\b/i,
  /\bopenai\b/i,
  /rate[_\s-]?limit/i,
  /status=\d{3}/i,
  /Claude structured output failed/i,
  /\bnode failed:/i,
  /Decision node failed closed:/i,
  /Last error:/i,
  /match_policy_chunks failed/i,
  /Missing (OPENAI|ANTHROPIC)_API_KEY/i,
];

export function containsUpstreamLeak(text: string): boolean {
  return UPSTREAM_LEAK_PATTERNS.some((pattern) => pattern.test(text));
}

export function sanitizeClientError(
  rawError: string,
  code: InternalErrorCode = INTERNAL_ERROR_CODES.UPSTREAM_SERVICE,
): SanitizedClientError {
  if (!containsUpstreamLeak(rawError)) {
    return { message: rawError, code };
  }

  return {
    message: CLIENT_UPSTREAM_ERROR_MESSAGE,
    code,
  };
}

export function sanitizeReasoningSummary(
  reasoningSummary: string,
): string {
  if (containsUpstreamLeak(reasoningSummary)) {
    return CLIENT_UPSTREAM_ERROR_MESSAGE;
  }
  return reasoningSummary;
}

export function sanitizeDecisionForClient(decision: Decision): Decision {
  return {
    ...decision,
    reasoningSummary: sanitizeReasoningSummary(decision.reasoningSummary),
  };
}

export function sanitizePriorAuthStateForClient(
  state: PriorAuthGraphState,
): PriorAuthGraphState {
  const sanitized: PriorAuthGraphState = { ...state };

  if (typeof sanitized.error === "string" && sanitized.error.length > 0) {
    sanitized.error = sanitizeClientError(sanitized.error).message;
  }

  if (sanitized.decision) {
    sanitized.decision = sanitizeDecisionForClient(sanitized.decision);
  }

  return sanitized;
}

export function classifyGraphExecutionError(error: unknown): {
  rawMessage: string;
  client: SanitizedClientError;
} {
  const rawMessage =
    error instanceof Error
      ? error.message
      : "Unknown processing error during graph execution";

  return {
    rawMessage,
    client: sanitizeClientError(rawMessage, INTERNAL_ERROR_CODES.GRAPH_EXECUTION),
  };
}
