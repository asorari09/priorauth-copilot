import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

import { safeStartGeneration } from "../langfuse";
import { ClinicalExtractionSchema, type ClinicalExtraction } from "../schemas";

const DEFAULT_EXTRACTION_MODEL = "gpt-4o-mini";

const ClinicalExtractionWireSchema = z.object({
  patientAge: z.number().int().min(0).max(120),
  diagnosisCodes: z.array(z.string().min(1)),
  requestedProcedureCode: z.string().min(1),
  priorTreatmentsTried: z.array(z.string().min(1)),
  treatmentFailureDocumented: z.boolean(),
  clinicalNotesSummary: z.string().min(1),
  requestedUnits: z.number().int().positive().nullable(),
  symptomDurationWeeks: z.number().int().nonnegative().nullable(),
  imagingFindingsPresent: z.boolean().nullable(),
  neurologicDeficitsPresent: z.boolean().nullable(),
});

export type ExtractionErrorCode =
  | "parse_failure"
  | "api_error"
  | "configuration_error";

export class ExtractionError extends Error {
  public readonly code: ExtractionErrorCode;

  public readonly cause?: unknown;

  constructor(code: ExtractionErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "ExtractionError";
    this.code = code;
    this.cause = cause;
  }
}

const EXTRACTION_INSTRUCTIONS = `Extract structured clinical facts from the note.

Normalization rules:
- Normalize every value in priorTreatmentsTried to lowercase canonical forms.
- Use "physical therapy" (never "PT", "physiotherapy", or similar abbreviations).
- Use "nsaid" for any NSAID mention (never "NSAIDs", ibuprofen, naproxen, etc.).
- Keep other treatment names concise and lowercase.

Data completeness rules:
- Use only information explicitly present in the note.
- Never guess, infer, or default missing facts.
- For optional fields (requestedUnits, symptomDurationWeeks, imagingFindingsPresent, neurologicDeficitsPresent), set the field to null if the note does not explicitly state it.
- Preserve diagnosis and procedure codes exactly as written when present.`;

function createClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ExtractionError("configuration_error", "Missing OPENAI_API_KEY");
  }

  return new OpenAI({ apiKey });
}

function isLikelyParseFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("parse") ||
    message.includes("schema") ||
    message.includes("invalid json") ||
    message.includes("json")
  );
}

export async function extractClinicalExtractionFromNote(
  note: string,
  model = DEFAULT_EXTRACTION_MODEL,
  telemetry?: {
    traceId?: string | null;
    parentObservationId?: string | null;
  },
): Promise<ClinicalExtraction> {
  const client = createClient();
  let lastParseError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const generation = safeStartGeneration({
      traceId: telemetry?.traceId ?? null,
      parentObservationId: telemetry?.parentObservationId ?? null,
      name: "openai.extract",
      model,
      input: {
        attempt,
        messages: [
          { role: "system", content: EXTRACTION_INSTRUCTIONS },
          { role: "user", content: note },
        ],
      },
      metadata: {
        provider: "openai",
        operation: "clinical_extraction",
      },
    });

    try {
      const completion = await client.chat.completions.parse({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: EXTRACTION_INSTRUCTIONS,
          },
          {
            role: "user",
            content: note,
          },
        ],
        response_format: zodResponseFormat(
          ClinicalExtractionWireSchema,
          "clinical_extraction",
        ),
      });

      const parsed = completion.choices[0]?.message?.parsed as
        | z.infer<typeof ClinicalExtractionWireSchema>
        | null
        | undefined;
      if (!parsed) {
        throw new Error("Missing parsed extraction in response.");
      }

      const normalized = ClinicalExtractionSchema.parse({
        patientAge: parsed.patientAge,
        diagnosisCodes: parsed.diagnosisCodes,
        requestedProcedureCode: parsed.requestedProcedureCode,
        priorTreatmentsTried: parsed.priorTreatmentsTried,
        treatmentFailureDocumented: parsed.treatmentFailureDocumented,
        clinicalNotesSummary: parsed.clinicalNotesSummary,
        ...(parsed.requestedUnits === null ? {} : { requestedUnits: parsed.requestedUnits }),
        ...(parsed.symptomDurationWeeks === null
          ? {}
          : { symptomDurationWeeks: parsed.symptomDurationWeeks }),
        ...(parsed.imagingFindingsPresent === null
          ? {}
          : { imagingFindingsPresent: parsed.imagingFindingsPresent }),
        ...(parsed.neurologicDeficitsPresent === null
          ? {}
          : { neurologicDeficitsPresent: parsed.neurologicDeficitsPresent }),
      });

      generation.end({
        output: normalized,
        usage: completion.usage ?? undefined,
      });

      return normalized;
    } catch (error) {
      generation.end({
        level: "ERROR",
        statusMessage: `extract attempt ${attempt} failed`,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      if (isLikelyParseFailure(error)) {
        lastParseError = error;
        if (attempt < 2) {
          continue;
        }
        break;
      }

      throw new ExtractionError(
        "api_error",
        `OpenAI extraction request failed on attempt ${attempt}.`,
        error,
      );
    }
  }

  throw new ExtractionError(
    "parse_failure",
    "OpenAI extraction parse failed after 1 retry.",
    lastParseError,
  );
}
