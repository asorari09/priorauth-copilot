create extension if not exists vector;

create table policy_chunks (
  id uuid primary key default gen_random_uuid(),
  chunk_id text unique not null,        -- human-readable: "{doc_slug}-{page}-{n}"
  payer_name text not null,
  document_title text not null,
  source_url text not null,
  page_number int,
  content text not null,
  embedding vector(1536)
);
create index on policy_chunks using hnsw (embedding vector_cosine_ops);

create table cases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  status text not null default 'processing',   -- processing | done | error
  raw_note text not null,
  extraction jsonb,
  rules_result jsonb,
  citations jsonb,
  decision jsonb,
  appeal_draft jsonb,
  error text
);

-- RPC for similarity search (call via supabase.rpc from the app)
create or replace function match_policy_chunks(
  query_embedding vector(1536), match_count int default 5
) returns table (chunk_id text, payer_name text, document_title text,
                 source_url text, content text, similarity float)
language sql stable as $$
  select chunk_id, payer_name, document_title, source_url, content,
         1 - (embedding <=> query_embedding) as similarity
  from policy_chunks
  order by embedding <=> query_embedding
  limit match_count;
$$;
