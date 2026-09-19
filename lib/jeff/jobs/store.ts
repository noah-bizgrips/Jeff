import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errorMessage } from "@/lib/security/log";
import { redactString } from "@/lib/security/redact";
import { getSettings } from "@/lib/jeff/settings-store";
import { SEED_REFRESH_FIELDS, SYSTEM_JOBS } from "./registry";
import { nextRunAt } from "./schedule";
import { JobInputSchema, JobPatchSchema, NotificationPolicySchema, type CoverageEntry, type JobPatch, type JobRow, type JobRunRow, type RunMode, type RunStats, type TestResult } from "./types";

const JOB_COLUMNS =
  "id, owner_id, slug, name, icon, description, purpose, scope, job_type, status, schedule_type, schedule_expression, timezone, notification_policy, minimum_severity, sources, detectors, config, system_managed, created_by, last_run_at, next_run_at, run_count, findings_30d, created_at, updated_at";
const RUN_COLUMNS = "id, owner_id, job_id, mode, status, started_at, finished_at, duration_ms, coverage, stats, results, error, created_at";

export function rowToJob(r: Record<string, unknown>): JobRow {
  const policy = NotificationPolicySchema.safeParse(r.notification_policy ?? {});
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    slug: String(r.slug),
    name: String(r.name),
    icon: String(r.icon ?? "briefcase"),
    description: String(r.description ?? ""),
    purpose: String(r.purpose ?? ""),
    scope: (r.scope as JobRow["scope"]) ?? "business",
    job_type: (r.job_type as JobRow["job_type"]) ?? "custom",
    status: (r.status as JobRow["status"]) ?? "active",
    schedule_type: (r.schedule_type as JobRow["schedule_type"]) ?? "daily",
    schedule_expression: (r.schedule_expression as string | null) ?? null,
    timezone: (r.timezone as string | null) ?? null,
    notification_policy: policy.success ? policy.data : NotificationPolicySchema.parse({}),
    minimum_severity: (r.minimum_severity as JobRow["minimum_severity"]) ?? "low",
    sources: Array.isArray(r.sources) ? (r.sources as string[]) : [],
    detectors: Array.isArray(r.detectors) ? (r.detectors as string[]) : [],
    config: (r.config as Record<string, unknown>) ?? {},
    system_managed: Boolean(r.system_managed),
    created_by: String(r.created_by ?? "owner"),
    last_run_at: (r.last_run_at as string | null) ?? null,
    next_run_at: (r.next_run_at as string | null) ?? null,
    run_count: Number(r.run_count ?? 0),
    findings_30d: Number(r.findings_30d ?? 0),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export function rowToRun(r: Record<string, unknown>): JobRunRow {
  return {
    id: String(r.id),
    owner_id: String(r.owner_id),
    job_id: String(r.job_id),
    mode: (r.mode as RunMode) ?? "run",
    status: (r.status as JobRunRow["status"]) ?? "queued",
    started_at: (r.started_at as string | null) ?? null,
    finished_at: (r.finished_at as string | null) ?? null,
    duration_ms: (r.duration_ms as number | null) ?? null,
    coverage: Array.isArray(r.coverage) ? (r.coverage as CoverageEntry[]) : [],
    stats: (r.stats as Partial<RunStats>) ?? {},
    results: Array.isArray(r.results) ? (r.results as TestResult[]) : [],
    error: (r.error as string | null) ?? null,
    created_at: String(r.created_at),
  };
}

export async function listJobs(ownerId: string): Promise<JobRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("jobs").select(JOB_COLUMNS).eq("owner_id", ownerId).order("created_at", { ascending: true });
  if (error) throw new Error(`jobs_list_failed:${error.code ?? ""}:${redactString(error.message ?? "").slice(0, 120)}`);
  return (data ?? []).map((r) => rowToJob(r as Record<string, unknown>));
}

export async function getJob(ownerId: string, slugOrId: string): Promise<JobRow | null> {
  const admin = createAdminClient();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);
  const { data } = await admin.from("jobs").select(JOB_COLUMNS).eq("owner_id", ownerId).eq(isUuid ? "id" : "slug", slugOrId).maybeSingle();
  return data ? rowToJob(data as Record<string, unknown>) : null;
}

async function ownerTimezone(ownerId: string): Promise<string> {
  return (await getSettings(ownerId).catch(() => null))?.timezone ?? "America/Denver";
}

/**
 * Seeds the system roster idempotently. Owner-owned state (status, schedule,
 * policy, sources they narrowed, config) is never overwritten; descriptive
 * fields and detector lists follow the registry so new detectors appear.
 */
export async function seedSystemJobs(ownerId: string, now = new Date()): Promise<{ created: number; refreshed: number }> {
  const admin = createAdminClient();
  const existing = await listJobs(ownerId);
  const bySlug = new Map(existing.map((j) => [j.slug, j]));
  const tz = await ownerTimezone(ownerId);
  let created = 0;
  let refreshed = 0;
  for (const def of SYSTEM_JOBS) {
    const prev = bySlug.get(def.slug);
    if (!prev) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { template_category, looks_for, pending, ui_name, ...plain } = def;
      const input = JobInputSchema.parse(plain);
      const { error } = await admin.from("jobs").insert({
        ...input,
        owner_id: ownerId,
        system_managed: true,
        created_by: "system",
        next_run_at: nextRunAt(input, now, tz)?.toISOString() ?? null,
      });
      if (error) log.warn("job_seed_failed", { slug: def.slug, message: error.message });
      else created++;
      continue;
    }
    const patch: Record<string, unknown> = {};
    for (const f of SEED_REFRESH_FIELDS) {
      const a = JSON.stringify(prev[f]);
      const b = JSON.stringify(def[f]);
      if (a !== b) patch[f] = def[f];
    }
    // A pending draft that now has detectors becomes active once, unless the owner paused/disabled it.
    if (def.status === "active" && prev.status === "draft" && def.detectors.length && !prev.detectors.length) patch.status = "active";
    if (Object.keys(patch).length) {
      const { error } = await admin.from("jobs").update(patch).eq("id", prev.id);
      if (!error) refreshed++;
    }
  }
  return { created, refreshed };
}

export async function createJob(ownerId: string, raw: unknown, meta: { createdBy: "owner" | "jeff"; systemManaged?: boolean; now?: Date }): Promise<{ ok: true; job: JobRow } | { ok: false; reason: string }> {
  const parsed = JobInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400) };
  const admin = createAdminClient();
  const tz = parsed.data.timezone ?? (await ownerTimezone(ownerId));
  const { data, error } = await admin
    .from("jobs")
    .insert({ ...parsed.data, owner_id: ownerId, system_managed: meta.systemManaged ?? false, created_by: meta.createdBy, next_run_at: nextRunAt(parsed.data, meta.now ?? new Date(), tz)?.toISOString() ?? null })
    .select(JOB_COLUMNS)
    .single();
  if (error) return { ok: false, reason: error.code === "23505" ? "a job with that slug already exists" : `create_failed:${error.code ?? ""}` };
  return { ok: true, job: rowToJob(data as Record<string, unknown>) };
}

export async function updateJob(ownerId: string, slugOrId: string, raw: unknown): Promise<{ ok: true; job: JobRow; changed: string[] } | { ok: false; reason: string }> {
  const parsed = JobPatchSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 400) };
  const job = await getJob(ownerId, slugOrId);
  if (!job) return { ok: false, reason: "job_not_found" };
  const patch: JobPatch & { next_run_at?: string | null } = { ...parsed.data };
  const changed = Object.keys(parsed.data);
  if (!changed.length) return { ok: true, job, changed: [] };
  const merged = { ...job, ...patch };
  const tz = merged.timezone ?? (await ownerTimezone(ownerId));
  patch.next_run_at = nextRunAt(merged, new Date(), tz)?.toISOString() ?? null;
  const admin = createAdminClient();
  const { data, error } = await admin.from("jobs").update(patch).eq("id", job.id).eq("owner_id", ownerId).select(JOB_COLUMNS).single();
  if (error) return { ok: false, reason: `update_failed:${error.code ?? ""}` };
  return { ok: true, job: rowToJob(data as Record<string, unknown>), changed };
}

export async function deleteJob(ownerId: string, slugOrId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const job = await getJob(ownerId, slugOrId);
  if (!job) return { ok: false, reason: "job_not_found" };
  if (job.system_managed) return { ok: false, reason: "system_jobs_cannot_be_deleted" };
  const admin = createAdminClient();
  const { error } = await admin.from("jobs").delete().eq("id", job.id).eq("owner_id", ownerId);
  if (error) return { ok: false, reason: `delete_failed:${error.code ?? ""}` };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

export async function startRun(ownerId: string, jobId: string, mode: RunMode, now = new Date()): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("job_runs")
    .insert({ owner_id: ownerId, job_id: jobId, mode, status: "running", started_at: now.toISOString(), stats: { progress: "preparing" } })
    .select("id")
    .single();
  if (error || !data) throw new Error(`job_run_start_failed:${error?.code ?? ""}`);
  return String(data.id);
}

export async function setRunProgress(runId: string, progress: string): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.from("job_runs").select("stats").eq("id", runId).maybeSingle();
  const stats = ((data?.stats as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  await admin.from("job_runs").update({ stats: { ...stats, progress } }).eq("id", runId);
}

export async function finishRun(
  runId: string,
  patch: { status: JobRunRow["status"]; coverage: CoverageEntry[]; stats: Partial<RunStats>; results?: TestResult[]; error?: string | null },
  startedAt: Date,
  now = new Date(),
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("job_runs")
    .update({
      status: patch.status,
      finished_at: now.toISOString(),
      duration_ms: Math.max(0, now.getTime() - startedAt.getTime()),
      coverage: patch.coverage,
      stats: { ...patch.stats, progress: "complete" },
      results: (patch.results ?? []).slice(0, 50),
      error: patch.error ? redactString(patch.error).slice(0, 500) : null,
    })
    .eq("id", runId);
  if (error) log.warn("job_run_finish_failed", { runId, message: error.message });
}

export async function getRun(ownerId: string, runId: string): Promise<JobRunRow | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("job_runs").select(RUN_COLUMNS).eq("owner_id", ownerId).eq("id", runId).maybeSingle();
  return data ? rowToRun(data as Record<string, unknown>) : null;
}

export async function listRuns(ownerId: string, jobId: string, limit = 20): Promise<JobRunRow[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("job_runs").select(RUN_COLUMNS).eq("owner_id", ownerId).eq("job_id", jobId).order("created_at", { ascending: false }).limit(limit);
  return (data ?? []).map((r) => rowToRun(r as Record<string, unknown>));
}

/** Bookkeeping after a real run: last/next run, counters, 30-day findings. */
export async function recordRunCompleted(ownerId: string, job: JobRow, now = new Date()): Promise<void> {
  const admin = createAdminClient();
  const tz = job.timezone ?? (await ownerTimezone(ownerId));
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const { count } = await admin.from("findings").select("id", { count: "exact", head: true }).eq("owner_id", ownerId).eq("job_id", job.id).gte("created_at", since);
  const { error } = await admin
    .from("jobs")
    .update({ last_run_at: now.toISOString(), next_run_at: nextRunAt(job, now, tz)?.toISOString() ?? null, run_count: job.run_count + 1, findings_30d: count ?? 0 })
    .eq("id", job.id);
  if (error) log.warn("job_bookkeeping_failed", { slug: job.slug, message: errorMessage(error) });
}

/** Count of alerts raised today for this job's findings (for max_per_day). */
export async function alertsCreatedToday(ownerId: string, jobId: string, dayStartIso: string): Promise<number> {
  const admin = createAdminClient();
  const { data } = await admin.from("findings").select("id").eq("owner_id", ownerId).eq("job_id", jobId).limit(500);
  const ids = (data ?? []).map((r) => String(r.id));
  if (!ids.length) return 0;
  const { count } = await admin.from("alerts").select("id", { count: "exact", head: true }).eq("owner_id", ownerId).in("ref_id", ids).gte("created_at", dayStartIso);
  return count ?? 0;
}
