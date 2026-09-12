-- Memory + operating rules layer. Additive only: new tables, new enum values,
-- nullable columns on findings. No data is removed or rewritten.

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type public.memory_scope as enum ('business', 'personal', 'financial', 'all');
create type public.memory_category as enum (
  'preference', 'definition', 'working_style', 'priority', 'dislike',
  'business_context', 'personal_context', 'communication_style', 'exception'
);
create type public.learning_source as enum ('chat', 'settings', 'system', 'feedback');
create type public.rule_effect as enum ('excluded', 'reclassified', 'suppressed', 'allowed_by_exception', 'unsuppressed');
create type public.feedback_verdict as enum ('useful', 'not_useful', 'wrong', 'too_noisy', 'dont_show', 'change_rule');

-- Finding lifecycle additions (existing values kept).
alter type public.finding_status add value if not exists 'new';
alter type public.finding_status add value if not exists 'reviewing';
alter type public.finding_status add value if not exists 'accepted';
alter type public.finding_status add value if not exists 'suppressed_by_rule';
alter type public.finding_status add value if not exists 'action_planned';
alter type public.finding_status add value if not exists 'action_in_progress';
alter type public.finding_status add value if not exists 'monitoring';

-- ---------------------------------------------------------------------------
-- Soft memory: durable facts about how the owner thinks and wants Jeff to behave.
-- ---------------------------------------------------------------------------
create table public.memories (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references auth.users (id) on delete cascade,
  scope               public.memory_scope not null default 'business',
  category            public.memory_category not null default 'preference',
  content             text not null,
  normalized_content  text not null,
  source              public.learning_source not null default 'chat',
  source_reference    text,
  confidence          numeric(3,2) not null default 0.80 check (confidence between 0 and 1),
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  last_used_at        timestamptz
);
create index memories_owner_active_idx on public.memories (owner_id, active, category);
create unique index memories_owner_normalized_idx on public.memories (owner_id, normalized_content);
create trigger memories_updated_at before update on public.memories
  for each row execute function public.set_updated_at();
alter table public.memories enable row level security;
create policy memories_owner_select on public.memories
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy memories_owner_update on public.memories
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());
create policy memories_owner_delete on public.memories
  for delete to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
-- Inserts happen through server code (service role) so normalization/audit always run.

-- ---------------------------------------------------------------------------
-- Operating rules: deterministic, machine-enforced configuration (never code).
-- ---------------------------------------------------------------------------
create table public.operating_rules (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null references auth.users (id) on delete cascade,
  name                    text not null,
  description             text,
  rule_type               text not null default 'monitor_filter',   -- monitor_filter | alert_policy | briefing_pref | classification
  scope                   public.memory_scope not null default 'business',
  target_system           text not null default 'monitors',         -- monitors | alerts | briefings | chat
  target_monitor          text,                                     -- null = all monitors
  conditions              jsonb not null default '{}'::jsonb,       -- validated by lib/jeff/rules/schema.ts
  action                  jsonb not null default '{"type":"exclude"}'::jsonb,
  priority                integer not null default 100,             -- lower = evaluated first among equals
  tier                    smallint not null default 1 check (tier in (1, 2)),
  enabled                 boolean not null default true,
  pending_confirmation    boolean not null default false,
  source                  public.learning_source not null default 'chat',
  source_conversation_id  text,
  source_message_id       text,
  source_quote            text,                                     -- the owner's words that created it (redacted)
  created_by              text not null default 'owner',            -- owner | system | jeff
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  last_triggered_at       timestamptz,
  trigger_count           integer not null default 0
);
create index operating_rules_owner_enabled_idx on public.operating_rules (owner_id, enabled, target_monitor);
create trigger operating_rules_updated_at before update on public.operating_rules
  for each row execute function public.set_updated_at();
alter table public.operating_rules enable row level security;
create policy operating_rules_owner_select on public.operating_rules
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy operating_rules_owner_update on public.operating_rules
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());
create policy operating_rules_owner_delete on public.operating_rules
  for delete to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Rule events: every rule-based decision is traceable.
-- ---------------------------------------------------------------------------
create table public.rule_events (
  id              bigint generated always as identity primary key,
  owner_id        uuid not null references auth.users (id) on delete cascade,
  rule_id         uuid not null references public.operating_rules (id) on delete cascade,
  finding_id      uuid references public.findings (id) on delete set null,
  source_item_id  uuid references public.source_items (id) on delete set null,
  monitor         text,
  effect          public.rule_effect not null,
  detail          text,                                              -- short, redacted
  created_at      timestamptz not null default now()
);
create index rule_events_rule_time_idx on public.rule_events (rule_id, created_at desc);
create index rule_events_finding_idx on public.rule_events (finding_id);
alter table public.rule_events enable row level security;
create policy rule_events_owner_select on public.rule_events
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Finding feedback + suppression trace
-- ---------------------------------------------------------------------------
create table public.finding_feedback (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  finding_id  uuid not null references public.findings (id) on delete cascade,
  verdict     public.feedback_verdict not null,
  note        text,
  rule_id     uuid references public.operating_rules (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index finding_feedback_finding_idx on public.finding_feedback (finding_id, created_at desc);
alter table public.finding_feedback enable row level security;
create policy finding_feedback_owner_select on public.finding_feedback
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

alter table public.findings add column if not exists suppressed_by_rule_id uuid references public.operating_rules (id) on delete set null;
alter table public.findings add column if not exists suppressed_at timestamptz;
alter table public.findings add column if not exists previous_status text;
create index if not exists findings_suppressed_rule_idx on public.findings (suppressed_by_rule_id) where suppressed_by_rule_id is not null;

revoke all on all tables in schema public from anon;
