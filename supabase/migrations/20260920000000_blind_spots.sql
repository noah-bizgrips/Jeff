-- Blind spots: attention signals + per-owner controls (additive).

create table if not exists public.owner_attention (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('finding_viewed','alert_viewed','goal_viewed','client_viewed','page_viewed','briefing_read')),
  ref_id      text,
  path        text,
  created_at  timestamptz not null default now()
);
comment on table public.owner_attention is 'What the owner has looked at; used only to detect blind spots (things not being noticed). No content, only kinds/refs/paths.';
create index if not exists owner_attention_owner_time_idx on public.owner_attention (owner_id, created_at desc);
create index if not exists owner_attention_owner_kind_ref_idx on public.owner_attention (owner_id, kind, ref_id);

alter table public.owner_attention enable row level security;
create policy owner_attention_owner_select on public.owner_attention
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy owner_attention_owner_insert on public.owner_attention
  for insert to authenticated with check (public.is_owner_aal2() and owner_id = auth.uid());
-- Service role writes server-side signals (tool use, briefing read).

alter table public.owner_settings
  add column if not exists push_blind_spots         boolean not null default true,
  add column if not exists blind_spot_max_per_day   integer not null default 2 check (blind_spot_max_per_day between 1 and 5),
  add column if not exists blind_spots_last_run_at  timestamptz;
