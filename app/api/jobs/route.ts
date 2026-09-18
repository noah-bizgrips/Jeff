import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { createJob } from "@/lib/gomez/jobs/store";
import { JobInputSchema } from "@/lib/gomez/jobs/types";
import { createJobFromDescription, ensureJobs, getJob, presentJobs } from "@/lib/gomez/jobs";

export const dynamic = "force-dynamic";

/** GET /api/jobs — owner + aal2. Seeds the system roster idempotently and returns every job with presentation fields. */
export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const jobs = await presentJobs(g.session.userId, await ensureJobs(g.session.userId));
  return json({ jobs });
});

const CreateBody = z.union([
  z.object({ description: z.string().trim().min(8).max(1000), draft: z.boolean().optional() }),
  z.object({ job: JobInputSchema }),
]);

/**
 * POST /api/jobs — owner + aal2. Either `{ description }` (NL → job via the
 * interpreter, honouring jobs_auto_create_safe) or `{ job }` (manual, validated
 * declarative definition). Never creates system-managed jobs.
 */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, CreateBody);
  if (!body.ok) return body.response;
  if ("description" in body.data) {
    const res = await createJobFromDescription(g.session.userId, body.data.description, { forceDraft: body.data.draft, source: "ui" });
    if (res.job) await audit({ event: "job_created", ownerId: g.session.userId, targetId: res.job.id, request: req, metadata: { slug: res.job.slug, outcome: res.outcome, via: "description" } });
    const job = res.job ? (await presentJobs(g.session.userId, [res.job]))[0] : null;
    return json({ outcome: res.outcome, job, interpretation: res.interpretation, reason: res.reason ?? null, notes: res.notes ?? [] });
  }
  if (await getJob(g.session.userId, body.data.job.slug)) return apiError("slug_taken", 409);
  const res = await createJob(g.session.userId, { ...body.data.job, job_type: body.data.job.job_type === "system" ? "user" : body.data.job.job_type }, { createdBy: "owner" });
  if (!res.ok) return apiError(res.reason, 400);
  await audit({ event: "job_created", ownerId: g.session.userId, targetId: res.job.id, request: req, metadata: { slug: res.job.slug, via: "manual" } });
  const [job] = await presentJobs(g.session.userId, [res.job]);
  return json({ outcome: "created", job }, { status: 201 });
});
