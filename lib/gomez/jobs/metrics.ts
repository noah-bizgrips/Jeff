import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { LIVE_STATUSES } from "@/lib/gomez/obligations/types";
import { listRules } from "@/lib/gomez/rules/store";
import { pendingSuggestions } from "./learning-store";
import { listJobs } from "./store";
import type { JobRow } from "./types";

/**
 * Observability for Gomez's Jobs (spec §55). One read model, computed from
 * job_runs, findings, finding_feedback, ai_usage (feature `job:<slug>`) and
 * obligations. Pure aggregation over rows so it is cheap to test.
 */

export const METRICS_WINDOW_DAYS = 30;

export interface JobMetricRow {
  slug: string;
  name: string;
  status: string;
  runs: number;
  runs_per_day: number;
  succeeded: number;
  partial: number;
  failed: number;
  avg_duration_ms: number | null;
  last_run_at: string | null;
  last_status: string | null;
  ai_calls: number;
  ai_cost_usd: number;
  findings_created: number;
  findings_suppressed: number;
  feedback: Record<string, number>;
  /** Set-aside verdicts (wrong, not useful, don't show, too noisy) ÷ findings that received any feedback. */
  false_positive_rate: number | null;
}

export interface FollowThroughMetrics {
  open: number;
  overdue: number;
  waiting_on_other: number;
  snoozed: number;
  possibly_complete: number;
  completed_30d: number;
  auto_completed_30d: number;
  dismissed_30d: number;
  reminders_30d: number;
  reminders_per_day: number;
}

export interface JobsMetrics {
  window_days: number;
  generated_at: string;
  totals: {
    runs: number;
    runs_per_day: number;
    succeeded: number;
    partial: number;
    failed: number;
    ai_calls: number;
    ai_cost_usd: number;
    findings_created: number;
    findings_suppressed: number;
    feedback: number;
    false_positive_rate: number | null;
    pending_proposals: number;
  };
  jobs: JobMetricRow[];
  follow_through: FollowThroughMetrics;
}

export interface MetricsInputs {
  now: Date;
  windowDays: number;
  jobs: Pick<JobRow, "id" | "slug" | "name" | "status">[];
  runs: { job_id: string; mode: string; status: string; started_at: string | null; created_at: string; duration_ms: number | null; stats: Record<string, unknown> | null }[];
  usage: { feature: string; estimated_usd: number | string }[];
  findings: { job_id: string | null; created_at: string }[];
  feedback: { job_id: string | null; finding_id: string; verdict: string }[];
  obligations: { status: string; due_at: string | null; completed_at: string | null; dismissed_at: string | null; metadata: Record<string, unknown> | null }[];
  obligationEvents: { kind: string; created_at: string }[];
  pendingProposals: number;
}

const SET_ASIDE = new Set(["wrong", "not_useful", "dont_show", "too_noisy"]);
const OPEN = new Set(LIVE_STATUSES as string[]);

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeMetrics(i: MetricsInputs): JobsMetrics {
  const days = Math.max(1, i.windowDays);
  const byJob = new Map<string, JobMetricRow>();
  const idToSlug = new Map(i.jobs.map((j) => [j.id, j.slug]));
  for (const j of i.jobs) byJob.set(j.slug, { slug: j.slug, name: j.name, status: j.status, runs: 0, runs_per_day: 0, succeeded: 0, partial: 0, failed: 0, avg_duration_ms: null, last_run_at: null, last_status: null, ai_calls: 0, ai_cost_usd: 0, findings_created: 0, findings_suppressed: 0, feedback: {}, false_positive_rate: null });
  const durations = new Map<string, number[]>();
  for (const run of i.runs) {
    if (run.mode === "test") continue;
    const slug = idToSlug.get(run.job_id);
    const row = slug ? byJob.get(slug) : undefined;
    if (!row) continue;
    row.runs++;
    if (run.status === "succeeded") row.succeeded++;
    else if (run.status === "partial") row.partial++;
    else if (run.status === "failed") row.failed++;
    if (typeof run.duration_ms === "number") durations.set(slug!, [...(durations.get(slug!) ?? []), run.duration_ms]);
    const at = run.started_at ?? run.created_at;
    if (!row.last_run_at || at > row.last_run_at) {
      row.last_run_at = at;
      row.last_status = run.status;
    }
    const s = run.stats ?? {};
    if (typeof s.duplicates_suppressed === "number") row.findings_suppressed += s.duplicates_suppressed;
    if (typeof s.ai_calls === "number") row.ai_calls += s.ai_calls;
  }
  for (const [slug, list] of durations) byJob.get(slug)!.avg_duration_ms = Math.round(list.reduce((a, b) => a + b, 0) / list.length);
  // The ai_usage ledger (feature `job:<slug>`) is the source of truth for calls and cost; run stats are the fallback.
  const ledgerCalls = new Map<string, number>();
  for (const u of i.usage) {
    const m = /^job:(.+)$/.exec(u.feature);
    if (!m) continue;
    const row = byJob.get(m[1]!);
    if (!row) continue;
    row.ai_cost_usd += Number(u.estimated_usd) || 0;
    ledgerCalls.set(row.slug, (ledgerCalls.get(row.slug) ?? 0) + 1);
  }
  for (const [slug, n] of ledgerCalls) byJob.get(slug)!.ai_calls = Math.max(byJob.get(slug)!.ai_calls, n);
  for (const f of i.findings) {
    const slug = f.job_id ? idToSlug.get(f.job_id) : undefined;
    const row = slug ? byJob.get(slug) : undefined;
    if (row) row.findings_created++;
  }
  const feedbackFindings = new Map<string, Set<string>>();
  const setAsideFindings = new Map<string, Set<string>>();
  for (const fb of i.feedback) {
    const slug = fb.job_id ? idToSlug.get(fb.job_id) : undefined;
    const row = slug ? byJob.get(slug) : undefined;
    if (!row) continue;
    row.feedback[fb.verdict] = (row.feedback[fb.verdict] ?? 0) + 1;
    feedbackFindings.set(slug!, (feedbackFindings.get(slug!) ?? new Set()).add(fb.finding_id));
    if (SET_ASIDE.has(fb.verdict)) setAsideFindings.set(slug!, (setAsideFindings.get(slug!) ?? new Set()).add(fb.finding_id));
  }
  for (const row of byJob.values()) {
    row.runs_per_day = r2(row.runs / days);
    row.ai_cost_usd = Math.round(row.ai_cost_usd * 10_000) / 10_000;
    const withFeedback = feedbackFindings.get(row.slug)?.size ?? 0;
    row.false_positive_rate = withFeedback ? r2((setAsideFindings.get(row.slug)?.size ?? 0) / withFeedback) : null;
  }
  const jobs = [...byJob.values()].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
  const totalFeedbackFindings = new Set([...feedbackFindings.values()].flatMap((s) => [...s])).size;
  const totalSetAside = new Set([...setAsideFindings.values()].flatMap((s) => [...s])).size;
  const totals = {
    runs: jobs.reduce((n, j) => n + j.runs, 0),
    runs_per_day: 0,
    succeeded: jobs.reduce((n, j) => n + j.succeeded, 0),
    partial: jobs.reduce((n, j) => n + j.partial, 0),
    failed: jobs.reduce((n, j) => n + j.failed, 0),
    ai_calls: jobs.reduce((n, j) => n + j.ai_calls, 0),
    ai_cost_usd: Math.round(jobs.reduce((n, j) => n + j.ai_cost_usd, 0) * 10_000) / 10_000,
    findings_created: jobs.reduce((n, j) => n + j.findings_created, 0),
    findings_suppressed: jobs.reduce((n, j) => n + j.findings_suppressed, 0),
    feedback: i.feedback.length,
    false_positive_rate: totalFeedbackFindings ? r2(totalSetAside / totalFeedbackFindings) : null,
    pending_proposals: i.pendingProposals,
  };
  totals.runs_per_day = r2(totals.runs / days);

  const since = i.now.getTime() - days * 86_400_000;
  const nowMs = i.now.getTime();
  const live = i.obligations.filter((o) => OPEN.has(o.status));
  const reminders = i.obligationEvents.filter((e) => e.kind === "reminded" && Date.parse(e.created_at) >= since).length;
  const follow_through: FollowThroughMetrics = {
    open: live.length,
    overdue: live.filter((o) => o.status === "overdue" || (o.due_at && Date.parse(o.due_at) < nowMs && o.status !== "snoozed")).length,
    waiting_on_other: live.filter((o) => o.status === "waiting_on_other").length,
    snoozed: live.filter((o) => o.status === "snoozed").length,
    possibly_complete: live.filter((o) => o.status === "possibly_complete").length,
    completed_30d: i.obligations.filter((o) => o.status === "completed" && o.completed_at && Date.parse(o.completed_at) >= since).length,
    auto_completed_30d: i.obligationEvents.filter((e) => e.kind === "auto_completed" && Date.parse(e.created_at) >= since).length,
    dismissed_30d: i.obligations.filter((o) => o.status === "dismissed" && o.dismissed_at && Date.parse(o.dismissed_at) >= since).length,
    reminders_30d: reminders,
    reminders_per_day: r2(reminders / days),
  };
  return { window_days: days, generated_at: i.now.toISOString(), totals, jobs, follow_through };
}

export async function loadJobsMetrics(ownerId: string, now = new Date(), windowDays = METRICS_WINDOW_DAYS): Promise<JobsMetrics> {
  const admin = createAdminClient();
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const jobs = await listJobs(ownerId);
  const [runs, usage, findings, feedback, obligations, events, proposals] = await Promise.all([
    admin.from("job_runs").select("job_id, mode, status, started_at, created_at, duration_ms, stats").eq("owner_id", ownerId).gte("created_at", since).limit(2000),
    admin.from("ai_usage").select("feature, estimated_usd").eq("owner_id", ownerId).gte("created_at", since).limit(5000),
    admin.from("findings").select("job_id, created_at").eq("owner_id", ownerId).eq("is_sample", false).gte("created_at", since).limit(5000),
    admin.from("finding_feedback").select("job_id, finding_id, verdict").eq("owner_id", ownerId).gte("created_at", since).limit(2000),
    admin.from("obligations").select("status, due_at, completed_at, dismissed_at, metadata").eq("owner_id", ownerId).limit(2000),
    admin.from("obligation_events").select("kind, created_at").eq("owner_id", ownerId).gte("created_at", since).in("kind", ["reminded", "auto_completed"]).limit(5000),
    listRules(ownerId, { enabledOnly: false }).catch(() => []),
  ]);
  return computeMetrics({
    now,
    windowDays,
    jobs: jobs.map((j) => ({ id: j.id, slug: j.slug, name: j.name, status: j.status })),
    runs: (runs.data ?? []) as MetricsInputs["runs"],
    usage: ((usage.data ?? []) as MetricsInputs["usage"]).filter((u) => typeof u.feature === "string" && u.feature.startsWith("job:")),
    findings: (findings.data ?? []) as MetricsInputs["findings"],
    feedback: (feedback.data ?? []) as MetricsInputs["feedback"],
    obligations: (obligations.data ?? []) as MetricsInputs["obligations"],
    obligationEvents: (events.data ?? []) as MetricsInputs["obligationEvents"],
    pendingProposals: pendingSuggestions(proposals).length,
  });
}
