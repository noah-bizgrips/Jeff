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

## Phase 7 — Goal engine — DONE
Migration `20260915000000_goals.sql` (additive; **must be pushed with `supabase db push` by the main session**): `goals` (immutable `prompt_text` enforced by trigger), `goal_metrics`, `goal_milestones`, `goal_source_mappings`, `goal_snapshots`, `goal_events`, `goal_recommendations`, plus nullable `goal_id` on `missions` and `findings`. Engine in `lib/jeff/goals/`: Zod `GoalInterpretation` (`schema.ts`); deterministic pre-parser for N clients/leads in N days, CAC under $X, sign→payment under N days, $X MRR, reserve by <month>, response time below N min, margin ≥ X% (`interpret.ts`) with a validated strict-tool Claude pass only when coverage is low (budget-guarded, no network in tests); deterministic metric computation with per-metric source/formula/time range/sample size/freshness/limitations and null-not-zero for missing sources (`metrics.ts`, incl. HighLevel→Stripe duration pairing by hashed email and a safe arithmetic evaluator — no `eval`); trajectory labels On track / Slightly at risk / At risk / Severely at risk / Not enough data with pace, linear forecast + coarse band, constraint violations and driver-based constraint detection (`trajectory.ts`); rule-based recommendations with why/evidence/mechanism/downside/what-Jeff-can-prepare/approval flag (`recommend.ts`); refresh job writing snapshots, `trajectory_changed` events and upserting recommendations, run after every cron sync and via `POST /api/goals/refresh` (`refresh.ts`). §49 acceptance covered by tests (10 clients / 60 days / CAC < $1,000 / sign→payment < 14 days; HighLevel + Meta + Stripe; ambiguities for CAC definition, sign date, average/median/every client). Approved metric definitions are never silently redefined: edits are `edited` events with before/after.

APIs: `GET/POST /api/goals`, `GET/PATCH/DELETE /api/goals/[id]` (approve with resolved ambiguities; pause/resume/archive; edits), `POST /api/goals/refresh`, `POST /api/goals/[id]/refresh`, `POST /api/goals/[id]/recommendations/[recId]/prepare` (sandbox mission linked by `goal_id`). All owner+aal2, Zod, audited (`goal_created`, `goal_approved`, `goal_updated`, `goal_deleted`, `goal_recommendation_prepared`). Ask Jeff tools: `list_goals`, `get_goal_status`, `propose_goal` (+ system prompt guidance: trajectory label, metric vs target, pace, constraint, freshness; never claims tracking before approval).

## Phase 8 — Goal tracking UI — DONE
Route `/goals` ("Goals" in nav): cards with primary-metric progress, days remaining, trajectory pill, constraint; New goal → NL prompt → review screen (metrics with sources/formulas, assumptions, ambiguities as choice groups or free text, dates) → Approve; detail view with metrics table (value/target/source/formula/window/n/updated/freshness), trajectory + forecast + observed vs required pace, leading indicators, snapshot history bars, recommendations with Prepare → mission, related missions, events. Mission Control shows a compact "Goals at risk" strip in Live mode.

Tests: 218 total (37 new) — §49 pre-parse, other shapes, model merge/validation fallback, metric computation (count, currency minor units, ratio null on missing source, duration pairing, staleness, safe formulas), trajectory scenarios + driver constraint + history pace, recommendations, route auth, propose→approve (prompt immutability, unresolved ambiguities block, dates), post-approval edit events, refresh snapshot/metric/event, prepare → sandbox mission, chat tools.

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
