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

## Phase 2 — Memory + operating rules schema/engine — DONE
Migration `20260914000000_memory_rules.sql` (additive; **must be pushed with `supabase db push` by the main session**): `memories`, `operating_rules`, `rule_events`, `finding_feedback`, new `finding_status` values (`new`, `reviewing`, `accepted`, `suppressed_by_rule`, `action_planned`, `action_in_progress`, `monitoring`), `findings.suppressed_by_rule_id / suppressed_at / previous_status`. Engine in `lib/jeff/rules/`: Zod schema (rules are configuration, never code; safe wildcard patterns only), deterministic matcher, precedence (system > owner > goal > monitor > preference, then specificity; specific `include` overrides broad `exclude`), conflict detection, safety tiers (Tier 3 vocabulary → refused), reprocess/undo without deleting evidence.

## Phase 3 — Ask Jeff memory/rule tools — DONE
`remember_preference`, `forget_memory`, `list_memories`, `list_rules`, `interpret_rule` (deterministic parser for sender/domain/GitHub/bot/amount/monitor/briefing patterns; validated model fallback via `proposed_rule`), `apply_rule` (Tier 1 apply + reprocess; Tier 2 pending confirmation; Tier 3 refused), `update_rule` (enable/disable/confirm/edit/undo), `explain_finding_decision`. System prompt requires feedback to go through these tools and to report exactly what changed.

## Phase 4 — Rules integrated into monitors — DONE
`runMonitors(rows, now, monitors, rules)`: rules exclude source rows before any monitor runs (no AI involved), then adjust candidates (severity, confidence floor, include exceptions). Decisions are written to `rule_events`; trigger counts updated. Seeded system rule "Ignore GitHub repo notifications in Open commitments" created idempotently per owner.

## Phase 5 — Open Commitments GitHub-noise fix — DONE
`lib/jeff/monitors/commitment-classifier.ts`: human/bot/system classification from sender address & domain, Gmail category labels, display-name markers and structural subject patterns (`[owner/repo]`, `PR #`, deployment/build/workflow, receipts, unsubscribe). Commitment extraction needs actor + action + future marker; due dates parsed; confidence scored; replies close the loop. Acceptance sample (`[BizGrips-Site-Builds/…]` from notifications@github.com) is excluded with or without a rule.

## Phase 6 — Memory & Rules UI — DONE
Route `/memory` ("Memory & rules" in nav): memories grouped by category with scope/provenance, inline edit/delete; rules with plain-English summary, enable/disable/confirm, edit (structured form), history (rule_events), reprocess, undo, delete; conflicts panel; Add rule/Add memory. Finding modal has Useful / Not useful / Wrong / Too noisy / Don't show this again (narrowest rule inferred, never a monitor mute) / Change rule (opens editor with proposal). Suppressed findings shown collapsed with the rule name.

APIs: `GET/POST /api/rules`, `GET/PATCH/DELETE /api/rules/[id]`, `POST /api/rules/[id]/reprocess`, `POST /api/rules/[id]/undo`, `GET /api/rules/conflicts`, `GET/POST/PATCH/DELETE /api/memories`, `POST /api/findings/[id]/feedback` — all owner+aal2, audited (`rule_*`, `memory_*`, `findings_reprocessed`, `finding_feedback`).

Tests: 181 total (40 new) — schema rejection of unsafe input, matcher, precedence/§51 exception, conflicts, tiers (Tier 3 refusals), classifier + monitor, rules-before-monitors trace, NL interpretation (§50, §51, §52), narrow feedback rules (§11), route auth, §50 end-to-end at tool level with reprocessing, rule lifecycle, memories de-dup/forget.

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
