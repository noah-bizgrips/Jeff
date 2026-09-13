import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "../fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
let db = new FakeDb();
const audit = vi.fn(async () => {});
const runJob = vi.fn(async (_o: string, job: { slug: string }, opts: { mode: string }) => ({
  runId: "run-1",
  mode: opts.mode,
  status: "succeeded",
  coverage: [],
  stats: { candidates: 1, findings_created: 0 },
  results: opts.mode === "test" ? [{ fingerprint: "x", category: "failed_payment", title: `would-be for ${job.slug}`, severity: "medium", confidence: 0.6, observed_facts: [], interpretation: "", evidence_count: 1, evidence: [], limitations: "", existing: false }] : [],
  notes: [],
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.client() }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/jeff/settings-store", () => ({ getSettings: async () => ({ timezone: "America/Denver", jobs_auto_create_safe: true }) }));
let connected = ["portal", "stripe"];
vi.mock("@/lib/integrations/store", () => ({ listConnections: async () => connected.map((provider) => ({ provider, status: "connected" })) }));
vi.mock("@/lib/jeff/jobs/runner", () => ({ runJob: (...a: unknown[]) => runJob(...(a as [string, { slug: string }, { mode: string }])), runDueJobs: async () => ({ ran: [], skipped: [] }), triggerJobsForEvent: async () => [] }));
vi.mock("@/lib/jeff/budget", () => ({ budgetStatus: async () => ({ spentUsd: 0, budgetUsd: 2, exhausted: false }), recordUsage: async () => 0 }));

const { JOB_TOOLS, runJobTool } = await import("@/lib/jeff/jobs/tools");
const { JEFF_TOOLS } = await import("@/lib/jeff/tools");
const ctx = { ownerId: OWNER } as never;

beforeEach(() => {
  db = new FakeDb();
  audit.mockClear();
  runJob.mockClear();
});

describe("Ask Jeff job tools", () => {
  it("are registered in JEFF_TOOLS with strict schemas", () => {
    const names = JOB_TOOLS.map((t) => t.name);
    expect(names).toEqual(["list_jobs", "get_job", "run_job", "pause_job", "resume_job", "create_job_from_description", "update_job_policy"]);
    for (const n of names) expect(JEFF_TOOLS.some((t) => t.name === n)).toBe(true);
    for (const t of JOB_TOOLS) expect((t.input_schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
  it("list_jobs seeds the roster and reports coverage; get_job resolves by slug or name", async () => {
    const list = (await runJobTool("list_jobs", {}, ctx)) as { slug: string; name: string; status: string; missing_sources: string[]; pending: string | null }[];
    expect(list).toHaveLength(13);
    const scanner = list.find((j) => j.slug === "blind-spot-scanner")!;
    expect(scanner.name).toBe("Find what I'm missing");
    expect(scanner.status).toBe("LIMITED COVERAGE"); // reads every connected source; only portal + stripe are connected here
    expect(list.filter((j) => j.status === "LIMITED COVERAGE").length).toBeGreaterThan(0);
    const cash = list.find((j) => j.slug === "cash-flow-watchdog")!;
    expect(cash.status).toBe("LIMITED COVERAGE");
    expect(cash.missing_sources).toEqual(["plaid"]);
    connected = ["portal", "stripe", "plaid"];
    const relisted = (await runJobTool("list_jobs", {}, ctx)) as { slug: string; status: string }[];
    expect(relisted.find((j) => j.slug === "cash-flow-watchdog")!.status).toBe("ACTIVE");
    connected = ["portal", "stripe"];
    expect(list.find((j) => j.slug === "relationship-radar")!.pending).toBeNull();
    expect(list.find((j) => j.slug === "relationship-radar")!.status).toBe("LIMITED COVERAGE");
    const got = (await runJobTool("get_job", { job: "Cash Flow Watchdog" }, ctx)) as { slug: string; recent_runs: unknown[] };
    expect(got.slug).toBe("cash-flow-watchdog");
    expect(got.recent_runs).toEqual([]);
    expect(await runJobTool("get_job", { job: "nothing-here" }, ctx)).toEqual({ error: "job_not_found" });
  });
  it("run_job test mode labels the result as TEST MODE and returns would-be findings; run mode omits them", async () => {
    await runJobTool("list_jobs", {}, ctx);
    const test = (await runJobTool("run_job", { job: "blind spot scanner", mode: "test" }, ctx)) as { label: string; results: unknown[] };
    expect(test.label).toMatch(/TEST MODE/);
    expect(test.results).toHaveLength(1);
    expect(runJob).toHaveBeenLastCalledWith(OWNER, expect.objectContaining({ slug: "blind-spot-scanner" }), { mode: "test" });
    const run = (await runJobTool("run_job", { job: "blind-spot-scanner", mode: "run" }, ctx)) as { label: string; results?: unknown[] };
    expect(run.label).toBe("Run completed");
    expect(run.results).toBeUndefined();
    // Draft jobs without detectors cannot run for real.
    db.rows("jobs").push({ ...db.rows("jobs").find((j) => j.slug === "goal-coach")!, id: "empty-draft-id", slug: "empty-draft", name: "Empty draft", status: "draft", detectors: [], system_managed: false, created_by: "owner" });
    expect(await runJobTool("run_job", { job: "empty-draft", mode: "run" }, ctx)).toMatchObject({ error: "job_has_no_detectors" });
  });
  it("pause/resume change status and audit; drafts without detectors cannot be resumed", async () => {
    await runJobTool("list_jobs", {}, ctx);
    expect(await runJobTool("pause_job", { job: "goal coach" }, ctx)).toEqual({ ok: true, job: "Goal Coach", status: "paused" });
    expect(db.rows("jobs").find((j) => j.slug === "goal-coach")!.status).toBe("paused");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "job_paused", metadata: expect.objectContaining({ slug: "goal-coach", via: "chat" }) }));
    expect(await runJobTool("resume_job", { job: "goal-coach" }, ctx)).toMatchObject({ ok: true, status: "active" });
    db.rows("jobs").push({ ...db.rows("jobs").find((j) => j.slug === "goal-coach")!, id: "empty-draft-id", slug: "empty-draft", name: "Empty draft", status: "draft", detectors: [], system_managed: false, created_by: "owner" });
    expect(await runJobTool("resume_job", { job: "empty-draft" }, ctx)).toMatchObject({ error: "job_has_no_detectors" });
  });
  it("create_job_from_description creates the §87 job active with the connected sources", async () => {
    const res = (await runJobTool("create_job_from_description", { description: "Create a job that checks every Friday for clients we do way more work for than they pay us for." }, ctx)) as { outcome: string; job: { slug: string; status: string; schedule: string; schedule_expression: string; sources: string[]; detectors: string[] }; guidance?: string };
    expect(res.outcome).toBe("created_active");
    expect(res.job).toMatchObject({ slug: "client-scope-creep-auditor", status: "active", schedule: "weekly", schedule_expression: "fri 07:05", detectors: ["client_scope_creep"] });
    expect(res.job.sources.sort()).toEqual(["portal", "stripe"]);
    expect(res.guidance).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "job_created" }));
    // Same request again → a second slug, never a clash.
    const again = (await runJobTool("create_job_from_description", { description: "Create a job that checks every Friday for clients we do way more work for than they pay us for." }, ctx)) as { job: { slug: string } };
    expect(again.job.slug).not.toBe("client-scope-creep-auditor");
  });
  it("create_job_from_description points at the system scanner for the blind-spot sentence and asks when unclear", async () => {
    await runJobTool("list_jobs", {}, ctx);
    const match = (await runJobTool("create_job_from_description", { description: "Every week, look for something important I might be missing" }, ctx)) as { outcome: string; job: { slug: string }; guidance: string };
    expect(match.outcome).toBe("matches_system_job");
    expect(match.job.slug).toBe("blind-spot-scanner");
    expect(match.guidance).toMatch(/already covers/);
    const ask = (await runJobTool("create_job_from_description", { description: "Do the thing with the stuff" }, ctx)) as { outcome: string; job: null; reason: string };
    expect(ask.outcome).toBe("needs_input");
    expect(ask.job).toBeNull();
    expect(ask.reason).toMatch(/look for/);
    expect(db.rows("jobs").filter((j) => j.job_type === "user")).toHaveLength(0);
  });
  it("update_job_policy merges policy fields, validates them, and recomputes the schedule", async () => {
    await runJobTool("list_jobs", {}, ctx);
    const res = (await runJobTool("update_job_policy", { job: "expense creep hunter", max_per_day: 1, push: true, schedule_type: "weekly", schedule_expression: "fri 07:05" }, ctx)) as { ok: boolean; changed: string[]; notification_policy: Record<string, unknown>; schedule_expression: string };
    expect(res.ok).toBe(true);
    expect(res.changed.sort()).toEqual(["notification_policy", "schedule_expression", "schedule_type"]);
    expect(res.notification_policy).toMatchObject({ max_per_day: 1, push: true, briefing_only: true }); // briefing_only preserved from the seed
    expect(res.schedule_expression).toBe("fri 07:05");
    expect(await runJobTool("update_job_policy", { job: "expense creep hunter", max_per_day: 999 }, ctx)).toEqual({ error: "invalid_policy" });
    expect(await runJobTool("unknown_tool", {}, ctx)).toBeUndefined();
  });
});
