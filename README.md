# PriorAuth Copilot

Prior-authorization decision-support demo built with Next.js 15, LangGraph, OpenAI extraction, Claude (citation synthesis + reasoning prose + appeal drafts), Supabase policy RAG, and Langfuse observability.

Outcomes are **code-determined** by deterministic rules and citation guardrails; the LLM never chooses `likely_approve | likely_deny | insufficient_info` — it only generates reasoning summaries (and appeal text on denies).

Production is deployed on Vercel with health check, `x-demo-key` auth gate, and SSE streaming.

## Local setup

```bash
npm install
cp .env.example .env   # fill in API keys
npm run dev
```

Required env vars are listed in `.env.example`. Model routing for cost optimization:

| Variable | Default | Used for |
|----------|---------|----------|
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Appeal drafts (deny path only) |
| `ANTHROPIC_MODEL_FAST` | `claude-haiku-4-5-20251001` | Citation synthesis |
| `ANTHROPIC_MODEL_REASONING` | falls back to `ANTHROPIC_MODEL_FAST` | Decision reasoning prose |

Flip decision reasoning back to Sonnet by setting `ANTHROPIC_MODEL_REASONING=claude-sonnet-4-6` — no code change required.

## API smoke test

```bash
# Health (free)
curl -s http://localhost:3000/api/health

# Case run (~$0.013/case after optimization; requires DEMO_KEY)
curl -N -X POST http://localhost:3000/api/cases \
  -H "Content-Type: application/json" \
  -H "x-demo-key: $DEMO_KEY" \
  -d '{"note": "<clinical note from data/goldenCases.json>"}'
```

## Eval suite

26 golden cases in `data/goldenCases.json`. Regression gate: **26/26 decision accuracy, 0 false-approves, 100% citation validity**.

```bash
npm run eval              # full suite (~$0.35–0.40 after optimization)
npm run eval -- --case CASE-001   # single-case spot check
```

**Do not run the full eval during iteration** — use single-case spot checks only unless explicitly approved (~$0.70 pre-optimization).

### Verification protocol (post-credit top-up)

1. Three spot checks: CASE-001 (approve + citation quality), CASE-004 (deny + appeal), CASE-008 (insufficient) — ~$0.05 total
2. One full 26-case eval only if all three pass
3. Commit with before/after cost numbers if 26/26 holds

### Architecture: who decides what

| Step | Engine | Role |
|------|--------|------|
| Extraction | OpenAI (`gpt-4o-mini`) | Structured clinical facts from free text |
| Rules check | TypeScript rules engine | Deterministic eligibility (zero LLM) |
| Policy RAG | pgvector + Haiku | Retrieve chunks; synthesize validated citations |
| **Outcome** | **TypeScript (`determineOutcomeConstraint`)** | **Always sets `likely_approve \| likely_deny \| insufficient_info`** |
| Reasoning prose | Haiku | Explains the code-determined outcome; lists unverified requirements |
| Appeal draft | Sonnet | Deny-path letter only; human copies out |

The LLM does not adjudicate. Previously, Claude proposed an outcome via `emit_decision` and code overrode on mismatch (`overrideLog` captured disagreements). That path is removed: outcomes are purely code-determined and Claude only narrates. `overrideLog` remains in the wire schema for compatibility but is always empty.

### Per-node cost model

Measured from Langfuse (`priorauth-case-run` traces, July 2026). Targets are **cost per case at equal eval accuracy**.

#### Before optimization (~$0.045/case avg)

| Node | Model | ~Cost/call | % of case | Notes |
|------|-------|------------|-----------|-------|
| Citation synthesis | Sonnet 4.6 | $0.022 | ~50% | All 5 retrieved chunks, full content (~1,539 input tok) |
| Decision | Sonnet 4.6 | $0.011 | ~30% | `emit_decision` proposed outcome; code overrode on mismatch (`overrideLog`) |
| Appeal draft | Sonnet 4.6 | $0.017 | deny only | Legitimate writing-quality use |
| Decision reasoning | Sonnet 4.6 | $0.004 | edge cases | Reasoning-only path when citations empty |
| Extraction | gpt-4o-mini | $0.00009 | — | Already optimal |

Hidden multiplier: retry loop retried non-retryable 4xx errors (doubled latency + Langfuse noise on credit failures).

#### After optimization (~$0.013/case avg projected)

Savings come from three levers: smaller payloads, cheaper models per task, and removing the redundant `emit_decision` call.

| Node | Model | ~Cost/call | Savings lever |
|------|-------|------------|---------------|
| Citation synthesis | Haiku 4.5 | ~$0.004 | Top-3 chunks by similarity, ~300 tok/chunk truncation, 3× cheaper model |
| Decision reasoning | Haiku 4.5 | ~$0.002 | Reasoning-only (outcome never sent to LLM); citation summaries not full objects |
| Appeal draft | Sonnet 4.6 | ~$0.017 | Unchanged — writing showcase on deny path |
| Extraction | gpt-4o-mini | $0.00009 | Unchanged |

**Prompt caching:** `cache_control: ephemeral` is wired on static system prompts in `lib/llm/claude.ts` as a forward-looking pattern. At current prompt sizes (one-line system strings, well below Anthropic's minimum cacheable prefix of ~1–4K tokens depending on model), caching is silently ignored and contributes **~$0** to savings. Do not count it in the cost model until prompts grow large enough to cross the threshold.

**Projected reduction: ~$0.045 → ~$0.013/case (~70%), pending 26/26 eval confirmation.**

#### Model-routing rationale

- **Citation synthesis → Haiku:** Constrained extract-and-paraphrase with code-level validation (invalid chunk IDs stripped; empty → `insufficient_info`). Worst case is a safe outcome, not a wrong one.
- **Decision reasoning → Haiku:** Outcome is always set by `determineOutcomeConstraint` before any LLM call; Claude writes prose only. Configurable via `ANTHROPIC_MODEL_REASONING`.
- **Appeal draft → Sonnet:** Only fires on `likely_deny`; quality matters for the demo narrative.

Architecture invariants preserved: fail-closed behavior, citation validation, code-forced outcome constraints, wire-schema separation.

## Development

```bash
npm run lint
npx tsc --noEmit
npm test
```

CI (`.github/workflows/ci.yml`): eslint → tsc → vitest on every push/PR. Eval job runs on `workflow_dispatch` or changes to `lib/**`, `evals/**`, `data/**`.

## Key files

| File | Role |
|------|------|
| `lib/graph/nodes.ts` | LangGraph nodes — citation synthesis, decision, appeal |
| `lib/llm/claude.ts` | Claude structured calls, retry policy, prompt-cache wiring (no savings at current prompt sizes), model routing |
| `lib/llm/openai.ts` | Clinical extraction (don't touch) |
| `lib/clientErrors.ts` | Error sanitization for client/SSE |
| `app/api/cases/route.ts` | SSE API route |
| `evals/runEvals.ts` | Golden-case eval runner |
| `data/goldenCases.json` | CASE-001 through CASE-026 |

## Langfuse

Project: [cloud.langfuse.com](https://cloud.langfuse.com/project/cmrdrenon00chad0c3bi1gcoe)

Traces are named `priorauth-case-run`. Generation spans: `openai.extract`, `claude.citation_synthesis`, `claude.decision_reasoning`, `claude.appeal_draft`.
