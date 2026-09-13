import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, jsonReq, OWNER_ID, OTHER_ID, req, type Claims } from "../helpers";
import { FakeDb } from "../fake-db";

let claims: Claims = null;
let db = new FakeDb();
const audit = vi.fn(async () => {});
const runJob = vi.fn(async (_o: string, job: { id: string; slug: string }, opts: { mode: string; onStart?: (id: string) => void }) => {
  const runId = "33333333-3333-4333-8333-333333333333";
  opts.onStart?.(runId);
  db.rows("job_runs").push({ id: runId, owner_id: OWNER_ID, job_id: job.id, mode: opts.mode, status: "succeeded", started_at: null, finished_at: null, duration_ms: 12, coverage: [], stats: { progress: "complete", findings_created: 1 }, results: opts.mode === "test" ? [{ fingerprint: "x", category: "failed_payment", title: "t", severity: "low", confidence: 0.5, observed_facts: [], interpretation: "", evidence_count: 0, evidence: [], limitations: "", existing: false }] : [], error: null, created_at: new Date().toISOString() });
  return { runId, mode: opts.mode, status: "succeeded", coverage: [], stats: { candidates: 1 }, results: [], notes: [] };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.client() }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/jeff/settings-store", () => ({ getSettings: async () => ({ timezone: "America/Denver", jobs_auto_create_safe: true }) }));
vi.mock("@/lib/integrations/store", () => ({ listConnections: async () => [{ provider: "portal", status: "connected" }, { provider: "stripe", status: "connected" }] }));
vi.mock("@/lib/jeff/jobs/runner", () => ({ runJob: (...a: unknown[]) => runJob(...(a as [string, { id: string; slug: string }, { mode: string }])), runDueJobs: async () => ({ ran: [], skipped: [] }), triggerJobsForEvent: async () => [] }));
vi.mock("@/lib/jeff/budget", () => ({ budgetStatus: async () => ({ spentUsd: 0, budgetUsd: 2, exhausted: false }), recordUsage: async () => 0 }));
vi.mock("@/lib/env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/env")>();
  return { ...mod, hasEnv: (name: string) => (name === "ANTHROPIC_API_KEY" ? false : mod.hasEnv(name)) };
});
vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  return { ...mod, after: (fn: () => unknown) => void fn() };
});

const list = await import("@/app/api/jobs/route");
const detail = await import("@/app/api/jobs/[slug]/route");
const test = await import("@/app/api/jobs/[slug]/test/route");
const run = await import("@/app/api/jobs/[slug]/run/route");
const runs = await import("@/app/api/jobs/[slug]/runs/route");
const findings = await import("@/app/api/jobs/[slug]/findings/route");
const interpret = await import("@/app/api/jobs/interpret/route");
const templates = await import("@/app/api/jobs/templates/route");
const scan = await import("@/app/api/jobs/blind-spot-scan/route");
const runById = await import("@/app/api/jobs/runs/[id]/route");

const params = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const owner = () => (claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal2" });

beforeEach(() => {
  claims = null;
  db = new FakeDb();
  audit.mockClear();
  runJob.mockClear();
});

describe("auth: every jobs route requires the owner at aal2", () => {
  const calls: [string, () => Promise<Response>][] = [
    ["GET /api/jobs", () => list.GET(req("/api/jobs"), params())],
    ["POST /api/jobs", () => list.POST(jsonReq("/api/jobs", { description: "watch failed payments daily" }), params())],
    ["GET /api/jobs/x", () => detail.GET(req("/api/jobs/goal-coach"), params({ slug: "goal-coach" }))],
    ["PATCH /api/jobs/x", () => detail.PATCH(jsonReq("/api/jobs/goal-coach", { status: "paused" }, { method: "PATCH" }), params({ slug: "goal-coach" }))],
    ["DELETE /api/jobs/x", () => detail.DELETE(req("/api/jobs/goal-coach", { method: "DELETE" }), params({ slug: "goal-coach" }))],
    ["POST test", () => test.POST(req("/api/jobs/goal-coach/test", { method: "POST" }), params({ slug: "goal-coach" }))],
    ["POST run", () => run.POST(req("/api/jobs/goal-coach/run", { method: "POST" }), params({ slug: "goal-coach" }))],
    ["GET runs", () => runs.GET(req("/api/jobs/goal-coach/runs"), params({ slug: "goal-coach" }))],
    ["GET findings", () => findings.GET(req("/api/jobs/goal-coach/findings"), params({ slug: "goal-coach" }))],
    ["POST interpret", () => interpret.POST(jsonReq("/api/jobs/interpret", { description: "watch failed payments daily" }), params())],
    ["GET templates", () => templates.GET(req("/api/jobs/templates"), params())],
    ["POST blind-spot-scan", () => scan.POST(req("/api/jobs/blind-spot-scan", { method: "POST" }), params())],
    ["GET runs/id", () => runById.GET(req("/api/jobs/runs/33333333-3333-4333-8333-333333333333"), params({ id: "33333333-3333-4333-8333-333333333333" }))],
    ["PATCH runs/id", () => runById.PATCH(jsonReq("/api/jobs/runs/x", { index: 0, verdict: "useful" }, { method: "PATCH" }), params({ id: "33333333-3333-4333-8333-333333333333" }))],
  ];
  it("returns 401 anonymous, 403 for another user, 403 at aal1", async () => {
    for (const [name, call] of calls) {
      claims = null;
      expect((await call()).status, `${name} anonymous`).toBe(401);
      claims = { sub: OTHER_ID, email: "other@example.com", aal: "aal2" };
      expect((await call()).status, `${name} other user`).toBe(403);
      claims = { sub: OWNER_ID, email: "noah@bizgrips.com", aal: "aal1" };
      expect((await call()).status, `${name} aal1`).toBe(403);
    }
    expect(runJob).not.toHaveBeenCalled();
    expect(db.rows("jobs")).toHaveLength(0);
  });
  it("rejects cross-site mutations", async () => {
    owner();
    const r = await list.POST(jsonReq("/api/jobs", { description: "watch failed payments daily" }, { sameOrigin: false, origin: "https://evil.example" }), params());
    expect(r.status).toBe(403);
  });
});

describe("jobs routes (owner)", () => {
  it("GET /api/jobs seeds and lists; GET /api/jobs/{slug} returns presentation + runs; unknown slug 404; bad slug 400", async () => {
    owner();
    const r = await list.GET(req("/api/jobs"), params());
    expect(r.status).toBe(200);
    const body = (await r.json()) as { jobs: { slug: string; status_label: string }[] };
    expect(body.jobs).toHaveLength(13);
    const d = await detail.GET(req("/api/jobs/goal-coach"), params({ slug: "goal-coach" }));
    expect(d.status).toBe(200);
    expect(await d.json()).toMatchObject({ job: { slug: "goal-coach", ui_name: "Goal Coach" }, runs: [] });
    expect((await detail.GET(req("/api/jobs/nope"), params({ slug: "nope" }))).status).toBe(404);
    expect((await detail.GET(req("/api/jobs/x"), params({ slug: "Bad Slug!" }))).status).toBe(400);
  });
  it("PATCH audits pause/resume/update, validates, and blocks activating a job with no detectors", async () => {
    owner();
    await list.GET(req("/api/jobs"), params());
    const p = await detail.PATCH(jsonReq("/api/jobs/goal-coach", { status: "paused" }, { method: "PATCH" }), params({ slug: "goal-coach" }));
    expect(p.status).toBe(200);
    expect(await p.json()).toMatchObject({ ok: true, changed: ["status"], job: { status: "paused", status_label: "PAUSED" } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "job_paused" }));
    const u = await detail.PATCH(jsonReq("/api/jobs/goal-coach", { schedule_type: "weekly", schedule_expression: "fri 07:05", notification_policy: { min_importance: "urgent", push: false, briefing_only: false, max_per_day: 1 } }, { method: "PATCH" }), params({ slug: "goal-coach" }));
    expect(u.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "job_updated" }));
    expect((await detail.PATCH(jsonReq("/api/jobs/goal-coach", { slug: "hack" }, { method: "PATCH" }), params({ slug: "goal-coach" }))).status).toBe(400);
    expect((await detail.PATCH(jsonReq("/api/jobs/goal-coach", { notification_policy: { max_per_day: 999 } }, { method: "PATCH" }), params({ slug: "goal-coach" }))).status).toBe(400);
    expect((await detail.PATCH(jsonReq("/api/jobs/relationship-radar", { status: "active" }, { method: "PATCH" }), params({ slug: "relationship-radar" }))).status).toBe(409);
  });
  it("DELETE refuses system jobs (403) and removes user jobs (audited)", async () => {
    owner();
    await list.GET(req("/api/jobs"), params());
    expect((await detail.DELETE(req("/api/jobs/goal-coach", { method: "DELETE" }), params({ slug: "goal-coach" }))).status).toBe(403);
    const c = await list.POST(jsonReq("/api/jobs", { job: { slug: "my-watch", name: "My watch", job_type: "user", sources: ["stripe"], detectors: ["failed_payment"] } }), params());
    expect(c.status).toBe(201);
    expect(await c.json()).toMatchObject({ outcome: "created", job: { slug: "my-watch", job_type: "user" } });
    expect((await list.POST(jsonReq("/api/jobs", { job: { slug: "my-watch", name: "My watch" } }), params())).status).toBe(409);
    // Manual creation can never mint a system job.
    const s = await list.POST(jsonReq("/api/jobs", { job: { slug: "sneaky", name: "Sneaky", job_type: "system" } }), params());
    expect(((await s.json()) as { job: { job_type: string } }).job.job_type).toBe("user");
    const del = await detail.DELETE(req("/api/jobs/my-watch", { method: "DELETE" }), params({ slug: "my-watch" }));
    expect(del.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "job_deleted" }));
    expect((await detail.GET(req("/api/jobs/my-watch"), params({ slug: "my-watch" }))).status).toBe(404);
  });
  it("POST /api/jobs with a description creates via the interpreter and audits job_created", async () => {
    owner();
    const r = await list.POST(jsonReq("/api/jobs", { description: "Create a job that checks every Friday for clients we do way more work for than they pay us for." }), params());
    expect(r.status).toBe(200);
    const body = (await r.json()) as { outcome: string; job: { slug: string; status: string } };
    expect(body.outcome).toBe("created_active");
    expect(body.job).toMatchObject({ slug: "client-scope-creep-auditor", status: "active" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "job_created", metadata: expect.objectContaining({ via: "description" }) }));
    expect((await list.POST(jsonReq("/api/jobs", { description: "short" }), params())).status).toBe(400);
  });
  it("test and run call the runner in the right mode; test is audited as job_test; drafts cannot run for real", async () => {
    owner();
    await list.GET(req("/api/jobs"), params());
    const t = await test.POST(req("/api/jobs/goal-coach/test", { method: "POST" }), params({ slug: "goal-coach" }));
    expect(t.status).toBe(200);
    expect(await t.json()).toMatchObject({ mode: "test", status: "succeeded" });
    expect(runJob).toHaveBeenLastCalledWith(OWNER_ID, expect.objectContaining({ slug: "goal-coach" }), { mode: "test" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "job_test" }));
    const r = await run.POST(req("/api/jobs/goal-coach/run", { method: "POST" }), params({ slug: "goal-coach" }));
    expect(r.status).toBe(200);
    expect(runJob).toHaveBeenLastCalledWith(OWNER_ID, expect.objectContaining({ slug: "goal-coach" }), { mode: "run" });
    expect((await run.POST(req("/api/jobs/relationship-radar/run", { method: "POST" }), params({ slug: "relationship-radar" }))).status).toBe(409);
    expect((await run.POST(req("/api/jobs/nope/run", { method: "POST" }), params({ slug: "nope" }))).status).toBe(404);
  });
  it("runs and findings are scoped to the job", async () => {
    owner();
    await list.GET(req("/api/jobs"), params());
    const job = db.rows("jobs").find((j) => j.slug === "goal-coach")!;
    const other = db.rows("jobs").find((j) => j.slug === "cash-flow-watchdog")!;
    db.rows("findings").push({ id: "f1", owner_id: OWNER_ID, job_id: job.id, status: "open", category: "goal_trajectory", severity: "medium", title: "G", last_seen_at: "2026-09-12T00:00:00Z" }, { id: "f2", owner_id: OWNER_ID, job_id: other.id, status: "open", category: "failed_payment", severity: "high", title: "P", last_seen_at: "2026-09-12T00:00:00Z" }, { id: "f3", owner_id: OWNER_ID, job_id: job.id, status: "dismissed", category: "goal_trajectory", severity: "low", title: "D", last_seen_at: "2026-09-11T00:00:00Z" });
    await test.POST(req("/api/jobs/goal-coach/test", { method: "POST" }), params({ slug: "goal-coach" }));
    const rs = (await (await runs.GET(req("/api/jobs/goal-coach/runs?limit=5"), params({ slug: "goal-coach" }))).json()) as { runs: { mode: string }[] };
    expect(rs.runs).toHaveLength(1);
    expect(rs.runs[0]!.mode).toBe("test");
    const open = (await (await findings.GET(req("/api/jobs/goal-coach/findings"), params({ slug: "goal-coach" }))).json()) as { findings: { id: string }[] };
    expect(open.findings.map((f) => f.id)).toEqual(["f1"]);
    const all = (await (await findings.GET(req("/api/jobs/goal-coach/findings?status=all"), params({ slug: "goal-coach" }))).json()) as { findings: { id: string }[] };
    expect(all.findings.map((f) => f.id).sort()).toEqual(["f1", "f3"]);
  });
  it("interpret proposes without creating; templates list the catalog and detectors", async () => {
    owner();
    const i = await interpret.POST(jsonReq("/api/jobs/interpret", { description: "Every week, look for something important I might be missing" }), params());
    expect(i.status).toBe(200);
    expect(await i.json()).toMatchObject({ interpretation: { matches_system_job: "blind-spot-scanner", detectors: ["blind_spots"] }, used_model: false, connected: ["portal", "stripe"] });
    expect(db.rows("jobs")).toHaveLength(0);
    const t = (await (await templates.GET(req("/api/jobs/templates"), params())).json()) as { templates: { id: string; missing_sources: string[] }[]; detectors: { id: string }[] };
    expect(t.templates.find((x) => x.id === "client-scope-creep")!.missing_sources).toEqual([]);
    expect(t.templates.find((x) => x.id === "payments-watch")).toBeTruthy();
    expect(t.detectors.some((d) => d.id === "client_scope_creep")).toBe(true);
  });
  it("blind-spot-scan returns a scanId immediately and the run is pollable with progress labels", async () => {
    owner();
    const s = await scan.POST(req("/api/jobs/blind-spot-scan", { method: "POST" }), params());
    expect(s.status).toBe(202);
    const { scanId } = (await s.json()) as { scanId: string };
    expect(scanId).toBe("33333333-3333-4333-8333-333333333333");
    expect(runJob).toHaveBeenCalledWith(OWNER_ID, expect.objectContaining({ slug: "blind-spot-scanner" }), expect.objectContaining({ mode: "run", onStart: expect.any(Function) }));
    const p = await runById.GET(req(`/api/jobs/runs/${scanId}`), params({ id: scanId }));
    expect(p.status).toBe(200);
    expect(await p.json()).toMatchObject({ run: { id: scanId, status: "succeeded" }, progress: "complete", progress_label: "Complete", findings: [] });
    expect((await runById.GET(req("/api/jobs/runs/x"), params({ id: "not-a-uuid" }))).status).toBe(400);
    expect((await runById.GET(req("/api/jobs/runs/x"), params({ id: "44444444-4444-4444-8444-444444444444" }))).status).toBe(404);
    // A running scan reports its progress step.
    db.rows("job_runs")[0]!.status = "running";
    db.rows("job_runs")[0]!.stats = { progress: "novel" };
    expect(await (await runById.GET(req(`/api/jobs/runs/${scanId}`), params({ id: scanId }))).json()).toMatchObject({ progress: "novel", progress_label: "Looking for novel blind spots" });
  });
  it("PATCH runs/{id} records feedback only on test runs", async () => {
    owner();
    await list.GET(req("/api/jobs"), params());
    await test.POST(req("/api/jobs/goal-coach/test", { method: "POST" }), params({ slug: "goal-coach" }));
    const id = db.rows("job_runs")[0]!.id as string;
    const ok = await runById.PATCH(jsonReq(`/api/jobs/runs/${id}`, { index: 0, verdict: "too_noisy" }, { method: "PATCH" }), params({ id }));
    expect(ok.status).toBe(200);
    expect((db.rows("job_runs")[0]!.results as { feedback?: string }[])[0]!.feedback).toBe("too_noisy");
    expect((await runById.PATCH(jsonReq(`/api/jobs/runs/${id}`, { index: 5, verdict: "useful" }, { method: "PATCH" }), params({ id }))).status).toBe(404);
    expect((await runById.PATCH(jsonReq(`/api/jobs/runs/${id}`, { index: 0, verdict: "dont_show" }, { method: "PATCH" }), params({ id }))).status).toBe(400);
    db.rows("job_runs")[0]!.mode = "run";
    expect((await runById.PATCH(jsonReq(`/api/jobs/runs/${id}`, { index: 0, verdict: "useful" }, { method: "PATCH" }), params({ id }))).status).toBe(409);
  });
});
