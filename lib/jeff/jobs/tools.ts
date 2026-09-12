import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { audit } from "@/lib/audit";
import { redact } from "@/lib/security/redact";
import { createJobFromDescription, ensureJobs, presentJobs } from "./index";
import { listRuns, updateJob } from "./store";
import { runJob } from "./runner";
import { NotificationPolicySchema } from "./types";

/**
 * Ask Jeff tools for Jeff's Jobs. Configuration changes are performed, not
 * explained; consequential actions still flow through findings → missions →
 * approvals like everything else.
 */
export const JOB_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_jobs",
    description: "Jeff's Jobs: the roster of recurring analysts (Revenue Leakage Hunter, Client Health Analyst, Cash Flow Watchdog, Blind Spot Scanner, …) with status, schedule, sources/coverage, last run and 30-day findings. Use for 'what jobs are running', 'what is Jeff watching'.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "get_job",
    description: "Details for one job by slug or name: purpose, what it looks for, sources and coverage, schedule, notification policy, last runs.",
    input_schema: { type: "object", properties: { job: { type: "string", description: "slug or name" } }, required: ["job"], additionalProperties: false },
    strict: true,
  },
  {
    name: "run_job",
    description: "Run a job now. mode 'test' analyses current data and returns what it WOULD find without creating findings/alerts/notifications; mode 'run' executes for real (findings, alerts per policy). 'Run the blind spot scanner' → run_job blind-spot-scanner run; 'Test relationship radar' → mode test.",
    input_schema: { type: "object", properties: { job: { type: "string" }, mode: { type: "string", enum: ["test", "run"] } }, required: ["job", "mode"], additionalProperties: false },
    strict: true,
  },
  {
    name: "pause_job",
    description: "Pause a job (it stops running on schedule; findings are kept). Tier 1, reversible.",
    input_schema: { type: "object", properties: { job: { type: "string" } }, required: ["job"], additionalProperties: false },
    strict: true,
  },
  {
    name: "resume_job",
    description: "Resume a paused or draft job.",
    input_schema: { type: "object", properties: { job: { type: "string" } }, required: ["job"], additionalProperties: false },
    strict: true,
  },
  {
    name: "create_job_from_description",
    description:
      "Turn a natural-language request ('Create a job that checks every Friday for clients we do way more work for than they pay us for') into a Job. Safe, unambiguous jobs are created active; others are created as drafts or come back with a question. Never invents sources the owner has not connected.",
    input_schema: { type: "object", properties: { description: { type: "string", description: "the owner's exact sentence" } }, required: ["description"], additionalProperties: false },
    strict: true,
  },
  {
    name: "update_job_policy",
    description: "Change Tier-1 job settings: schedule (type/expression), notification policy (min_importance, push, briefing_only, max_per_day), scope, minimum severity.",
    input_schema: {
      type: "object",
      properties: {
        job: { type: "string" },
        schedule_type: { type: "string", enum: ["continuous", "event_driven", "hourly", "daily", "weekly", "monthly", "custom", "manual"] },
        schedule_expression: { type: "string", description: "e.g. 'fri 07:05', '1 07:05', '07:05'" },
        min_importance: { type: "string", enum: ["informational", "briefing", "important", "urgent", "actionable"] },
        push: { type: "boolean" },
        briefing_only: { type: "boolean" },
        max_per_day: { type: "integer", minimum: 0, maximum: 50 },
        scope: { type: "string", enum: ["business", "personal", "financial", "all"] },
        minimum_severity: { type: "string", enum: ["info", "low", "medium", "high"] },
      },
      required: ["job"],
      additionalProperties: false,
    },
  },
];

async function resolveJob(ownerId: string, ref: string) {
  const jobs = await ensureJobs(ownerId);
  const key = ref.trim().toLowerCase();
  return jobs.find((j) => j.slug === key) ?? jobs.find((j) => j.name.toLowerCase() === key) ?? jobs.find((j) => j.name.toLowerCase().includes(key) || j.slug.includes(key.replace(/\s+/g, "-"))) ?? null;
}

export async function runJobTool(name: string, input: Record<string, unknown>, ctx: { ownerId: string }): Promise<unknown> {
  switch (name) {
    case "list_jobs": {
      const jobs = await presentJobs(ctx.ownerId, await ensureJobs(ctx.ownerId));
      return jobs.map((j) => ({ slug: j.slug, name: j.ui_name, status: j.status_label, scope: j.scope, schedule: j.schedule_label, sources: j.sources, missing_sources: j.missing_sources, last_run_at: j.last_run_at, next_run_at: j.next_run_at, findings_30d: j.findings_30d, pending: j.pending }));
    }
    case "get_job": {
      const job = await resolveJob(ctx.ownerId, String(input.job ?? ""));
      if (!job) return { error: "job_not_found" };
      const [pres] = await presentJobs(ctx.ownerId, [job]);
      const runs = await listRuns(ctx.ownerId, job.id, 5);
      return redact({ ...pres, recent_runs: runs.map((r) => ({ mode: r.mode, status: r.status, started_at: r.started_at, duration_ms: r.duration_ms, stats: r.stats, coverage: r.coverage })) });
    }
    case "run_job": {
      const job = await resolveJob(ctx.ownerId, String(input.job ?? ""));
      if (!job) return { error: "job_not_found" };
      const mode = input.mode === "test" ? "test" : "run";
      if (mode === "run" && job.status === "draft" && !job.detectors.length) return { error: "job_has_no_detectors", note: `${job.name} is defined but its detectors are not available yet.` };
      const out = await runJob(ctx.ownerId, job, { mode });
      return {
        mode: out.mode,
        label: mode === "test" ? "TEST MODE — nothing was created or sent" : "Run completed",
        status: out.status,
        coverage: out.coverage,
        stats: out.stats,
        notes: out.notes,
        results: mode === "test" ? out.results.slice(0, 10) : undefined,
      };
    }
    case "pause_job":
    case "resume_job": {
      const job = await resolveJob(ctx.ownerId, String(input.job ?? ""));
      if (!job) return { error: "job_not_found" };
      const status = name === "pause_job" ? "paused" : "active";
      if (status === "active" && !job.detectors.length) return { error: "job_has_no_detectors", note: `${job.name} cannot run yet: its detectors arrive in a later update.` };
      const res = await updateJob(ctx.ownerId, job.id, { status });
      if (!res.ok) return { error: res.reason };
      await audit({ event: status === "paused" ? "job_paused" : "job_resumed", ownerId: ctx.ownerId, targetId: job.id, metadata: { slug: job.slug, via: "chat" } });
      return { ok: true, job: job.name, status };
    }
    case "create_job_from_description": {
      const res = await createJobFromDescription(ctx.ownerId, String(input.description ?? ""), { source: "chat" });
      return {
        outcome: res.outcome,
        job: res.job ? { slug: res.job.slug, name: res.job.name, status: res.job.status, schedule: res.job.schedule_type, schedule_expression: res.job.schedule_expression, sources: res.job.sources, detectors: res.job.detectors } : null,
        interpretation: { name: res.interpretation.name, scope: res.interpretation.scope, schedule_type: res.interpretation.schedule_type, schedule_expression: res.interpretation.schedule_expression, detectors: res.interpretation.detectors, sources: res.interpretation.sources, would_need: res.interpretation.would_need, notification_policy: res.interpretation.notification_policy, limitations: res.interpretation.limitations, ambiguities: res.interpretation.ambiguities },
        reason: res.reason,
        notes: res.notes,
        guidance:
          res.outcome === "matches_system_job"
            ? "An existing system job already covers this; tell the owner and offer to run or resume it."
            : res.outcome === "created_draft"
              ? "Created as a draft; tell the owner it needs their review under Jeff's Jobs before it runs."
              : res.outcome === "needs_input"
                ? "Ask the owner the ambiguity question; do not create anything yet."
                : undefined,
      };
    }
    case "update_job_policy": {
      const job = await resolveJob(ctx.ownerId, String(input.job ?? ""));
      if (!job) return { error: "job_not_found" };
      const patch: Record<string, unknown> = {};
      if (typeof input.schedule_type === "string") patch.schedule_type = input.schedule_type;
      if (typeof input.schedule_expression === "string") patch.schedule_expression = input.schedule_expression;
      if (typeof input.scope === "string") patch.scope = input.scope;
      if (typeof input.minimum_severity === "string") patch.minimum_severity = input.minimum_severity;
      const policyPatch: Record<string, unknown> = {};
      for (const k of ["min_importance", "push", "briefing_only", "max_per_day"]) if (input[k] !== undefined) policyPatch[k] = input[k];
      if (Object.keys(policyPatch).length) {
        const merged = NotificationPolicySchema.safeParse({ ...job.notification_policy, ...policyPatch });
        if (!merged.success) return { error: "invalid_policy" };
        patch.notification_policy = merged.data;
      }
      const res = await updateJob(ctx.ownerId, job.id, patch);
      if (!res.ok) return { error: res.reason };
      await audit({ event: "job_updated", ownerId: ctx.ownerId, targetId: job.id, metadata: { slug: job.slug, changed: res.changed, via: "chat" } });
      return { ok: true, job: job.name, changed: res.changed, schedule_type: res.job.schedule_type, schedule_expression: res.job.schedule_expression, notification_policy: res.job.notification_policy };
    }
    default:
      return undefined;
  }
}
