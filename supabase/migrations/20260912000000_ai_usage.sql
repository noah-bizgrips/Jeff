-- Ask Jeff usage ledger: per-call token counts and estimated cost, used to
-- enforce JEFF_DAILY_BUDGET_USD server-side. Written by the service role only.

create table public.ai_usage (
  id                 bigint generated always as identity primary key,
  owner_id           uuid not null references auth.users (id) on delete cascade,
  model              text not null,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0,
  estimated_usd      numeric(10,6) not null default 0,
  created_at         timestamptz not null default now()
);
create index ai_usage_owner_time_idx on public.ai_usage (owner_id, created_at desc);

alter table public.ai_usage enable row level security;
create policy ai_usage_owner_select on public.ai_usage
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
-- No insert/update/delete policies: only the service role (server code) writes.
revoke all on table public.ai_usage from anon;
