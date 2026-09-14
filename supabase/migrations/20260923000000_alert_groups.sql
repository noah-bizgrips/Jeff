-- Context-aware alert grouping (additive, non-destructive).
-- Related alerts / findings / obligations for the same client, goal, mission,
-- contact, campaign or workflow are bundled under ONE parent item. Individual
-- records are never deleted or merged: members keep their own rows and history,
-- they are only marked `grouped` while the parent is open.

-- Parent alerts are a new kind; member alerts hide under a new status.
alter type public.alert_kind add value if not exists 'group';
alter type public.alert_status add value if not exists 'grouped';

create table if not exists public.alert_groups (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references auth.users (id) on delete cascade,
  group_key             text not null,                          -- client:<id>:delivery | goal:<id> | workflow:<id> | ...
  entity_kind           text not null check (entity_kind in ('client','project','goal','mission','contact','campaign','workflow','issue','category')),
  entity_id             text,
  entity_name           text not null,
  issue_kind            text not null default 'mixed',          -- delivery | money | engagement | acquisition | goal | automation | follow_through | mixed
  title                 text not null,
  summary               text,                                   -- deterministic (counts, oldest overdue, blocker, owner split)
  facts                 jsonb not null default '{}'::jsonb,     -- structured summary facts shown in the UI
  interpretation        text,                                   -- Jeff's one-paragraph reading (AI, budget-guarded, optional)
  interpretation_model  text,
  interpreted_at        timestamptz,
  interpretation_hash   text,                                   -- member-set hash the interpretation was written for
  importance            public.alert_importance not null default 'briefing',
  scope                 public.memory_scope not null default 'business',
  status                text not null default 'open' check (status in ('open','acknowledged','snoozed','dismissed','resolved')),
  snoozed_until         timestamptz,
  acknowledged_at       timestamptz,
  resolved_at           timestamptz,
  dismissed_at          timestamptz,
  reopened_count        integer not null default 0,
  member_count          integer not null default 0,
  member_hash           text,                                   -- hash of the live member set (drives re-interpretation)
  member_count_pushed   integer not null default 0,             -- member count at the last push (re-push when it grows by 3+)
  last_pushed_at        timestamptz,
  pushed_importance     text,
  alert_id              uuid references public.alerts (id) on delete set null,  -- the parent alert row
  first_seen            timestamptz not null default now(),
  last_seen             timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (owner_id, group_key)
);
create index if not exists alert_groups_owner_status_idx on public.alert_groups (owner_id, status, importance, last_seen desc);
drop trigger if exists alert_groups_updated_at on public.alert_groups;
create trigger alert_groups_updated_at before update on public.alert_groups
  for each row execute function public.set_updated_at();

alter table public.alert_groups enable row level security;
drop policy if exists alert_groups_owner_select on public.alert_groups;
create policy alert_groups_owner_select on public.alert_groups
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
drop policy if exists alert_groups_owner_update on public.alert_groups;
create policy alert_groups_owner_update on public.alert_groups
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());
-- Inserts / lifecycle are written by the grouping engine (service role).

create table if not exists public.alert_group_members (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  group_id      uuid not null references public.alert_groups (id) on delete cascade,
  member_kind   text not null check (member_kind in ('alert','finding','obligation','commitment')),
  member_id     uuid not null,                                  -- alert / finding / obligation / commitment id
  alert_id      uuid references public.alerts (id) on delete set null,
  title         text not null,
  status        text not null default 'open',                   -- live | resolved (member no longer part of the situation)
  key_source    text not null default 'structured' check (key_source in ('structured','semantic')),
  detail        jsonb not null default '{}'::jsonb,             -- due date, days overdue, owner, priority, status, notes, items[]
  added_at      timestamptz not null default now(),
  resolved_at   timestamptz,
  updated_at    timestamptz not null default now(),
  unique (owner_id, group_id, member_kind, member_id)
);
create index if not exists alert_group_members_group_idx on public.alert_group_members (owner_id, group_id, status);
create index if not exists alert_group_members_member_idx on public.alert_group_members (owner_id, member_kind, member_id);
drop trigger if exists alert_group_members_updated_at on public.alert_group_members;
create trigger alert_group_members_updated_at before update on public.alert_group_members
  for each row execute function public.set_updated_at();

alter table public.alert_group_members enable row level security;
drop policy if exists alert_group_members_owner_select on public.alert_group_members;
create policy alert_group_members_owner_select on public.alert_group_members
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

-- Member alerts point at their group; the parent alert points back via alert_groups.alert_id.
alter table public.alerts add column if not exists group_id uuid references public.alert_groups (id) on delete set null;
create index if not exists alerts_owner_group_idx on public.alerts (owner_id, group_id) where group_id is not null;
