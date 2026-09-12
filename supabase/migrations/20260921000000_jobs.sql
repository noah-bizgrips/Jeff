-- Jeff's Jobs: persistent recurring responsibilities Jeff owns for the owner.
-- Additive only. Jobs are declarative configuration (detector ids, sources,
-- schedule, policy); they never carry executable code.

create type public.job_scope as enum ('business', 'personal', 'financial', 'all');
create type public.job_type as enum ('system', 'user', 'custom');
create type public.job_status as enum ('active', 'paused', 'draft', 'disabled', 'error');
create type public.job_schedule_type as enum ('continuous', 'event_driven', 'hourly', 'daily', 'weekly', 'monthly', 'custom', 'manual');
create type public.job_run_mode as enum ('test', 'run', 'scheduled');
create type public.job_run_status as enum ('queued', 'running', 'succeeded', 'partial', 'failed');

create table public.jobs (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null references auth.users (id) on delete cascade,
  slug                 text not null,
  name                 text not null,
  icon                 text not null default 'briefcase',
  description          text not null default '',
  purpose              text not null default '',
  scope                public.job_scope not null default 'business',
  job_type             public.job_type not null default 'system',
  status               public.job_status not null default 'active',
  schedule_type        public.job_schedule_type not null default 'daily',
  schedule_expression  text,                                  -- weekly: "mon 07:05" · monthly: "1 07:05" · daily/hourly: "07:05" · custom: validated subset
  timezone             text,                                  -- null = owner_settings.timezone
  notification_policy  jsonb not null default '{"min_importance":"important","push":true,"briefing_only":false,"max_per_day":5}'::jsonb,
  minimum_severity     text not null default 'low',
  sources              text[] not null default '{}',          -- provider ids the job may analyze
  detectors            text[] not null default '{}',          -- monitor / detector ids bundled by this job
  config               jsonb not null default '{}'::jsonb,    -- validated per template
  system_managed       boolean not null default false,
  created_by           text not null default 'owner',         -- owner | jeff | system
  last_run_at          timestamptz,
  next_run_at          timestamptz,
  run_count            integer not null default 0,
  findings_30d         integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (owner_id, slug)
);
create index jobs_owner_status_idx on public.jobs (owner_id, status, next_run_at);
create trigger jobs_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();
alter table public.jobs enable row level security;
create policy jobs_owner_select on public.jobs
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy jobs_owner_update on public.jobs
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());
-- Inserts/deletes go through server code (service role) so seeding stays consistent.

create table public.job_runs (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  job_id        uuid not null references public.jobs (id) on delete cascade,
  mode          public.job_run_mode not null,
  status        public.job_run_status not null default 'queued',
  started_at    timestamptz,
  finished_at   timestamptz,
  duration_ms   integer,
  coverage      jsonb not null default '[]'::jsonb,   -- [{ source, status ok|missing|stale|error, freshness }]
  stats         jsonb not null default '{}'::jsonb,   -- counts, ai calls, cost, progress
  results       jsonb not null default '[]'::jsonb,   -- TEST mode: bounded would-be findings
  error         text,
  created_at    timestamptz not null default now()
);
create index job_runs_job_idx on public.job_runs (job_id, created_at desc);
create index job_runs_owner_idx on public.job_runs (owner_id, created_at desc);
alter table public.job_runs enable row level security;
create policy job_runs_owner_select on public.job_runs
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

-- Findings/feedback/rules learn which job produced or scopes them.
alter table public.findings add column if not exists job_id uuid references public.jobs (id) on delete set null;
alter table public.findings add column if not exists job_run_id uuid references public.job_runs (id) on delete set null;
create index if not exists findings_job_idx on public.findings (owner_id, job_id, status);
alter table public.finding_feedback add column if not exists job_id uuid references public.jobs (id) on delete set null;
alter type public.feedback_verdict add value if not exists 'already_knew';
alter table public.operating_rules add column if not exists target_job text;   -- job slug; null = not job-scoped
create index if not exists operating_rules_owner_job_idx on public.operating_rules (owner_id, target_job);
alter table public.owner_settings add column if not exists jobs_auto_create_safe boolean not null default true;
