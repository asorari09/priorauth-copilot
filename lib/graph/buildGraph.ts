import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

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
