-- Goals layer. Additive only: new tables + two nullable columns.
-- Goals are natural-language outcomes turned into structured, approved
-- metric definitions. Nothing is authoritative until the owner approves.

create type public.goal_scope as enum ('business', 'personal', 'financial');
create type public.goal_status as enum ('draft', 'active', 'paused', 'achieved', 'missed', 'archived');
create type public.goal_metric_kind as enum ('count', 'currency', 'ratio', 'duration_days', 'percentage');
create type public.goal_comparator as enum ('gte', 'lte', 'eq', 'between');
create type public.goal_trajectory as enum ('on_track', 'slightly_at_risk', 'at_risk', 'severely_at_risk', 'unknown');
create type public.goal_event_kind as enum ('created', 'approved', 'metric_updated', 'trajectory_changed', 'milestone_hit', 'paused', 'resumed', 'edited', 'note', 'archived');
create type public.goal_recommendation_status as enum ('proposed', 'accepted', 'dismissed', 'prepared');
create type public.goal_aggregation as enum ('sum', 'count', 'avg', 'median', 'max', 'latest');

-- ---------------------------------------------------------------------------
-- goals: one row per outcome; prompt_text is the owner's original words.
-- ---------------------------------------------------------------------------
create table public.goals (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  name            text not null,
  prompt_text     text not null,                       -- immutable original natural language
  description     text,
  scope           public.goal_scope not null default 'business',
  status          public.goal_status not null default 'draft',
  start_date      date,
  end_date        date,
  interpretation  jsonb not null default '{}'::jsonb,  -- validated GoalInterpretation
  assumptions     jsonb not null default '[]'::jsonb,
  ambiguities     jsonb not null default '[]'::jsonb,  -- [{field, question, options, resolution}]
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index goals_owner_status_idx on public.goals (owner_id, status);
create trigger goals_updated_at before update on public.goals
  for each row execute function public.set_updated_at();

-- prompt_text cannot be rewritten once the row exists.
create or replace function public.goals_protect_prompt()
returns trigger language plpgsql as $$
begin
  if new.prompt_text is distinct from old.prompt_text then
    raise exception 'goals.prompt_text is immutable';
  end if;
  return new;
end $$;
create trigger goals_protect_prompt before update on public.goals
  for each row execute function public.goals_protect_prompt();

alter table public.goals enable row level security;
create policy goals_owner_select on public.goals
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy goals_owner_insert on public.goals
  for insert to authenticated with check (public.is_owner_aal2() and owner_id = auth.uid());
create policy goals_owner_update on public.goals
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());
create policy goals_owner_delete_draft on public.goals
  for delete to authenticated using (public.is_owner_aal2() and owner_id = auth.uid() and status = 'draft');

-- ---------------------------------------------------------------------------
-- goal_metrics: the KPIs a goal is judged by; each knows its source + formula.
-- ---------------------------------------------------------------------------
create table public.goal_metrics (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references auth.users (id) on delete cascade,
  goal_id             uuid not null references public.goals (id) on delete cascade,
  key                 text not null,
  name                text not null,
  kind                public.goal_metric_kind not null,
  target_value        numeric,
  comparator          public.goal_comparator not null default 'gte',
  target_upper        numeric,
  unit                text,
  formula             text,
  source_mappings     jsonb not null default '[]'::jsonb,   -- [{provider, resource_type, filter, aggregation, field}]
  time_range          jsonb not null default '{"kind":"goal_window"}'::jsonb,
  is_primary          boolean not null default false,
  is_constraint       boolean not null default false,
  constraint_strength text not null default 'soft',          -- soft | hard
  current_value       numeric,
  current_computed_at timestamptz,
  limitations         text,
  sort                integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (goal_id, key)
);
create index goal_metrics_goal_idx on public.goal_metrics (goal_id);
create trigger goal_metrics_updated_at before update on public.goal_metrics
  for each row execute function public.set_updated_at();
alter table public.goal_metrics enable row level security;
create policy goal_metrics_owner_select on public.goal_metrics
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy goal_metrics_owner_insert on public.goal_metrics
  for insert to authenticated with check (public.is_owner_aal2() and owner_id = auth.uid());
create policy goal_metrics_owner_update on public.goal_metrics
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- goal_milestones
-- ---------------------------------------------------------------------------
create table public.goal_milestones (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  goal_id       uuid not null references public.goals (id) on delete cascade,
  name          text not null,
  due_date      date,
  target_value  numeric,
  status        text not null default 'pending',   -- pending | hit | missed
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index goal_milestones_goal_idx on public.goal_milestones (goal_id);
create trigger goal_milestones_updated_at before update on public.goal_milestones
  for each row execute function public.set_updated_at();
alter table public.goal_milestones enable row level security;
create policy goal_milestones_owner_select on public.goal_milestones
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy goal_milestones_owner_insert on public.goal_milestones
  for insert to authenticated with check (public.is_owner_aal2() and owner_id = auth.uid());
create policy goal_milestones_owner_update on public.goal_milestones
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- goal_source_mappings: flattened view of where each metric input comes from
-- (denormalised from goal_metrics.source_mappings for querying/UI).
-- ---------------------------------------------------------------------------
create table public.goal_source_mappings (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  goal_id       uuid not null references public.goals (id) on delete cascade,
  metric_key    text not null,
  input_key     text not null default 'value',
  provider      text not null,
  resource_type text not null,
  filter        jsonb not null default '{}'::jsonb,
  aggregation   public.goal_aggregation not null default 'count',
  field         text,
  notes         text,
  created_at    timestamptz not null default now()
);
create index goal_source_mappings_goal_idx on public.goal_source_mappings (goal_id, metric_key);
alter table public.goal_source_mappings enable row level security;
create policy goal_source_mappings_owner_select on public.goal_source_mappings
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- goal_snapshots: one row per refresh; the history behind trends/forecasts.
-- ---------------------------------------------------------------------------
create table public.goal_snapshots (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  goal_id         uuid not null references public.goals (id) on delete cascade,
  taken_at        timestamptz not null default now(),
  metrics         jsonb not null default '{}'::jsonb,   -- {key: MetricResult}
  elapsed_pct     numeric,
  completion_pct  numeric,
  observed_pace   numeric,
  required_pace   numeric,
  forecast        jsonb,                                  -- {value, low, high, at}
  trajectory      public.goal_trajectory not null default 'unknown',
  constraint_key  text,
  data_freshness  jsonb not null default '{}'::jsonb
);
create index goal_snapshots_goal_time_idx on public.goal_snapshots (goal_id, taken_at desc);
alter table public.goal_snapshots enable row level security;
create policy goal_snapshots_owner_select on public.goal_snapshots
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- goal_events: audit-style history of what happened to a goal.
-- ---------------------------------------------------------------------------
create table public.goal_events (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  goal_id     uuid not null references public.goals (id) on delete cascade,
  kind        public.goal_event_kind not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index goal_events_goal_time_idx on public.goal_events (goal_id, created_at desc);
alter table public.goal_events enable row level security;
create policy goal_events_owner_select on public.goal_events
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- goal_recommendations: bounded, explainable interventions.
-- ---------------------------------------------------------------------------
create table public.goal_recommendations (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users (id) on delete cascade,
  goal_id            uuid not null references public.goals (id) on delete cascade,
  fingerprint        text not null,
  title              text not null,
  why                text not null,
  evidence           jsonb not null default '[]'::jsonb,
  mechanism          text,
  downside           text,
  jeff_can_prepare   text,
  requires_approval  boolean not null default true,
  status             public.goal_recommendation_status not null default 'proposed',
  mission_id         uuid references public.missions (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (goal_id, fingerprint)
);
create index goal_recommendations_goal_idx on public.goal_recommendations (goal_id, status);
create trigger goal_recommendations_updated_at before update on public.goal_recommendations
  for each row execute function public.set_updated_at();
alter table public.goal_recommendations enable row level security;
create policy goal_recommendations_owner_select on public.goal_recommendations
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy goal_recommendations_owner_update on public.goal_recommendations
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Links from existing tables (nullable, additive).
-- ---------------------------------------------------------------------------
alter table public.missions add column if not exists goal_id uuid references public.goals (id) on delete set null;
alter table public.findings add column if not exists goal_id uuid references public.goals (id) on delete set null;
create index if not exists missions_goal_idx on public.missions (goal_id);
create index if not exists findings_goal_idx on public.findings (goal_id);

revoke all on all tables in schema public from anon;
