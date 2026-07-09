import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import { safeStartTrace, safeUpdateTrace } from "../langfuse";
import {
  appealDraftNode,
  decisionNode,
  extractNode,
  policyRagNode,
  routeOnDecision,
  rulesCheckNode,
  type PriorAuthGraphState,
} from "./nodes";

const GraphState = Annotation.Root({
  rawNote: Annotation<string>(),
  traceId: Annotation<string | undefined>(),
  caseId: Annotation<string | undefined>(),
  forceNoRetrieval: Annotation<boolean | undefined>(),
  extraction: Annotation<PriorAuthGraphState["extraction"]>(),
  rulesResult: Annotation<PriorAuthGraphState["rulesResult"]>(),
  citations: Annotation<PriorAuthGraphState["citations"]>(),
  retrievedChunks: Annotation<PriorAuthGraphState["retrievedChunks"]>(),
  decision: Annotation<PriorAuthGraphState["decision"]>(),
  appealDraft: Annotation<PriorAuthGraphState["appealDraft"]>(),
  overrideLog: Annotation<PriorAuthGraphState["overrideLog"]>({
    reducer: (left, right) => [...(left ?? []), ...(right ?? [])],
    default: () => [],
  }),
  error: Annotation<string>(),
});

export function buildPriorAuthGraph() {
  return new StateGraph(GraphState)
    .addNode("extract", extractNode)
    .addNode("rulesCheck", rulesCheckNode)
    .addNode("policyRag", policyRagNode)
    .addNode("decide", decisionNode)
    .addNode("draftAppeal", appealDraftNode)
    .addEdge(START, "extract")
    .addEdge("extract", "rulesCheck")
    .addEdge("extract", "policyRag")
    .addEdge("rulesCheck", "decide")
    .addEdge("policyRag", "decide")
    .addConditionalEdges("decide", routeOnDecision)
    .addEdge("draftAppeal", END)
    .compile();
}

export async function runPriorAuthGraphCase(params: {
  rawNote: string;
  caseId?: string;
  sessionId?: string;
  userId?: string;
  forceNoRetrieval?: boolean;
}) {
  const trace = safeStartTrace({
    name: "priorauth-case-run",
    input: { rawNote: params.rawNote },
    metadata: { caseId: params.caseId ?? null },
    sessionId: params.sessionId,
    userId: params.userId,
  });

  const graph = buildPriorAuthGraph();
  const result = (await graph.invoke({
    rawNote: params.rawNote,
    traceId: trace.traceId ?? undefined,
    caseId: params.caseId,
    forceNoRetrieval: params.forceNoRetrieval,
    overrideLog: [],
  })) as PriorAuthGraphState;

  safeUpdateTrace(trace.traceId, {
    output: {
      decision: result.decision ?? null,
      citations: result.citations ?? [],
      error: result.error ?? null,
    },
    metadata: {
      caseId: params.caseId ?? null,
      overrideLog: result.overrideLog ?? [],
    },
  });

  return result;
}
