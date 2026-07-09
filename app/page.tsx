"use client";

import { FormEvent, useMemo, useState } from "react";

type Outcome = "likely_approve" | "likely_deny" | "insufficient_info";

type EventRow = {
  node: string;
  summary: unknown;
  timestamp: string;
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
  decision?: Decision;
  appealDraft?: { draftText: string; requiresHumanReview: boolean };
  retrievedChunks?: RetrievedChunk[];
};

const OUTCOME_STYLES: Record<Outcome, string> = {
  likely_approve: "bg-emerald-100 text-emerald-900 border border-emerald-300",
  likely_deny: "bg-red-100 text-red-900 border border-red-300",
  insufficient_info: "bg-amber-100 text-amber-900 border border-amber-300",
};

const SAMPLE_CASES = [
  {
    id: "CASE-001",
    label: "CASE-001 approve",
    note: `SYNTHETIC CASE CASE-001: Prior authorization intake for patient A. The ordering clinician documented diagnosis codes (K50.90) and requested procedure J1745. The patient is 29 years old and presented for coverage review in a routine outpatient workflow.\n\nChart review states prior management included mesalamine and azathioprine. Treatment failure was documented as true in the assessment narrative. The progress note summary reads: "Adult Crohn disease with two failed therapies and dose within limit."\n\nRequested infusion quantity is 6 units for this authorization period.`,
  },
  {
    id: "CASE-004",
    label: "CASE-004 deny",
    note: `SYNTHETIC CASE CASE-004: Prior authorization intake for patient D. The ordering clinician documented diagnosis codes (K50.90) and requested procedure J1745. The patient is 4 years old and presented for coverage review in a routine outpatient workflow.\n\nChart review states prior management included mesalamine and azathioprine. Treatment failure was documented as true in the assessment narrative. The progress note summary reads: "Pediatric Crohn patient meets therapy history but is younger than six."\n\nRequested infusion quantity is 5 units for this authorization period.`,
  },
  {
    id: "CASE-008",
    label: "CASE-008 insufficient",
    note: `SYNTHETIC CASE CASE-008: Prior authorization intake for patient H. The ordering clinician documented diagnosis codes (K50.90) and requested procedure J1745. The patient is 48 years old and presented for coverage review in a routine outpatient workflow.\n\nChart review states prior management included azathioprine and mesalamine. Treatment failure was documented as true in the assessment narrative. The progress note summary reads: "Crohn disease with step therapy met but infusion units not documented."\n\nOutside infusion-center paperwork did not list the exact number of units requested.`,
  },
  {
    id: "CASE-017",
    label: "CASE-017 MRI approve",
    note: `SYNTHETIC CASE CASE-017: Prior authorization intake for patient Q. The ordering clinician documented diagnosis codes (G40.909) and requested procedure 70553. The patient is 25 years old and presented for coverage review in a routine outpatient workflow.\n\nChart review states prior management included levetiracetam. Treatment failure was documented as true in the assessment narrative. The progress note summary reads: "Seizure disorder code present with prior imaging abnormalities documented."\n\nNeurologic deficits are documented as absent in the exam. Prior imaging or focal findings are documented as present.`,
  },
  {
    id: "CASE-025",
    label: "CASE-025 canary",
    note: `SYNTHETIC CASE CASE-025: Prior authorization intake for patient Y. The ordering clinician documented diagnosis codes (Z99.89) and requested procedure J9999. The patient is 25 years old and presented for coverage review in a routine outpatient workflow.\n\nChart review states prior management included therapy alpha, therapy beta, and therapy gamma. Treatment failure was documented as true in the assessment narrative. The progress note summary reads: "Meridian synthetic canary request documents exactly three failed prior therapies and age twenty-five."\n\nSYNTHETIC Meridian Health Plan context: fictional policy for J9999 states exactly three failed therapies and age twenty-one or older.`,
  },
] as const;

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

export default function Home() {
  const [selectedCaseId, setSelectedCaseId] = useState<string>(SAMPLE_CASES[0].id);
  const [note, setNote] = useState<string>(SAMPLE_CASES[0].note);
  const [demoKey, setDemoKey] = useState("");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [done, setDone] = useState<DonePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

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

    try {
      const response = await fetch("/api/cases", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-key": demoKey,
        },
        body: JSON.stringify({ note }),
      });

      if (!response.ok || !response.body) {
        setIsRunning(false);
        setError(response.status === 401 ? "Unable to run case: check demo key and try again." : "Unable to run case right now. Please retry.");
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
            setEvents((prev) => [
              ...prev,
              {
                node: String(payload.node ?? "unknown"),
                summary: payload.summary ?? {},
                timestamp: new Date().toLocaleTimeString(),
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

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="sticky top-0 z-20 border-b border-amber-300 bg-amber-100 px-4 py-3 text-sm font-medium text-amber-900">
        ⚠ This is not a coverage decision. Verify with the payer directly. All data shown is synthetic — no real patient information is used.
      </div>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
        <form onSubmit={runCase} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h1 className="text-lg font-semibold">Prior Auth Copilot Demo</h1>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="text-sm font-medium">
              Preset case
              <select
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                value={selectedCaseId}
                onChange={(e) => {
                  const nextCase = SAMPLE_CASES.find((item) => item.id === e.target.value);
                  setSelectedCaseId(e.target.value);
                  if (nextCase) setNote(nextCase.note);
                }}
              >
                {SAMPLE_CASES.map((sampleCase) => (
                  <option key={sampleCase.id} value={sampleCase.id}>
                    {sampleCase.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-sm font-medium">
              Demo key
              <input
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                type="password"
                placeholder="Enter DEMO_KEY"
                value={demoKey}
                onChange={(e) => setDemoKey(e.target.value)}
                required
              />
            </label>
          </div>

          <label className="mt-3 block text-sm font-medium">
            Custom notes
            <textarea
              className="mt-1 h-44 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required
            />
          </label>

          <button
            type="submit"
            disabled={isRunning}
            className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {isRunning ? "Running..." : "Run"}
          </button>
        </form>

        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-base font-semibold">Live Agent Trace</h2>
          {events.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No events yet.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {events.map((row, index) => (
                <li key={`${row.node}-${index}`} className="rounded-md border border-slate-200 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{row.node}</span>
                    <span className="text-xs text-slate-500">{row.timestamp}</span>
                  </div>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-slate-700">
                    {JSON.stringify(row.summary, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          )}
          {isRunning ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-blue-700">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
              Run in progress
            </div>
          ) : null}
        </section>

        {(done || error) && (
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold">Result</h2>

            {error ? <p className="mt-2 rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}

            {done?.decision ? (
              <div className="mt-3 space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${OUTCOME_STYLES[done.decision.outcome]}`}>
                    {done.decision.outcome}
                  </span>
                  <span className="rounded-full border border-slate-300 px-3 py-1 text-xs">
                    {(() => {
                      const rules = done.decision.rulesResult;
                      const y = rules?.ruleIdsApplied.length ?? 0;
                      const x = Math.max(0, y - (rules?.failedCriteria.length ?? 0));
                      return `Rules passed: ${x}/${y}`;
                    })()}
                  </span>
                  <span className="text-xs text-slate-600">confidence: {done.decision.confidence}</span>
                </div>

                <p>{done.decision.reasoningSummary}</p>

                <div>
                  <h3 className="font-semibold">Citations</h3>
                  {done.decision.supportingCitations.length === 0 ? (
                    <p className="text-slate-500">No citations returned.</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {done.decision.supportingCitations.map((citation, idx) => {
                        const sourceUrl = chunkUrlById.get(citation.sourceChunkId);
                        return (
                          <li key={`${citation.sourceChunkId}-${idx}`} className="rounded-md border border-slate-200 p-2">
                            <p className="font-medium">{citation.payerName}</p>
                            <p>{citation.documentTitle}</p>
                            <p className="text-slate-700">{emphasizeConstraintPhrases(citation.requirementSummary)}</p>
                            <p className="text-xs text-slate-500">chunk: {citation.sourceChunkId}</p>
                            {sourceUrl ? (
                              <a className="text-xs text-blue-700 underline" href={sourceUrl} target="_blank" rel="noreferrer">
                                source document
                              </a>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {done.appealDraft ? (
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-semibold">Appeal Draft</h3>
                      <span className="rounded border border-amber-300 bg-amber-100 px-2 py-1 text-xs text-amber-900">requires human review</span>
                    </div>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs">
                      {done.appealDraft.draftText}
                    </pre>
                    <button
                      type="button"
                      className="mt-2 rounded border border-slate-300 px-3 py-1 text-xs"
                      onClick={async () => {
                        await navigator.clipboard.writeText(done.appealDraft?.draftText ?? "");
                      }}
                    >
                      Copy to clipboard
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>
        )}
      </main>
    </div>
  );
}
