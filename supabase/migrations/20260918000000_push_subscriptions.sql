-- Web Push: per-device subscriptions for the owner's installed PWA, plus
-- owner toggles and per-alert push bookkeeping. Additive only.

create table public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  device_label  text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  last_error    text,
  disabled_at   timestamptz
);
create index push_subscriptions_owner_idx on public.push_subscriptions (owner_id) where disabled_at is null;
alter table public.push_subscriptions enable row level security;
create policy push_subscriptions_owner_select on public.push_subscriptions
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
create policy push_subscriptions_owner_delete on public.push_subscriptions
  for delete to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
-- Inserts/updates happen server-side (service role) after the owner+aal2 route validates the payload.
revoke all on table public.push_subscriptions from anon;

alter table public.owner_settings
  add column if not exists push_alerts    boolean not null default true,
  add column if not exists push_briefings boolean not null default true;

-- One push per alert per importance level; deferred alerts are pushed when the quiet window ends.
alter table public.alerts
  add column if not exists pushed_at          timestamptz,
  add column if not exists pushed_importance  text;
