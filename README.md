<p align="center">
  <strong>PriorAuth Copilot</strong><br/>
  LangGraph prior-authorization decision support — rules-first outcomes, policy-grounded citations, eval-gated quality.<br/>
  <strong>✅ Project 1 — CLOSED &amp; COMPLETE</strong> · <a href="docs/PROJECT_STATUS.md">Status</a>
</p>

<p align="center">
  <a href="https://priorauth-copilot-swart.vercel.app/"><strong>Live demo</strong></a> ·
  <a href="https://cloud.langfuse.com/project/cmrdrenon00chad0c3bi1gcoe">Langfuse</a> ·
  <a href="docs/MIGRATIONS.md">Migrations</a> ·
  <a href="docs/blueprint.md">Blueprint</a> ·
  <a href="docs/PROJECT_DEEP_DIVE.md">Deep dive</a>
</p>

---

## At a glance

| | |
|---|---|
| **Problem** | Prior-auth reviewers need structured facts, payer policy citations, and a defensible approve/deny/insufficient signal — without the LLM inventing outcomes. |
| **Approach** | LangGraph pipeline: extract → rules + RAG in parallel → **code-forced outcome** → optional appeal draft. LLMs synthesize citations and prose; TypeScript owns the decision. |
| **Default demo** | [CASE-001 instant replay](https://priorauth-copilot-swart.vercel.app/) — **no API key, no LLM cost**, real CareSource PDF links |
| **Regression gate** | **100 / 0 / 100** verified post-optimization — [`evals/results/2026-07-10T02-38-26-825Z.json`](evals/results/2026-07-10T02-38-26-825Z.json) (`--no-cache`, CI [`workflow_dispatch`](https://github.com/asorari09/priorauth-copilot/actions/runs/29065131002) green) |
| **Measured cost** | **~$0.003/case** approve · **~$0.006/case** deny (Langfuse, full eval run) · **~90%** vs Sonnet baseline (~$0.041) |
| **Stack** | Next.js 15 · LangGraph · OpenAI extract · Claude Haiku citations/appeals · Supabase pgvector · Langfuse |

**Full deep dive:** [`docs/PROJECT_DEEP_DIVE.md`](docs/PROJECT_DEEP_DIVE.md)

---

## System design

### Live UI (production)

<p align="center">
  <img src="docs/ui-case001-approve.png" alt="PriorAuth Copilot — CASE-001 approve replay on desktop" width="960"/>
</p>

<p align="center"><sub>Desktop — CASE-001 Instant Replay: honest <code>stored_result</code> timeline, <code>likely_approve</code>, CareSource citations with real PDF links.</sub></p>

<p align="center">
  <img src="docs/ui-case004-deny-appeal.png" alt="PriorAuth Copilot — CASE-004 deny with appeal draft" width="960"/>
</p>

<p align="center"><sub>Desktop — CASE-004 Instant Replay: <code>likely_deny</code>, purple-bordered citations, amber appeal draft with human-review badge.</sub></p>

<p align="center">
  <img src="docs/ui-mobile-case001.png" alt="PriorAuth Copilot mobile stacked layout" width="390"/>
</p>

<p align="center"><sub>Mobile (390px) — three columns stack: input → trace → outcome.</sub></p>

### Architecture

<p align="center">
  <img src="docs/architecture-diagram.png" alt="PriorAuth Copilot system architecture — actual demo UI, LangGraph pipeline, Supabase, and Langfuse" width="960"/>
</p>

<p align="center"><sub>Diagram reflects the shipped system only — single-page demo, code-forced outcomes, honest preset replay path.</sub></p>

### Live pipeline (LangGraph)

```mermaid
flowchart TB
  subgraph Client["Browser — actual demo UI"]
    DD[Demo scenario dropdown]
    TA[Clinical note textarea]
    BTN[Run button]
    TR[Agent Trace panel]
    RS[Result + citations]
    DD --> BTN
    TA --> BTN
    BTN --> TR
    BTN --> RS
  end

  subgraph Vercel["Vercel — Next.js API"]
    API["POST /api/cases\nSSE stream"]
    Replay{{"Preset replay?\n(stored_result)"}}
    Graph[LangGraph compile]
  end

  subgraph Pipeline["LangGraph nodes"]
    E[extract\nOpenAI gpt-4o-mini]
    R[rulesCheck\nTypeScript engine]
    P[policyRag\npgvector + Claude Haiku]
    D[decide\noutcome forced in code\ntemplate reasoning]
    A[draftAppeal\nClaude Haiku\ndeny path only]
  end

  subgraph Data["Supabase Postgres"]
    PC[(policy_chunks\nHNSW vectors)]
    CS[(cases\nlive runs only)]
    CC[(citation_cache\ninference cache)]
  end

  LF[(Langfuse traces)]

  BTN -->|SSE| API
  API --> Replay
  Replay -->|stored_result event| TR
  Replay -->|citations + decision| RS
  API --> Graph
  Graph --> E
  E --> R
  E --> P
  R --> D
  P --> D
  D -->|likely_deny| A
  D -->|approve / insufficient| END((done))
  A --> END
  P <--> PC
  P <--> CC
  A <--> CC
  Graph --> CS
  E & P & A -.-> LF
  Graph -.->|priorauth-case-run| LF
  Replay -.->|priorauth-preset-replay\nreplay: true| LF
```

### Request paths: replay vs live

```mermaid
sequenceDiagram
  participant U as User
  participant API as /api/cases
  participant DB as Supabase
  participant G as LangGraph
  participant LF as Langfuse

  alt Any preset cached (default)
    U->>API: presetCaseId, no demo key
    API->>LF: trace preset-replay (replay: true)
    Note over API,DB: No cases row inserted
    API-->>U: SSE stored_result + real citations
  else Live pipeline
    U->>API: x-demo-key + runLive
    API->>DB: insert cases (processing)
    API->>G: stream graph
    G->>DB: update cases (done)
    API->>LF: trace priorauth-case-run
    API-->>U: SSE node events + decision
  end
```

### Data model

```mermaid
erDiagram
  policy_chunks {
    text chunk_id PK
    text payer_name
    text document_title
    text source_url
    text content
    vector embedding
  }
  cases {
    uuid id PK
    text status
    text raw_note
    jsonb extraction
    jsonb rules_result
    jsonb citations
    jsonb decision
    jsonb appeal_draft
  }
  citation_cache {
    text cache_key PK
    text cache_kind
    jsonb payload
  }
  policy_chunks ||--o{ cases : "chunk_ids in citations"
  citation_cache ||--o{ cases : "cache warms live runs"
```

---

## Demo modes

| Scenario | Demo key | LLM | What you see |
|----------|----------|-----|--------------|
| **All five demo scenarios** | Not required | None | Instant replay from verified production runs (incl. CASE-004 deny + appeal draft) |
| **Custom note + live** | Required | Yes | Real-time SSE node trace |

Open the [live app](https://priorauth-copilot-swart.vercel.app/) → keep **CASE-001** → click **Run (instant cached demo)**. Click any **source document** link — it resolves to a real payer PDF, not a placeholder.

---

## Who decides what

| Step | Engine | LLM? | Role |
|------|--------|------|------|
| Extraction | OpenAI `gpt-4o-mini` | Yes | Structured clinical facts from free text |
| Rules check | `lib/rulesEngine.ts` | **No** | Deterministic eligibility (step therapy, age, qty, diagnosis) |
| Policy RAG | pgvector + Claude Haiku | Yes (cacheable) | Retrieve chunks; synthesize **validated** citations |
| **Outcome** | `determineOutcomeConstraint()` | **No** | **Always code-set** — never LLM-chosen |
| Reasoning prose | `templateReasoning.ts` (default) | **No** | Rules + citation summaries + unverified items |
| Appeal draft | Claude Haiku | Yes (cacheable) | Deny-path letter only; human review required |

---

## Caching layers

| Layer | Key | Skips | Honest labeling |
|-------|-----|-------|-----------------|
| Preset replay | `presetCaseId` | Entire graph | UI banner + `replay: true` + Langfuse tag `replay` |
| Citation synthesis | `sha256(CPT + sorted chunk_ids)` | Haiku call | `citation_cache` table |
| Appeal draft | content-hash | Haiku call | same table, `cache_kind=appeal_draft` |
| Eval freshness | `--no-cache` flag | All inference cache | Used for regression runs |

Cached replays **do not insert** into `cases` — demo traffic does not pollute live case data.

---

<br/>

<details>
<summary><strong>Reference — setup, commands, eval, and operations</strong></summary>

### Local setup

```bash
git clone https://github.com/asorari09/priorauth-copilot.git
cd priorauth-copilot
npm install
cp .env.example .env    # fill keys
```

Apply migrations — see [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md) (`0001_init.sql` then `0002_citation_cache.sql`).

```bash
npm run dev
```

### Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `REASONING_MODE` | `template` | `template` = zero-cost reasoning; `llm` = Haiku prose |
| `ANTHROPIC_MODEL_FAST` | `claude-haiku-4-5-20251001` | Citations + appeals |
| `DEMO_KEY` | — | Required for live API runs (not cached CASE-001) |
| `SUPABASE_*` | — | Policy RAG, cases, inference cache |
| `LANGFUSE_*` | — | Traces: `priorauth-case-run` / `priorauth-preset-replay` |

### API smoke tests

```bash
# Health
curl -s https://priorauth-copilot-swart.vercel.app/api/health

# Cached CASE-001 — no key
curl -N -X POST https://priorauth-copilot-swart.vercel.app/api/cases \
  -H "Content-Type: application/json" \
  -d '{"note":"<CASE-001 note>","presetCaseId":"CASE-001"}'

# Live run — key required
curl -N -X POST https://priorauth-copilot-swart.vercel.app/api/cases \
  -H "Content-Type: application/json" \
  -H "x-demo-key: $DEMO_KEY" \
  -d '{"note":"<note>","presetCaseId":"CASE-001","runLive":true}'
```

### Eval suite

34 synthetic golden cases in `data/goldenCases.json` (26 clean + 3 messy-prose + regressions including date-derived duration and categorical-age). Extraction verified at 100% structured-field accuracy on both clean and realistic clinician-shorthand prose; summary fields scored for presence, not wording; out-of-scope procedures and thin-evidence cases fail closed to insufficient_info.

```bash
npm run eval                      # uses inference cache
npm run eval -- --no-cache        # fresh synthesis (regression)
npm run eval -- --case CASE-001   # single spot check
npm run rebuild:presets           # rebuild demo JSON from Supabase (no LLM)
```

**CI:** every push → lint, tsc, vitest. **Eval** → manual `workflow_dispatch` only; exits non-zero unless **100 / 0 / 100**.

### Cost model (measured — post-optimization full eval, `--no-cache`)

Source: Langfuse `priorauth-case-run` traces from [`2026-07-10T02-38-26-825Z.json`](evals/results/2026-07-10T02-38-26-825Z.json) (26 cases, 100/0/100 gate).

| Scenario | Measured $/case | Billed |
|----------|-----------------|--------|
| **Preset replay** | **$0** | Nothing |
| **Live approve** (n=10) | **$0.0033** | gpt-4o-mini extract + Haiku citation synthesis |
| **Live deny** (n=12) | **$0.0057** | Above + Haiku appeal draft |
| **Insufficient info** (n=4) | **$0.0029** | Extract + citations (no appeal) |
| **All cases avg** (n=26) | **$0.0043** | — |
| **Sonnet baseline** (pre-opt) | ~$0.041 | citation + decision + appeal on Sonnet 4.6 |

**Reduction vs baseline:** ~**92%** approve path · ~**86%** deny path · ~**89%** blended.

Representative trace: [`88046535-fa61-47e5-bdf3-5ecb9e9aa476`](https://cloud.langfuse.com/project/cmrdrenon00chad0c3bi1gcoe/traces/88046535-fa61-47e5-bdf3-5ecb9e9aa476) (CASE-001, $0.0032).

<p align="center">
  <img src="docs/langfuse-post-optimization.png" alt="Langfuse dashboard — trace volume, cost by model, and observation breakdown for priorauth-case-run" width="900"/>
</p>

<p align="center"><sub>Langfuse project dashboard — cumulative traces across development; per-case costs above are from the isolated post-optimization eval window.</sub></p>

### Key files

| Path | Role |
|------|------|
| `app/api/cases/route.ts` | SSE API — replay vs live, demo key gate |
| `lib/graph/buildGraph.ts` | LangGraph wiring |
| `lib/graph/nodes.ts` | Extract, RAG, decide, appeal nodes |
| `lib/rulesEngine.ts` | Deterministic rules |
| `lib/cache/presetDemo.ts` | Preset + live-only manifest |
| `data/presetDemoResults.json` | Verified cached results for all 5 demo scenarios |
| `data/liveOnlyPresets.json` | Empty when all presets have stored snapshots |
| `evals/runEvals.ts` | Eval runner + regression gate |
| `.github/workflows/ci.yml` | Quality + dispatch eval |

### Development

```bash
npm run lint && npx tsc --noEmit && npm test
```

### Observability

[Langfuse project](https://cloud.langfuse.com/project/cmrdrenon00chad0c3bi1gcoe) — filter live runs vs replays via trace name or `replay` metadata/tag. Dashboard snapshot: [`docs/langfuse-post-optimization.png`](docs/langfuse-post-optimization.png).

</details>

---

<p align="center">
  <sub>Synthetic data only · Not a coverage decision · Verify with the payer directly</sub>
</p>
