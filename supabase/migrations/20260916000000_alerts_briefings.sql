-- Alerts, briefings, owner settings, commitments, mission outcomes.
-- Additive only: new enums, new tables with RLS. No existing data is touched.

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type public.alert_kind as enum ('finding', 'goal', 'commitment', 'system');
create type public.alert_importance as enum ('informational', 'briefing', 'important', 'urgent', 'actionable');
create type public.alert_status as enum ('open', 'acknowledged', 'snoozed', 'dismissed', 'resolved');
create type public.briefing_kind as enum ('daily', 'weekly', 'monthly');
create type public.briefing_status as enum ('generated', 'read', 'saved');
create type public.commitment_status as enum ('open', 'done', 'dismissed', 'overdue');
create type public.commitment_direction as enum ('owed_by_me', 'owed_to_me');
create type public.outcome_direction as enum ('improved', 'worsened', 'unchanged', 'unknown');

-- ---------------------------------------------------------------------------
-- Alerts: findings/goal changes/commitments important enough to surface.
-- One row per condition (fingerprint); repeats bump occurrences.
-- ---------------------------------------------------------------------------
create table public.alerts (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  fingerprint    text not null,
  kind           public.alert_kind not null,
  ref_id         uuid,                                   -- finding_id / goal_id / commitment_id
  importance     public.alert_importance not null default 'briefing',
  scope          public.memory_scope not null default 'business',
  category       text,                                   -- finding category / goal / commitment
  title          text not null,
  summary        text,
  evidence       jsonb not null default '[]'::jsonb,
  status         public.alert_status not null default 'open',
  snoozed_until  timestamptz,
  cooldown_until timestamptz,
  deferred_until timestamptz,                            -- quiet hours: not surfaced before this
  occurrences    integer not null default 1,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  resolved_at    timestamptz,
  acknowledged_at timestamptz,
  rule_trace     jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (owner_id, fingerprint)
);
create index alerts_owner_status_idx on public.alerts (owner_id, status, importance, last_seen desc);
create trigger alerts_updated_at before update on public.alerts
  for each row execute function public.set_updated_at();
alter table public.alerts enable row level security;
create policy alerts_owner_select on public.alerts
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy alerts_owner_update on public.alerts
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());
-- Inserts/resolution are written by the alert engine (service role).

-- ---------------------------------------------------------------------------
-- Briefings: daily / weekly / monthly summaries (in-app inbox first).
-- ---------------------------------------------------------------------------
create table public.briefings (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  kind          public.briefing_kind not null,
  period_start  date not null,
  period_end    date not null,
  timezone      text not null default 'America/Denver',
  title         text not null,
  sections      jsonb not null default '{}'::jsonb,       -- validated BriefingSummary
  model         text,                                     -- null when the deterministic template was used
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  estimated_usd numeric(10,6) not null default 0,
  status        public.briefing_status not null default 'generated',
  read_at       timestamptz,
  saved         boolean not null default false,
  delivery      jsonb not null default '[]'::jsonb,       -- [{ provider, delivered_at }]
  created_at    timestamptz not null default now(),
  unique (owner_id, kind, period_start)
);
create index briefings_owner_idx on public.briefings (owner_id, created_at desc);
alter table public.briefings enable row level security;
create policy briefings_owner_select on public.briefings
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy briefings_owner_update on public.briefings
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Owner settings (single row per owner). Security settings are NOT here.
-- ---------------------------------------------------------------------------
create table public.owner_settings (
  owner_id                 uuid primary key references auth.users (id) on delete cascade,
  timezone                 text not null default 'America/Denver',
  daily_brief_enabled      boolean not null default true,
  daily_brief_time         text not null default '07:30',
  weekly_review_enabled    boolean not null default true,
  weekly_review_day        smallint not null default 1 check (weekly_review_day between 0 and 6),  -- 1 = Monday
  weekly_review_time       text not null default '07:30',
  monthly_review_enabled   boolean not null default true,
  monthly_review_time      text not null default '07:30',
  quiet_hours_start        text not null default '21:00',
  quiet_hours_end          text not null default '07:00',
  alert_min_importance     public.alert_importance not null default 'important',
  goal_alerts              boolean not null default true,
  opportunity_alerts       boolean not null default true,
  business_notifications   boolean not null default true,
  personal_notifications   boolean not null default true,
  financial_notifications  boolean not null default true,
  learn_from_feedback      boolean not null default true,
  auto_apply_safe_rules    boolean not null default true,
  ask_before_major_changes boolean not null default true,
  brief_max_items          smallint not null default 3 check (brief_max_items between 1 and 10),
  updated_at               timestamptz not null default now()
);
create trigger owner_settings_updated_at before update on public.owner_settings
  for each row execute function public.set_updated_at();
alter table public.owner_settings enable row level security;
create policy owner_settings_owner_select on public.owner_settings
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy owner_settings_owner_upsert on public.owner_settings
  for insert to authenticated with check (public.is_owner_aal2() and owner_id = auth.uid());
create policy owner_settings_owner_update on public.owner_settings
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Commitments extracted from human conversations.
-- ---------------------------------------------------------------------------
create table public.commitments (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  source_item_id  uuid references public.source_items (id) on delete set null,
  fingerprint     text not null,
  actor           text,
  action_text     text not null,
  context_text    text,                                   -- context-rich reminder sentence
  due_at          timestamptz,
  confidence      numeric(3,2) not null default 0.5 check (confidence between 0 and 1),
  status          public.commitment_status not null default 'open',
  direction       public.commitment_direction not null default 'owed_to_me',
  counterparty    text,
  provider        text,
  source_url      text,
  finding_id      uuid references public.findings (id) on delete set null,
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (owner_id, fingerprint)
);
create index commitments_owner_status_idx on public.commitments (owner_id, status, due_at);
create trigger commitments_updated_at before update on public.commitments
  for each row execute function public.set_updated_at();
alter table public.commitments enable row level security;
create policy commitments_owner_select on public.commitments
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy commitments_owner_update on public.commitments
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Mission outcomes: did the change work? Baseline vs post window.
-- ---------------------------------------------------------------------------
create table public.mission_outcomes (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  mission_id       uuid not null references public.missions (id) on delete cascade,
  finding_id       uuid references public.findings (id) on delete set null,
  goal_id          uuid references public.goals (id) on delete set null,
  metric_key       text not null,
  metric_label     text,
  higher_is_better boolean not null default true,
  baseline_value   numeric,
  baseline_window  jsonb not null default '{}'::jsonb,
  implemented_at   timestamptz not null,
  post_value       numeric,
  post_window      jsonb not null default '{}'::jsonb,
  delta            numeric,
  delta_pct        numeric,
  direction        public.outcome_direction not null default 'unknown',
  limitations      text,
  confounders      text[] not null default '{}',
  measured_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (mission_id, metric_key)
);
create index mission_outcomes_owner_idx on public.mission_outcomes (owner_id, measured_at);
create trigger mission_outcomes_updated_at before update on public.mission_outcomes
  for each row execute function public.set_updated_at();
alter table public.mission_outcomes enable row level security;
create policy mission_outcomes_owner_select on public.mission_outcomes
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

-- Missions: when the owner marks work complete (drives outcome measurement).
alter table public.missions add column if not exists completed_at timestamptz;
alter table public.missions add column if not exists finding_id uuid references public.findings (id) on delete set null;

revoke all on all tables in schema public from anon;
