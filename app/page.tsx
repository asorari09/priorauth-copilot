"use client";

import { FormEvent, useMemo, useState } from "react";

import { isLiveOnlyPreset } from "@/lib/cache/presetDemo";
import { renderReasoningMarkdown } from "@/lib/renderMarkdown";

type Outcome = "likely_approve" | "likely_deny" | "insufficient_info";

type EventRow = {
  node: string;
  summary: unknown;
  timestamp: string;
  replay?: boolean;
};

type PolicyCitation = {
  payerName: string;
  documentTitle: string;
  sourceChunkId: string;
  requirementSummary: string;
};

type RetrievedChunk = {
  chunk_id: string;
  source_url: string;
};

type Decision = {
  outcome: Outcome;
  confidence: "high" | "medium" | "low";
  reasoningSummary: string;
  supportingCitations: PolicyCitation[];
  rulesResult?: {
    eligibleByRules: boolean;
    failedCriteria: string[];
    ruleIdsApplied: string[];
  };
};

type DonePayload = {
  caseId: string;
  cached?: boolean;
  replay?: boolean;
  presetCaseId?: string;
  decision?: Decision;
  appealDraft?: { draftText: string; requiresHumanReview: boolean };
  retrievedChunks?: RetrievedChunk[];
};

const GITHUB_REPO = "https://github.com/asorari09/priorauth-copilot";

const SAMPLE_CASES = [
  {
    id: "CASE-001",
    label: "CASE-001 approve (instant demo)",
    note: `SYNTHETIC CASE CASE-001: Prior authorization intake for patient A. The ordering clinician documented diagnosis codes (K50.90) and requested procedure J1745. The patient is 29 years old and presented for coverage review in a routine outpatient workflow.\n\nChart review states prior management included mesalamine and azathioprine. Treatment failure was documented as true in the assessment narrative. The progress note summary reads: "Adult Crohn disease with two failed therapies and dose within limit."\n\nRequested infusion quantity is 6 units for this authorization period.`,
  },
  {
    id: "CASE-004",
    label: "CASE-004 deny (instant demo)",
    note: `SYNTHETIC CASE CASE-004: Prior authorization intake for patient D. The ordering clinician documented diagnosis codes (K50.90) and requested procedure J1745. The patient is 4 years old and presented for coverage review in a routine outpatient workflow.\n\nChart review states prior management included mesalamine and azathioprine. Treatment failure was documented as true in the assessment narrative. The progress note summary reads: "Pediatric Crohn patient meets therapy history but is younger than six."\n\nRequested infusion quantity is 5 units for this authorization period.`,
  },
  {
    id: "CASE-008",
    label: "CASE-008 insufficient (instant demo)",
    note: `SYNTHETIC CASE CASE-008: Prior authorization intake for patient H. The ordering clinician documented diagnosis codes (K50.90) and requested procedure J1745. The patient is 48 years old and presented for coverage review in a routine outpatient workflow.\n\nChart review states prior management included azathioprine and mesalamine. Treatment failure was documented as true in the assessment narrative. The progress note summary reads: "Crohn disease with step therapy met but infusion units not documented."\n\nOutside infusion-center paperwork did not list the exact number of units requested.`,
  },
  {
    id: "CASE-017",
    label: "CASE-017 MRI approve (instant demo)",
    note: `SYNTHETIC CASE CASE-017: Prior authorization intake for patient Q. The ordering clinician documented diagnosis codes (G40.909) and requested procedure 70553. The patient is 25 years old and presented for coverage review in a routine outpatient workflow.\n\nChart review states prior management included levetiracetam. Treatment failure was documented as true in the assessment narrative. The progress note summary reads: "Seizure disorder code present with prior imaging abnormalities documented."\n\nNeurologic deficits are documented as absent in the exam. Prior imaging or focal findings are documented as present.`,
  },
  {
    id: "CASE-025",
    label: "CASE-025 canary (instant demo)",
    note: `SYNTHETIC CASE CASE-025: Prior authorization intake for patient Y. The ordering clinician documented diagnosis codes (Z99.89) and requested procedure J9999. The patient is 25 years old and presented for coverage review in a routine outpatient workflow.\n\nChart review states prior management included therapy alpha, therapy beta, and therapy gamma. Treatment failure was documented as true in the assessment narrative. The progress note summary reads: "Meridian synthetic canary request documents exactly three failed prior therapies and age twenty-five."\n\nSYNTHETIC Meridian Health Plan context: fictional policy for J9999 states exactly three failed therapies and age twenty-one or older.`,
  },
] as const;

const PIPELINE_LEGEND = [
  { name: "extract", kind: "llm" as const, color: "text-warning-amber", label: "Extract" },
  { name: "rulesCheck", kind: "deterministic" as const, color: "text-success-green", label: "Rules Check" },
  { name: "policyRag", kind: "retrieval" as const, color: "text-retrieval-purple", label: "Policy RAG" },
  { name: "decide", kind: "deterministic" as const, color: "text-success-green", label: "Decide (Code)" },
  { name: "draftAppeal", kind: "llm" as const, color: "text-warning-amber", label: "Appeal Draft" },
];

type NodeKind = "deterministic" | "llm" | "retrieval" | "replay";

function nodeKind(node: string, replay?: boolean): NodeKind {
  if (replay || node === "stored_result") return "replay";
  if (node === "policyRag") return "retrieval";
  if (node === "extract" || node === "draftAppeal") return "llm";
  return "deterministic";
}

function nodeDotClass(kind: NodeKind): string {
  switch (kind) {
    case "llm":
      return "bg-warning-amber";
    case "retrieval":
      return "bg-retrieval-purple";
    case "replay":
      return "bg-secondary";
    default:
      return "bg-success-green";
  }
}

function nodeDotGlyph(kind: NodeKind): string {
  switch (kind) {
    case "llm":
      return "◆";
    case "retrieval":
      return "◇";
    case "replay":
      return "↻";
    default:
      return "✓";
  }
}

function summarizeNodeEvent(node: string, summary: unknown, replay?: boolean): string {
  if (replay || node === "stored_result") {
    const payload = summary as { message?: string; presetCaseId?: string } | null;
    return (
      payload?.message ??
      `Loaded stored verified result${payload?.presetCaseId ? ` for ${payload.presetCaseId}` : ""} — no LLM calls made`
    );
  }

  const payload = (summary ?? {}) as {
    keys?: string[];
    outcome?: string | null;
    citationsCount?: number;
    hasAppealDraft?: boolean;
    error?: { message?: string };
  };

  if (payload.error?.message) return payload.error.message;
  if (node === "decide" && payload.outcome) return `Outcome set in code: ${payload.outcome}`;
  if (node === "policyRag" && typeof payload.citationsCount === "number") {
    return `Retrieved policy chunks; ${payload.citationsCount} citation${payload.citationsCount === 1 ? "" : "s"} synthesized`;
  }
  if (node === "draftAppeal" && payload.hasAppealDraft) {
    return "Appeal letter draft generated — human review required";
  }
  if (node === "extract") return "Structured clinical facts extracted from free-text note";
  if (node === "rulesCheck") return "Deterministic eligibility rules evaluated (zero LLM)";
  if (node === "__start__" || node === "START") return "Graph started";
  if (Array.isArray(payload.keys) && payload.keys.length > 0) {
    return `Updated state: ${payload.keys.slice(0, 4).join(", ")}`;
  }
  return `Completed ${node}`;
}

function truncateChunkId(chunkId: string, max = 28): string {
  if (chunkId.length <= max) return chunkId;
  return `${chunkId.slice(0, max - 1)}…`;
}

function parseSseBuffer(buffer: string): { events: Array<{ event: string; data: string }>; rest: string } {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = blocks
    .map((block) => {
      const lines = block.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLines = lines.filter((line) => line.startsWith("data:"));
      return {
        event: eventLine ? eventLine.slice(6).trim() : "message",
        data: dataLines.map((line) => line.slice(5).trim()).join("\n"),
      };
    })
    .filter((entry) => entry.data.length > 0);
  return { events, rest };
}

function emphasizeConstraintPhrases(text: string) {
  const phrases = [
    "must",
    "requires",
    "at least",
    "all of the following",
    "documented",
    "prior authorization",
    "medical necessity",
  ];
  const regex = new RegExp(`(${phrases.map((p) => p.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")).join("|")})`, "gi");
  const parts = text.split(regex);
  return parts.map((part, idx) =>
    phrases.some((phrase) => phrase.toLowerCase() === part.toLowerCase()) ? (
      <strong key={`${part}-${idx}`}>{part}</strong>
    ) : (
      <span key={`${part}-${idx}`}>{part}</span>
    ),
  );
}

function outcomeBarClass(outcome: Outcome): string {
  switch (outcome) {
    case "likely_approve":
      return "bg-success-green";
    case "likely_deny":
      return "bg-error-red";
    default:
      return "bg-warning-amber";
  }
}

function outcomeBadgeClass(outcome: Outcome): string {
  switch (outcome) {
    case "likely_approve":
      return "bg-[#D1FAE5] text-[#065F46]";
    case "likely_deny":
      return "bg-[#FEE2E2] text-[#991B1B]";
    default:
      return "bg-[#FEF3C7] text-[#92400E]";
  }
}

export default function Home() {
  const [selectedCaseId, setSelectedCaseId] = useState<string>(SAMPLE_CASES[0].id);
  const [note, setNote] = useState<string>(SAMPLE_CASES[0].note);
  const [demoKey, setDemoKey] = useState("");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [done, setDone] = useState<DonePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runLive, setRunLive] = useState(false);

  const selectedIsLiveOnly = isLiveOnlyPreset(selectedCaseId);
  const requiresDemoKey = runLive || selectedIsLiveOnly;
  const fullPipelineSelected = runLive || selectedIsLiveOnly;

  const pipelineHelperText = selectedIsLiveOnly
    ? "This scenario has no stored snapshot — a live pipeline run is always required."
    : runLive
      ? "Switch to Instant Replay to load the stored verified result with zero LLM calls."
      : "Instant Replay loads a stored verified result. Full Pipeline executes live LLM calls.";

  const chunkUrlById = useMemo(() => {
    const map = new Map<string, string>();
    for (const chunk of done?.retrievedChunks ?? []) map.set(chunk.chunk_id, chunk.source_url);
    return map;
  }, [done]);

  async function runCase(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEvents([]);
    setDone(null);
    setError(null);
    setIsRunning(true);

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (requiresDemoKey && demoKey) {
      headers["x-demo-key"] = demoKey;
    }

    try {
      const response = await fetch("/api/cases", {
        method: "POST",
        headers,
        body: JSON.stringify({
          note,
          presetCaseId: SAMPLE_CASES.some((sampleCase) => sampleCase.id === selectedCaseId)
            ? selectedCaseId
            : undefined,
          runLive: runLive || selectedIsLiveOnly,
        }),
      });

      if (!response.ok || !response.body) {
        setIsRunning(false);
        if (response.status === 401) {
          setError("Live runs require a valid demo key. Cached presets work without a key.");
        } else if (response.status === 400) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? "This scenario cannot run in cached mode.");
        } else {
          setError("Unable to run case right now. Please retry.");
        }
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });

        const parsed = parseSseBuffer(buffer);
        buffer = parsed.rest;

        for (const event of parsed.events) {
          const payload = JSON.parse(event.data) as Record<string, unknown>;
          if (event.event === "node") {
            const summary = payload.summary ?? {};
            const replay =
              typeof summary === "object" &&
              summary !== null &&
              (summary as { replay?: boolean }).replay === true;
            setEvents((prev) => [
              ...prev,
              {
                node: String(payload.node ?? "unknown"),
                summary,
                timestamp: new Date().toLocaleTimeString(),
                replay,
              },
            ]);
          }
          if (event.event === "done") {
            setDone(payload as unknown as DonePayload);
            setIsRunning(false);
          }
          if (event.event === "error") {
            setError("The run failed. Please review your note and try again.");
            setIsRunning(false);
          }
        }
      }
    } catch {
      setError("We could not complete this run. Please try again.");
      setIsRunning(false);
    }
  }

  const rulesPassedLabel = (() => {
    if (!done?.decision?.rulesResult) return null;
    const rules = done.decision.rulesResult;
    const y = rules.ruleIdsApplied.length;
    const x = Math.max(0, y - (rules.failedCriteria.length ?? 0));
    return `Rules passed: ${x}/${y}`;
  })();

  return (
    <div className="flex min-h-screen flex-col bg-surface text-foreground">
      {/* Slim disclaimer banner */}
      <div className="flex items-center justify-center gap-2 border-b border-surface-border bg-surface-high px-4 py-2 text-center text-[13px] leading-[18px] text-on-surface-variant">
        <span aria-hidden>ⓘ</span>
        <span>Not a coverage decision · Synthetic data only · Verify with the payer directly</span>
      </div>

      {/* Slim product header — no invented nav */}
      <header className="border-b border-surface-border bg-surface-lowest">
        <div className="mx-auto flex w-full max-w-[1280px] items-center gap-4 px-6 py-4 md:px-8">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-black text-sm font-bold text-white">
            PA
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-semibold tracking-[-0.01em] text-black">PriorAuth Copilot</div>
            <p className="truncate text-[13px] text-on-surface-variant">
              Rules-first prior-auth decision support — the LLM never chooses the outcome
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-[13px]">
            <a
              className="text-secondary transition-colors hover:text-black"
              href={GITHUB_REPO}
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
            <a
              className="text-secondary transition-colors hover:text-black"
              href={`${GITHUB_REPO}/blob/main/docs/PROJECT_DEEP_DIVE.md`}
              target="_blank"
              rel="noreferrer"
            >
              Deep dive
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1280px] flex-grow flex-col gap-6 px-6 py-8 md:flex-row md:px-8">
        {/* Left: input */}
        <aside className="flex w-full shrink-0 flex-col gap-6 md:w-[320px]">
          <div>
            <h1 className="text-lg font-semibold tracking-[-0.01em] text-black">New Case Review</h1>
            <p className="mt-1 text-[13px] leading-[18px] text-on-surface-variant">
              Pick a demo scenario, then run Instant Replay (zero cost) or Full Pipeline (live LLM).
            </p>
          </div>

          <form
            onSubmit={runCase}
            className="flex flex-col gap-4 rounded border border-surface-border bg-surface-lowest p-5 shadow-sm"
          >
            <label className="block">
              <span className="mb-2 block text-[12px] font-semibold tracking-[0.05em] text-on-surface-variant uppercase">
                Scenario
              </span>
              <select
                className="w-full cursor-pointer appearance-none rounded border border-surface-border bg-surface px-3 py-2 text-[13px] text-foreground transition-colors focus:border-black focus:outline-none"
                value={selectedCaseId}
                onChange={(e) => {
                  const nextCase = SAMPLE_CASES.find((item) => item.id === e.target.value);
                  setSelectedCaseId(e.target.value);
                  if (nextCase) setNote(nextCase.note);
                  setEvents([]);
                  setDone(null);
                  setError(null);
                }}
              >
                {SAMPLE_CASES.map((sampleCase) => (
                  <option key={sampleCase.id} value={sampleCase.id}>
                    {sampleCase.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-2 block text-[12px] font-semibold tracking-[0.05em] text-on-surface-variant uppercase">
                Clinical note
              </span>
              <textarea
                className="font-data-mono h-40 w-full resize-none rounded border border-surface-border bg-surface p-3 text-[13px] leading-4 text-foreground transition-colors focus:border-black focus:outline-none"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                required
              />
            </label>

            {/* Instant Replay / Full Pipeline segmented toggle */}
            <div>
              <div className="flex items-center rounded bg-surface-high p-1">
                <button
                  type="button"
                  disabled={selectedIsLiveOnly}
                  onClick={() => setRunLive(false)}
                  className={`flex-1 rounded px-3 py-1.5 text-center text-[13px] transition-colors ${
                    !fullPipelineSelected
                      ? "bg-surface-lowest font-medium text-black shadow-sm"
                      : "text-on-surface-variant hover:text-black disabled:opacity-50"
                  }`}
                >
                  Instant Replay
                </button>
                <button
                  type="button"
                  onClick={() => setRunLive(true)}
                  className={`flex-1 rounded px-3 py-1.5 text-center text-[13px] transition-colors ${
                    fullPipelineSelected
                      ? "bg-surface-lowest font-medium text-black shadow-sm"
                      : "text-on-surface-variant hover:text-black"
                  }`}
                >
                  Full Pipeline
                </button>
              </div>
              <p className="mt-2 text-[12px] leading-[16px] text-on-surface-variant">{pipelineHelperText}</p>
            </div>

            {selectedIsLiveOnly ? (
              <p className="rounded border border-warning-amber bg-[#FEF3C7] p-2 text-[13px] text-[#92400E]">
                This scenario has no stored verified result yet — Full Pipeline is required (demo key + LLM calls).
              </p>
            ) : null}

            {requiresDemoKey ? (
              <label className="block">
                <span className="mb-2 block text-[12px] font-semibold tracking-[0.05em] text-on-surface-variant uppercase">
                  Demo key (live runs only)
                </span>
                <input
                  className="w-full rounded border border-surface-border bg-surface px-3 py-2 text-[13px] transition-colors focus:border-black focus:outline-none"
                  type="password"
                  placeholder="Enter DEMO_KEY"
                  value={demoKey}
                  onChange={(e) => setDemoKey(e.target.value)}
                  required
                />
              </label>
            ) : null}

            <button
              type="submit"
              disabled={isRunning}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded bg-black py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-[#565e74] disabled:opacity-60"
            >
              {isRunning ? "Running…" : fullPipelineSelected ? "Run Full Pipeline" : "Run Decision Support"}
            </button>
          </form>

          {/* Pipeline Steps legend */}
          <div>
            <h2 className="mb-3 text-[12px] font-semibold tracking-[0.05em] text-on-surface-variant uppercase">
              Pipeline Steps
            </h2>
            <div className="flex flex-col gap-2">
              {PIPELINE_LEGEND.map((step, idx) => (
                <div
                  key={step.name}
                  className={`flex items-center gap-3 rounded p-2 ${
                    idx === 0 ? "border border-surface-border bg-surface-low" : ""
                  }`}
                >
                  <span className={`font-data-mono text-[14px] ${step.color}`} aria-hidden>
                    {step.kind === "llm" ? "◆" : step.kind === "retrieval" ? "◇" : "●"}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-foreground">{step.label}</div>
                    <div className="font-data-mono text-[10px] text-on-surface-variant">
                      {step.name} · {step.kind === "deterministic" ? "deterministic" : step.kind === "retrieval" ? "retrieval" : "LLM"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Center: Agent Trace */}
        <section className="flex min-w-0 flex-1 flex-col gap-4">
          <h2 className="border-b border-surface-border pb-3 text-lg font-semibold tracking-[-0.01em] text-black">
            Agent Trace
          </h2>

          {events.length === 0 && !isRunning ? (
            <p className="text-[13px] text-on-surface-variant">No events yet. Run a scenario to stream the agent timeline.</p>
          ) : null}

          {isRunning && events.length === 0 ? (
            <div className="flex items-center gap-2 text-[13px] text-secondary">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-secondary" />
              Run in progress…
            </div>
          ) : null}

          <div className="relative pl-1">
            {events.map((row, index) => {
              const kind = nodeKind(row.node, row.replay);
              const isLast = index === events.length - 1;
              return (
                <div key={`${row.node}-${index}`} className={`relative ${isLast ? "pb-2" : "pb-8"}`}>
                  {!isLast ? <div className="timeline-line" /> : null}
                  <div className="relative flex gap-4">
                    <div
                      className={`timeline-dot mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-surface-lowest text-[10px] font-bold text-white shadow-sm ${nodeDotClass(kind)}`}
                    >
                      {nodeDotGlyph(kind)}
                    </div>
                    <div className="flex-1 rounded border border-surface-border bg-surface-lowest p-4 shadow-sm transition-colors hover:bg-surface">
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-data-mono rounded bg-surface-low px-2 py-0.5 text-[13px] text-on-surface-variant">
                            {row.node}
                          </span>
                          {row.replay ? (
                            <span className="rounded bg-surface-high px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.05em] text-on-surface-variant uppercase">
                              Stored result
                            </span>
                          ) : null}
                        </div>
                        <span className="font-data-mono shrink-0 text-[11px] text-secondary">{row.timestamp}</span>
                      </div>
                      <p className="text-[13px] leading-5 text-foreground">
                        {summarizeNodeEvent(row.node, row.summary, row.replay)}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {isRunning && events.length > 0 ? (
            <div className="flex items-center gap-2 text-[12px] text-secondary">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-secondary" />
              Streaming…
            </div>
          ) : null}
        </section>

        {/* Right: Outcome */}
        <aside className="flex w-full shrink-0 flex-col gap-6 md:w-[380px]">
          <h2 className="border-b border-surface-border pb-3 text-lg font-semibold tracking-[-0.01em] text-black">
            Outcome Summary
          </h2>

          {error ? (
            <div className="rounded border border-error-red bg-[#FEE2E2] p-4 text-[13px] text-[#991B1B]">
              {error}
            </div>
          ) : null}

          {!done?.decision && !error ? (
            <p className="text-[13px] text-on-surface-variant">
              Results appear here after a run — outcome, citations, and appeal draft (deny path).
            </p>
          ) : null}

          {done?.replay ? (
            <div className="rounded border border-secondary/30 bg-surface-low p-3 text-[13px] text-on-surface-variant">
              Instant demo result — replayed from a stored verified run. No LLM calls made. Switch to{" "}
              <strong>Full Pipeline</strong> to execute live.
            </div>
          ) : null}

          {done?.decision ? (
            <>
              <div className="relative overflow-hidden rounded border border-surface-border bg-surface-lowest p-5 shadow-sm">
                <div className={`absolute top-0 left-0 h-full w-1 ${outcomeBarClass(done.decision.outcome)}`} />
                <div className="mb-4 flex flex-wrap items-center gap-3">
                  <div
                    className={`font-data-mono flex items-center gap-2 rounded px-3 py-1 text-sm font-bold ${outcomeBadgeClass(done.decision.outcome)}`}
                  >
                    {done.decision.outcome}
                  </div>
                  {rulesPassedLabel ? (
                    <span className="text-[13px] text-on-surface-variant">{rulesPassedLabel}</span>
                  ) : null}
                  <span className="text-[12px] text-secondary">confidence: {done.decision.confidence}</span>
                </div>
                <div className="space-y-3 text-[13px] leading-5 text-foreground">
                  {renderReasoningMarkdown(done.decision.reasoningSummary)}
                </div>
              </div>

              <div>
                <h3 className="mb-3 text-[12px] font-semibold tracking-[0.05em] text-on-surface-variant uppercase">
                  Citations
                </h3>
                {done.decision.supportingCitations.length === 0 ? (
                  <p className="text-[13px] text-on-surface-variant">No citations returned.</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {done.decision.supportingCitations.map((citation, idx) => {
                      const sourceUrl = chunkUrlById.get(citation.sourceChunkId);
                      return (
                        <div
                          key={`${citation.sourceChunkId}-${idx}`}
                          className="rounded-r border-l-2 border-retrieval-purple bg-surface-low py-2 pr-2 pl-3"
                        >
                          <div className="mb-1 text-[10px] font-semibold tracking-[0.05em] text-secondary uppercase">
                            {citation.payerName}
                            {citation.documentTitle ? ` · ${citation.documentTitle}` : ""}
                          </div>
                          <p className="mb-2 text-[13px] leading-5 text-foreground">
                            {emphasizeConstraintPhrases(citation.requirementSummary)}
                          </p>
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className="font-data-mono truncate text-[10px] text-on-surface-variant"
                              title={citation.sourceChunkId}
                            >
                              {truncateChunkId(citation.sourceChunkId)}
                            </span>
                            {sourceUrl ? (
                              <a
                                className="shrink-0 text-[11px] text-retrieval-purple hover:underline"
                                href={sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Source PDF
                              </a>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {done.appealDraft ? (
                <div className="overflow-hidden rounded border border-warning-amber bg-surface-lowest">
                  <div className="flex items-center justify-between border-b border-warning-amber bg-[#FEF3C7] px-3 py-2">
                    <span className="text-[12px] font-semibold tracking-[0.05em] text-[#92400E] uppercase">
                      Appeal Draft
                    </span>
                    <span className="rounded bg-white px-2 py-0.5 text-[10px] font-semibold tracking-[0.05em] text-[#92400E] uppercase">
                      Human review required
                    </span>
                  </div>
                  <div className="bg-surface p-3">
                    <pre className="font-data-mono whitespace-pre-wrap text-[11px] leading-relaxed text-on-surface-variant">
                      {done.appealDraft.draftText}
                    </pre>
                    <button
                      type="button"
                      className="mt-3 rounded border border-surface-border bg-surface-lowest px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-surface-low"
                      onClick={async () => {
                        await navigator.clipboard.writeText(done.appealDraft?.draftText ?? "");
                      }}
                    >
                      Copy to clipboard
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </aside>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-surface-border bg-surface-low">
        <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-3 px-6 py-3 md:flex-row md:items-center md:justify-between md:px-8">
          <div className="text-[13px] text-on-surface-variant">
            Synthetic data only · Portfolio project by Abhi Sorari ·{" "}
            <a className="underline hover:text-black" href={GITHUB_REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={GITHUB_REPO}
              target="_blank"
              rel="noreferrer"
              className="font-data-mono rounded border border-surface-border bg-surface-high px-2 py-1 text-[11px] text-on-surface-variant transition-colors hover:text-black"
            >
              26/26 eval accuracy · 0% false-approve
            </a>
            <a
              href={GITHUB_REPO}
              target="_blank"
              rel="noreferrer"
              className="font-data-mono rounded border border-surface-border bg-surface-high px-2 py-1 text-[11px] text-on-surface-variant transition-colors hover:text-black"
            >
              ~$0.004/case inference
            </a>
            <a
              href={GITHUB_REPO}
              target="_blank"
              rel="noreferrer"
              className="font-data-mono rounded border border-surface-border bg-surface-high px-2 py-1 text-[11px] text-on-surface-variant transition-colors hover:text-black"
            >
              100% citation validity
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
