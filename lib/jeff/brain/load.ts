import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAlerts } from "@/lib/jeff/alerts/store";
import { latestSnapshot, listGoalMetrics, listGoals } from "@/lib/jeff/goals/store";
import { listObligations } from "@/lib/jeff/obligations/store";
import { bucketOf } from "@/lib/jeff/obligations/types";
import { loadFreshness } from "@/lib/jeff/freshness-store";
import { listConnections } from "@/lib/integrations/store";
import { listJobs } from "@/lib/jeff/jobs/store";
import { computeBrainState, EMPTY_BRAIN_STATE, type BrainState, type BrainStateInput } from "./state";
import { BRAIN_POLICY } from "./policy";
import { log, errorMessage } from "@/lib/security/log";

/**
 * Loads EXISTING, already-filtered application state (post-rules, post-lifecycle)
 * with bounded queries and computes the brain state. Never runs analysis of its own.
 */
export async function getBrainState(ownerId: string, now = new Date()): Promise<BrainState> {
  try {
    const admin = createAdminClient();
    const since = new Date(now.getTime() - BRAIN_POLICY.failedRunsWindowHours * 3_600_000).toISOString();
    const [alerts, findingsRes, goals, obligations, freshness, connections, jobs, runsRes] = await Promise.all([
      listAlerts(ownerId, { status: ["open"], limit: 200 }).catch(() => []),
      admin
        .from("findings")
        .select("id, category, title, status, severity, confidence, metrics, evidence, goal_id, created_at")
        .eq("owner_id", ownerId)
        .eq("is_sample", false)
        .in("status", ["new", "open", "acknowledged", "in_progress", "reviewing", "accepted", "action_planned", "action_in_progress", "monitoring"])
        .order("created_at", { ascending: false })
        .limit(200),
      listGoals(ownerId, ["active"]).catch(() => []),
      listObligations(ownerId, { live: true, limit: 300 }).catch(() => []),
      loadFreshness(ownerId, now).catch(() => []),
      listConnections(ownerId).catch(() => []),
      listJobs(ownerId).catch(() => []),
      admin.from("job_runs").select("job_id, mode, status, finished_at, error, created_at").eq("owner_id", ownerId).gte("created_at", since).order("created_at", { ascending: false }).limit(100),
    ]);

    const goalInputs: BrainStateInput["goals"] = await Promise.all(
      goals.slice(0, 20).map(async (g) => {
        const [snap, metrics] = await Promise.all([latestSnapshot(g.id).catch(() => null), listGoalMetrics(g.id).catch(() => [])]);
        const sources = [...new Set(metrics.flatMap((m) => Object.values(m.source_mappings ?? {}).map((i) => i.provider)))];
        return { id: g.id, name: g.name, status: g.status, trajectory: snap?.trajectory ?? null, constraint_key: snap?.constraint_key ?? null, sources };
      }),
    );

    const freshByProvider = new Map(freshness.map((f) => [f.provider, f]));
    const jobById = new Map(jobs.map((j) => [j.id, j]));

    const input: BrainStateInput = {
      now,
      alerts: alerts
        .filter((a) => !a.deferred_until || Date.parse(a.deferred_until) <= now.getTime())
        .filter((a) => !a.snoozed_until || Date.parse(a.snoozed_until) <= now.getTime())
        .map((a) => ({ id: a.id, kind: a.kind, category: a.category, importance: a.importance, status: a.status, title: a.title, summary: a.summary, ref_id: a.ref_id, evidence: (a.evidence as { provider?: string; capability?: string | null }[]) ?? [], first_seen: a.first_seen })),
      findings: (findingsRes.data ?? []).map((f) => ({
        id: f.id,
        category: f.category,
        title: f.title,
        status: f.status,
        severity: f.severity,
        confidence: f.confidence == null ? null : Number(f.confidence),
        metrics: (f.metrics as Record<string, unknown>) ?? {},
        evidence: (f.evidence as { provider?: string; capability?: string | null }[]) ?? [],
        goal_id: f.goal_id,
        created_at: f.created_at,
      })),
      goals: goalInputs,
      obligations: obligations.map((o) => ({
        id: o.id,
        title: o.title,
        status: o.status,
        bucket: bucketOf(o, now),
        priority: o.priority,
        scope: o.scope,
        due_at: o.due_at,
        related_goal_id: o.related_goal_id,
        related_client_id: o.related_client_id,
        has_money: typeof o.metadata?.amount_label === "string" || typeof o.metadata?.amount === "number",
        source_provider: o.source_provider,
      })),
      connections: connections.map((c) => {
        const f = freshByProvider.get(c.provider);
        return { provider: c.provider, capabilities: c.capabilities, status: c.status, freshness_level: f?.level ?? "never", freshness_text: f?.text ?? `${c.displayName} has not synced yet`, age_hours: f?.age_hours ?? null };
      }),
      jobRuns: (runsRes.data ?? []).map((r) => {
        const j = jobById.get(r.job_id);
        return { job_slug: j?.slug ?? r.job_id, job_name: j?.name ?? "Job", status: r.status, mode: r.mode, sources: j?.sources ?? [], finished_at: r.finished_at, error: r.error };
      }),
    };
    return computeBrainState(input);
  } catch (err) {
    log.warn("brain_state_failed", { message: errorMessage(err) });
    return { ...EMPTY_BRAIN_STATE, computedAt: now.toISOString() };
  }
}
