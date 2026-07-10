import { describe, expect, it } from "vitest";

import {
  selectTopRetrievedChunks,
  truncateApproxTokens,
} from "../lib/graph/citationPayload";

type RetrievedChunk = {
  chunk_id: string;
  payer_name: string;
  document_title: string;
  source_url: string;
  content: string;
  similarity: number;
};

describe("citation payload trimming", () => {
  it("keeps the highest-similarity chunks only", () => {
    const chunks: RetrievedChunk[] = [
      {
        chunk_id: "a",
        payer_name: "A",
        document_title: "Doc A",
        source_url: "https://example.com/a",
        content: "low",
        similarity: 0.4,
      },
      {
        chunk_id: "b",
        payer_name: "B",
        document_title: "Doc B",
        source_url: "https://example.com/b",
        content: "high",
        similarity: 0.9,
      },
      {
        chunk_id: "c",
        payer_name: "C",
        document_title: "Doc C",
        source_url: "https://example.com/c",
        content: "mid",
        similarity: 0.7,
      },
      {
        chunk_id: "d",
        payer_name: "D",
        document_title: "Doc D",
        source_url: "https://example.com/d",
        content: "lower",
        similarity: 0.5,
      },
    ];

    expect(selectTopRetrievedChunks(chunks).map((chunk) => chunk.chunk_id)).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("truncates long chunk content conservatively", () => {
    const longText = "x".repeat(2000);
    const truncated = truncateApproxTokens(longText, 300);
    expect(truncated.length).toBeLessThanOrEqual(300 * 4 + 1);
    expect(truncated.endsWith("…")).toBe(true);
  });
});
