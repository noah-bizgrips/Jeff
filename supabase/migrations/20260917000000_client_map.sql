-- Client entity map: one row per portal client, joining the identifiers each
-- connected provider uses for that client. Rebuilt from source_items after
-- every portal sync (lib/jeff/clients/map.ts). Additive only.

create table public.client_map (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references auth.users (id) on delete cascade,
  portal_client_id      text not null,
  name                  text not null,
  slug                  text,
  status                text,
  ghl_contact_id        text,
  meta_page_ids         text[] not null default '{}',
  meta_form_ids         text[] not null default '{}',
  email_hashes          text[] not null default '{}',
  email_domains         text[] not null default '{}',
  stripe_customer_ids   text[] not null default '{}',
  highlevel_contact_ids text[] not null default '{}',
  updated_at            timestamptz not null default now(),
  unique (owner_id, portal_client_id)
);
comment on table public.client_map is 'Per-client identifier map (portal ↔ Meta pages ↔ HighLevel contacts ↔ Stripe customers via hashed emails). Derived data; rebuilt by the server.';

create index client_map_owner_idx on public.client_map (owner_id);
create index client_map_meta_pages_idx on public.client_map using gin (meta_page_ids);
create index client_map_email_hashes_idx on public.client_map using gin (email_hashes);
create index client_map_stripe_idx on public.client_map using gin (stripe_customer_ids);

alter table public.client_map enable row level security;
create policy client_map_owner_select on public.client_map
  for select to authenticated using (public.is_owner_aal2() and owner_id = auth.uid());
-- Writes: service role only (server-side rebuild).
