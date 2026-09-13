-- Follow-Through: Open Obligations (additive).
-- An obligation stays alive until it is actually completed, dismissed, cancelled
-- or intentionally abandoned — never because a reminder was shown.

do $$ begin
  create type public.obligation_status as enum (
    'open', 'due', 'overdue', 'waiting_on_me', 'waiting_on_other', 'possibly_complete', 'completed', 'dismissed', 'cancelled', 'snoozed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.obligation_tracking_mode as enum ('once', 'persistent', 'important', 'critical');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.obligation_event_kind as enum (
    'created', 'reminded', 'snoozed', 'dismissed', 'cancelled', 'completed', 'auto_completed', 'possibly_complete',
    'confirmed', 'reopened', 'escalated', 'note', 'context_trigger', 'source_linked', 'tracking_stopped', 'cadence_changed'
  );
exception when duplicate_object then null; end $$;

-- Reminders are alerts of a new kind.
alter type public.alert_kind add value if not exists 'obligation';

create table if not exists public.obligations (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references auth.users (id) on delete cascade,
  title                 text not null,
  description           text,
  scope                 text not null default 'business' check (scope in ('business','personal','financial','all')),
  origin                text not null default 'jeff',           -- jeff | commitment | calendar | notion | highlevel | portal | mission | job
  source_provider       text,
  source_external_id    text,
  source_url            text,
  commitment_id         uuid references public.commitments (id) on delete set null,
  assigned_to           text not null default 'me' check (assigned_to in ('me','other')),
  waiting_on            text,                                    -- person / party name when assigned_to = other
  status                public.obligation_status not null default 'open',
  priority              text not null default 'normal' check (priority in ('low','normal','high','critical')),
  due_at                timestamptz,
  remind_at             timestamptz,
  snoozed_until         timestamptz,
  tracking_mode         public.obligation_tracking_mode not null default 'once',
  completion_strategy   jsonb not null default '{"kind":"manual","match":{},"min_confidence":0.85}'::jsonb,
  completion_confidence numeric(3,2),
  completion_evidence   jsonb not null default '[]'::jsonb,
  completion_question   text,
  cadence               jsonb not null default '{}'::jsonb,
  escalation_level      smallint not null default 0,
  reminder_count        integer not null default 0,
  last_checked_at       timestamptz,
  last_reminded_at      timestamptz,
  next_reminder_at      timestamptz,
  related_goal_id       uuid references public.goals (id) on delete set null,
  related_mission_id    uuid references public.missions (id) on delete set null,
  related_client_id     text,
  counterparty          text,
  fingerprint           text,
  metadata              jsonb not null default '{}'::jsonb,
  completed_at          timestamptz,
  dismissed_at          timestamptz,
  cancelled_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists obligations_owner_status_idx on public.obligations (owner_id, status, due_at);
create index if not exists obligations_owner_next_reminder_idx on public.obligations (owner_id, next_reminder_at);
create unique index if not exists obligations_owner_fingerprint_idx on public.obligations (owner_id, fingerprint) where fingerprint is not null;
create unique index if not exists obligations_owner_commitment_idx on public.obligations (owner_id, commitment_id) where commitment_id is not null;
drop trigger if exists obligations_updated_at on public.obligations;
create trigger obligations_updated_at before update on public.obligations
  for each row execute function public.set_updated_at();

alter table public.obligations enable row level security;
drop policy if exists obligations_owner_select on public.obligations;
create policy obligations_owner_select on public.obligations
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
drop policy if exists obligations_owner_insert on public.obligations;
create policy obligations_owner_insert on public.obligations
  for insert to authenticated with check (public.is_owner_aal2() and owner_id = auth.uid());
drop policy if exists obligations_owner_update on public.obligations;
create policy obligations_owner_update on public.obligations
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());

create table if not exists public.obligation_sources (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  obligation_id  uuid not null references public.obligations (id) on delete cascade,
  provider       text not null,
  external_id    text not null,
  url            text,
  kind           text,
  is_primary     boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (owner_id, provider, external_id)
);
create index if not exists obligation_sources_obligation_idx on public.obligation_sources (obligation_id);
alter table public.obligation_sources enable row level security;
drop policy if exists obligation_sources_owner_select on public.obligation_sources;
create policy obligation_sources_owner_select on public.obligation_sources
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

create table if not exists public.obligation_events (
  id             bigint generated always as identity primary key,
  owner_id       uuid not null references auth.users (id) on delete cascade,
  obligation_id  uuid not null references public.obligations (id) on delete cascade,
  kind           public.obligation_event_kind not null,
  payload        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists obligation_events_obligation_idx on public.obligation_events (obligation_id, created_at desc);
alter table public.obligation_events enable row level security;
drop policy if exists obligation_events_owner_select on public.obligation_events;
create policy obligation_events_owner_select on public.obligation_events
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

revoke all on table public.obligations, public.obligation_sources, public.obligation_events from anon;
