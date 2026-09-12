# Jeff's Jobs · Find What I'm Missing · Follow-Through — status

Branch: `claude/jeffs-jobs` (from `claude/production-foundation`). Statuses: **DONE · IN PROGRESS · USER ACTION REQUIRED · BLOCKED · NOT STARTED**. No secrets in this file.

## 0. Audit — existing architecture reused (DONE)

| Area | What exists (2026-09-12) | Reuse decision |
| --- | --- | --- |
| Framework / hosting | Next.js 16 App Router + `proxy.ts`, Vercel; Supabase Postgres 17 with RLS on all 30+ tables; owner-only + TOTP aal2 | Unchanged (Tier-3 protected) |
| Scheduler | Vercel Cron: `/api/cron/sync` every 30 min (sync → client map/attribution → monitors → goals refresh → alerts → blind spots daily) and `/api/cron/briefings` every 15 min; `CRON_SECRET` bearer | Jobs run inside the same cron family with per-job schedules; no new orchestration |
| Monitors | `lib/jeff/monitors/*` — 22 pure monitors (lead follow-up, pipeline aging, open commitments, calendar bottleneck, failed payment, cash-flow, recurring expense, ad spend, underperforming acquisition, portal tasks/stages/notifications, uncontacted leads, unpaid invoices, ad spend without leads, automation failure) → `findings` by fingerprint, auto-resolve, rules applied first | Become the detectors behind system Jobs; each Job = a declarative bundle of monitors + sources + schedule + policy |
| Blind spots | `lib/jeff/blindspots/*` — 8 detectors, novelty vs findings/alerts, daily cap, one AI review, 👁️ push, `owner_attention` signals | Becomes the **Blind Spot Scanner** Job; "Find what I'm missing" triggers it with progress states |
| Findings / feedback / rules | `findings` (facts/metrics/interpretation/evidence/limitations/status), `finding_feedback`, `operating_rules` with tiers/precedence/conflicts, `rule_events`, reprocess/undo | Job findings ARE findings (`job_id` + `job_run_id` added); Job-scoped rules = `operating_rules.target_job` |
| Commitments | `commitments` table (actor, action, due_at, direction owed_by_me/owed_to_me, status open/done/dismissed/overdue) fed by the commitment classifier over Gmail/HighLevel/Slack | Extended into **obligations** (Open Obligations); commitments become one origin |
| Alerts / push | `alerts` (importance, dedupe, cooldown, quiet hours), Web Push with per-type toggles + emoji | Reminders and Job findings flow through the same engine; new emoji for obligations (⏰) and jobs (🧑‍💼) |
| Briefings | daily/weekly/monthly bundle → one AI call → validated summary; memories/rules honored | Add FOLLOW-THROUGH and JOBS sections (bounded) |
| Ask Jeff | tool loop with ~40 narrow tools (memory/rules, goals, alerts, briefings, commitments, clients, blind spots), budget guard, cached prefix | Add job + obligation tools; NL job/reminder creation |
| Goals / Missions | goals engine with trajectory/recommendations; missions with approvals + outcome measurement | Obligations link `related_goal_id`/`related_mission_id`; Jobs → findings → Prepare → mission |
| Integrations | Google (Gmail/Calendar/Drive), HighLevel, Stripe, Slack, Client Portal connected; Plaid/Meta/Notion/GitHub/n8n coded, awaiting credentials | Jobs declare sources; coverage shown as ACTIVE / LIMITED COVERAGE when a source is missing |
| Reminders / tasks | none beyond commitments; Apple Reminders not integrated (no public API; iCloud CalDAV possible later) | Provider abstraction `ObligationSource` with adapters for jeff, calendar, notion, highlevel, gmail/slack commitments; Apple left as `not_configured` |
| UI | Premium black design system (`app/globals.css`), nav in `components/jeff/AppShell.tsx`, mobile pass done | New pages `/jobs`, `/jobs/[slug]`, `/follow-through`; Mission Control strips |

## 1. Schema changes — NOT STARTED
Additive migrations: `jobs`, `job_runs`, `job_sources` (or `jobs.sources text[]`), `job_findings` via `findings.job_id/job_run_id`, `job_feedback` via `finding_feedback.job_id`, `operating_rules.target_job`; `obligations` (+ `obligation_events`, `obligation_sources`), migration path from `commitments`.

## 2. Jobs framework, Test/Run Now, UI, Ask Jeff, templates — NOT STARTED
## 3. Default system Jobs — NOT STARTED
Revenue Leakage Hunter · Relationship Radar · Client Health Analyst · Cash Flow Watchdog · Expense Creep Hunter · Commitment Watchdog · Follow-Through Watchdog · Automation Auditor · Time Allocation Auditor · Attention Cost Detector · Personal Project Tracker · Goal Coach · Blind Spot Scanner
## 4. Follow-Through (obligations, reminders, completion detection, escalation) — NOT STARTED
## 5. Find What I'm Missing (button, progress states, novelty) — NOT STARTED
## 6. Tests, preview deploy — NOT STARTED

## User actions required
- None to start. Coverage improves as Notion/Plaid/Meta/GitHub/n8n are connected.
