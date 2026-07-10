create table citation_cache (
  cache_key text primary key,
  cache_kind text not null check (cache_kind in ('citations', 'appeal_draft')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index citation_cache_kind_idx on citation_cache (cache_kind);
