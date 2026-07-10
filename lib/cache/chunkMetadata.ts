import type { PolicyCitation } from "../schemas";

function titleCaseWords(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function parseChunkMetadata(chunkId: string): { payerName: string; documentTitle: string } {
  const parts = chunkId.split("-");
  const pageMarkerIndex = parts.findIndex((part) => /^p\d+$/i.test(part));

  if (pageMarkerIndex <= 0) {
    return {
      payerName: titleCaseWords(parts[0] ?? "Unknown payer"),
      documentTitle: chunkId,
    };
  }

  const payerSlug = parts[0];
  const documentSlug = parts.slice(1, pageMarkerIndex).join(" ");

  return {
    payerName: titleCaseWords(payerSlug.replace(/-/g, " ")),
    documentTitle: titleCaseWords(documentSlug.replace(/-/g, " ")),
  };
}

export function citationFromChunkId(
  chunkId: string,
  requirementSummary: string,
): PolicyCitation {
  const meta = parseChunkMetadata(chunkId);
  return {
    payerName: meta.payerName,
    documentTitle: meta.documentTitle,
    sourceChunkId: chunkId,
    clauseTextParaphrased: requirementSummary,
    requirementSummary,
  };
}
