# PriorAuth Copilot — Complete Project Deep Dive

**Live demo:** https://priorauth-copilot-swart.vercel.app · **Repo:** https://github.com/asorari09/priorauth-copilot

*Author: Abhi Sorari · July 2026 · All clinical data synthetic. Not a coverage decision system.*

---

## 0. "Walk me through an AI project you built, in depth."

*This section is the two-minute interview answer. Everything after it is the supporting depth.*

Prior authorization is one of the most hated workflows in US healthcare: before a clinician can prescribe certain drugs or procedures, staff must manually read insurance policy PDFs, check the patient's chart against unstructured eligibility criteria, wait on an opaque payer decision, and — if denied — hand-draft an appeal letter. The AMA reports physicians and staff average roughly 13 hours per week on this, and the large majority say it delays patient care. A 2026 CMS rule (CMS-0057-F) now forces payers to give specific denial reasons and decide within days, which makes structured, evidence-cited decision support commercially timely.

I built **PriorAuth Copilot**: a multi-agent pipeline that takes a free-text clinical note and produces a defensible `likely_approve` / `likely_deny` / `insufficient_info` signal with validated citations to real payer policy documents, plus a drafted appeal letter on likely denials. The core architectural thesis — and the thing I'd defend hardest in a design review — is **rules-first, LLM-second**: the outcome is *never* chosen by a language model. A deterministic TypeScript rules engine and a code-level constraint function (`determineOutcomeConstraint`) own the decision; LLMs do only what they're uniquely good at — structured extraction from messy prose, citation synthesis from retrieved policy text, and drafting.

The pipeline is a LangGraph state graph: an extraction node (OpenAI, structured outputs) fans out in parallel to a deterministic rules check and a RAG branch (pgvector over real public CMS and payer policy PDFs, with Claude synthesizing citations *only* from retrieved chunks). Both branches fan in to a decision node where the outcome is forced in code, then a conditional edge routes likely-denies to an appeal-drafting node. Three hard guardrails are structural, not prompted: every citation's chunk ID is validated in code against the actually-retrieved set (zero hallucinated citations, by construction); any failure anywhere fails *closed* to `insufficient_info`, never to an approval; and there is no code path that transmits anything externally — human-in-the-loop is enforced by the absence of a send capability, not by a bypassable approval gate.

Quality is proven, not asserted: a 26-case golden dataset with hand-labeled outcomes gates CI — the current run is **100% decision accuracy, 0% false-approve rate, 100% citation validity**. Two evals prove retrieval provenance: an **ablation mode** (retrieval disabled → all 26 cases correctly return `insufficient_info`, proving answers come from the corpus, not model memory) and **canary cases** (a fictional payer and drug code that exist nowhere except my corpus — correct citations of them are impossible without genuine retrieval).

Every node and LLM call is traced in Langfuse, which enabled the second phase: **cost engineering**. Measured baseline was ~$0.041/case on Claude Sonnet. Through task-routed model selection (Haiku for constrained synthesis, Sonnet reserved for appeal prose), payload trimming, template-based reasoning for code-forced outcomes, and a content-hash inference cache, the measured post-optimization cost is **~$0.003/case (approve path) and ~$0.006/case (deny path) — a ~90% reduction — verified at unchanged 26/26 eval accuracy**.

It's deployed on Vercel (Next.js 15, Supabase, SSE streaming of the live agent trace), with an honest demo layer: preset scenarios replay stored verified runs at zero cost, clearly labeled as replays, while live runs execute the full graph. Tradeoffs I made deliberately and can defend: a well-structured monolith over microservices, pgvector inside the app's Postgres over a dedicated vector store, a demo-key gate over full OAuth, and real public policy documents plus canaries over a fabricated corpus.

---

## 1. Terminology and vernacular — every term, as it exists in this project

**Agentic orchestration.** Coordinating multiple specialized LLM and non-LLM steps into a controlled workflow with explicit state, routing, and error handling — as opposed to a single prompt-response chatbot. Here: a five-node LangGraph pipeline where each node has one job, a typed input/output contract, and its own failure policy.

**LangGraph / state graph.** LangGraph (used here via its JavaScript package, `@langchain/langgraph` v1.4.7) models a workflow as a directed graph over a shared, typed state object. **Nodes** are functions that receive state and return partial state updates. **Edges** define execution order. **Conditional edges** route based on state — here, `routeOnDecision` sends `likely_deny` to the appeal node and everything else to END. **Fan-out/fan-in** runs branches in parallel: `rulesCheck` and `policyRag` both consume the extraction concurrently and both feed the decision node, a genuine latency win since neither depends on the other. A practical constraint discovered during the build: LangGraph JS forbids a node name colliding with a state channel name (nodes were renamed `decide`/`draftAppeal` to avoid the `decision`/`appealDraft` state keys).

**RAG (Retrieval-Augmented Generation).** Instead of asking a model to answer from training memory, relevant documents are retrieved at query time and placed in the model's context, and the model is constrained to answer from them. Here: payer policy criteria are retrieved from a vector index and Claude synthesizes citations from *only* the retrieved chunk text — never from the whole document, never from memory.

**Embeddings.** Dense numeric vectors representing text meaning, such that semantically similar texts have nearby vectors. Here: OpenAI `text-embedding-3-small` (1536 dimensions) embeds both policy chunks at ingestion time and the query built from each case's extraction at run time.

**pgvector / HNSW.** pgvector is a PostgreSQL extension adding a `vector` column type and similarity operators, letting the vector index live inside the same Postgres (Supabase) as the application data — a production-realistic choice over standing up a separate vector database. HNSW (Hierarchical Navigable Small World) is the approximate-nearest-neighbor index used on the embedding column for fast cosine-similarity search; retrieval is exposed as a SQL function, `match_policy_chunks`, called via Supabase RPC.

**Chunking.** Splitting long documents into retrievable units. Here: ~500-token chunks with ~50-token overlap, each carrying metadata (`chunk_id` in the format `{doc_slug}-p{page}-{n}`, payer name, document title, source URL, page number). The human-readable, ingestion-generated chunk ID format is load-bearing — see citation validation.

**Citation grounding and validation.** The system's central integrity mechanism. Claude is given the retrieved chunks and their IDs and must attach a `sourceChunkId` to every citation. After parsing, *code* verifies every cited ID exists in that run's retrieved set; violations trigger one corrective retry, then invalid citations are stripped; if none survive, the outcome is forced to `insufficient_info`. Because chunk IDs are generated by the ingestion script and exist nowhere on the internet, a valid citation is near-proof the content was genuinely retrieved in that run. Measured result: **100% citation validity across the full eval**.

**Structured outputs / tool-use.** Getting schema-conforming JSON from an LLM using the provider's native mechanism rather than "please respond in JSON" prompting. OpenAI calls use its structured-outputs mode bound to a Zod schema; Claude calls use tool-use with `tool_choice` forcing a single tool whose `input_schema` is the JSON-schema rendering of a Zod schema. Every LLM response is re-validated through Zod before touching application state.

**Wire schema vs. domain schema.** A pattern this project was forced to discover: OpenAI's strict structured-output mode requires every schema field to be present — `.optional()` is unsupported, only `.nullable()`. The fix: a separate *wire* schema (`ClinicalExtractionWireSchema`) where optional fields are nullable, used only at the API boundary; nulls are stripped immediately after parsing and the result is validated against the real *domain* schema, so the rest of the system sees genuine field absence. The absent-vs-null distinction matters because field absence is what drives `insufficient_info` logic downstream.

**Fail-closed design.** When anything unexpected happens — a parse failure, an API outage, an empty retrieval — the system defaults to the safe outcome (`insufficient_info`), never to a false positive. This was accidentally live-tested when the Anthropic account ran out of credits mid-development: every Claude call failed, and the system cleanly produced `insufficient_info` with a sanitized error rather than crashing or guessing.

**Code-forced outcomes.** The outcome enum is computed by a pure TypeScript function, `determineOutcomeConstraint`, from three inputs: citation availability, the deterministic rules result, and the missing-field analysis. The LLM writes reasoning prose; it does not choose outcomes. The strongest one-line safety claim in the project: *the model cannot approve a case, structurally.*

**Deterministic rules engine.** `lib/rulesEngine.ts`: a table of eligibility rules (step-therapy counts, age minimums, diagnosis-code matching, quantity limits, conservative-care duration) implemented as pure functions of the extraction — zero LLM calls in the file, 100% unit-test coverage, built and tested before any AI code existed. It encodes the judgment FDE work actually requires: knowing when *not* to use an LLM.

**Missing-field → insufficient_info logic.** A subtle correctness requirement: a rule that fails because its input field is *absent* (e.g., requested units never documented) must produce `insufficient_info`, not `likely_deny` — "we can't evaluate" is different from "it fails." Implemented as a rule-ID-to-optional-field dependency map; if every failed rule is explained by an absent field, the outcome is forced to `insufficient_info`. Four golden cases exist specifically to punish the naive implementation.

**Golden dataset.** 26 hand-labeled synthetic clinical notes spanning three real procedure codes (biologic infusion J1745, total knee arthroplasty 27447, brain MRI 70553) plus a fictional canary code — deliberately mixing clean passes, targeted single-rule failures, ambiguous missing-data cases, and canaries. It serves as both the demo dataset and the eval ground truth.

**Eval harness.** `evals/runEvals.ts` runs the golden set through the full pipeline and scores: decision accuracy, field-level extraction accuracy, citation validity rate, **false-approve rate** (approving what should be denied — the safety-critical metric, held at 0%), and latency. Results are written to timestamped JSON committed to the repo, making eval history part of the git record.

**Ablation testing.** Re-running the eval with retrieval stubbed to return zero chunks. Per the citation invariant, every case must then return `insufficient_info` — and all 26 did. This is the mathematical proof that answers derive from the corpus, not model memory (training-data contamination is impossible to exploit when the system refuses to answer without retrieval).

**Canary documents / retrieval provenance.** One synthetic policy document for a fictional payer ("Meridian Health Plan") covering a fictional drug code (J9999) with made-up criteria, clearly labeled as a canary and ingested alongside real documents. Two golden cases target it. Since these facts exist nowhere in any training corpus, correct citation of Meridian chunks is possible only through genuine retrieval — provenance proof by construction.

**Observability: traces, spans, generations.** Langfuse instrumentation, fail-safe (Langfuse being unreachable can never break the pipeline). Each case run is one **trace**; each graph node is a **span** with inputs/outputs; each LLM call is a **generation** capturing model, prompts, responses, token counts, and dollar cost. This per-generation cost data is what made the cost-engineering phase quantitative rather than guesswork. Replay (cached demo) paths are tagged distinctly (`priorauth-preset-replay`, `replay: true`) so observability never conflates demo traffic with live runs.

**SSE (Server-Sent Events).** One-directional HTTP streaming from server to client. The API route runs the graph synchronously and streams one event per completed node, which the UI renders as a live agent trace — the reasoning made visible step-by-step rather than a black-box spinner. Timestamps in production confirmed genuinely progressive delivery (not end-of-run buffering).

**Serverless constraints.** Vercel functions are stateless and time-limited, which shaped the architecture: no background workers or queues; the graph runs synchronously inside one route with `runtime = "nodejs"` and `maxDuration = 120`; state persists to Supabase, not process memory.

**Prompt caching vs. inference caching.** Two different things. *Prompt caching* (Anthropic's `cache_control`) discounts repeated prompt prefixes — wired into the code as a pattern but honestly documented as saving ~$0 here, because the static system prompts are far below the minimum cacheable prefix length. *Inference caching* is the real saver: a Supabase `citation_cache` table keyed by `sha256(CPT + sorted retrieved chunk IDs)` stores validated citation sets (and, under a second cache kind, appeal drafts keyed by content hash), so structurally identical retrievals skip the LLM call entirely. A `--no-cache` flag exists so regression evals always exercise fresh inference.

**Template reasoning.** For code-forced outcomes, the reasoning summary is assembled deterministically from the rules result, citation requirement summaries, and unverified-items list (`templateReasoning.ts`) — no LLM call. An env flag (`REASONING_MODE=template|llm`) preserves the LLM-prose option. Rationale: paying a model to narrate data the code already holds is waste.

**Model routing.** Per-task model selection via env vars: extraction on OpenAI `gpt-4o-mini` (cheap, schema-strict, high-volume), citation synthesis and appeal drafts on Claude Haiku 4.5 (constrained tasks with code-level validation backstopping quality), with per-node env overrides (`ANTHROPIC_MODEL_FAST`, `ANTHROPIC_MODEL_REASONING`) so any node can be flipped back to Sonnet as configuration, not code.

**Honest demo / preset replay.** The public demo's default path serves stored results from real verified runs — real citations, real payer PDF URLs — at $0 and with no key, explicitly labeled as a replay with a single `stored_result (replay)` trace step (never theatrical fake node events). Live runs (full graph, real LLM calls) sit behind a demo key. This layer exists because an earlier iteration served fabricated preset citations with placeholder URLs — a trust failure caught in audit and rebuilt from persisted real run data.

---

## 2. Purpose and business value

**The problem, quantified.** Prior authorization consumes ~13 hours/week of physician and staff time (AMA survey data); ~94% of physicians report it delays care. Denials have historically come with vague reasons, and appeals are manual re-work measured in hours. CMS-0057-F (effective 2026) compresses payer decision windows to 72 hours (urgent) / 7 days (standard) and mandates specific denial reasons — increasing the value of pre-submission triage and evidence-cited appeals on the provider side.

**What the product is.** A *pre-submission copilot* for the provider's staff: paste the clinical note, get (a) structured extraction of the clinically relevant facts, (b) a deterministic eligibility read against encoded payer criteria, (c) policy citations with links to the actual payer documents, (d) a three-way likelihood signal, and (e) on likely denial, a drafted appeal letter citing the specific policy clause — for a human to review and send through existing channels.

**What it deliberately is not.** It never renders a real coverage decision (the outcome enum has no "approved"), never transmits anything (no send code path exists), and never touches real PHI (synthetic data only, stated in the UI and README). These aren't disclaimers bolted on — they're architectural properties.

**The value logic.** Each manual policy-lookup-plus-criteria-check cycle costs staff minutes to hours; the pipeline does it in ~30 seconds at $0.003–0.006 of inference. The appeal draft converts hours of drafting into minutes of review. The `insufficient_info` outcome is itself valuable: it tells staff *exactly which* documentation gap to close before submitting, preventing avoidable denials.

---

## 3. System design

### 3.1 Request flow

```
Browser (single page)
   │  POST /api/cases  (SSE)
   ▼
Vercel — Next.js API route (nodejs runtime, maxDuration 120)
   │  preset replay? ── yes ──▶ stored verified result, $0, no key, labeled replay
   │  no (X-Demo-Key required)
   ▼
LangGraph pipeline:
   extract (OpenAI) ──▶ fan-out ──▶ rulesCheck (pure TS)      ─┐
                              └──▶ policyRag (pgvector+Haiku) ─┤ fan-in
                                                               ▼
                                             decide (outcome forced in TypeScript)
                                                               │
                                        likely_deny ──▶ draftAppeal (Haiku) ──▶ END
                                        otherwise ──▶ END
   ▼
Supabase: cases (live-run persistence; replays excluded)
Langfuse: trace per case, span per node, generation per LLM call
```

### 3.2 Node contracts

| Node | Engine | LLM? | Contract |
|---|---|---|---|
| `extract` | OpenAI gpt-4o-mini, structured outputs | Yes | Free-text note → `ClinicalExtraction` (wire schema at boundary, nulls stripped to absence) |
| `rulesCheck` | `rulesEngine.ts` | No | Extraction → `{eligibleByRules, failedCriteria[], ruleIdsApplied[]}` |
| `policyRag` | pgvector top-5 → top-3 to Haiku | Yes (cacheable) | Extraction → validated `PolicyCitation[]`; every `sourceChunkId` verified in code |
| `decide` | `determineOutcomeConstraint()` + template reasoning | No (LLM optional for prose) | Rules + citations → outcome (code-set) + reasoning + rules-passed metric |
| `draftAppeal` | Claude Haiku (Sonnet-capable via env) | Yes (cacheable) | Deny-path only; `requiresHumanReview` is a literal `true` in the schema; graph ends here — no send node exists |

### 3.3 Data model (Supabase Postgres)

- **`policy_chunks`** — chunked, embedded payer policy text; `chunk_id` (unique, human-readable), payer/document/URL/page metadata, `vector(1536)` embedding under an HNSW cosine index; queried via the `match_policy_chunks` SQL function.
- **`cases`** — one row per live run: raw note, then extraction / rules_result / citations / decision / appeal_draft as jsonb, plus status (`processing|done|error`). Replays do not insert.
- **`citation_cache`** — inference cache: `cache_key` (content hash), `cache_kind` (`citation|appeal_draft`), payload jsonb.

### 3.4 The corpus

Seven real public policy documents ingested (~92 chunks): infliximab medical policies from three payers (Blue Cross of Idaho, CareSource, Blue Shield of California), total-knee-arthroplasty policies from three (Premera, Kaiser Permanente WA, Providence), CMS NCD 220.2 for MRI plus a Medicaid derivative — plus the Meridian canary. Ingestion (`scripts/ingest.ts`) is an offline, idempotent, developer-run script: fetch PDF → extract text → chunk → embed → upsert on `chunk_id`. It is not deployed and not callable from the app.

---

## 4. Design tradeoffs — each decision and its rejected alternative

**Rules engine vs. "just ask the LLM."** Eligibility math (counts, thresholds, code matching) is deterministic; an LLM adds cost, latency, and nondeterminism to arithmetic. The rejected alternative — LLM-evaluated eligibility — would also make the false-approve rate a prompt-quality problem instead of a solved one. This is the project's core judgment claim: route by task nature, not by novelty.

**Code-forced outcomes vs. LLM-proposed with override.** The first implementation had Claude propose an outcome that code could override (with an `overrideLog`). The final design removes the LLM from the outcome path entirely — cleaner to defend ("the model cannot approve"), cheaper, and it eliminated an actual observed failure class (the model omitting schema fields it was pointlessly asked to echo). Lesson generalized: *LLM output schemas should contain only fields the LLM actually decides.*

**Two LLM providers, task-routed vs. single vendor.** Extraction is high-volume and schema-bound (OpenAI structured outputs: cheap, strict); synthesis and drafting are context-reasoning tasks (Claude). Not redundancy — each node has exactly one provider — but cost/latency-fit plus no single-vendor dependency.

**Synchronous SSE vs. background jobs.** Serverless has no long-lived workers; a queue (the original Railway-era design had Celery) would add infrastructure for no user benefit. A single streaming route with `maxDuration: 120` is the minimal correct pattern, and the SSE stream doubles as the demo's live trace view.

**pgvector-in-Postgres vs. dedicated vector DB.** One database, one backup story, relational metadata filtering available in the same query, zero extra infrastructure. At this corpus size (and at most realistic single-tenant sizes), a dedicated vector store is complexity without payoff.

**Monolith vs. microservices.** A well-structured Next.js monolith with clean internal module boundaries. Microservices for a single-workflow, single-team system is résumé-driven architecture; the senior signal is knowing that.

**Demo key vs. OAuth.** A public demo with per-run LLM cost needs bot protection, not identity. A static header key plus a keyless zero-cost replay path solves the actual problem; full OAuth2/JWT is documented as the production path.

**Real corpus + canaries vs. fabricated corpus.** A fully fabricated corpus would "prove" retrieval (nothing in training data) but destroy the harder claim — that the system handles real, messy, inconsistently formatted payer documents. The hybrid keeps both: real documents prove the integration; ablation + canaries prove provenance.

**Committed eval history vs. ephemeral results.** Timestamped result JSONs live in git, so the quality trajectory (including the failures) is auditable — the same transparency posture as labeling replays.

---

## 5. Findings and incidents — what actually happened, and what it taught

**The `.optional()` wall (OpenAI structured outputs).** First extraction call failed before the model even ran: OpenAI's strict mode requires all fields present, rejecting Zod `.optional()`. Fix: the wire-schema/domain-schema split (nullable at the boundary, absence internally). Generalized lesson: provider-specific structured-output constraints leak into schema design; isolate them at the boundary rather than weakening domain types.

**LangGraph name collisions.** Node names may not collide with state channel names in LangGraph JS — `decision` and `appealDraft` were both. Nodes were renamed (`decide`, `draftAppeal`); state keys, referenced everywhere, kept their names. Lesson: verify a fast-moving library's actual installed API, never transcribe patterns (especially cross-language) from memory.

**Truncation-driven "random" failures.** Three eval cases failed identically: citation synthesis "structured output failure after retry." Root cause via improved error surfacing: `maxTokens: 1400` truncated multi-citation tool-use JSON mid-object; the retry hit the same wall. Fix: raise the budget, cap citations at three, and — more importantly — instrument the *underlying* error so retries never mask root causes again.

**The schema-contract bug.** One case still failed: Claude omitted `supportingCitations` and `rulesResult` from its Decision output — fields the code overwrote from state anyway. The model was being forced to echo data it didn't own. Fix: shrink the schema to Claude-owned fields only (`outcome`, `confidence`, `reasoningSummary` — and later, outcome left the schema too). This bug produced the project's most transferable design rule.

**Credit exhaustion as an accidental chaos test.** Mid-development, the Anthropic account ran dry. Every Claude call 400'd — and the system behaved exactly as designed: zero citations → forced `insufficient_info`, coherent UI state, "Rules passed 4/4" alongside the safe outcome telling the precise story (deterministic layer healthy, LLM layer down, no guessing). It also exposed a real bug: raw upstream error text (billing messages, request IDs) leaked into client-facing SSE events — fixed with error sanitization (generic client message + internal code; full detail to Langfuse/server logs only).

**The appeal agent out-argued its own rules engine.** In an early deny case, the appeal draft correctly noticed that the synthetic age rule (18+) contradicted the *actual ingested CareSource policy* (age ≥ 6 for Crohn's) and wrote an appeal arguing the denial misapplied policy. Simultaneously the best evidence of genuine citation-grounded reasoning and a demo-coherence bug; resolved by aligning the synthetic rule with the real policy language. Lesson: when your RAG layer is genuinely grounded, it will find your own inconsistencies.

**The fabricated-preset trust failure.** A demo-caching layer initially shipped preset results with placeholder citations and fake `example.com` URLs, plus theatrical replayed node events — in a project whose headline claim is zero fabricated citations. Caught in an aggressive self-audit; rebuilt from real persisted run data (real chunk IDs, real payer PDF links that resolve), with replays collapsed to a single honestly-labeled `stored_result (replay)` step. Lesson: demo layers are part of the system's integrity surface, not exempt from it.

**Fail-fast retry hygiene.** The Claude wrapper originally retried even non-retryable errors (hard 400s), doubling latency and error noise for zero benefit. Fixed to retry only 429/5xx/timeouts and parse-level failures. Small bug, disproportionate observability pollution.

---

## 6. Cost engineering — the measured story

All figures below are Langfuse-measured (per-generation dollar tracking), not estimates.

### 6.1 Baseline (all-Sonnet, full payloads)

| Generation | Avg cost/call | Share |
|---|---|---|
| Citation synthesis (5 full chunks + extraction in prompt) | ~$0.022 | ~50% |
| Decision (full citations JSON re-sent; outcome later discarded) | ~$0.013 | ~30% |
| Appeal draft (deny only) | ~$0.017 | — |
| Extraction (OpenAI) | ~$0.0001 | ~0% |
| **Per case** | **~$0.041 avg** (range $0.030–0.058, n=64 traces) | |

### 6.2 The four levers

1. **Model routing.** Citation synthesis and appeals to Claude Haiku 4.5 (~5× cheaper), justified because both tasks are constrained and code-validated (invalid citations are stripped; worst case is the safe outcome). Per-node env overrides keep Sonnet one config change away.
2. **Payload trimming.** Retrieve 5 chunks, send top-3 by similarity, truncate each to ~300 tokens; decision context gets citation *summaries*, not full objects.
3. **Template reasoning.** The outcome being code-forced means its explanation can be assembled deterministically from data the code already holds — removing the decision-node LLM call entirely (env-flagged, LLM prose available on demand).
4. **Inference caching.** Content-hash cache for citation sets (keyed on CPT + sorted retrieved chunk IDs) and appeal drafts; structurally identical work never pays twice. `--no-cache` preserves eval integrity. (Prompt caching is wired but honestly documented as ~$0 savings at these prompt sizes.)

### 6.3 Verified result (post-optimization eval run, 2026-07-10)

| Metric | Value |
|---|---|
| Eval gate | **100% decision accuracy · 0% false-approve · 100% citation validity (26/26)** — `evals/results/2026-07-10T02-38-26-825Z.json` |
| Approve path | **$0.00325/case avg** (n=10) |
| Deny path (incl. appeal) | **$0.00568/case avg** (n=12) |
| All 26 cases | **$0.00432/case avg** |
| Reduction vs. baseline | **~90%** at unchanged accuracy |
| Preset demo path | **$0** (stored replay, no generations) |

Representative trace: `88046535-fa61-47e5-bdf3-5ecb9e9aa476` — CASE-001, $0.0032 total (Haiku citations $0.0031 + gpt-4o-mini extraction $0.00009).

### 6.4 The meta-lesson

Costs were also *incurred* the hard way: ~$5 of credits burned in one evening through repeated full-suite evals, duplicate concurrent runs during tooling instability, and CI evals wired to fire on every push. The resulting operating discipline is itself a finding: single-case evals for debugging, full suites as deliberate gated checkpoints, CI evals on manual dispatch only, cost estimates stated before any multi-case run, and provider-side spend alerts. Cost engineering is an operational habit, not a one-time optimization.

---

## 7. Evaluation methodology and results

**Dataset design.** 26 synthetic notes across J1745 / 27447 / 70553 / J9999-canary: 10 clean approvals, 12 denials each failing a *different specific* rule, 4 ambiguous missing-field cases that punish any implementation conflating "criterion failed" with "criterion unevaluable." Each case carries a hand-labeled expected outcome *and* expected extraction (field-level ground truth planted in the prose).

**Metrics.** Decision accuracy; field-level extraction accuracy (99.6% — the residual being summary-text normalization); citation validity (code-verifiable, 100%); **false-approve rate** (the metric a healthcare reviewer cares about most — 0% throughout, including during failure conditions, because failures close to `insufficient_info`); per-case latency.

**Provenance proofs.** Ablation (retrieval off → 26/26 `insufficient_info`) rules out model-memory answering wholesale; canaries rule it out per-case by construction. Together they answer the strongest skeptical question — "how do I know the retrieval matters?" — with evidence rather than assertion.

**CI integration.** Lint/typecheck/unit tests run on every push. The eval suite runs on manual `workflow_dispatch` only (a deliberate cost decision) and **fails the workflow** unless the gate (100/0/100) holds — verified passing in CI run 29065131002 on the optimized stack.

**What the eval caught during development** (the harness paying rent): the missing-field conflation risk (by design), the truncation failure cluster, the schema-contract bug, and the rules-vs-corpus contradiction — each surfaced as a red case with diagnostics, not as a production surprise.

---

## 8. Limitations and the production roadmap

Stated openly because knowing the demo-to-production gap is the job:

1. **Payer-gated retrieval.** The demo searches cross-payer to showcase multi-document retrieval; production must filter retrieval by the patient's actual payer (the `payer_name` metadata already on every chunk makes this a one-line RPC change) — a real patient has one policy, and cross-payer citation blending is a correctness risk.
2. **Weight-based dose validation.** J1745 is dosed in mg/kg; validating requested units requires patient weight — a deterministic calculator node plus a weight field in extraction, halting on absence. The current quantity rule checks unit counts only.
3. **FHIR / CMS-0057-F integration.** Production intake would consume structured FHIR resources from the EHR and payer APIs mandated by the 2026 rule, replacing free-text-only ingestion.
4. **PHI-compliant infrastructure.** Real deployment requires BAAs across every vendor in the path, encryption and access-control posture, and audit logging — the reason this demo is synthetic-only by hard rule.
5. **Real auth and multi-tenancy.** OAuth2/JWT, per-organization keys and data isolation, replacing the demo-key gate.
6. **Latency.** ~30s/case live is demo-acceptable (with streaming) but production triage would want batching, speculative retrieval, and possibly parallel citation synthesis.

---

## 9. Appendix

**Repository map.** `lib/rulesEngine.ts` (deterministic core) · `lib/schemas.ts` (domain schemas) · `lib/llm/{openai,claude}.ts` (provider wrappers; wire schemas, retries, tracing) · `lib/graph/{nodes,buildGraph}.ts` (pipeline) · `lib/templateReasoning.ts` · `scripts/ingest.ts` (offline corpus ingestion) · `scripts/generateSyntheticCases.ts` · `evals/runEvals.ts` + `evals/results/` (committed history) · `app/api/cases/*` (SSE API) · `app/page.tsx` (single-page demo) · `data/canary/meridian-policy.md` · `supabase/migrations/` · `.github/workflows/ci.yml`.

**Key commands.** `npm run eval -- --case=CASE-XXX --no-cache` (single-case debug) · `npm run eval -- --no-cache` (full regression, deliberate) · `npm run eval:ablation` (provenance proof) · `npm run ingest` (offline) · `npm run rebuild:presets`.

**Environment.** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`, `ANTHROPIC_MODEL_FAST`, `ANTHROPIC_MODEL_REASONING`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LANGFUSE_PUBLIC_KEY`/`SECRET_KEY`/`HOST`, `DEMO_KEY` (Vercel-only), `REASONING_MODE`.

**Verified artifacts.** Passing eval: `evals/results/2026-07-10T02-38-26-825Z.json` · CI gate run: 29065131002 · Representative cost trace: `88046535-fa61-47e5-bdf3-5ecb9e9aa476` · Cost dashboard: `docs/langfuse-post-optimization.png`.

---

*Synthetic data only · Not a coverage decision · Verify with the payer directly*
