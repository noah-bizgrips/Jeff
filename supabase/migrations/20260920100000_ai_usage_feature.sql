-- Attribute AI spend to the feature that incurred it (additive).
alter table public.ai_usage add column if not exists feature text not null default 'other';
create index if not exists ai_usage_owner_feature_day_idx on public.ai_usage (owner_id, feature, created_at desc);
