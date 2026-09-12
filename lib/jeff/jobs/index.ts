import "server-only";
import { listConnections } from "@/lib/integrations/store";
import { audit } from "@/lib/audit";
import { getSettings } from "@/lib/jeff/settings-store";
import { interpretJob, type JobDefinitionInterpretation, type JobInterpretDeps } from "./interpret";
import { createJob, getJob, listJobs, seedSystemJobs } from "./store";
import type { JobRow } from "./types";
import { getSystemJob } from "./registry";
import { getDetector } from "./detectors";

export { runJob, runDueJobs, triggerJobsForEvent } from "./runner";
export { listJobs, getJob, updateJob, deleteJob, listRuns, getRun, seedSystemJobs } from "./store";
export { listTemplates, getTemplate } from "./templates";
export { SYSTEM_JOBS, getSystemJob } from "./registry";
export { describeSchedule } from "./schedule";

/** Providers whose connection is usable right now. */
export async function connectedProviders(ownerId: string): Promise<string[]> {
  const conns = await listConnections(ownerId).catch(() => []);
  return [...new Set(conns.filter((c) => ["connected", "limited"].includes(c.status)).map((c) => c.provider))];
}

/** Seeds the roster (idempotent) and returns it. */
export async function ensureJobs(ownerId: string, now = new Date()): Promise<JobRow[]> {
  await seedSystemJobs(ownerId, now);
  return listJobs(ownerId);
}

export interface JobPresentation extends JobRow {
  schedule_label: string;
  status_label: "ACTIVE" | "LIMITED COVERAGE" | "PAUSED" | "DRAFT" | "DISABLED" | "ERROR";
  missing_sources: string[];
  detector_labels: string[];
  looks_for: string[];
  ui_name: string;
  pending: string | null;
}

export async function presentJobs(ownerId: string, jobs: JobRow[]): Promise<JobPresentation[]> {
  const { describeSchedule } = await import("./schedule");
  const connected = await connectedProviders(ownerId);
  return jobs.map((j) => {
    const def = getSystemJob(j.slug);
    const missing = j.sources.filter((s) => !connected.includes(s));
    const status_label: JobPresentation["status_label"] =
      j.status === "paused" ? "PAUSED" : j.status === "draft" ? "DRAFT" : j.status === "disabled" ? "DISABLED" : j.status === "error" ? "ERROR" : missing.length && missing.length < j.sources.length ? "LIMITED COVERAGE" : missing.length && j.sources.length ? "LIMITED COVERAGE" : "ACTIVE";
    return {
      ...j,
      schedule_label: describeSchedule(j),
      status_label,
      missing_sources: missing,
      detector_labels: j.detectors.map((d) => getDetector(d)?.label ?? d),
      looks_for: def?.looks_for ?? [],
      ui_name: def?.ui_name ?? j.name,
      pending: def?.pending ?? null,
    };
  });
}

export interface CreateFromDescriptionResult {
  interpretation: JobDefinitionInterpretation;
  usedModel: boolean;
  notes: string[];
  /** Created job (active or draft) when creation was attempted. */
  job: JobRow | null;
  outcome: "created_active" | "created_draft" | "matches_system_job" | "needs_input" | "error";
  reason?: string;
}

/**
 * Ask Jeff / Add Job entry point: interpret, then create when safe. An
 * existing system job that already covers the request is returned instead
 * of creating a duplicate.
 */
export async function createJobFromDescription(ownerId: string, text: string, opts: { forceDraft?: boolean; deps?: JobInterpretDeps; source?: "chat" | "ui" } = {}): Promise<CreateFromDescriptionResult> {
  const connected = await connectedProviders(ownerId);
  const { interpretation, usedModel, notes } = await interpretJob(ownerId, text, connected, opts.deps);
  if (interpretation.matches_system_job) {
    const existing = await getJob(ownerId, interpretation.matches_system_job);
    if (existing) return { interpretation, usedModel, notes, job: existing, outcome: "matches_system_job" };
  }
  if (interpretation.ambiguities.length || !interpretation.detectors.length) {
    return { interpretation, usedModel, notes, job: null, outcome: "needs_input", reason: interpretation.ambiguities[0]?.question ?? "No detector matched the request." };
  }
  const settings = await getSettings(ownerId).catch(() => null);
  const autoSafe = settings ? (settings as unknown as { jobs_auto_create_safe?: boolean }).jobs_auto_create_safe !== false : true;
  const active = interpretation.safe && autoSafe && !opts.forceDraft;
  const res = await createJob(
    ownerId,
    {
      slug: await uniqueSlug(ownerId, interpretation.slug),
      name: interpretation.name,
      icon: "briefcase",
      description: interpretation.description,
      purpose: interpretation.purpose,
      scope: interpretation.scope,
      job_type: "user",
      status: active ? "active" : "draft",
      schedule_type: interpretation.schedule_type,
      schedule_expression: interpretation.schedule_expression,
      timezone: null,
      notification_policy: interpretation.notification_policy,
      minimum_severity: "low",
      sources: interpretation.sources,
      detectors: interpretation.detectors,
      config: { ...interpretation.config, would_need: interpretation.would_need, limitations: interpretation.limitations, request: text.slice(0, 500) },
    },
    { createdBy: opts.source === "ui" ? "owner" : "jeff" },
  );
  if (!res.ok) return { interpretation, usedModel, notes, job: null, outcome: "error", reason: res.reason };
  await audit({ event: "job_created", ownerId, targetId: res.job.id, metadata: { slug: res.job.slug, status: res.job.status, source: opts.source ?? "chat", usedModel } });
  return { interpretation, usedModel, notes, job: res.job, outcome: active ? "created_active" : "created_draft" };
}

async function uniqueSlug(ownerId: string, base: string): Promise<string> {
  const existing = new Set((await listJobs(ownerId)).map((j) => j.slug));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 50; i++) if (!existing.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}
