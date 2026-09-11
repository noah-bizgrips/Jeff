-- Jeff core schema. Single-owner application.
-- Security model:
--   * public.app_owner binds the app to exactly ONE auth.users uuid.
--   * public.is_owner()      -> auth.uid() is the bound owner
--   * public.is_owner_aal2() -> is_owner() AND the JWT carries aal = 'aal2'
--   * Every table has RLS enabled. Owner-facing tables allow the owner (aal2)
--     to read, and in a few cases write. connection_secrets has NO policies:
--     only the service role (server code) can touch it.
--   * No secret values appear in this file.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Owner binding
-- ---------------------------------------------------------------------------
create table public.app_owner (
  id          smallint primary key default 1 check (id = 1),
  user_id     uuid not null unique references auth.users (id) on delete restrict,
  email       text not null,
  bound_at    timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.app_owner is 'Exactly one row: the only permitted user of Jeff. Populated by the server-side bootstrap from OWNER_USER_ID.';

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_owner o where o.user_id = auth.uid()
  );
$$;

create or replace function public.jwt_aal()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', 'aal1');
$$;

create or replace function public.is_owner_aal2()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_owner() and public.jwt_aal() = 'aal2';
$$;

revoke all on function public.is_owner() from public;
revoke all on function public.is_owner_aal2() from public;
revoke all on function public.jwt_aal() from public;
grant execute on function public.is_owner() to authenticated, service_role;
grant execute on function public.is_owner_aal2() to authenticated, service_role;
grant execute on function public.jwt_aal() to authenticated, service_role;

alter table public.app_owner enable row level security;
create policy app_owner_select_self on public.app_owner
  for select to authenticated
  using (user_id = auth.uid());
-- No insert/update/delete policies: only service role (server bootstrap) may write.

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type public.connection_status as enum (
  'not_configured',
  'ready_for_setup',
  'authorization_required',
  'testing',
  'connected',
  'limited',
  'reconnect_required',
  'paused',
  'error'
);

create type public.access_mode as enum ('read', 'read_write');

create type public.mission_status as enum (
  'draft', 'queued', 'running', 'review', 'approved', 'rejected', 'completed', 'failed', 'cancelled'
);

create type public.approval_status as enum ('pending', 'granted', 'denied', 'expired', 'consumed');

create type public.finding_status as enum ('open', 'acknowledged', 'in_progress', 'resolved', 'dismissed');

create type public.sync_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');

create type public.service_request_status as enum (
  'new', 'existing_connector', 'connector_can_be_prepared', 'manual_investigation_required', 'unsupported', 'in_progress', 'done'
);

-- ---------------------------------------------------------------------------
-- Connections (non-secret metadata only)
-- ---------------------------------------------------------------------------
create table public.connections (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references auth.users (id) on delete cascade,
  provider            text not null,                 -- registry id: google, slack, notion, highlevel, stripe, plaid, meta, github, n8n
  display_name        text not null,
  status              public.connection_status not null default 'not_configured',
  access_mode         public.access_mode not null default 'read',
  scopes              text[] not null default '{}',
  capabilities        text[] not null default '{}',  -- e.g. gmail, drive, calendar / ads, pages, instagram
  account_identifier  text,                          -- e.g. email, workspace name, location id, item id (non-secret)
  external_account_id text,                          -- provider-side id (non-secret)
  metadata            jsonb not null default '{}'::jsonb,  -- non-secret settings (selected accounts, etc.)
  last_test_at        timestamptz,
  last_test_ok        boolean,
  last_error          text,                          -- redacted
  last_sync_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (owner_id, provider, external_account_id)
);
create index connections_owner_provider_idx on public.connections (owner_id, provider);
create trigger connections_updated_at before update on public.connections
  for each row execute function public.set_updated_at();

alter table public.connections enable row level security;
create policy connections_owner_select on public.connections
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy connections_owner_update on public.connections
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());
-- Inserts and deletes go through server code (service role) so the encrypted
-- secret row is always created/removed in the same transaction.

-- ---------------------------------------------------------------------------
-- Connection secrets: ciphertext only. NO client access at all.
-- ---------------------------------------------------------------------------
create table public.connection_secrets (
  id                  uuid primary key default gen_random_uuid(),
  connection_id       uuid not null unique references public.connections (id) on delete cascade,
  encryption_version  smallint not null,
  ciphertext          text not null,
  iv                  text not null,
  auth_tag            text not null,
  secret_kind         text not null,               -- oauth_tokens | api_key | plaid_access_token | app_private_key ...
  expires_at          timestamptz,                 -- access-token expiry hint (non-secret)
  rotated_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger connection_secrets_updated_at before update on public.connection_secrets
  for each row execute function public.set_updated_at();

alter table public.connection_secrets enable row level security;
-- Deliberately no policies. Belt and braces: revoke table privileges too.
revoke all on table public.connection_secrets from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Sync runs
-- ---------------------------------------------------------------------------
create table public.sync_runs (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  connection_id   uuid references public.connections (id) on delete set null,
  provider        text not null,
  resource_type   text,
  trigger         text not null default 'manual',   -- manual | schedule | webhook
  status          public.sync_status not null default 'queued',
  started_at      timestamptz,
  finished_at     timestamptz,
  items_seen      integer not null default 0,
  items_upserted  integer not null default 0,
  cursor          text,                             -- provider cursor (non-secret)
  error           text,                             -- redacted
  created_at      timestamptz not null default now()
);
create index sync_runs_owner_idx on public.sync_runs (owner_id, created_at desc);
alter table public.sync_runs enable row level security;
create policy sync_runs_owner_select on public.sync_runs
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Source items: normalized records pulled from services
-- ---------------------------------------------------------------------------
create table public.source_items (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  connection_id    uuid references public.connections (id) on delete cascade,
  provider         text not null,
  capability       text,                            -- gmail | drive | calendar | ads | pages ...
  resource_type    text not null,                   -- email | file | event | message | contact | invoice | transaction ...
  external_id      text not null,
  title            text,
  summary          text,                            -- short, minimised excerpt
  author           text,
  source_url       text,
  source_timestamp timestamptz,
  synced_at        timestamptz not null default now(),
  content_hash     text,
  tags             text[] not null default '{}',
  metadata         jsonb not null default '{}'::jsonb,
  is_sample        boolean not null default false,
  -- Reserved for future search without a destructive migration:
  search_text      tsvector generated always as (
                     to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))
                   ) stored,
  embedding_status text,                            -- null | pending | done
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (owner_id, provider, resource_type, external_id)
);
create index source_items_owner_time_idx on public.source_items (owner_id, source_timestamp desc);
create index source_items_search_idx on public.source_items using gin (search_text);
create index source_items_tags_idx on public.source_items using gin (tags);
create trigger source_items_updated_at before update on public.source_items
  for each row execute function public.set_updated_at();
alter table public.source_items enable row level security;
create policy source_items_owner_select on public.source_items
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Missions, approvals
-- ---------------------------------------------------------------------------
create table public.missions (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  code          text not null,                      -- human id, e.g. M-0001
  title         text not null,
  goal          text not null,
  status        public.mission_status not null default 'draft',
  worker        text not null default 'claude',     -- claude | n8n | manual
  target        jsonb not null default '{}'::jsonb, -- e.g. { repo, branch, workflowId }
  budget_usd    numeric(10,2) not null default 5,
  time_limit_min integer not null default 15,
  max_retries   integer not null default 2,
  environment   text not null default 'sandbox',    -- sandbox | production (production requires approval)
  result        jsonb not null default '{}'::jsonb, -- evidence, PR url, test output summary (redacted)
  is_sample     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (owner_id, code)
);
create index missions_owner_status_idx on public.missions (owner_id, status);
create trigger missions_updated_at before update on public.missions
  for each row execute function public.set_updated_at();
alter table public.missions enable row level security;
create policy missions_owner_select on public.missions
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy missions_owner_insert on public.missions
  for insert to authenticated with check (public.is_owner_aal2() and owner_id = auth.uid() and environment = 'sandbox');
create policy missions_owner_update on public.missions
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());

create table public.approvals (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  mission_id     uuid references public.missions (id) on delete cascade,
  action         text not null,                      -- merge_pr | deploy | publish_workflow | send_message ...
  artifact_ref   text,                               -- exact version: commit sha, workflow version id
  environment    text not null default 'production',
  status         public.approval_status not null default 'pending',
  requested_at   timestamptz not null default now(),
  decided_at     timestamptz,
  expires_at     timestamptz,
  decided_aal    text,                               -- must be aal2 when granted
  reason         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index approvals_owner_status_idx on public.approvals (owner_id, status);
create trigger approvals_updated_at before update on public.approvals
  for each row execute function public.set_updated_at();
alter table public.approvals enable row level security;
create policy approvals_owner_select on public.approvals
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
-- Decisions are written by server code after re-verifying aal2 (service role).

-- ---------------------------------------------------------------------------
-- Findings (operations brain)
-- ---------------------------------------------------------------------------
create table public.findings (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  category         text not null,      -- lead_followup_gap | pipeline_aging | onboarding_blocker | missed_commitment |
                                       -- automation_failure | failed_payment | cashflow_change | recurring_expense_change |
                                       -- ad_spend_change | operational_bottleneck | automation_opportunity
  title            text not null,
  observed_facts   jsonb not null default '[]'::jsonb,   -- what the data literally says
  metrics          jsonb not null default '{}'::jsonb,   -- calculated numbers + formulas
  interpretation   text,                                  -- AI narrative, clearly separated
  evidence         jsonb not null default '[]'::jsonb,   -- [{ source_item_id, provider, external_id, url }]
  range_start      timestamptz,
  range_end        timestamptz,
  confidence       numeric(3,2) check (confidence between 0 and 1),
  limitations      text,
  severity         text not null default 'info',          -- info | low | medium | high
  status           public.finding_status not null default 'open',
  proposed_mission jsonb,                                  -- draft goal for a mission
  is_sample        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index findings_owner_status_idx on public.findings (owner_id, status, created_at desc);
create trigger findings_updated_at before update on public.findings
  for each row execute function public.set_updated_at();
alter table public.findings enable row level security;
create policy findings_owner_select on public.findings
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy findings_owner_update_status on public.findings
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Audit events (append-only, server-written)
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id           bigint generated always as identity primary key,
  owner_id     uuid,                                -- null for pre-auth events (e.g. failed login for unknown user)
  actor        text not null default 'owner',       -- owner | system | webhook | worker
  event        text not null,                       -- login, login_failed, mfa_enrolled, connection_created ...
  provider     text,
  target_id    text,
  ip_hash      text,                                -- sha256 of client ip, never raw
  user_agent   text,
  metadata     jsonb not null default '{}'::jsonb,  -- redacted, never request bodies
  created_at   timestamptz not null default now()
);
create index audit_events_owner_time_idx on public.audit_events (owner_id, created_at desc);
alter table public.audit_events enable row level security;
create policy audit_owner_select on public.audit_events
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
-- Insert only via service role. No update/delete for anyone but service role.

-- ---------------------------------------------------------------------------
-- Service requests ("Add a service")
-- ---------------------------------------------------------------------------
create table public.service_requests (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null references auth.users (id) on delete cascade,
  service_name         text not null,
  desired_capability   text not null,
  access_intent        public.access_mode not null default 'read',
  requested_resources  text[] not null default '{}',
  status               public.service_request_status not null default 'new',
  classification_notes text,
  implementation_notes text,
  matched_provider     text,                        -- registry id when classification = existing_connector
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index service_requests_owner_idx on public.service_requests (owner_id, created_at desc);
create trigger service_requests_updated_at before update on public.service_requests
  for each row execute function public.set_updated_at();
alter table public.service_requests enable row level security;
create policy service_requests_owner_select on public.service_requests
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy service_requests_owner_insert on public.service_requests
  for insert to authenticated with check (public.is_owner_aal2() and owner_id = auth.uid());
create policy service_requests_owner_update on public.service_requests
  for update to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Saved answers & notes (owner's own knowledge)
-- ---------------------------------------------------------------------------
create table public.saved_answers (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  question    text not null,
  answer      text not null,
  mode        text not null default 'ai',
  citations   jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
alter table public.saved_answers enable row level security;
create policy saved_answers_owner_all on public.saved_answers
  for all to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());

create table public.notes (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  title       text not null,
  content     text not null,
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger notes_updated_at before update on public.notes
  for each row execute function public.set_updated_at();
alter table public.notes enable row level security;
create policy notes_owner_all on public.notes
  for all to authenticated
  using (public.is_owner_aal2() and owner_id = auth.uid())
  with check (public.is_owner_aal2() and owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Default privileges: the anon role gets nothing in public.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
