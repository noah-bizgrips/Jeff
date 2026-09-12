-- Deterministic identity for monitor-generated findings so re-runs update
-- instead of duplicating. Non-destructive: nullable columns + partial unique index.
alter table public.findings add column if not exists fingerprint text;
alter table public.findings add column if not exists last_seen_at timestamptz;
create unique index if not exists findings_owner_fingerprint_idx
  on public.findings (owner_id, fingerprint) where fingerprint is not null;
