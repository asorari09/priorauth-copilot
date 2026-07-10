import { START } from "@langchain/langgraph";
import { NextRequest } from "next/server";
import { z } from "zod";

import {
  classifyGraphExecutionError,
  sanitizeClientError,
  sanitizePriorAuthStateForClient,
  type SanitizedClientError,
} from "@/lib/clientErrors";
import { buildPriorAuthGraph } from "@/lib/graph/buildGraph";
import { type PriorAuthGraphState } from "@/lib/graph/nodes";
import { safeFlushLangfuse, safeStartTrace, safeUpdateTrace } from "@/lib/langfuse";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 120;

const CreateCaseBodySchema = z.object({
  note: z.string().min(1),
});

function unauthorizedResponse() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function invalidRequestResponse(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function checkDemoKey(request: NextRequest): boolean {
  const expectedKey = process.env.DEMO_KEY;
  const providedKey = request.headers.get("x-demo-key");
  return Boolean(expectedKey && providedKey && providedKey === expectedKey);
}

function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function summarizeNodeUpdate(node: string, update: unknown) {
  const payload = update as Record<string, unknown>;
  let error: SanitizedClientError | undefined;
  if (typeof payload.error === "string" && payload.error.length > 0) {
    error = sanitizeClientError(payload.error);
  }

  return {
    node,
    keys: Object.keys(payload),
    outcome:
      node === "decide" && typeof payload.decision === "object" && payload.decision
        ? (payload.decision as { outcome?: string }).outcome ?? null
        : null,
    citationsCount:
      Array.isArray(payload.citations) ? payload.citations.length : undefined,
    hasAppealDraft: Boolean(payload.appealDraft),
    error,
  };
}

function applyUpdate(
  state: PriorAuthGraphState,
  update: Partial<PriorAuthGraphState>,
): PriorAuthGraphState {
  return {
    ...state,
    ...update,
  };
}

export async function POST(request: NextRequest) {
  if (!checkDemoKey(request)) {
    return unauthorizedResponse();
  }

  const json = await request.json().catch(() => null);
  const parsed = CreateCaseBodySchema.safeParse(json);
  if (!parsed.success) {
    return invalidRequestResponse("Invalid request body");
  }

  const note = parsed.data.note;
  const graph = buildPriorAuthGraph();
  const trace = safeStartTrace({
    name: "priorauth-case-run",
    input: { rawNote: note },
  });

  const caseInsert = await supabaseAdmin
    .from("cases")
    .insert({
      status: "processing",
      raw_note: note,
    })
    .select("id")
    .single();

  if (caseInsert.error || !caseInsert.data) {
    return new Response(JSON.stringify({ error: "Failed to create case" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const caseId = caseInsert.data.id as string;
  let finalState: PriorAuthGraphState | null = null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(formatSseEvent(event, data)));
      };

      let state: PriorAuthGraphState = {
        rawNote: note,
        caseId,
        traceId: trace.traceId ?? undefined,
        overrideLog: [],
      };

      send("node", { node: START, summary: { node: START, keys: ["rawNote"] } });

      try {
        const updates = await graph.stream(
          {
            rawNote: note,
            caseId,
            traceId: trace.traceId ?? undefined,
            overrideLog: [],
          },
          { streamMode: "updates" },
        );

        for await (const chunk of updates) {
          const asRecord = chunk as Record<string, Partial<PriorAuthGraphState>>;
          for (const [nodeName, nodeUpdate] of Object.entries(asRecord)) {
            state = applyUpdate(state, nodeUpdate);
            send("node", {
              node: nodeName,
              summary: summarizeNodeUpdate(nodeName, nodeUpdate),
            });
          }
        }

        finalState = state;
        const clientState = sanitizePriorAuthStateForClient(finalState);

        await supabaseAdmin
          .from("cases")
          .update({
            status: "done",
            extraction: clientState.extraction ?? null,
            rules_result: clientState.rulesResult ?? null,
            citations: clientState.citations ?? null,
            decision: clientState.decision ?? null,
            appeal_draft: clientState.appealDraft ?? null,
            error: clientState.error ?? null,
          })
          .eq("id", caseId);

        safeUpdateTrace(trace.traceId, {
          output: {
            caseId,
            decision: finalState.decision ?? null,
            citations: finalState.citations ?? [],
          },
          metadata: {
            overrideLog: finalState.overrideLog ?? [],
            caseId,
          },
        });

        send("done", { caseId, ...clientState });
      } catch (error) {
        const { rawMessage, client } = classifyGraphExecutionError(error);
        console.error("[case-processing] graph execution failed", {
          caseId,
          error: rawMessage,
          errorCode: client.code,
        });

        const persistedState = sanitizePriorAuthStateForClient(finalState ?? {
          rawNote: note,
          caseId,
          overrideLog: [],
        });

        await supabaseAdmin
          .from("cases")
          .update({
            status: "error",
            error: client.message,
            extraction: persistedState.extraction ?? null,
            rules_result: persistedState.rulesResult ?? null,
            citations: persistedState.citations ?? null,
            decision: persistedState.decision ?? null,
            appeal_draft: persistedState.appealDraft ?? null,
          })
          .eq("id", caseId);

        safeUpdateTrace(trace.traceId, {
          level: "ERROR",
          statusMessage: rawMessage,
          metadata: {
            caseId,
            errorCode: client.code,
            overrideLog: finalState?.overrideLog ?? [],
          },
        });

        send("error", {
          caseId,
          message: client.message,
          code: client.code,
        });
      } finally {
        await safeFlushLangfuse();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
