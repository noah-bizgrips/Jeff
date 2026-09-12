# Jeff — Intelligence upgrade status

Branch: `claude/intelligence-memory-engine` (from `claude/production-foundation`).
Statuses: **DONE** · **IN PROGRESS** · **USER ACTION REQUIRED** · **BLOCKED** · **NOT STARTED**. No secrets in this file.

## Phase 1 — Audit of what already exists (DONE)

| Area | Current state | Verdict |
| --- | --- | --- |
| Framework | Next.js 16 App Router + `proxy.ts`, React 19, TypeScript, Vercel | Use as-is |
| Database | Supabase Postgres 17, migrations in `supabase/migrations/` (3 applied), RLS everywhere, `is_owner_aal2()` | Extend additively |
| Auth | Owner email + user id + TOTP aal2 enforced in proxy, layout, `requireOwnerAal2()` | Protected (Tier 3), untouched |
| Integrations | Google, HighLevel, Stripe connected in production; Plaid/Meta/Slack/Notion/GitHub/n8n coded, awaiting owner credentials | Reuse |
| Ingestion | `lib/integrations/sync/{google,highlevel,stripe,plaid}.ts` → `source_items` (normalized, PII-minimised), cursors in `connections.metadata.sync_cursors`, `sync_runs` rows | Extend (freshness view) |
| Scheduler | Vercel Cron `*/30 * * * *` → `/api/cron/sync` (bearer `CRON_SECRET`) → sync all → run monitors | Extend with more jobs on the same cron/route family |
| Monitors | `lib/jeff/monitors/*` — 8 pure rule-based monitors (lead_followup_gap, pipeline_aging, missed_commitment, automation_failure, operational_bottleneck, failed_payment, cashflow_change, recurring_expense_change) → `findings` upserted by `fingerprint`, auto-resolve | Extend: apply operating rules before candidate detection; add feedback + suppression states |
| Findings | `findings` table: observed_facts / metrics / interpretation / evidence / range / confidence / limitations / severity / status / proposed_mission | Extend lifecycle + `suppressed_by_rule` + rule trace |
| Missions / approvals | `missions`, `approvals` tables + APIs + UI; sandbox-only drafts; approval bound to artifact | Extend with goal/finding links + outcome measurement |
| Ask Jeff | `/api/jeff/chat` → `lib/jeff/chat.ts` (Claude via SDK, adaptive thinking, fallbacks) with 9 narrow tools in `lib/jeff/tools.ts`; untrusted-evidence wrapping; `ai_usage` ledger + daily budget | Extend with memory/rule/goal/briefing tools |
| Notifications | None (no alert model, no delivery) | Create |
| Memory / preferences / rules | None | Create |
| Goals | None | Create |
| Briefings | None | Create |
| Settings | Demo/Live mode cookie only | Create |
| UI | `components/{jeff,brain,assistant,connections,mission-control,security}` on the ported Jeff design system (`app/globals.css`) | Extend, preserve design |
| Tests | Vitest, 141 tests (auth, crypto, redaction, OAuth, webhooks, mappers, monitors) | Extend |

## Phase 2 — Memory + operating rules schema/engine — NOT STARTED
Tables: `memories`, `operating_rules`, `rule_events` (trigger history), `finding_feedback`. Rule engine: validated condition/action schema (Zod), precedence, conflict detection, Tier 1/2/3 safety, reprocessing with undo. Migration required (additive).

## Phase 3 — Ask Jeff memory/rule tools — NOT STARTED
Tools: `remember`, `forget`, `list_memories`, `propose_rule` → `apply_rule` (tier-gated), `list_rules`, `update_rule`, `explain_decision`.

## Phase 4 — Rules integrated into monitors — NOT STARTED
Pipeline: normalization → operating rules → deterministic filters → candidates → evidence → (AI interpretation) → finding → alert decision. No LLM call for rule-excluded items.

## Phase 5 — Open Commitments GitHub-noise fix — NOT STARTED
Sender/domain/bot/subject-pattern classifier + confidence model (actor/action/future-state/due).

## Phase 6 — Memory & Rules UI — NOT STARTED
Route `/memory`, nav entry, edit/disable/delete/provenance/trigger history, conflicts, feedback buttons on findings.

## Phase 7–8 — Goal engine + UI — NOT STARTED
Tables: `goals`, `goal_metrics`, `goal_milestones`, `goal_source_mappings`, `goal_snapshots`, `goal_events`, `goal_recommendations`. NL parsing with validated `GoalInterpretation` schema; trajectory math deterministic.

## Phase 9–10 — Finding/opportunity + alert engine — NOT STARTED
`alerts` table, importance levels, dedupe/cooldown/snooze/acknowledge/mute, quiet hours.

## Phase 11–12 — Daily brief, weekly/monthly reviews — NOT STARTED
`briefings` table + inbox UI; cron-scheduled generation in America/Denver; delivery-provider abstraction (in-app first).

## Phase 13–15 — Mission Control, commitments, outcome measurement — NOT STARTED
## Phase 16 — Tests/security review, preview deploy — NOT STARTED

## User configuration required
- None for the memory/rules layer. Briefing time/timezone/quiet hours configurable in Settings (defaults: 7:30 AM America/Denver).
- Goals require the owner to type/approve them in the UI.

## Blocked
- Nothing blocked. Meta/Plaid/Slack/Notion/GitHub/n8n data will enrich goals/monitors once those connections are authorized (paused by owner).
