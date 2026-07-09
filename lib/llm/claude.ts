import Anthropic from "@anthropic-ai/sdk";
import { z, type ZodTypeAny } from "zod";

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

export async function callClaudeStructured<TSchema extends ZodTypeAny>(
  args: ClaudeStructuredCallArgs<TSchema>,
): Promise<z.infer<TSchema>> {
  const client = getClient();
  const model = args.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_CLAUDE_MODEL;
  const schemaJson = z.toJSONSchema(args.schema);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
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
        throw new Error("Claude did not return the required tool_use block.");
      }

      return args.schema.parse(toolBlock.input);
    } catch (error) {
      lastError = error;
      const retryable = isRetryable(error);
      if (attempt < 2 && retryable) {
        await sleep(300 * attempt);
        continue;
      }

      if (attempt < 2 && !retryable) {
        continue;
      }
    }
  }

  throw new ClaudeStructuredOutputError("Claude structured output failed after 1 retry.", lastError);
}
