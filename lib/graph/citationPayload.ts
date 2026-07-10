export const CITATION_SYNTHESIS_CHUNK_COUNT = 3;
export const CHUNK_CONTENT_MAX_TOKENS = 300;
const APPROX_CHARS_PER_TOKEN = 4;

export function truncateApproxTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

export function selectTopRetrievedChunks<T extends { similarity: number }>(
  chunks: T[],
  maxChunks = CITATION_SYNTHESIS_CHUNK_COUNT,
): T[] {
  return [...chunks].sort((a, b) => b.similarity - a.similarity).slice(0, maxChunks);
}
