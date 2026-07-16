import OpenAI from "openai";
import { z } from "zod";

import {
  safeCaptureLangfuseErrorContext,
  safeStartSpan,
} from "../langfuse";
import {
  buildAppealDraftCacheKey,
  buildCitationSynthesisCacheKey,
} from "../cache/cacheKeys";
import {
  getCachedAppealDraft,
  getCachedCitations,
  setCachedAppealDraft,
  setCachedCitations,
} from "../cache/inferenceCache";
import { callClaudeStructured, resolveClaudeModel } from "../llm/claude";
import { extractClinicalExtractionFromNote } from "../llm/openai";
import { runRulesEngine } from "../rulesEngine";
import {
  AppealDraftSchema,
  PolicyCitationSchema,
  type AppealDraft,
  type ClinicalExtraction,
  type Decision,
  type PolicyCitation,
  type RulesEngineResult,
} from "../schemas";
import { supabaseAdmin } from "../supabase";
import {
  CHUNK_CONTENT_MAX_TOKENS,
  selectTopRetrievedChunks,
  truncateApproxTokens,
} from "./citationPayload";
import {
  generateTemplateReasoningSummary,
  getReasoningMode,
} from "./templateReasoning";
import { determineOutcomeConstraint } from "./outcomeConstraint";

export type RetrievedChunk = {
  chunk_id: string;
  payer_name: string;
  document_title: string;
  source_url: string;
  content: string;
  similarity: number;
};

export type PriorAuthGraphState = {
  rawNote: string;
  traceId?: string;
  caseId?: string;
  forceNoRetrieval?: boolean;
  disableInferenceCache?: boolean;
  extraction?: ClinicalExtraction;
  rulesResult?: RulesEngineResult;
  citations?: PolicyCitation[];
  retrievedChunks?: RetrievedChunk[];
  decision?: Decision;
  appealDraft?: AppealDraft;
  overrideLog?: string[];
  error?: string;
};

const EMBEDDING_MODEL = "text-embedding-3-small";
const RETRIEVAL_MATCH_COUNT = 5;

const CITATION_SYNTHESIS_SYSTEM_PROMPT =
  "You produce policy citations strictly from supplied retrieval chunks. Never cite outside chunks.";

const DECISION_REASONING_SYSTEM_PROMPT =
  "Provide concise clinical coverage reasoning based only on provided rules and citations. Never presume an unverified policy requirement is satisfied. If citations mention requirements that cannot be confirmed from the extraction (e.g., prescriber specialty), list them explicitly as unverified items requiring confirmation — do not assume compliance.";

const APPEAL_DRAFT_SYSTEM_PROMPT =
  "Draft concise prior-authorization appeals grounded only in provided citations.";

function toCitationSummaries(citations: PolicyCitation[]): Array<{
  payerName: string;
  requirementSummary: string;
}> {
  return citations.map((citation) => ({
    payerName: citation.payerName,
    requirementSummary: citation.requirementSummary,
  }));
}

const DecisionReasoningOnlySchema = z.object({
  confidence: z.enum(["high", "medium", "low"]),
  reasoningSummary: z.string().min(1),
});

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }
  return new OpenAI({ apiKey });
}

function buildPolicyQuery(extraction: ClinicalExtraction): string {
  const base = [
    `Procedure code ${extraction.requestedProcedureCode}`,
    `Diagnosis codes ${extraction.diagnosisCodes.join(", ")}`,
    `Prior treatments ${extraction.priorTreatmentsTried.join(", ")}`,
  ];

  const procedureTerms: Record<string, string[]> = {
    J1745: [
      "infliximab intravenous products",
      "step therapy",
      "documented treatment failure",
      "quantity limits",
    ],
    "27447": [
      "total knee arthroplasty",
      "conservative care",
      "physical therapy",
      "NSAID",
      "12 weeks",
    ],
    "70553": [
      "brain MRI with and without contrast",
      "neurologic deficits",
      "red flag diagnosis",
      "prior imaging findings",
    ],
  };

  const criteriaTerms = procedureTerms[extraction.requestedProcedureCode] ?? [
    "medical necessity criteria",
  ];
  return `${base.join(" | ")} | ${criteriaTerms.join(" | ")}`;
}

async function withNodeSpan(
  state: PriorAuthGraphState,
  nodeName: string,
  input: unknown,
  run: (spanId: string | null) => Promise<Partial<PriorAuthGraphState>>,
): Promise<Partial<PriorAuthGraphState>> {
  const span = safeStartSpan({
    traceId: state.traceId ?? null,
    name: `node.${nodeName}`,
    input,
    metadata: { caseId: state.caseId ?? null },
  });

  try {
    const output = await run(span.id);
    span.end({ output });
    return output;
  } catch (error) {
    span.end({
      level: "ERROR",
      statusMessage: `${nodeName} failed`,
      metadata: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    safeCaptureLangfuseErrorContext({
      traceId: state.traceId,
      location: `node.${nodeName}`,
      error,
    });
    throw error;
  }
}

export async function extractNode(
  state: PriorAuthGraphState,
): Promise<Partial<PriorAuthGraphState>> {
  return withNodeSpan(state, "extract", { rawNote: state.rawNote }, async (spanId) => {
    try {
      const extraction = await extractClinicalExtractionFromNote(state.rawNote, undefined, {
        traceId: state.traceId ?? null,
        parentObservationId: spanId,
      });
      return { extraction };
    } catch (error) {
      return {
        error: `extract node failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}

export async function rulesCheckNode(
  state: PriorAuthGraphState,
): Promise<Partial<PriorAuthGraphState>> {
  return withNodeSpan(
    state,
    "rulesCheck",
    { extraction: state.extraction ?? null },
    async () => {
      if (!state.extraction) {
        return { error: "rulesCheck node missing extraction" };
      }
      const rulesResult = runRulesEngine(state.extraction);
      return { rulesResult };
    },
  );
}

async function retrievePolicyChunks(
  extraction: ClinicalExtraction,
): Promise<RetrievedChunk[]> {
  const openai = getOpenAIClient();
  const query = buildPolicyQuery(extraction);
  const embedding = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: query,
  });
  const queryVector = embedding.data[0].embedding;

  const { data, error } = await supabaseAdmin.rpc("match_policy_chunks", {
    query_embedding: queryVector,
    match_count: RETRIEVAL_MATCH_COUNT,
  });
  if (error) {
    throw new Error(`match_policy_chunks failed: ${error.message}`);
  }

  return (data ?? []) as RetrievedChunk[];
}

async function synthesizeCitationsWithValidation(
  extraction: ClinicalExtraction,
  retrievedChunks: RetrievedChunk[],
  options?: {
    disableCache?: boolean;
    telemetry?: { traceId?: string | null; parentObservationId?: string | null };
  },
): Promise<PolicyCitation[]> {
  const synthesisChunks = selectTopRetrievedChunks(retrievedChunks);
  const allowedIds = new Set(synthesisChunks.map((chunk) => chunk.chunk_id));

  if (!options?.disableCache) {
    const cacheKey = buildCitationSynthesisCacheKey(
      extraction.requestedProcedureCode,
      retrievedChunks.map((chunk) => chunk.chunk_id),
    );
    const cached = await getCachedCitations(cacheKey);
    if (cached) {
      return cached.filter((citation) => allowedIds.has(citation.sourceChunkId));
    }
  }

  const CitationToolSchema = z.object({
    citations: z.array(PolicyCitationSchema),
  });
  const retrievedPayload = synthesisChunks.map((chunk) => ({
    chunk_id: chunk.chunk_id,
    payer_name: chunk.payer_name,
    document_title: chunk.document_title,
    source_url: chunk.source_url,
    content: truncateApproxTokens(chunk.content, CHUNK_CONTENT_MAX_TOKENS),
    similarity: chunk.similarity,
  }));

  let citations: PolicyCitation[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await callClaudeStructured({
      toolName: "emit_policy_citations",
      toolDescription: "Emit policy citation objects from provided chunk text only.",
      schema: CitationToolSchema,
      systemPrompt: CITATION_SYNTHESIS_SYSTEM_PROMPT,
      model: resolveClaudeModel("fast"),
      userPrompt: [
        "Clinical extraction JSON:",
        JSON.stringify(extraction),
        "",
        "Retrieved chunks JSON (only valid evidence):",
        JSON.stringify(retrievedPayload),
        "",
        `Allowed sourceChunkId values: ${JSON.stringify(Array.from(allowedIds))}`,
        "Emit at most 3 citations and choose the most relevant supporting evidence.",
        "Return only citations supported by these chunks. If none are supportable, return [].",
        attempt === 2
          ? "Retry correction: any sourceChunkId not in allowed list is invalid."
          : "",
      ].join("\n"),
      maxTokens: 3000,
      telemetry: {
        traceId: options?.telemetry?.traceId ?? null,
        parentObservationId: options?.telemetry?.parentObservationId ?? null,
        generationName: "claude.citation_synthesis",
      },
    });

    const invalid = response.citations.filter((c) => !allowedIds.has(c.sourceChunkId));
    if (invalid.length === 0) {
      citations = response.citations;
      break;
    }

    citations = response.citations.filter((c) => allowedIds.has(c.sourceChunkId));
  }

  if (!options?.disableCache && citations.length > 0) {
    const cacheKey = buildCitationSynthesisCacheKey(
      extraction.requestedProcedureCode,
      retrievedChunks.map((chunk) => chunk.chunk_id),
    );
    await setCachedCitations(cacheKey, citations);
  }

  return citations;
}

export async function policyRagNode(
  state: PriorAuthGraphState,
): Promise<Partial<PriorAuthGraphState>> {
  return withNodeSpan(
    state,
    "policyRag",
    { extraction: state.extraction ?? null },
    async (spanId) => {
      if (!state.extraction) {
        return { error: "policyRag node missing extraction", citations: [] };
      }

      try {
        if (state.forceNoRetrieval) {
          return { citations: [], retrievedChunks: [] };
        }
        const retrievedChunks = await retrievePolicyChunks(state.extraction);
        if (retrievedChunks.length === 0) {
          return { citations: [], retrievedChunks };
        }

        const citations = await synthesizeCitationsWithValidation(
          state.extraction,
          retrievedChunks,
          {
            disableCache: state.disableInferenceCache,
            telemetry: { traceId: state.traceId ?? null, parentObservationId: spanId },
          },
        );

        return { citations, retrievedChunks };
      } catch (error) {
        return {
          citations: [],
          error: `policyRag node failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  );
}

async function generateReasoningForForcedOutcome(
  extraction: ClinicalExtraction,
  rulesResult: RulesEngineResult,
  citations: PolicyCitation[],
  forcedOutcome: Decision["outcome"],
  reason: string,
  telemetry?: { traceId?: string | null; parentObservationId?: string | null },
): Promise<z.infer<typeof DecisionReasoningOnlySchema>> {
  return callClaudeStructured({
    toolName: "emit_forced_decision_reasoning",
    toolDescription:
      "Emit decision confidence and reasoning summary while outcome is fixed by deterministic guardrails.",
    schema: DecisionReasoningOnlySchema,
    systemPrompt: DECISION_REASONING_SYSTEM_PROMPT,
    model: resolveClaudeModel("reasoning"),
    userPrompt: [
      `Outcome is fixed by code as: ${forcedOutcome}`,
      `Constraint reason: ${reason}`,
      `Extraction: ${JSON.stringify(extraction)}`,
      `Rules result: ${JSON.stringify(rulesResult)}`,
      `Validated citation summaries: ${JSON.stringify(toCitationSummaries(citations))}`,
      "Never presume an unverified policy requirement is satisfied. If citations mention requirements that cannot be confirmed from extraction, list them as unverified items requiring confirmation.",
      "Generate confidence and reasoningSummary aligned with the forced outcome.",
    ].join("\n"),
    maxTokens: 700,
    telemetry: {
      traceId: telemetry?.traceId ?? null,
      parentObservationId: telemetry?.parentObservationId ?? null,
      generationName: "claude.decision_reasoning",
    },
  });
}

export async function decisionNode(
  state: PriorAuthGraphState,
): Promise<Partial<PriorAuthGraphState>> {
  return withNodeSpan(
    state,
    "decide",
    {
      extraction: state.extraction ?? null,
      rulesResult: state.rulesResult ?? null,
      citationsCount: (state.citations ?? []).length,
    },
    async (spanId) => {
      const extraction = state.extraction;
      const rulesResult = state.rulesResult;
      const citations = state.citations ?? [];
      const overrideLog = [...(state.overrideLog ?? [])];

      if (!extraction || !rulesResult) {
        return {
          decision: {
            outcome: "insufficient_info",
            confidence: "low",
            reasoningSummary: "Decision node missing extraction or rules result.",
            supportingCitations: [],
            rulesResult:
              rulesResult ??
              ({
                eligibleByRules: false,
                failedCriteria: ["MISSING_RULES_RESULT"],
                ruleIdsApplied: [],
              } as RulesEngineResult),
          },
          overrideLog,
        };
      }

      const constraint = determineOutcomeConstraint(extraction, rulesResult, citations);

      try {
        const reasoning =
          getReasoningMode() === "template"
            ? generateTemplateReasoningSummary({
                extraction,
                rulesResult,
                citations,
                forcedOutcome: constraint.forcedOutcome,
                constraintReason: constraint.reason,
              })
            : await generateReasoningForForcedOutcome(
                extraction,
                rulesResult,
                citations,
                constraint.forcedOutcome,
                constraint.reason,
                { traceId: state.traceId ?? null, parentObservationId: spanId },
              );

        const decision: Decision = {
          outcome: constraint.forcedOutcome,
          confidence: reasoning.confidence,
          reasoningSummary: reasoning.reasoningSummary,
          supportingCitations: citations,
          rulesResult,
        };

        return { decision, overrideLog };
      } catch (error) {
        return {
          decision: {
            outcome: "insufficient_info",
            confidence: "low",
            reasoningSummary: `Decision node failed closed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            supportingCitations: [],
            rulesResult,
          },
          overrideLog,
          error: `decision node failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  );
}

export async function appealDraftNode(
  state: PriorAuthGraphState,
): Promise<Partial<PriorAuthGraphState>> {
  return withNodeSpan(
    state,
    "draftAppeal",
    { decision: state.decision ?? null, extraction: state.extraction ?? null },
    async (spanId) => {
      if (!state.decision || state.decision.outcome !== "likely_deny") {
        return {};
      }

      const fallbackCitation =
        state.decision.supportingCitations[0] ??
        ({
          payerName: "Unknown payer",
          documentTitle: "No citation available",
          sourceChunkId: "none",
          clauseTextParaphrased: "No validated citation available.",
          requirementSummary: "Manual review required due to missing citation evidence.",
        } satisfies PolicyCitation);

      try {
        const extraction = state.extraction;
        if (!extraction) {
          return {};
        }

        const cacheKey = buildAppealDraftCacheKey({
          procedureCode: extraction.requestedProcedureCode,
          diagnosisCodes: extraction.diagnosisCodes,
          outcome: state.decision.outcome,
          failedCriteria: state.decision.rulesResult.failedCriteria,
          citationChunkIds: state.decision.supportingCitations.map(
            (citation) => citation.sourceChunkId,
          ),
        });

        if (!state.disableInferenceCache) {
          const cachedDraft = await getCachedAppealDraft(cacheKey);
          if (cachedDraft) {
            return { appealDraft: cachedDraft };
          }
        }

        const draft = await callClaudeStructured({
          toolName: "emit_appeal_draft",
          toolDescription:
            "Emit an appeal draft object using the provided decision context and citations.",
          schema: AppealDraftSchema,
          systemPrompt: APPEAL_DRAFT_SYSTEM_PROMPT,
          model: resolveClaudeModel("fast"),
          userPrompt: [
            `Decision: ${JSON.stringify(state.decision)}`,
            `Extraction: ${JSON.stringify(extraction)}`,
            "Use one of the provided citations as citedClause.",
          ].join("\n"),
          maxTokens: 1200,
          telemetry: {
            traceId: state.traceId ?? null,
            parentObservationId: spanId,
            generationName: "claude.appeal_draft",
          },
        });

        if (!state.disableInferenceCache) {
          await setCachedAppealDraft(cacheKey, draft);
        }

        return { appealDraft: draft };
      } catch (error) {
        const fallback: AppealDraft = {
          draftText:
            "Appeal draft unavailable due to model failure. Human review required before submission.",
          citedClause: fallbackCitation,
          requiresHumanReview: true,
        };
        return {
          appealDraft: fallback,
          error: `appealDraft node failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  );
}

export function routeOnDecision(
  state: PriorAuthGraphState,
): "draftAppeal" | "__end__" {
  return state.decision?.outcome === "likely_deny" ? "draftAppeal" : "__end__";
}
