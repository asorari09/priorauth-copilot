# PriorAuth Copilot — Final Blueprint (single source of truth)
### For the coding agent. Read this entire document before writing a single line of code. If anything in a later prompt conflicts with this document, this document wins unless the user explicitly overrides it in writing.

---

## 0. What this project is, in one paragraph

A clinician's staff submits a synthetic clinical note. The system extracts structured clinical facts (OpenAI structured output), runs them through a deterministic eligibility rules engine (pure TypeScript, zero LLM calls) and a pgvector RAG match over real public payer policy documents in parallel, then a Claude-powered decision node outputs exactly one of `likely_approve | likely_deny | insufficient_info` with validated citations. If `likely_deny`, Claude drafts an appeal letter citing the specific policy clause. Nothing is ever transmitted anywhere; a human copies the draft out. This is a decision-support copilot, not an adjudicator.

**Why this project exists (for you, the builder):** This is a portfolio piece for Forward Deployed Engineer roles. The thing being demonstrated is not "I can call an LLM." It is:
1. Knowing when to use deterministic logic vs. an LLM (much of this system is NOT an LLM call)
2. Building a real multi-agent pipeline with LangGraph, not a single prompt
3. Integrating with real, messy, external data (public payer policy PDFs)
4. Deliberate multi-provider LLM routing (OpenAI vs. Claude, by task)
5. Hard safety guardrails as first-class architecture, not afterthoughts
6. Instrumented, measurable, evaluable behavior — and shipping it live with clean docs

Every design decision below traces back to one of those six. If you are ever unsure why something is built a certain way, it's one of these six.

**Real-world grounding (for the README):** Physicians and staff average roughly 13 hours a week on prior authorization, and the large majority say the process delays patient care. Denial reasons have historically been vague; a 2026 CMS rule (CMS-0057-F) now requires payers to give specific denial reasons and decide within 72 hours (urgent) or 7 days (standard). The as-is process is: staff manually reads policy PDFs, manually checks the chart against unstructured criteria, waits on an opaque decision, and hand-drafts appeals. The future state this system implements: note in → extraction → parallel deterministic rules + policy RAG → a decision node architecturally forbidden from real approvals → cited appeal draft → human approves out-of-band.

---

## 1. Non-negotiable guardrails (read this twice)

These are hard constraints, not suggestions. A coding agent working "fast" will be tempted to skip these. Do not.

1. **The system NEVER outputs a real approval or denial.** Every decision output is exactly one of `likely_approve`, `likely_deny`, `insufficient_info` — enforced by the Zod schema so emitting anything else is structurally impossible. The UI carries a persistent, un-dismissable banner: "This is not a coverage decision. Verify with the payer directly."
2. **All patient/clinical data is synthetic.** No real PHI under any circumstances. This repo is public; real PHI would be a HIPAA violation. State the synthetic-only disclaimer in the README and in the UI.
3. **Nothing is ever sent.** There is no code path that emails, faxes, or POSTs the appeal letter anywhere. Do not create one. This is a stronger human-in-the-loop guarantee than an approval gate that could be bypassed — the send capability simply does not exist.
4. **Every claim must be citeable.** If the RAG layer can't find a supporting policy clause, the decision is `insufficient_info`, never a guess. Every citation carries a `sourceChunkId` that is validated in code against the actually-retrieved set (retry once on failure, then strip; if none remain → `insufficient_info`). No hallucinated citations, ever.
5. **The rules engine is not an LLM call.** Plain TypeScript conditionals and arithmetic against a hardcoded criteria table. Never "just ask the LLM" for eligibility math. This is the single most important architectural choice in the project for FDE interview purposes — it demonstrates judgment about when NOT to use AI.
6. **Fail closed, never open.** Any unexpected error in any node ends the case as `insufficient_info` with `status: error` — never as an approval, and never as an unhandled 500 leaking a stack trace to the client.

---

## 2. Locked tech stack (do not substitute anything)

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15 (App Router), TypeScript, single repo | One repo, one deploy, matches user's existing stack |
| Orchestration | `@langchain/langgraph` (LangGraph JS) | Graph control flow, parallel branches, conditional routing |
| Extraction + embeddings | OpenAI API — structured outputs for extraction, `text-embedding-3-small` for embeddings | Cheap, fast, strict schema adherence for high-volume schema-bound tasks |
| Reasoning + drafting | Claude API (`@anthropic-ai/sdk`) — policy synthesis, decision node, appeal letter | Long-context reasoning over retrieved policy text |
| DB + vectors | Supabase: Postgres for cases, pgvector for policy chunks | Production-realistic: RAG in the same Postgres as app data; no separate vector infra |
| Hosting | Vercel | Frontend + API routes in one deploy, zero Docker |
| CI | GitHub Actions: eslint, tsc, vitest, eval suite | Free, standard, recruiter-recognizable |
| Observability | Langfuse cloud free tier (`langfuse` JS SDK) | Trace every node and every LLM call |
| UI | One page, plain React in the same app, minimal Tailwind | UI polish is explicitly not a goal |

No Docker. No Python. No queue. No LangGraph checkpointer. No Kubernetes/microservices. No auth beyond a single `DEMO_KEY` header check on the API route (document in the README: "production would use OAuth2/JWT + per-org keys; simplified deliberately for a single-user public demo").

**Multi-provider rationale (memorize; it goes in the README and comes up in interviews):** extraction is a high-volume, schema-bound task — OpenAI structured outputs are cheap, fast, and strict. Decision/synthesis/drafting is long-context reasoning over retrieved policy text — Claude. Task-routed multi-provider design also removes single-vendor dependency. Do NOT use both providers for the same node "for redundancy" — each node has exactly one provider.

---

## 3. Architecture (serverless-native)

```
Browser (single page)
   │  POST /api/cases  { note, demoKey }
   ▼
Next.js API route (runtime: nodejs, maxDuration: 120)
   1. insert row into supabase.cases (status: processing)
   2. run LangGraph graph SYNCHRONOUSLY, streaming node events
      back to the client via SSE (ReadableStream)
   3. on completion, update cases row with full final state
   ▼
LangGraph JS graph:
   extract (OpenAI) ──▶ fan-out ──▶ rulesCheck (pure TS)      ─┐
                              └──▶ policyRag (pgvector+Claude)─┤
                                                               ▼
                                                      decision (Claude)
                                                               │
                                         likely_deny? ── yes ─▶ appealDraft (Claude)
                                                  no ─▶ END
```

Design decisions, and why:
- **Synchronous run with SSE streaming, not background jobs.** On serverless there is no long-lived worker; a single route with `maxDuration: 120` streaming node events is the minimal correct pattern. The SSE stream doubles as the live agent-trace view in the UI — the single best thing to show a recruiter ("here's the agent's reasoning, step by step, not a black box").
- **`rulesCheck` and `policyRag` run as parallel branches** (LangGraph fan-out/fan-in) feeding `decision`. They don't depend on each other; this is a genuine multi-agent pattern and a real latency win, not a disguised linear chain.
- **`GET /api/cases/[id]`** returns persisted final state for revisits/permalinks.
- **Ingestion is offline.** `scripts/ingest.ts` is run locally by the developer, once, against 5–8 real public policy PDFs (CMS NCD/LCD pages + publicly posted payer medical policies; respect robots.txt/terms — prefer direct public PDF links over crawling). It chunks (~500 tokens, ~50 overlap), embeds via OpenAI, upserts into pgvector with metadata. It is NOT deployed and NOT callable from the app. Don't build a general crawler — that's scope creep.

---

## 4. Supabase schema (commit as a migration SQL file)

```sql
create extension if not exists vector;

create table policy_chunks (
  id uuid primary key default gen_random_uuid(),
  chunk_id text unique not null,        -- human-readable: "{doc_slug}-{page}-{n}"
  payer_name text not null,
  document_title text not null,
  source_url text not null,
  page_number int,
  content text not null,
  embedding vector(1536)
);
create index on policy_chunks using hnsw (embedding vector_cosine_ops);

create table cases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  status text not null default 'processing',   -- processing | done | error
  raw_note text not null,
  extraction jsonb,
  rules_result jsonb,
  citations jsonb,
  decision jsonb,
  appeal_draft jsonb,
  error text
);

-- RPC for similarity search (call via supabase.rpc from the app)
create or replace function match_policy_chunks(
  query_embedding vector(1536), match_count int default 5
) returns table (chunk_id text, payer_name text, document_title text,
                 source_url text, content text, similarity float)
language sql stable as $$
  select chunk_id, payer_name, document_title, source_url, content,
         1 - (embedding <=> query_embedding) as similarity
  from policy_chunks
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

Use the Supabase **service role key only in API routes / scripts** (server-side), never in client code. RLS stays off for this demo since the anon key is never used for writes — state this decision in the README.

---

## 5. Types and schemas (Zod, in `lib/schemas.ts`)

```
ClinicalExtraction: patientAge, diagnosisCodes (ICD-10 strings),
  requestedProcedureCode (CPT/HCPCS), priorTreatmentsTried,
  treatmentFailureDocumented (boolean), clinicalNotesSummary (short, non-verbatim)

PolicyCitation: payerName, documentTitle, sourceChunkId (MUST exist in retrieved set),
  clauseTextParaphrased (always paraphrased, never a long verbatim quote), requirementSummary

RulesEngineResult: eligibleByRules, failedCriteria[], ruleIdsApplied[]

Decision: outcome z.enum(["likely_approve","likely_deny","insufficient_info"]),
  confidence z.enum(["high","medium","low"]), reasoningSummary,
  supportingCitations: PolicyCitation[], rulesResult

AppealDraft: draftText, citedClause: PolicyCitation, requiresHumanReview: z.literal(true)
```

Every LLM response is parsed through its Zod schema. A parse failure retries once, then the node fails closed to `insufficient_info` (never to approve). Zod-at-every-LLM-boundary is a detail an FDE interviewer will notice and ask about — it's deliberate.

Hard invariants enforced IN CODE, not in prompts:
1. If `citations.length === 0` → decision is forced to `insufficient_info` before Claude is even asked to reason.
2. Every `sourceChunkId` in the decision must exist in the retrieved set — validate, retry once, else strip; if none remain, `insufficient_info`.
3. No code path transmits the appeal anywhere (guardrail 3).

---

## 6. Graph nodes

| Node | Type / provider | Input | Output | Notes |
|---|---|---|---|---|
| `extract` | OpenAI, structured output | raw note | `ClinicalExtraction` | Native structured outputs, never "please respond in JSON" |
| `rulesCheck` | Pure TypeScript | `ClinicalExtraction` | `RulesEngineResult` | Zero LLM. See Section 7 |
| `policyRag` | pgvector retrieve + Claude | `ClinicalExtraction` | `PolicyCitation[]` | Embed query from extraction, top-k=5 via `match_policy_chunks`, Claude synthesizes citations from ONLY the retrieved chunk text (never whole documents) |
| `decision` | Claude, structured output | rules + citations | `Decision` | Invariant 1 enforced in code before the call |
| `routeOnDecision` | Conditional edge, pure TS | `Decision` | routes | `likely_deny` → `appealDraft`, else → END |
| `appealDraft` | Claude | `Decision` | `AppealDraft` | Cites the specific `PolicyCitation`; graph simply ends after this — no send node exists |

Retry/failure handling: wrap every LLM node in retry with exponential backoff for transient errors (rate limits, timeouts). A genuinely malformed extraction (e.g., no diagnosis code found) routes to an explicit error state surfaced as "needs manual review," not a crash. Never let a parsing failure silently produce `likely_approve`.

---

## 7. Deterministic rules engine (`lib/rulesEngine.ts` — build FIRST)

Pure TypeScript, zero dependencies, zero LLM. A `RULES` array of `{ ruleId, appliesToCpt, description, check(extraction): boolean }` with 6–8 synthetic rules across ~3 CPT codes, modeled on real public payer medical-necessity patterns:

```ts
// lib/rulesEngine.ts — no LLM calls anywhere in this file
export const RULES = [
  {
    ruleId: "STEP_THERAPY_001",
    appliesToCpt: ["J1745"],            // example: biologic infusion
    description: "Requires 2 documented failed conventional therapies first",
    check: (e: ClinicalExtraction) =>
      e.priorTreatmentsTried.length >= 2 && e.treatmentFailureDocumented,
  },
  {
    ruleId: "AGE_MINIMUM_001",
    appliesToCpt: ["J1745"],
    description: "Patient must be 18 or older",
    check: (e: ClinicalExtraction) => e.patientAge >= 18,
  },
  // + 4-6 more: diagnosis-code match, quantity limit, etc., across 2 more CPT codes
];

export function runRulesEngine(e: ClinicalExtraction): RulesEngineResult { ... }
```

Write vitest unit tests to 100% coverage on this file before anything else exists. This ordering forces the deterministic core to be nailed first, and lets you demo "the part of the system that is NOT AI" independently — a strong interview talking point.

---

## 8. Synthetic data + evals (one dataset, two jobs)

**`scripts/generateSyntheticCases.ts`** → `data/goldenCases.json`: 20–30 hand-shaped synthetic clinical notes (a few paragraphs each, varying diagnosis, age, treatment history), each labeled with the expected outcome. Deliberately construct some to pass the rules engine, some to fail it, and some ambiguous (missing a data point) so `insufficient_info` actually gets exercised. This is both the demo dataset AND the eval golden set — do not build two things.

**`evals/runEvals.ts`** scores the golden set and writes `evals/results/*.json` (committed, so eval history is visible in git log). Metrics per run:
- **Decision accuracy** — outcome matches golden label
- **Extraction field accuracy** — codes/age/history match what was written into the note
- **Citation validity rate** — % of citations whose `sourceChunkId` is real and whose paraphrase is actually supported by that chunk (spot-check a sample manually; note methodology in README)
- **False-approve rate** — `likely_approve` when golden says `likely_deny`. THE metric that matters. Iterate prompts until this is 0 on the golden set.
- **Latency** — end-to-end and per-node (from Langfuse traces)

Evals run as a GitHub Actions step gating deploy. Automated evals in CI — not manual spot-checks — is the single highest-signal detail for an FDE interview.

---

## 9. API surface

```
POST /api/cases            { note, demoKey } → SSE stream of node events, ends with final state
GET  /api/cases/[id]       → persisted final CaseState
GET  /api/health           → 200 OK
```

The POST route exports `runtime = "nodejs"` and `maxDuration = 120`.

---

## 10. Repo structure

```
priorauth-copilot/
├── README.md
├── .github/workflows/ci.yml
├── supabase/migrations/0001_init.sql
├── scripts/
│   ├── ingest.ts                  # local-only policy ingestion
│   └── generateSyntheticCases.ts
├── data/goldenCases.json
├── lib/
│   ├── schemas.ts
│   ├── rulesEngine.ts
│   ├── llm/openai.ts              # extraction + embeddings only
│   ├── llm/claude.ts              # synthesis, decision, appeal only
│   ├── graph/nodes.ts
│   ├── graph/buildGraph.ts
│   ├── supabase.ts
│   └── langfuse.ts
├── app/
│   ├── page.tsx                   # the one UI page
│   ├── api/cases/route.ts         # POST: run graph w/ SSE
│   ├── api/cases/[id]/route.ts    # GET: persisted state
│   └── api/health/route.ts
├── evals/
│   ├── runEvals.ts
│   └── results/
└── tests/
    ├── rulesEngine.test.ts
    └── graph.test.ts              # LLM calls mocked
```

---

## 11. CI workflow (`.github/workflows/ci.yml`)

Jobs on PR and push to main: eslint → tsc --noEmit → vitest → `evals/runEvals.ts --ci-mode` (needs OPENAI_API_KEY / ANTHROPIC_API_KEY / SUPABASE keys as GitHub secrets; allow skipping the eval job on forks). Vercel handles the deploy itself on merge to main; CI green is the gate.

---

## 12. Frontend (explicitly minimal — do not over-invest)

One page:
- Textarea / sample-case picker for a synthetic note, submit button
- Live agent-trace panel rendering SSE node events as they stream (extract → rules → RAG → decision)
- Result panel: outcome badge, confidence, reasoning summary, citation list (linked to source docs), and — if likely_deny — the appeal draft with a copy-to-clipboard button
- Persistent banner: "This is not a coverage decision. Verify with the payer directly. All data shown is synthetic."

Plain React + minimal Tailwind. No component library, no design system. Function over form, explicitly.

---

## 13. Build order (strict — follow this sequence exactly; do not start step N+1 until step N's tests pass)

1. Repo init: Next.js 15 + TS, eslint, vitest, tailwind, `.env.example` naming every key (OPENAI_API_KEY, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, DEMO_KEY). Commit.
2. `lib/rulesEngine.ts` + full unit tests passing. Commit.
3. `lib/schemas.ts` (all Zod schemas). Commit.
4. Supabase migration SQL; run against the project; verify `match_policy_chunks` from a scratch script. Commit.
5. `scripts/generateSyntheticCases.ts` → `data/goldenCases.json`. Commit.
6. `scripts/ingest.ts`; run locally against 5–8 real public policy PDFs; **manually sanity-check retrieval quality with 3 test queries before proceeding.** Commit.
7. `lib/llm/openai.ts` extraction with structured output; test standalone against 3 golden cases. Commit.
8. Graph: nodes + wiring (extract → parallel rulesCheck/policyRag → decision → conditional appealDraft). Test end-to-end via a local script, NOT the UI. Commit.
9. Langfuse instrumentation on every node + LLM call. Commit.
10. API routes with SSE streaming + Supabase persistence. Test with curl. Commit.
11. Eval harness; **iterate prompts until false-approve = 0 and decision accuracy is high on the golden set.** Commit results JSON.
12. Minimal UI page. Commit.
13. CI workflow. Commit.
14. Deploy to Vercel, set env vars, smoke-test live. Write the README last (Section 15), once everything actually works.

Do not build the frontend before the graph works end-to-end via curl. Do not add Langfuse before the graph runs at all. Sequencing matters — jumping around produces inconsistent schemas across files.

---

## 14. Strict rules for the coding agent (in force for every session of this build)

1. **Never invent a library or API that doesn't exist.** Verify `@langchain/langgraph` JS APIs against the installed version's types before use — do not transcribe Python LangGraph patterns into JS from memory; the APIs differ, and the package moves fast.
2. **Never touch `lib/rulesEngine.ts` with an LLM call.** If you find yourself importing an LLM client in that file, stop — that's the guardrail this whole project demonstrates.
3. **Every LLM call uses native structured output / tool-calling + Zod parse.** No `JSON.parse` of raw model text without schema validation. Freeform JSON-in-a-prompt is fragile and signals an inexperienced build.
4. **One provider per node.** Never call OpenAI from `lib/llm/claude.ts` or vice versa.
5. **Every commit leaves the repo in a working state.** Finish the vertical slice (schema → node → wiring → test) before moving on. No half-wired nodes on main.
6. **Write the unit test with the logic, not "later."** "Later" doesn't happen in a 1–2 afternoon build. If a test is genuinely skipped, leave an explicit `TODO` with the reason.
7. **No secrets in code, ever, even temporarily.** `.env` from the first commit, `.gitignore`'d. Check `git diff` before every commit.
8. **No new npm dependencies** beyond: next, react, zod, @langchain/langgraph, @langchain/core, openai, @anthropic-ai/sdk, @supabase/supabase-js, langfuse, tailwindcss, vitest, eslint + configs, pdf-parse (ingest script only), tsx (scripts). Anything else requires explicit human approval.
9. **No silent deviations from this document.** If mid-build you believe Y is better than the specified X, say so explicitly ("spec says X, I think Y because Z — proceed with Y or stick with X?") and wait. Deviations are visible decisions, never silent scope creep.
10. **Fail closed everywhere** (Section 1, guardrail 6).
11. **`runtime = "nodejs"`, `maxDuration = 120`** exported from the POST route — the graph exceeds edge/default limits otherwise.
12. **Keep it readable.** Total app code small enough to read in 30 minutes; split any file exceeding ~200 lines; comment the "why" of non-obvious decisions, never the "what" of obvious lines.
13. **When something fails twice, stop guessing.** Paste the real error/stack trace and reason from it rather than trying five blind variations.
14. **End every session green.** Run the full test suite (and evals, once they exist) before stopping. Never leave main failing CI.

---

## 15. README structure (write last — it's what a recruiter actually reads)

1. One-paragraph summary (adapt Section 0)
2. As-is / future-state process diagrams (embed the two SVG/PNG exports from planning)
3. "Why this isn't just a chatbot" — 4–5 bullets from Section 1's guardrails, written for a non-technical reader
4. Architecture diagram (Section 3)
5. Tech stack table + the multi-provider rationale (Section 2)
6. Eval results summary — actual numbers from the latest run, never placeholders
7. "Try it live" link + synthetic-data disclaimer
8. Local setup instructions
9. "What I'd build next for production" — 3–4 honest bullets (real FHIR API integration per CMS-0057-F, multi-payer policy coverage, PHI-compliant infra with BAAs, OAuth2/JWT + multi-tenancy). This section is an FDE-specific signal: it shows you understand the gap between a demo and a real deployment, which is literally the job.

---

## 16. Explicit non-goals (actively do NOT build)

- No Docker, Kubernetes, microservices, queues, or background workers — serverless + synchronous SSE is the correct scope
- No real payer API integration (requires credentialing/contracts) — RAG over public policy PDFs is the honest, achievable version of real integration here
- No user accounts / multi-tenancy — single demo instance
- No frontend framework beyond plain React + Tailwind in the Next.js app
- No fine-tuning — the AI-depth signal is orchestration + RAG + guardrails + evals, not training

---

## 17. Definition of done

- Live Vercel URL where a recruiter can pick a sample note, watch the agent trace stream in live, and see a cited decision (plus appeal draft on likely_deny)
- `data/goldenCases.json` + committed eval results showing decision accuracy and **false-approve = 0**
- Green CI on main with the eval suite gating
- README per Section 15, with real numbers

---

*End of blueprint. Build in the Section 13 order, follow Section 14 without exception, and do not let scope drift past Section 16.*
