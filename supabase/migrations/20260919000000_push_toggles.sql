-- Per-type push toggles for goal and opportunity alerts (additive).
alter table public.owner_settings
  add column if not exists push_goal_alerts        boolean not null default true,
  add column if not exists push_opportunity_alerts boolean not null default true;
