import { z } from "zod";

export const ClinicalExtractionSchema = z.object({
  patientAge: z.number().int().min(0).max(120),
  diagnosisCodes: z.array(z.string().min(1)),
  requestedProcedureCode: z.string().min(1),
  priorTreatmentsTried: z.array(z.string().min(1)),
  treatmentFailureDocumented: z.boolean(),
  clinicalNotesSummary: z.string().min(1),
  requestedUnits: z.number().int().positive().optional(),
  symptomDurationWeeks: z.number().int().nonnegative().optional(),
  imagingFindingsPresent: z.boolean().optional(),
  neurologicDeficitsPresent: z.boolean().optional(),
});

export const PolicyCitationSchema = z.object({
  payerName: z.string().min(1),
  documentTitle: z.string().min(1),
  sourceChunkId: z.string().min(1),
  clauseTextParaphrased: z.string().min(1),
  requirementSummary: z.string().min(1),
});

export const RulesEngineResultSchema = z.object({
  eligibleByRules: z.boolean(),
  failedCriteria: z.array(z.string()),
  ruleIdsApplied: z.array(z.string()),
});

export const DecisionSchema = z.object({
  outcome: z.enum(["likely_approve", "likely_deny", "insufficient_info"]),
  confidence: z.enum(["high", "medium", "low"]),
  reasoningSummary: z.string().min(1),
  supportingCitations: z.array(PolicyCitationSchema),
  rulesResult: RulesEngineResultSchema,
});

export const DecisionCoreSchema = z.object({
  outcome: z.enum(["likely_approve", "likely_deny", "insufficient_info"]),
  confidence: z.enum(["high", "medium", "low"]),
  reasoningSummary: z.string().min(1),
});

export const AppealDraftSchema = z.object({
  draftText: z.string().min(1),
  citedClause: PolicyCitationSchema,
  requiresHumanReview: z.literal(true),
});

export type ClinicalExtraction = z.infer<typeof ClinicalExtractionSchema>;
export type PolicyCitation = z.infer<typeof PolicyCitationSchema>;
export type RulesEngineResult = z.infer<typeof RulesEngineResultSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type DecisionCore = z.infer<typeof DecisionCoreSchema>;
export type AppealDraft = z.infer<typeof AppealDraftSchema>;
