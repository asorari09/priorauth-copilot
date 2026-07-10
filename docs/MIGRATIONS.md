# Supabase migrations

Apply in order against your Supabase project (SQL editor or CLI):

| # | File | Creates |
|---|------|---------|
| 1 | `supabase/migrations/0001_init.sql` | `policy_chunks` (pgvector HNSW), `cases`, `match_policy_chunks()` RPC |
| 2 | `supabase/migrations/0002_citation_cache.sql` | `citation_cache` (citations + appeal draft inference cache) |

**Production project** (`fplchlkidnymdwstihin`): all three tables and `match_policy_chunks` verified live. `citation_cache` tracked via migration `citation_cache`; init schema applied before migration tracking.

Quick verify:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
-- expect: cases, citation_cache, policy_chunks
```
