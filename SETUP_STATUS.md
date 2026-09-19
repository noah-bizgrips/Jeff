# Jeff — setup status

Legend: **DONE** · **USER ACTION REQUIRED** · **BLOCKED** · **NOT STARTED**
No credential values appear in this file. Env var NAMES only.

Last updated: 2026-09-11

## Phase 1 — Starter audit

| Item | Status | Notes |
| --- | --- | --- |
| Repository inspected, build run | DONE | Starter built cleanly on Next 16.3.5 / Node 26. |
| `.gitignore` (was missing) | DONE | Covers `.env*`, `.vercel`, keys, credential JSON, `supabase/.temp`. |
| `next lint` (removed in Next 16) | DONE | Replaced with ESLint 9 flat config (`eslint.config.mjs`). |
| Obsolete `UPLOAD-TO-GITHUB.md` | DONE | Removed. |
| `.env.example` | DONE | All variable names documented. |
| Prototype HTML served at `/` via iframe | DONE | Moved to `docs/prototype/` (not served). UI migrated to React. |

## Phase 2–3 — App structure, Supabase SSR auth, login, MFA

| Item | Status | Notes |
| --- | --- | --- |
| Next.js structure (`app/(auth)`, `app/(jeff)`, `components/*`, `lib/*`) | DONE | |
| `lib/supabase/{client,server,admin}.ts` + `proxy.ts` (Next 16 Proxy) | DONE | `getClaims()` signature-verified sessions. |
| `/login` (owner-only, no signup) | DONE | Server-side `/api/auth/login`, audited failures. |
| `/unauthorized` for non-owner accounts | DONE | |
| `/mfa` — TOTP enroll (QR), challenge, verify, re-challenge | DONE | Owner enrolled + verified 2026-09-11 (audit trail confirmed). |
| aal2 enforced in proxy, layout, every API guard | DONE | |
| Create the owner user in Supabase Auth | DONE | Confirmed user exists in project `jpqwxyctzkokhrbizjxn` ("Jeff Production"). |
| Set `OWNER_USER_ID` in Vercel (prod/preview/dev) | DONE | |

## Phase 4 — Database

| Item | Status | Notes |
| --- | --- | --- |
| Supabase CLI config (`supabase/config.toml`, signup disabled, TOTP on) | DONE | |
| Migration `20260911000000_jeff_core.sql` | DONE | app_owner, connections, connection_secrets, sync_runs, source_items, missions, approvals, findings, audit_events, service_requests, saved_answers, notes. RLS on all. |
| Owner binding (`app_owner` row) | DONE | Bound to the owner UUID via CLI on 2026-09-11. Bootstrap route/script remain for re-binding. |
| Supabase CLI login | DONE | |
| Link project + apply migration | DONE | Dry-run reviewed (no destructive statements), pushed 2026-09-11. RLS verified on all 12 tables; `connection_secrets` has 0 client policies. |

## Phase 5–6 — Encryption & security

| Item | Status | Notes |
| --- | --- | --- |
| AES-256-GCM `encryptSecret/decryptSecret` (server-only) | DONE | |
| CSP with nonces, HSTS, XFO, nosniff, referrer, permissions policy | DONE | `lib/security/headers.ts`, `proxy.ts`, `next.config.ts`. |
| Zod validation + same-origin check on state-changing APIs | DONE | |
| OAuth state (signed cookie) + PKCE (Google) | DONE | |
| Redaction utility + redacted structured logging | DONE | |
| Audit events table + `audit()` helper | DONE | login, login_failed, mfa_*, connection_*, oauth_*, mission_*, approval_*, webhook_*, jeff_chat |
| Generate `JEFF_CREDENTIAL_ENCRYPTION_KEY` and add to Vercel (Sensitive) | USER ACTION REQUIRED | `npm run key:generate` prints one key; paste into Vercel only. |

## Phase 7–16 — Connections

| Provider | Code | Status | Owner action |
| --- | --- | --- | --- |
| Registry + status model + Connections UI | DONE | | |
| Google (Gmail/Drive/Calendar, read-only, PKCE) | DONE | CONNECTED 2026-09-11 | Internal OAuth client; all four probes pass. |
| Slack (user search/read scopes) | DONE | USER ACTION REQUIRED | Create Slack app; add `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` |
| Notion (read-only) | DONE | USER ACTION REQUIRED | Create public integration; add `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` |
| HighLevel (read-only, per-location) | DONE | CONNECTED 2026-09-12 | Private Marketplace app (published), route slug `/api/oauth/crm`; location "BizGrips - Clients". |
| Stripe (restricted key form + webhook + sync) | DONE | CONNECTED 2026-09-12 | Restricted read-only key verified ("Bizgrips"). Webhook endpoint needs `STRIPE_WEBHOOK_SECRET` (placeholder in Vercel) — USER ACTION optional. |
| Plaid / Financial Accounts (Link, exchange, webhook verify, transactions sync) | DONE | USER ACTION REQUIRED | Fill `PLAID_CLIENT_ID`, `PLAID_SECRET` placeholders (sandbox). |
| Meta (Ads/Pages/Instagram, v26.0, asset selection) | DONE | USER ACTION REQUIRED | Fill `META_APP_ID`, `META_APP_SECRET` placeholders. |
| GitHub App (JWT/installation tokens, repo selection, webhook) | DONE | USER ACTION REQUIRED | Create GitHub App; add `GITHUB_APP_*` vars |
| n8n adapter (read all; write only `jeff-test` tagged) | DONE | USER ACTION REQUIRED | Add `N8N_BASE_URL`, `N8N_API_KEY` |

## Phase 17–22 — Ask Jeff, worker, add-a-service, data model, findings, sample data

| Item | Status | Notes |
| --- | --- | --- |
| `/api/jeff/chat` (Claude via tools, untrusted-evidence handling) | DONE | Live on `claude-sonnet-5`; daily budget guard ($2 default, `ai_usage` ledger). |
| Tool architecture (`lib/jeff/tools.ts`) | DONE | get_connection_status, search_sources, get_calendar_context, get_crm_pipeline, get_financial_summary, get_ad_performance, get_findings, list_missions, create_mission |
| Claude technical worker (Vercel Sandbox) | NOT STARTED | Scaffolded via missions/approvals model; execution intentionally disabled in V1. |
| "Add a service" (`service_requests`, classifier, UI) | DONE | No installs / remote code. |
| `source_items` ingestion: Google, HighLevel, Stripe (charges/invoices/subscriptions/customers/refunds/disputes/balance/payouts), Plaid (transactions sync + balances) | DONE | Manual "Sync now" + Vercel cron every 30 min (`/api/cron/sync`). First Google sync: 480 records. |
| `findings` model + Insights UI + 8 monitors (lead follow-up gap, pipeline aging, missed commitment, automation failure, calendar bottleneck, failed payment, cash-flow change, recurring expense change) | DONE | Run after each cron sync or via "Run monitors now". |
| Demo/Live mode switch; sample data isolated | DONE | |

## Phase 23–24 — Vercel & Supabase

| Item | Status | Notes |
| --- | --- | --- |
| Vercel CLI authenticated | DONE | |
| Vercel project `jeff` linked + GitHub repo connected | DONE | Team noah-1259s-projects. |
| Preview deployment | DONE | Deployment Protection (SSO) on; unauthenticated probes verified: `/`→`/login`, APIs 401, health 200, CSP present. |
| Domain `jeff.bizgrips.com` | DONE | Cloudflare CNAME added 2026-09-11; Vercel cert issued; HTTPS + gating verified. |
| Supabase project ref | DONE | `jpqwxyctzkokhrbizjxn` |

| Non-secret Vercel env: `OWNER_EMAIL`, `JEFF_MODE`, `PLAID_ENV`, `NEXT_PUBLIC_APP_URL` (prod) | DONE | |
| Vercel env `NEXT_PUBLIC_SUPABASE_URL`, `OWNER_USER_ID` | DONE | |
| Vercel env `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `JEFF_CREDENTIAL_ENCRYPTION_KEY` | DONE | |
| Vercel env `ANTHROPIC_API_KEY`, `JEFF_MODEL`, `CRON_SECRET` | DONE | |

## Phase 25–26 — Tests, CI, security review

| Item | Status | Notes |
| --- | --- | --- |
| Vitest security suite (72 tests) | DONE | routing, claims, crypto, redaction, CSP, OAuth state, guards, webhooks, credential endpoints, classification |
| Typecheck, ESLint, production build | DONE | `npm run verify` |
| GitHub Actions CI on PRs | DONE | `.github/workflows/ci.yml` incl. secret-pattern scan |
| Secret scan of repo | DONE | No credential patterns present. |

## Naming note (2026-09-19)

The product was briefly renamed Gomez on 2026-09-18 and renamed back to Jeff the next day; only the Ask Jeff greeting ("Hola, I'm Jeff.") kept the change. Migrations `20260924000000_rebrand_gomez.sql` and `20260925000000_rebrand_jeff.sql` record the round trip for stored actor values (`operating_rules.created_by`, `obligations.origin`) and user-visible text.

## Intelligence upgrade (memory & rules, goals, alerts, briefings)

| Item | Status | Notes |
| --- | --- | --- |
| Memory & operating rules engine + UI (`/memory`) | DONE | Deployed to production 2026-09-12. See `INTELLIGENCE_UPGRADE_STATUS.md`. |
| Open Commitments classifier fix + seeded GitHub rule | DONE | |
| Goals engine + UI (`/goals`) | DONE | 2026-09-17: detailed briefs (≤6k chars) — cross-source metric conditions joined by email/contact/customer/client identity, hard exclusions, Client Portal as a goal source, anchored start dates ("from Steve's sign date"), strict-tool-compliant interpreter schema. |
| Alert engine + Alert center (`/alerts`) | DONE | |
| Daily/weekly/monthly briefings (`/briefings`), cron every 15 min | DONE | 7:30 AM America/Denver default; configurable in `/settings`. |
| Commitments, outcome measurement, data freshness, Settings | DONE | |
| Web Push (PWA), mobile pass, blind spots | DONE | |
| Jeff's Jobs (13 system jobs, Test/Run now, NL job creation), Find what I'm missing, Follow-Through (obligations, persistent reminders, completion detection) | DONE | Production 2026-09-12; see `JEFF_JOBS_STATUS.md`. |

## Phase 27–30

| Item | Status |
| --- | --- |
| Preview URL tests | DONE |
| Production deployment | DONE — 2026-09-11, alias jeff-noah-1259s-projects.vercel.app; owner login + TOTP enrollment verified on preview; health/gating/CSP/HSTS verified on production |
| Connect services one by one | IN PROGRESS — Google ✓ · HighLevel ✓ · Stripe ✓ · next: Meta, Plaid, Slack, Notion, GitHub, n8n |
