import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import OpenAI from "openai";
import { PDFParse } from "pdf-parse";

import { supabaseAdmin } from "../lib/supabase";

type PolicyDocument = {
  payerName: string;
  documentTitle: string;
  sourceUrl: string;
};

type PageChunk = {
  text: string;
  pageNumber: number;
  indexWithinPage: number;
};

type ChunkRow = {
  chunk_id: string;
  payer_name: string;
  document_title: string;
  source_url: string;
  page_number: number;
  content: string;
  embedding: number[];
};

const EMBEDDING_MODEL = "text-embedding-3-small";
const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 50;
const CHUNK_STEP = TARGET_TOKENS - OVERLAP_TOKENS;

// Replace these with your selected real public payer/CMS policy PDF URLs before running ingestion.
const POLICY_DOCUMENTS: PolicyDocument[] = [
  {
    payerName: "CareSource",
    documentTitle: "Infliximab Intravenous Products UM Medical Policy",
    sourceUrl:
      "https://www.caresource.com/documents/medicare-multi-policy-pharmacy-infliximab-20250326.pdf",
  },
  {
    payerName: "Blue Shield of California",
    documentTitle: "Infliximab Medicare Part B Step Therapy Policy",
    sourceUrl:
      "https://www.blueshieldca.com/content/dam/bsca/en/medicare/docs/infliximab-MCARE-PartB-provider.pdf",
  },
  {
    payerName: "Premera Blue Cross",
    documentTitle: "Medical Policy 7.01.550 Knee Arthroplasty in Adults",
    sourceUrl: "https://www.premera.com/medicalpolicies/7.01.550.pdf",
  },
  {
    payerName: "Kaiser Permanente WA",
    documentTitle: "Total Knee Arthroplasty Clinical Review Criteria",
    sourceUrl:
      "https://wa-provider.kaiserpermanente.org/static/pdf/hosting/clinical/criteria/pdf/tka.pdf",
  },
  {
    payerName: "Providence Health Plan",
    documentTitle: "Medicare Medical Policy Total Knee Arthroplasty",
    sourceUrl:
      "https://www.providencehealthplan.com/-/media/providence/website/pdfs/providers/medical-policy-and-provider-information/medical-policies/mp419.pdf?rev=79a4b369734642d1bb4cf27a009af23d&hash=A241DB405B839A99F354B7866B5A3571",
  },
  {
    payerName: "CMS (via RadMD)",
    documentTitle: "NCD 220.2 Magnetic Resonance Imaging",
    sourceUrl:
      "https://www1.radmd.com/sites/default/files/2023-09/NCD%20220.2%20for%20Magnetic%20Resonance%20Imaging.pdf",
  },
  {
    payerName: "Mercy Care (AZ Medicaid)",
    documentTitle: "MCA 220.2 Magnetic Resonance Imaging",
    sourceUrl:
      "https://www.mercycareaz.org/content/dam/mercycare/pdf/MCA%20220.2%20Magnetic%20Resonance%20Imaging-UA.pdf",
  },
];

const CANARY_DOCUMENT = {
  payerName: "Meridian Health Plan (SYNTHETIC CANARY)",
  documentTitle: "Meridian J9999 Prior Authorization Policy (SYNTHETIC)",
  sourceUrl: "local://data/canary/meridian-policy.md",
  localPath: "data/canary/meridian-policy.md",
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function chunksFromText(text: string, pageNumber: number): PageChunk[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return [];
  }

  const chunks: PageChunk[] = [];
  let start = 0;
  let chunkIndex = 1;

  while (start < tokens.length) {
    const end = Math.min(start + TARGET_TOKENS, tokens.length);
    const chunkTokens = tokens.slice(start, end);
    chunks.push({
      text: chunkTokens.join(" "),
      pageNumber,
      indexWithinPage: chunkIndex,
    });
    if (end === tokens.length) {
      break;
    }
    start += CHUNK_STEP;
    chunkIndex += 1;
  }

  return chunks;
}

async function parsePdfPages(buffer: Buffer): Promise<string[]> {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    if (!result.pages || result.pages.length === 0) {
      throw new Error("No pages were parsed from PDF");
    }
    return result.pages.map((page) => page.text?.replace(/\s+/g, " ").trim() ?? "");
  } finally {
    await parser.destroy();
  }
}

async function embedTexts(openai: OpenAI, texts: string[]): Promise<number[][]> {
  const result = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return result.data.map((d) => d.embedding);
}

function buildChunkRows(
  doc: PolicyDocument,
  docSlug: string,
  chunks: PageChunk[],
  embeddings: number[][],
): ChunkRow[] {
  return chunks.map((chunk, idx) => ({
    chunk_id: `${docSlug}-p${chunk.pageNumber}-${chunk.indexWithinPage}`,
    payer_name: doc.payerName,
    document_title: doc.documentTitle,
    source_url: doc.sourceUrl,
    page_number: chunk.pageNumber,
    content: chunk.text,
    embedding: embeddings[idx],
  }));
}

async function upsertChunkRows(rows: ChunkRow[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("policy_chunks")
    .upsert(rows, { onConflict: "chunk_id" });

  if (error) {
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }
}

async function ingestRemotePdf(doc: PolicyDocument, openai: OpenAI): Promise<void> {
  const response = await fetch(doc.sourceUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      Accept: "application/pdf,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to download PDF (${response.status}) ${doc.sourceUrl}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const pageTexts = await parsePdfPages(buffer);
  const pageChunks = pageTexts.flatMap((pageText, idx) =>
    chunksFromText(pageText, idx + 1),
  );
  if (pageChunks.length === 0) {
    throw new Error(`No chunks created for ${doc.documentTitle}`);
  }

  const embeddings = await embedTexts(
    openai,
    pageChunks.map((chunk) => chunk.text),
  );
  const docSlug = slugify(
    `${doc.payerName}-${doc.documentTitle}-${basename(doc.sourceUrl, extname(doc.sourceUrl))}`,
  );
  const rows = buildChunkRows(doc, docSlug, pageChunks, embeddings);
  await upsertChunkRows(rows);

  console.log(
    `Ingested PDF: "${doc.documentTitle}" (${doc.payerName}) - ${rows.length} chunks`,
  );
}

async function ingestCanary(openai: OpenAI): Promise<void> {
  const canaryText = readFileSync(CANARY_DOCUMENT.localPath, "utf8").trim();
  const chunks = chunksFromText(canaryText, 1);
  if (chunks.length === 0) {
    throw new Error("Canary document produced zero chunks");
  }

  const embeddings = await embedTexts(
    openai,
    chunks.map((chunk) => chunk.text),
  );
  const docSlug = slugify("meridian-health-plan-j9999-synthetic-canary");
  const rows = buildChunkRows(CANARY_DOCUMENT, docSlug, chunks, embeddings);
  await upsertChunkRows(rows);

  console.log(
    `Ingested canary: "${CANARY_DOCUMENT.documentTitle}" - ${rows.length} chunks`,
  );
}

async function main() {
  if (POLICY_DOCUMENTS.length === 0) {
    throw new Error(
      "POLICY_DOCUMENTS is empty. Add real public payer/CMS PDF URLs before running ingestion.",
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const openai = new OpenAI({ apiKey });

  let successCount = 0;
  let failureCount = 0;
  for (const doc of POLICY_DOCUMENTS) {
    try {
      await ingestRemotePdf(doc, openai);
      successCount += 1;
    } catch (error) {
      failureCount += 1;
      console.warn(
        `Skipping document after ingest failure: "${doc.documentTitle}" (${doc.sourceUrl}) :: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await ingestCanary(openai);
  console.log(`Ingestion complete. Success: ${successCount}, Failed: ${failureCount}`);
}

main().catch((error) => {
  console.error(`Ingestion failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
