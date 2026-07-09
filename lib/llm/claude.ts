import Anthropic from "@anthropic-ai/sdk";
import { z, type ZodTypeAny } from "zod";

import { safeStartGeneration } from "../langfuse";

const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

export class ClaudeStructuredOutputError extends Error {
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ClaudeStructuredOutputError";
    this.cause = cause;
  }
}

type ClaudeStructuredCallArgs<TSchema extends ZodTypeAny> = {
  systemPrompt: string;
  userPrompt: string;
  schema: TSchema;
  toolName: string;
  toolDescription: string;
  maxTokens?: number;
  model?: string;
  telemetry?: {
    traceId?: string | null;
    parentObservationId?: string | null;
    generationName?: string;
  };
};

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClaudeStructuredOutputError("Missing ANTHROPIC_API_KEY");
  }
  return new Anthropic({ apiKey });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeStatus = (error as { status?: number }).status;
  if (maybeStatus === 429) {
    return true;
  }
  if (typeof maybeStatus === "number" && maybeStatus >= 500) {
    return true;
  }

  const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
  return message.includes("timeout") || message.includes("temporar");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const status = typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;
    const stopReason = (error as { stop_reason?: unknown }).stop_reason;
    const details: string[] = [error.message];
    if (status !== undefined) {
      details.push(`status=${status}`);
    }
    if (typeof stopReason === "string" && stopReason.length > 0) {
      details.push(`stop_reason=${stopReason}`);
    }
    return details.join("; ");
  }
  return String(error);
}

export async function callClaudeStructured<TSchema extends ZodTypeAny>(
  args: ClaudeStructuredCallArgs<TSchema>,
): Promise<z.infer<TSchema>> {
  const client = getClient();
  const model = args.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_CLAUDE_MODEL;
  const schemaJson = z.toJSONSchema(args.schema);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const generation = safeStartGeneration({
      traceId: args.telemetry?.traceId ?? null,
      parentObservationId: args.telemetry?.parentObservationId ?? null,
      name: args.telemetry?.generationName ?? `claude.${args.toolName}`,
      model,
      input: {
        attempt,
        systemPrompt: args.systemPrompt,
        userPrompt: args.userPrompt,
        toolName: args.toolName,
        toolDescription: args.toolDescription,
      },
      metadata: {
        provider: "anthropic",
        toolName: args.toolName,
      },
    });

    try {
      const response = await client.messages.create({
        model,
        max_tokens: args.maxTokens ?? 1200,
        temperature: 0,
        system: args.systemPrompt,
        messages: [{ role: "user", content: args.userPrompt }],
        tools: [
          {
            name: args.toolName,
            description: args.toolDescription,
            input_schema: schemaJson as Anthropic.Messages.Tool.InputSchema,
          },
        ],
        tool_choice: {
          type: "tool",
          name: args.toolName,
        },
      });

      const toolBlock = response.content.find(
        (block) => block.type === "tool_use" && block.name === args.toolName,
      );
      if (!toolBlock || toolBlock.type !== "tool_use") {
        const stopReason = "stop_reason" in response ? response.stop_reason : undefined;
        throw new Error(
          `Claude did not return the required tool_use block (stop_reason=${String(stopReason ?? "unknown")}).`,
        );
      }

      const parsed = args.schema.parse(toolBlock.input);
      generation.end({
        output: parsed,
        usage: response.usage ?? undefined,
      });
      return parsed;
    } catch (error) {
      const retryable = isRetryable(error);
      generation.end({
        level: "ERROR",
        statusMessage: `claude structured attempt ${attempt} failed`,
        metadata: {
          error: formatError(error),
          retryable,
        },
      });
      lastError = error;
      if (attempt < 2 && retryable) {
        await sleep(300 * attempt);
        continue;
      }

      if (attempt < 2 && !retryable) {
        continue;
      }
    }
  }

  throw new ClaudeStructuredOutputError(
    `Claude structured output failed after 1 retry. Last error: ${formatError(lastError)}`,
    lastError,
  );
}
