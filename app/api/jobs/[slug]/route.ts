import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { deleteJob, getJob, listRuns, presentJobs, updateJob } from "@/lib/gomez/jobs";
import { JobPatchSchema } from "@/lib/gomez/jobs/types";

export const dynamic = "force-dynamic";

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(60);

/** GET /api/jobs/{slug} — job with presentation fields and its five most recent runs. */
export const GET = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { slug } = await ctx.params;
  if (!Slug.safeParse(slug).success) return apiError("invalid_slug", 400);
  const job = await getJob(g.session.userId, slug!);
  if (!job) return apiError("job_not_found", 404);
  const [pres] = await presentJobs(g.session.userId, [job]);
  const runs = await listRuns(g.session.userId, job.id, 5);
  return json({ job: pres, runs });
});

/**
 * PATCH /api/jobs/{slug} — Tier-1 edits (schedule, policy, scope, status,
 * config, name/description for user jobs). Audited as job_updated, or
 * job_paused / job_resumed when only the status moves.
 */
export const PATCH = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { slug } = await ctx.params;
  if (!Slug.safeParse(slug).success) return apiError("invalid_slug", 400);
  const body = await parseBody(req, JobPatchSchema);
  if (!body.ok) return body.response;
  const job = await getJob(g.session.userId, slug!);
  if (!job) return apiError("job_not_found", 404);
  if (body.data.status === "active" && !job.detectors.length) return apiError("job_has_no_detectors", 409);
  const res = await updateJob(g.session.userId, job.id, body.data);
  if (!res.ok) return apiError(res.reason, 400);
  const statusOnly = res.changed.length === 1 && res.changed[0] === "status";
  const event = statusOnly && res.job.status === "paused" ? "job_paused" : statusOnly && res.job.status === "active" ? "job_resumed" : "job_updated";
  await audit({ event, ownerId: g.session.userId, targetId: job.id, request: req, metadata: { slug: job.slug, changed: res.changed } });
  const [pres] = await presentJobs(g.session.userId, [res.job]);
  return json({ ok: true, job: pres, changed: res.changed });
});

/** DELETE /api/jobs/{slug} — user/custom jobs only; system jobs can be paused or disabled, never deleted. */
export const DELETE = withErrorBoundary(async (req, ctx) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { slug } = await ctx.params;
  if (!Slug.safeParse(slug).success) return apiError("invalid_slug", 400);
  const job = await getJob(g.session.userId, slug!);
  if (!job) return apiError("job_not_found", 404);
  if (job.system_managed || job.job_type === "system") return apiError("system_job", 403);
  const res = await deleteJob(g.session.userId, job.id);
  if (!res.ok) return apiError(res.reason, 400);
  await audit({ event: "job_deleted", ownerId: g.session.userId, targetId: job.id, request: req, metadata: { slug: job.slug } });
  return json({ ok: true });
});
