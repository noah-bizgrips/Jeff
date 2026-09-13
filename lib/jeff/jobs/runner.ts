import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { errorMessage, log } from "@/lib/security/log";
import { loadRows, persistFindings } from "@/lib/jeff/monitors";
import type { CandidateFinding, SourceRow } from "@/lib/jeff/monitors/types";
import { listRules, recordRuleEvents, type RuleEventInput } from "@/lib/jeff/rules/store";
import { ensureSystemRules } from "@/lib/jeff/rules/apply";
import { decide } from "@/lib/jeff/rules/precedence";
import { subjectFromCandidate, subjectFromRow } from "@/lib/jeff/rules/engine";
import { resolveMonitorId, type OperatingRule } from "@/lib/jeff/rules/schema";
import { loadFreshness } from "@/lib/jeff/freshness-store";
import { runAlertsForOwner } from "@/lib/jeff/alerts/store";
import { getSettings } from "@/lib/jeff/settings-store";
import { localTime } from "@/lib/jeff/settings";
import { refreshGoals, type GoalRefreshResult } from "@/lib/jeff/goals/refresh";
import { latestSnapshot } from "@/lib/jeff/goals/store";
import { TRAJECTORY_LABEL } from "@/lib/jeff/goals/schema";
import { formatMetricValue } from "@/lib/jeff/goals/metrics";
import { loadBlindSpotContext, runBlindSpotsForOwner, detectBlindSpots, DETECTORS as BLIND_SPOT_DETECTORS } from "@/lib/jeff/blindspots";
import { toFinding as blindSpotToFinding } from "@/lib/jeff/blindspots/detect";
import { computeCoverage, coverageLevel, coverageNotes } from "./coverage";
import { getDetector } from "./detectors";
import type { DetectorSpec } from "./types";
import { alertsCreatedToday, finishRun, recordRunCompleted, setRunProgress, startRun } from "./store";
import type { CoverageEntry, DetectorContext, JobRow, ProgressStep, RunMode, RunStats, TestResult } from "./types";

/**
 * Job runner.
 *
 * TEST  → analyse current data, return would-be findings, write ONLY a
 *         job_runs row (mode test). No findings, alerts, pushes, missions,
 *         or source changes.
 * RUN / SCHEDULED → persist findings tagged with the job, resolve cleared
 *         ones within the job's scope, raise alerts under the job's
 *         notification policy, record stats.
 *
 * Partial provider outage never fails a run and never lets a detector
 * conclude anything from missing data: those detectors are skipped and the
 * run is marked `partial` with a plain-language coverage note.
 */

export interface JobRunOutcome {
  runId: string;
  mode: RunMode;
  status: "succeeded" | "partial" | "failed";
  coverage: CoverageEntry[];
  stats: RunStats;
  results: TestResult[];
  notes: string[];
  error?: string;
}

const SOURCE_LABELS: Record<string, string> = { google: "Google", highlevel: "HighLevel", stripe: "Stripe", plaid: "Financial Accounts", meta: "Meta", slack: "Slack", notion: "Notion", github: "GitHub", n8n: "n8n", portal: "Client Portal" };

function emptyStats(): RunStats {
  return { records_considered: 0, candidates: 0, rules_matched: 0, findings_created: 0, findings_updated: 0, findings_resolved: 0, duplicates_suppressed: 0, alerts_created: 0, ai_calls: 0, tokens: 0, cost_usd: 0 };
}

/** Rules that apply inside this job: global (no target_job) + rules scoped to this slug. */
export function rulesForJob(rules: OperatingRule[], slug: string): OperatingRule[] {
  return rules.filter((r) => r.enabled && !r.pending_confirmation && (!r.target_job || r.target_job === slug));
}

/**
 * Pure core: rows → owner rules → detectors → post-candidate rules. Job-scoped
 * rules without a target_monitor apply to every detector in the job.
 */
export function runDetectors(
  job: JobRow,
  specs: DetectorSpec[],
  ctx: Omit<DetectorContext, "job">,
  rules: OperatingRule[],
): { candidates: CandidateFinding[]; events: RuleEventInput[]; excludedRows: number; suppressed: number; errors: { detector: string; message: string }[] } {
  const candidates: CandidateFinding[] = [];
  const events: RuleEventInput[] = [];
  const errors: { detector: string; message: string }[] = [];
  let excludedRows = 0;
  let suppressed = 0;
  const active = rulesForJob(rules, job.slug);
  for (const spec of specs) {
    if (!spec.run) continue;
    const monitorId = resolveMonitorId(spec.id) ?? spec.id;
    const relevant = active.filter((r) => !r.target_monitor || resolveMonitorId(r.target_monitor) === monitorId || r.target_job === job.slug);
    let input = ctx.rows;
    if (relevant.some((r) => r.action.type === "exclude" || r.action.type === "include")) {
      const seen = new Set<string>();
      input = ctx.rows.filter((row) => {
        const v = decide(relevant, subjectFromRow(row, monitorId));
        if (v.excluded && v.decidedBy) {
          const key = `${v.decidedBy.id}:${row.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            events.push({ ruleId: v.decidedBy.id, sourceItemId: row.id, monitor: monitorId, effect: "excluded", detail: row.title ?? undefined });
            excludedRows++;
          }
          return false;
        }
        return true;
      });
    }
    try {
      const index = new Map(input.map((r) => [r.id, r]));
      for (const c of spec.run({ ...ctx, rows: input, job })) {
        const v = decide(relevant, subjectFromCandidate(c, index));
        if (v.excluded && v.decidedBy) {
          events.push({ ruleId: v.decidedBy.id, monitor: monitorId, effect: "excluded", detail: c.title });
          suppressed++;
          continue;
        }
        if (v.minConfidence != null && c.confidence < v.minConfidence) {
          suppressed++;
          continue;
        }
        const sevRank: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3 };
        if ((sevRank[c.severity] ?? 0) < (sevRank[job.minimum_severity] ?? 0)) {
          suppressed++;
          continue;
        }
        candidates.push(v.severity && v.severity !== c.severity ? { ...c, severity: v.severity } : c);
      }
    } catch (err) {
      errors.push({ detector: spec.id, message: errorMessage(err) });
    }
  }
  const byFp = new Map<string, CandidateFinding>();
  for (const c of candidates) byFp.set(c.fingerprint, c);
  return { candidates: [...byFp.values()], events, excludedRows, suppressed, errors };
}

export function toTestResult(c: CandidateFinding, existing: boolean): TestResult {
  return {
    fingerprint: c.fingerprint,
    category: c.category,
    title: c.title,
    severity: c.severity,
    confidence: c.confidence,
    observed_facts: c.observed_facts.slice(0, 5),
    interpretation: c.interpretation.slice(0, 600),
    evidence_count: c.evidence.length,
    evidence: c.evidence.slice(0, 4).map((e) => ({ title: e.title, url: e.url, provider: e.provider })),
    limitations: c.limitations,
    existing,
  };
}

/** Goal Coach: findings for goals whose trajectory is at risk (deterministic, from the latest snapshot). */
export async function goalTrajectoryCandidates(results: GoalRefreshResult[], now: Date): Promise<CandidateFinding[]> {
  const out: CandidateFinding[] = [];
  for (const r of results) {
    if (!["slightly_at_risk", "at_risk", "severely_at_risk"].includes(r.trajectory)) continue;
    const snap = await latestSnapshot(r.goalId).catch(() => null);
    const primary = Object.values(r.metrics)[0];
    const facts: string[] = [];
    if (primary) facts.push(`Primary metric ${primary.key}: ${formatMetricValue(primary)} (target ${primary.target ?? "—"}), from ${primary.source}, sample ${primary.sample_size}, ${primary.freshness}.`);
    if (snap) facts.push(`Elapsed ${Math.round((snap.elapsed_pct ?? 0) * 100)}% of the window; completion ${Math.round((snap.completion_pct ?? 0) * 100)}%; observed pace ${snap.observed_pace ?? "—"} vs required ${snap.required_pace ?? "—"}.`);
    const severity = r.trajectory === "severely_at_risk" ? "high" : r.trajectory === "at_risk" ? "medium" : "low";
    out.push({
      fingerprint: `goal_trajectory:${r.goalId}`,
      category: "goal_trajectory",
      title: `${r.name}: ${TRAJECTORY_LABEL[r.trajectory]}`,
      observed_facts: facts,
      metrics: { trajectory: r.trajectory, constraint_key: snap?.constraint_key ?? null, observed_pace: snap?.observed_pace ?? null, required_pace: snap?.required_pace ?? null, forecast: snap?.forecast ?? null },
      interpretation: snap?.constraint_key ? `The binding constraint looks like "${snap.constraint_key}". Moving that driver is the highest-leverage change for this goal.` : `Pace is below what the remaining window requires. Review the goal's recommendations for the highest-leverage next step.`,
      evidence: [],
      range_start: snap?.taken_at ?? null,
      range_end: now.toISOString(),
      confidence: primary && primary.freshness === "fresh" ? 0.75 : 0.5,
      limitations: primary ? primary.limitations.join("; ") || "Linear forecast from observed pace; small samples widen the error band." : "No metric data yet.",
      severity,
      proposed_mission: null,
      goal_id: r.goalId,
    });
  }
  return out;
}

const SEV_TO_IMPORTANCE_RANK: Record<string, number> = { informational: 0, briefing: 1, important: 2, actionable: 2, urgent: 3 };

/**
 * Applies the job's notification policy to alerts raised for its findings:
 * briefing_only caps importance, max_per_day demotes the overflow to
 * informational, push=false marks alerts as already pushed.
 */
export async function applyNotificationPolicy(ownerId: string, job: JobRow, findingIds: string[], now: Date): Promise<number> {
  if (!findingIds.length) return 0;
  const admin = createAdminClient();
  const settings = await getSettings(ownerId);
  const tz = job.timezone ?? settings.timezone;
  const lt = localTime(now, tz);
  const dayStart = new Date(Date.UTC(lt.year, lt.month - 1, lt.day)).toISOString();
  const { data } = await admin.from("alerts").select("id, importance, created_at, pushed_at").eq("owner_id", ownerId).in("ref_id", findingIds).eq("status", "open");
  const alerts = (data ?? []) as { id: string; importance: string; created_at: string; pushed_at: string | null }[];
  const policy = job.notification_policy;
  const createdToday = await alertsCreatedToday(ownerId, job.id, dayStart);
  let overflow = Math.max(0, createdToday - policy.max_per_day);
  let adjusted = 0;
  // Newest first: the alerts beyond today's cap are the latest ones, never the ones already surfaced.
  for (const a of alerts.sort((x, y) => y.created_at.localeCompare(x.created_at))) {
    const patch: Record<string, unknown> = {};
    let importance = a.importance;
    if (policy.briefing_only && (SEV_TO_IMPORTANCE_RANK[importance] ?? 0) > 1) importance = "briefing";
    if (overflow > 0 && a.created_at >= dayStart && (SEV_TO_IMPORTANCE_RANK[importance] ?? 0) >= 1) {
      importance = "informational";
      overflow--;
    }
    if (importance !== a.importance) patch.importance = importance;
    if ((SEV_TO_IMPORTANCE_RANK[importance] ?? 0) < (SEV_TO_IMPORTANCE_RANK[policy.min_importance] ?? 2) && !a.pushed_at) {
      // Below the push floor: stored, never pushed.
      patch.pushed_at = now.toISOString();
      patch.pushed_importance = a.importance;
    }
    if (!policy.push && !a.pushed_at) {
      patch.pushed_at = now.toISOString();
      patch.pushed_importance = a.importance;
    }
    if (Object.keys(patch).length) {
      const { error } = await admin.from("alerts").update(patch).eq("id", a.id);
      if (!error) adjusted++;
    }
  }
  return adjusted;
}

export async function runJob(ownerId: string, job: JobRow, opts: { mode: RunMode; now?: Date; onStart?: (runId: string) => void }): Promise<JobRunOutcome> {
  const now = opts.now ?? new Date();
  const mode = opts.mode;
  const runId = await startRun(ownerId, job.id, mode, now);
  opts.onStart?.(runId);
  const stats = emptyStats();
  const notes: string[] = [];
  let coverage: CoverageEntry[] = [];
  let results: TestResult[] = [];
  const progress = async (step: ProgressStep) => setRunProgress(runId, step).catch(() => undefined);

  try {
    const [freshness, rulesAll] = await Promise.all([loadFreshness(ownerId, now).catch(() => []), listRules(ownerId, { enabledOnly: false }).catch(() => [] as OperatingRule[])]);
    const rules = await ensureSystemRules(ownerId, rulesAll).catch(() => rulesAll);
    coverage = computeCoverage(job, freshness);
    notes.push(...coverageNotes(coverage, SOURCE_LABELS));
    const unavailable = new Set(coverage.filter((c) => c.status === "missing" || c.status === "error").map((c) => c.source));

    const specs = job.detectors.map((id) => getDetector(id)).filter((d): d is DetectorSpec => !!d);
    if (!specs.length) notes.push(job.status === "draft" ? "This analyst has no detectors yet (coming next)." : "No detectors configured.");

    // Detectors that need an unavailable source are skipped, never run on partial data.
    const runnable = specs.filter((s) => s.kind !== "special" && !s.sources.some((src: string) => unavailable.has(src)));
    const skipped = specs.filter((s) => s.kind !== "special" && s.sources.some((src: string) => unavailable.has(src)));
    for (const s of skipped) notes.push(`${s.label} skipped: ${s.sources.filter((src: string) => unavailable.has(src)).map((x: string) => SOURCE_LABELS[x] ?? x).join(", ")} unavailable.`);

    const candidates: CandidateFinding[] = [];
    let events: RuleEventInput[] = [];
    let rows: SourceRow[] = [];
    if (runnable.length) {
      rows = await loadRows(ownerId);
      stats.records_considered = rows.length;
      const r = runDetectors(job, runnable, { now, rows, freshness }, rules);
      candidates.push(...r.candidates);
      events = r.events;
      stats.rules_matched = r.events.length;
      stats.duplicates_suppressed = r.suppressed;
      for (const e of r.errors) notes.push(`${e.detector} failed: ${e.message}`);
    }

    // Special subsystems.
    const specials = specs.filter((s) => s.kind === "special").map((s) => s.id);
    if (specials.includes("goal_trajectory")) {
      await progress("reviewing_goals");
      if (mode === "test") {
        const goals = await refreshGoalsReadOnly(ownerId, now);
        candidates.push(...(await goalTrajectoryCandidates(goals, now)));
      } else {
        const refreshed = await refreshGoals(ownerId, now).catch((err) => {
          notes.push(`Goal refresh failed: ${errorMessage(err)}`);
          return [] as GoalRefreshResult[];
        });
        candidates.push(...(await goalTrajectoryCandidates(refreshed, now)));
      }
    }
    if (specials.includes("quiet_client")) {
      const ctx = await loadBlindSpotContext(ownerId, now);
      const quiet = BLIND_SPOT_DETECTORS.filter((d) => d.id === "quiet_client");
      const detected = detectBlindSpots(ctx, rulesForJob(rules, job.slug), quiet);
      candidates.push(...detected.candidates.map(blindSpotToFinding));
      events.push(...detected.events);
    }

    // Follow-Through Watchdog: obligations lifecycle (ingest → dedupe → completion → reminders). TEST never writes.
    if (specials.includes("follow_through")) {
      await progress("obligations");
      const { runFollowThrough } = await import("@/lib/jeff/obligations/watchdog");
      const summary = await runFollowThrough(ownerId, { mode: mode === "test" ? "test" : "run", now });
      stats.records_considered += summary.open;
      stats.candidates += summary.items.length;
      stats.rules_matched += summary.rules_applied;
      stats.findings_created += summary.created;
      stats.findings_updated += summary.merged + summary.auto_completed + summary.asked;
      stats.alerts_created += summary.reminders;
      stats.duplicates_suppressed += summary.suppressed_cap + summary.suppressed_quiet_hours;
      notes.push(...summary.notes);
      notes.push(`Follow-Through: ${summary.open} open · ${summary.overdue} overdue · ${summary.waiting_on_me} waiting on you · ${summary.waiting_on_other} waiting on others · ${summary.possibly_complete} possibly complete · ${summary.snoozed} snoozed · ${summary.auto_completed} completed automatically · ${summary.asked} to confirm · ${summary.reminders} reminders · ${summary.suppressed_quiet_hours} held (quiet hours) · ${summary.suppressed_cap} held (daily cap) · ${summary.duration_ms}ms.`);
      if (mode === "test") {
        const sevFor = (b: string): CandidateFinding["severity"] => (b === "overdue" ? "high" : b === "possibly_complete" ? "medium" : "low");
        results.push(
          ...summary.items.slice(0, 60).map((it) => ({
            fingerprint: `obligation:${it.id ?? it.title}`,
            category: "obligation",
            title: it.title,
            severity: sevFor(it.bucket),
            confidence: it.confidence ?? 0.5,
            observed_facts: [`Bucket: ${it.bucket.replace(/_/g, " ")}`],
            interpretation: `${it.outcome.replace(/_/g, " ").toUpperCase()} — ${it.detail}`,
            evidence_count: 0,
            evidence: [],
            limitations: summary.unavailable_sources.length ? `${summary.unavailable_sources.join(", ")} stale/unavailable` : "",
            existing: !!it.id,
          })),
        );
      }
    }

    // Blind Spot Scanner: hands off to its own lifecycle (novelty, daily cap, single AI pass, push).
    let blindSpotSummary: { candidates: number; created: number; updated: number; resolved: number; usedModel: boolean } | null = null;
    if (specials.includes("blind_spots")) {
      if (mode === "test") {
        await progress("preparing");
        const ctx = await loadBlindSpotContext(ownerId, now);
        await progress("business_signals");
        const detected = detectBlindSpots(ctx, rulesForJob(rules, job.slug));
        await progress("ranking");
        candidates.push(...detected.candidates.map(blindSpotToFinding));
        events.push(...detected.events);
        notes.push("Test mode skips the AI review pass; results are the deterministic detectors only.");
      } else {
        const summary = await runBlindSpotsForOwner(ownerId, now, { force: true, onProgress: (step) => progress(step) });
        blindSpotSummary = { candidates: summary.candidates, created: summary.created, updated: summary.updated, resolved: summary.resolved, usedModel: summary.usedModel };
        stats.ai_calls += summary.usedModel ? 1 : 0;
        stats.findings_created += summary.created;
        stats.findings_updated += summary.updated;
        stats.findings_resolved += summary.resolved;
        stats.candidates += summary.candidates;
        for (const e of summary.errors) notes.push(`${e.detector} failed: ${e.message}`);
        // Tag the blind spots touched this run with the job.
        const admin = createAdminClient();
        await admin.from("findings").update({ job_id: job.id, job_run_id: runId }).eq("owner_id", ownerId).eq("category", "blind_spot").gte("last_seen_at", new Date(now.getTime() - 60_000).toISOString());
      }
    }

    const nonBlindSpot = candidates.filter((c) => c.category !== "blind_spot" || mode === "test" || !specials.includes("blind_spots"));
    stats.candidates += nonBlindSpot.length;

    if (mode === "test") {
      const admin = createAdminClient();
      const fps = nonBlindSpot.map((c) => c.fingerprint);
      const { data } = fps.length ? await admin.from("findings").select("fingerprint, status").eq("owner_id", ownerId).in("fingerprint", fps) : { data: [] as { fingerprint: string; status: string }[] };
      const active = new Set((data ?? []).filter((r) => !["resolved", "dismissed", "suppressed_by_rule"].includes(r.status)).map((r) => r.fingerprint));
      results = [...results, ...nonBlindSpot.map((c) => toTestResult(c, active.has(c.fingerprint)))].slice(0, 80);
      const status = coverageLevel(coverage) === "full" ? "succeeded" : "partial";
      await finishRun(runId, { status, coverage, stats, results }, now, new Date());
      await audit({ event: "job_test", ownerId, targetId: job.id, metadata: { slug: job.slug, candidates: results.length, coverage: coverageLevel(coverage) } });
      return { runId, mode, status, coverage, stats, results, notes };
    }

    // RUN / SCHEDULED: persist (job-scoped auto-resolve), then alerts under the job's policy.
    const persisted = await persistFindings(ownerId, nonBlindSpot, now, { jobId: job.id, jobRunId: runId, resolveScope: { jobId: job.id } });
    stats.findings_created += persisted.created;
    stats.findings_updated += persisted.updated;
    stats.findings_resolved += persisted.resolved;
    await recordRuleEvents(ownerId, events).catch(() => undefined);
    if (!specials.includes("blind_spots")) {
      try {
        const alerts = await runAlertsForOwner(ownerId, now);
        stats.alerts_created += alerts.created ?? 0;
      } catch (err) {
        notes.push(`Alert evaluation failed: ${errorMessage(err)}`);
      }
      await applyNotificationPolicy(ownerId, job, persisted.touched, now).catch(() => 0);
    }
    if (blindSpotSummary) notes.push(`Blind Spot Scanner: ${blindSpotSummary.candidates} candidates, ${blindSpotSummary.created} new, ${blindSpotSummary.updated} updated, ${blindSpotSummary.resolved} resolved${blindSpotSummary.usedModel ? " (AI review used)" : ""}.`);
    const status = coverageLevel(coverage) === "full" && !notes.some((n) => n.includes(" failed")) ? "succeeded" : "partial";
    await finishRun(runId, { status, coverage, stats: { ...stats, notes } }, now, new Date());
    await recordRunCompleted(ownerId, job, now);
    await audit({ event: "job_run", ownerId, targetId: job.id, actor: mode === "scheduled" ? "system" : "owner", metadata: { slug: job.slug, mode, status, ...stats } });
    return { runId, mode, status, coverage, stats, results: [], notes };
  } catch (err) {
    const message = errorMessage(err);
    await finishRun(runId, { status: "failed", coverage, stats: { ...stats, notes }, error: message }, now, new Date());
    if (mode !== "test") {
      const admin = createAdminClient();
      await admin.from("jobs").update({ status: "error" }).eq("id", job.id).eq("status", "active");
    }
    log.warn("job_run_failed", { slug: job.slug, mode, message });
    return { runId, mode, status: "failed", coverage, stats, results: [], notes, error: message };
  }
}

/** Test-mode goal evaluation without writing snapshots: reads the latest snapshots only. */
async function refreshGoalsReadOnly(ownerId: string, now: Date): Promise<GoalRefreshResult[]> {
  const { listGoals } = await import("@/lib/jeff/goals/store");
  const goals = await listGoals(ownerId, ["active"]).catch(() => []);
  const out: GoalRefreshResult[] = [];
  for (const g of goals) {
    const snap = await latestSnapshot(g.id).catch(() => null);
    if (!snap) continue;
    out.push({ goalId: g.id, name: g.name, trajectory: snap.trajectory, changed: false, metrics: (snap.metrics ?? {}) as GoalRefreshResult["metrics"], recommendationsCreated: 0 });
  }
  void now;
  return out;
}

/** Runs every due job for the owner within a time budget (used by the cron). */
export async function runDueJobs(ownerId: string, jobs: JobRow[], now = new Date(), budgetMs = 60_000): Promise<{ ran: string[]; skipped: string[] }> {
  const { dueJobs } = await import("./schedule");
  const ran: string[] = [];
  const skipped: string[] = [];
  const started = Date.now();
  for (const job of dueJobs(jobs, now)) {
    if (Date.now() - started > budgetMs) {
      skipped.push(job.slug);
      continue;
    }
    await runJob(ownerId, job, { mode: "scheduled", now });
    ran.push(job.slug);
  }
  return { ran, skipped };
}

/** Event-driven trigger: run active event_driven jobs whose sources include the provider that just changed. */
export async function triggerJobsForEvent(ownerId: string, jobs: JobRow[], provider: string, now = new Date()): Promise<string[]> {
  const ran: string[] = [];
  for (const job of jobs) {
    // event_driven jobs, plus periodic jobs that opt into event triggers (e.g. Follow-Through: hourly tick + sync events).
    const eventDriven = job.schedule_type === "event_driven" || job.config.event_triggers === true;
    if (job.status !== "active" || !eventDriven || !job.sources.includes(provider)) continue;
    await runJob(ownerId, job, { mode: "scheduled", now });
    ran.push(job.slug);
  }
  return ran;
}
