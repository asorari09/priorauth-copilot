import type { AppealDraft, PolicyCitation } from "../schemas";
import { supabaseAdmin } from "../supabase";

export type InferenceCacheKind = "citations" | "appeal_draft";

type CacheRow = {
  cache_key: string;
  cache_kind: InferenceCacheKind;
  payload: unknown;
};

export async function getInferenceCache<T>(
  cacheKey: string,
  cacheKind: InferenceCacheKind,
): Promise<T | null> {
  const { data, error } = await supabaseAdmin
    .from("citation_cache")
    .select("payload")
    .eq("cache_key", cacheKey)
    .eq("cache_kind", cacheKind)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data.payload as T;
}

export async function setInferenceCache(
  cacheKey: string,
  cacheKind: InferenceCacheKind,
  payload: unknown,
): Promise<void> {
  const row: CacheRow = {
    cache_key: cacheKey,
    cache_kind: cacheKind,
    payload,
  };

  const { error } = await supabaseAdmin.from("citation_cache").upsert(row, {
    onConflict: "cache_key",
  });

  if (error) {
    throw new Error(`citation_cache upsert failed: ${error.message}`);
  }
}

export async function getCachedCitations(cacheKey: string): Promise<PolicyCitation[] | null> {
  return getInferenceCache<PolicyCitation[]>(cacheKey, "citations");
}

export async function setCachedCitations(
  cacheKey: string,
  citations: PolicyCitation[],
): Promise<void> {
  await setInferenceCache(cacheKey, "citations", citations);
}

export async function getCachedAppealDraft(cacheKey: string): Promise<AppealDraft | null> {
  return getInferenceCache<AppealDraft>(cacheKey, "appeal_draft");
}

export async function setCachedAppealDraft(
  cacheKey: string,
  appealDraft: AppealDraft,
): Promise<void> {
  await setInferenceCache(cacheKey, "appeal_draft", appealDraft);
}
