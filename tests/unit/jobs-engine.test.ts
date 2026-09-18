import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "../fake-db";
import type { OperatingRule } from "@/lib/gomez/rules/schema";
import type { ProviderFreshness } from "@/lib/gomez/freshness";
import type { JobRow } from "@/lib/gomez/jobs/types";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-12T18:00:00Z"); // Saturday 12:00 Denver
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

let db = new FakeDb();
let freshness: ProviderFreshness[] = [];
let rules: OperatingRule[] = [];
const alerts = vi.fn(async () => ({ created: 0 }));
const audit = vi.fn(async () => {});
const runBlindSpotsForOwner = vi.fn(async (_o: string, _n: Date, opts: { onProgress?: (s: string) => void }) => {
  opts.onProgress?.("reviewing_goals");
  opts.onProgress?.("ranking");
  return { ran: true, candidates: 0, excludedByRules: 0, created: 0, updated: 0, resolved: 0, deferredByCap: 0, usedModel: false, pushed: false, errors: [] };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.client() }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/gomez/settings-store", () => ({ getSettings: async () => ({ timezone: "America/Denver", jobs_auto_create_safe: true }) }));
vi.mock("@/lib/gomez/freshness-store", () => ({ loadFreshness: async () => freshness }));
vi.mock("@/lib/gomez/rules/store", () => ({ listRules: async () => rules, recordRuleEvents: async () => {} }));
vi.mock("@/lib/gomez/rules/apply", () => ({ ensureSystemRules: async (_o: string, r: OperatingRule[]) => r }));
vi.mock("@/lib/gomez/alerts/store", () => ({ runAlertsForOwner: (...a: unknown[]) => alerts(...(a as [])) }));
vi.mock("@/lib/gomez/goals/refresh", () => ({ refreshGoals: async () => [] }));
vi.mock("@/lib/gomez/goals/store", () => ({ latestSnapshot: async () => null, listGoals: async () => [] }));
vi.mock("@/lib/gomez/blindspots", () => ({
  runBlindSpotsForOwner: (...a: unknown[]) => runBlindSpotsForOwner(...(a as [string, Date, { onProgress?: (s: string) => void }])),
  loadBlindSpotContext: async () => ({ now: NOW, ownerEmail: "", sourceItems: [], findings: [], alerts: [], goals: [], clients: [], connections: [], attention: [], commitments: [] }),
  detectBlindSpots: () => ({ candidates: [], events: [], errors: [] }),
  DETECTORS: [],
}));
vi.mock("@/lib/gomez/blindspots/detect", () => ({ toFinding: (c: unknown) => c }));
vi.mock("@/lib/integrations/store", () => ({ listConnections: async () => [{ provider: "stripe", status: "connected" }] }));

const store = await import("@/lib/gomez/jobs/store");
const runner = await import("@/lib/gomez/jobs/runner");
const { SYSTEM_JOBS } = await import("@/lib/gomez/jobs/registry");
const { computeCoverage, coverageLevel } = await import("@/lib/gomez/jobs/coverage");

function fresh(provider: string, level: ProviderFreshness["level"] = "fresh", status = "connected"): ProviderFreshness {
  return { connection_id: `c-${provider}`, provider, display_name: provider, status, last_success_at: NOW.toISOString(), last_attempt_at: NOW.toISOString(), last_error: null, age_hours: 1, level, text: `${provider} data is 1h old` };
}

function rule(partial: Partial<OperatingRule> & { name: string }): OperatingRule {
  return {
    id: partial.name.toLowerCase().replace(/\W+/g, "-"),
    owner_id: OWNER,
    rule_type: "monitor_filter",
    scope: "business",
    target_system: "monitors",
    target_monitor: null,
    conditions: {},
    action: { type: "exclude" },
    priority: 100,
    tier: 1,
    enabled: true,
    pending_confirmation: false,
    source: "chat",
    source_quote: null,
    created_by: "owner",
    created_at: daysAgo(1),
    updated_at: daysAgo(1),
    last_triggered_at: null,
    trigger_count: 0,
    ...partial,
  };
}

/** A past-due Stripe invoice + failed charge: the failed_payment monitor fires (fingerprint failed_payment:stripe:open). */
function seedStripeTrouble() {
  db.seed("source_items", [
    { owner_id: OWNER, is_sample: false, provider: "stripe", capability: null, resource_type: "invoice", external_id: "in_1", title: "Invoice A-1", summary: null, author: "acme.com", source_url: null, source_timestamp: daysAgo(3), tags: [], metadata: { status: "open", amount_due: 60000, amount_remaining: 60000, due_date: daysAgo(3), number: "A-1", currency: "usd" } },
    { owner_id: OWNER, is_sample: false, provider: "stripe", capability: null, resource_type: "charge", external_id: "ch_1", title: "Charge", summary: null, author: null, source_url: null, source_timestamp: daysAgo(2), tags: [], metadata: { status: "failed", amount: 2500, currency: "usd", failure_code: "card_declined" } },
  ]);
}

async function seededJob(slug: string): Promise<JobRow> {
  await store.seedSystemJobs(OWNER, NOW);
  const job = await store.getJob(OWNER, slug);
  if (!job) throw new Error(`missing ${slug}`);
  return job;
}

beforeEach(() => {
  db = new FakeDb();
  freshness = ["stripe", "plaid", "highlevel", "google", "meta", "portal", "slack", "n8n", "notion", "github"].map((p) => fresh(p));
  rules = [];
  alerts.mockClear();
  audit.mockClear();
  runBlindSpotsForOwner.mockClear();
});

describe("seedSystemJobs", () => {
  it("creates the 13-job roster once and is idempotent", async () => {
    const first = await store.seedSystemJobs(OWNER, NOW);
    expect(first.created).toBe(SYSTEM_JOBS.length);
    expect(SYSTEM_JOBS.length).toBe(13);
    const again = await store.seedSystemJobs(OWNER, NOW);
    expect(again).toEqual({ created: 0, refreshed: 0 });
    expect(db.rows("jobs")).toHaveLength(13);
    const scanner = db.rows("jobs").find((j) => j.slug === "blind-spot-scanner")!;
    expect(scanner.system_managed).toBe(true);
    expect(scanner.next_run_at).toBe("2026-09-14T13:15:00.000Z"); // Monday 07:15 Denver
    // Run C: every system job is active with detectors (LIMITED COVERAGE when sources are missing, never DRAFT).
    expect(db.rows("jobs").filter((j) => j.status === "draft")).toEqual([]);
    for (const j of db.rows("jobs")) expect((j.detectors as string[]).length, j.slug as string).toBeGreaterThan(0);
    expect(db.rows("jobs").find((j) => j.slug === "relationship-radar")!.detectors).toEqual(["relationship_quiet", "referral_source_declining", "contact_resurfaced", "important_date"]);
    expect(db.rows("jobs").find((j) => j.slug === "follow-through-watchdog")!.status).toBe("active");
  });
  it("preserves owner-owned state (status, schedule, policy) and only refreshes descriptive fields", async () => {
    await store.seedSystemJobs(OWNER, NOW);
    const row = db.rows("jobs").find((j) => j.slug === "cash-flow-watchdog")!;
    Object.assign(row, { status: "paused", schedule_expression: "20:00", notification_policy: { min_importance: "urgent", push: false, briefing_only: true, max_per_day: 1 }, description: "owner scribble" });
    const res = await store.seedSystemJobs(OWNER, NOW);
    expect(res.refreshed).toBe(1);
    const after = db.rows("jobs").find((j) => j.slug === "cash-flow-watchdog")!;
    expect(after.status).toBe("paused");
    expect(after.schedule_expression).toBe("20:00");
    expect(after.notification_policy).toEqual({ min_importance: "urgent", push: false, briefing_only: true, max_per_day: 1 });
    expect(after.description).not.toBe("owner scribble");
  });
  it("promotes a pending draft to active once its detectors arrive (rows seeded before run C)", async () => {
    await store.seedSystemJobs(OWNER, NOW);
    const row = db.rows("jobs").find((j) => j.slug === "relationship-radar")!;
    // Simulate a row seeded by an earlier deploy: draft, no detectors.
    Object.assign(row, { status: "draft", detectors: [] });
    await store.seedSystemJobs(OWNER, NOW);
    const after = db.rows("jobs").find((j) => j.slug === "relationship-radar")!;
    expect(after.detectors).toEqual(SYSTEM_JOBS.find((j) => j.slug === "relationship-radar")!.detectors);
    expect(after.status).toBe("active");
    // …but a paused row stays paused.
    Object.assign(after, { status: "paused", detectors: [] });
    await store.seedSystemJobs(OWNER, NOW);
    expect(db.rows("jobs").find((j) => j.slug === "relationship-radar")!.status).toBe("paused");
  });
});

describe("coverage", () => {
  it("classifies missing / stale / error sources and derives the level", () => {
    const job = { sources: ["stripe", "plaid", "google", "meta"] };
    const cov = computeCoverage(job, [fresh("stripe"), fresh("plaid", "stale"), fresh("meta", "error", "error")]);
    expect(cov).toEqual([
      { source: "stripe", status: "ok", freshness: "stripe data is 1h old" },
      { source: "plaid", status: "stale", freshness: "plaid data is 1h old" },
      { source: "google", status: "missing", freshness: "not connected" },
      { source: "meta", status: "error", freshness: "meta data is 1h old" },
    ]);
    expect(coverageLevel(cov)).toBe("partial");
    expect(coverageLevel([])).toBe("full");
    expect(coverageLevel(cov.filter((c) => c.status !== "ok"))).toBe("none");
  });
});

describe("runJob — TEST mode", () => {
  it("returns would-be findings and writes only a job_runs row (no findings, alerts, missions)", async () => {
    seedStripeTrouble();
    const job = await seededJob("revenue-leakage-hunter");
    db.writes.length = 0;
    const out = await runner.runJob(OWNER, job, { mode: "test", now: NOW });
    expect(out.mode).toBe("test");
    expect(out.status).toBe("succeeded");
    expect(out.results.map((r) => r.fingerprint)).toContain("failed_payment:stripe:open");
    expect(out.results[0]).toMatchObject({ existing: false, category: "failed_payment" });
    // The only table touched is job_runs (start + finish).
    expect(new Set(db.writes.map((w) => w.table))).toEqual(new Set(["job_runs"]));
    expect(db.rows("findings")).toHaveLength(0);
    expect(db.rows("alerts")).toHaveLength(0);
    expect(alerts).not.toHaveBeenCalled();
    const run = db.rows("job_runs")[0]!;
    expect(run.mode).toBe("test");
    expect(run.status).toBe("succeeded");
    expect((run.results as unknown[]).length).toBe(out.results.length);
    // Bookkeeping untouched: last_run_at stays null in test mode.
    expect(db.rows("jobs").find((j) => j.slug === job.slug)!.last_run_at ?? null).toBeNull();
  });
  it("marks a result as existing when the same fingerprint is already an open finding", async () => {
    seedStripeTrouble();
    db.seed("findings", [{ owner_id: OWNER, fingerprint: "failed_payment:stripe:open", status: "open", category: "failed_payment", job_id: null }]);
    const job = await seededJob("revenue-leakage-hunter");
    const out = await runner.runJob(OWNER, job, { mode: "test", now: NOW });
    expect(out.results.find((r) => r.fingerprint === "failed_payment:stripe:open")?.existing).toBe(true);
  });
});

describe("runJob — RUN mode", () => {
  it("persists findings tagged with the job and run, runs alerts, records bookkeeping, and audits job_run", async () => {
    seedStripeTrouble();
    alerts.mockResolvedValueOnce({ created: 1 });
    const job = await seededJob("revenue-leakage-hunter");
    const out = await runner.runJob(OWNER, job, { mode: "run", now: NOW });
    expect(out.status).toBe("succeeded");
    expect(out.stats.findings_created).toBeGreaterThanOrEqual(1);
    const f = db.rows("findings").find((r) => r.fingerprint === "failed_payment:stripe:open")!;
    expect(f.job_id).toBe(job.id);
    expect(f.job_run_id).toBe(out.runId);
    expect(f.status).toBe("open");
    expect(alerts).toHaveBeenCalledWith(OWNER, NOW);
    const after = db.rows("jobs").find((j) => j.slug === job.slug)!;
    expect(after.last_run_at).toBe(NOW.toISOString());
    expect(after.run_count).toBe(1);
    expect(after.findings_30d).toBe(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "job_run", metadata: expect.objectContaining({ slug: job.slug, mode: "run" }) }));
  });
  it("auto-resolves only findings that belong to the job (never global or other-job findings)", async () => {
    const job = await seededJob("revenue-leakage-hunter");
    db.seed("findings", [
      { owner_id: OWNER, fingerprint: "failed_payment:stripe:open", status: "open", category: "failed_payment", job_id: job.id },
      { owner_id: OWNER, fingerprint: "failed_payment:global", status: "open", category: "failed_payment", job_id: null },
      { owner_id: OWNER, fingerprint: "client_scope_creep:x", status: "open", category: "client_scope_creep", job_id: "other-job" },
    ]);
    const out = await runner.runJob(OWNER, job, { mode: "run", now: NOW }); // no stripe rows → nothing fires
    expect(out.stats.findings_resolved).toBe(1);
    const byFp = Object.fromEntries(db.rows("findings").map((r) => [r.fingerprint, r.status]));
    expect(byFp).toEqual({ "failed_payment:stripe:open": "resolved", "failed_payment:global": "open", "client_scope_creep:x": "open" });
  });
  it("applies the notification policy: max_per_day overflow → informational, below push floor → never pushed, push=false → marked pushed", async () => {
    const job = await seededJob("revenue-leakage-hunter");
    const capped = { ...job, notification_policy: { min_importance: "important" as const, push: true, briefing_only: false, max_per_day: 1 } };
    db.seed("findings", [
      { id: "f1", owner_id: OWNER, fingerprint: "a", status: "open", category: "failed_payment", job_id: job.id },
      { id: "f2", owner_id: OWNER, fingerprint: "b", status: "open", category: "failed_payment", job_id: job.id },
      { id: "f3", owner_id: OWNER, fingerprint: "c", status: "open", category: "failed_payment", job_id: job.id },
    ]);
    db.seed("alerts", [
      { id: "a1", owner_id: OWNER, ref_id: "f1", status: "open", importance: "important", created_at: NOW.toISOString(), pushed_at: null },
      { id: "a2", owner_id: OWNER, ref_id: "f2", status: "open", importance: "urgent", created_at: new Date(NOW.getTime() + 1000).toISOString(), pushed_at: null },
      { id: "a3", owner_id: OWNER, ref_id: "f3", status: "open", importance: "briefing", created_at: new Date(NOW.getTime() + 2000).toISOString(), pushed_at: null },
    ]);
    const adjusted = await runner.applyNotificationPolicy(OWNER, capped, ["f1", "f2", "f3"], NOW);
    expect(adjusted).toBe(2); // 3 alerts today vs cap 1 → the 2 newest become informational and sit below the push floor
    const byId = Object.fromEntries(db.rows("alerts").map((a) => [a.id, a]));
    expect(byId.a1!.importance).toBe("important");
    expect(byId.a1!.pushed_at).toBeNull(); // the one within the cap still pushes normally
    expect(byId.a2!.importance).toBe("informational");
    expect(byId.a3!.importance).toBe("informational");
    expect(byId.a2!.pushed_at).toBe(NOW.toISOString()); // stored, never pushed
    expect(byId.a3!.pushed_at).toBe(NOW.toISOString());

    // push=false: everything is marked pushed so the push loop skips it.
    db.rows("alerts").forEach((a) => Object.assign(a, { pushed_at: null, importance: "important" }));
    await runner.applyNotificationPolicy(OWNER, { ...job, notification_policy: { min_importance: "important", push: false, briefing_only: false, max_per_day: 50 } }, ["f1", "f2", "f3"], NOW);
    expect(db.rows("alerts").every((a) => a.pushed_at === NOW.toISOString())).toBe(true);

    // briefing_only caps importance at briefing.
    db.rows("alerts").forEach((a) => Object.assign(a, { pushed_at: null, importance: "urgent" }));
    await runner.applyNotificationPolicy(OWNER, { ...job, notification_policy: { min_importance: "informational", push: true, briefing_only: true, max_per_day: 50 } }, ["f1", "f2", "f3"], NOW);
    expect(db.rows("alerts").every((a) => a.importance === "briefing")).toBe(true);
  });
  it("delegates the Blind Spot Scanner to its own lifecycle with progress and never re-runs alerts for it", async () => {
    const job = await seededJob("blind-spot-scanner");
    const out = await runner.runJob(OWNER, job, { mode: "run", now: NOW });
    expect(runBlindSpotsForOwner).toHaveBeenCalledWith(OWNER, NOW, expect.objectContaining({ force: true, onProgress: expect.any(Function) }));
    expect(out.status).toBe("succeeded");
    expect(out.notes.join(" ")).toMatch(/Blind Spot Scanner: 0 candidates/);
    expect(alerts).not.toHaveBeenCalled();
    // zero result is a valid, non-failing outcome
    expect(out.stats.findings_created).toBe(0);
    expect(db.rows("job_runs")[0]!.status).toBe("succeeded");
  });
});

describe("runJob — partial coverage", () => {
  it("skips detectors whose sources are missing, marks the run partial, and explains why", async () => {
    seedStripeTrouble();
    freshness = freshness.filter((f) => f.provider !== "plaid"); // plaid missing
    const job = await seededJob("cash-flow-watchdog"); // stripe + plaid
    const out = await runner.runJob(OWNER, job, { mode: "test", now: NOW });
    expect(out.status).toBe("partial");
    expect(out.coverage).toEqual(expect.arrayContaining([{ source: "plaid", status: "missing", freshness: "not connected" }]));
    expect(out.notes.join("\n")).toMatch(/Financial Accounts is not connected/);
    expect(out.notes.join("\n")).toMatch(/skipped/);
    // Cash-flow detectors need plaid → skipped; nothing concluded from missing data.
    expect(out.results.map((r) => r.category)).not.toContain("cashflow_change");
    expect(db.rows("job_runs")[0]!.status).toBe("partial");
  });
  it("a provider sync error is treated like missing data, not as evidence", async () => {
    freshness = freshness.map((f) => (f.provider === "stripe" ? fresh("stripe", "error", "error") : f));
    const job = await seededJob("revenue-leakage-hunter");
    const out = await runner.runJob(OWNER, job, { mode: "test", now: NOW });
    expect(out.coverage.find((c) => c.source === "stripe")).toMatchObject({ source: "stripe", status: "error" });
    expect(out.status).toBe("partial");
    expect(out.results).toEqual([]);
  });
});

describe("job-scoped rules (target_job)", () => {
  it("a rule scoped to one job excludes rows there and nowhere else", async () => {
    seedStripeTrouble();
    const job = await seededJob("revenue-leakage-hunter");
    rules = [rule({ name: "Ignore invoices in leakage hunter", target_job: "revenue-leakage-hunter", target_monitor: "failed_payment", conditions: { source_type: "invoice" }, action: { type: "exclude" } })];
    const scoped = await runner.runJob(OWNER, job, { mode: "test", now: NOW });
    // The invoice from acme.com is excluded; only the failed charge remains, still enough for a finding.
    const r = scoped.results.find((x) => x.category === "failed_payment");
    expect(r?.evidence_count).toBe(1);
    expect(scoped.stats.rules_matched).toBe(1);

    const other = await seededJob("cash-flow-watchdog");
    const unscoped = await runner.runJob(OWNER, other, { mode: "test", now: NOW });
    expect(unscoped.stats.rules_matched).toBe(0);
  });
  it("rulesForJob keeps global rules and drops other jobs' rules", () => {
    const all = [rule({ name: "global" }), rule({ name: "mine", target_job: "a" }), rule({ name: "theirs", target_job: "b" }), rule({ name: "off", enabled: false })];
    expect(runner.rulesForJob(all, "a").map((r) => r.name)).toEqual(["global", "mine"]);
  });
  it("the global monitor run ignores job-scoped rules", async () => {
    seedStripeTrouble();
    rules = [rule({ name: "scoped", target_job: "revenue-leakage-hunter", conditions: { provider: "stripe" }, action: { type: "exclude" } })];
    const { runMonitorsForOwner } = await import("@/lib/gomez/monitors");
    const summary = await runMonitorsForOwner(OWNER, NOW);
    expect(summary.created).toBeGreaterThanOrEqual(1);
    expect(db.rows("findings").some((f) => f.fingerprint === "failed_payment:stripe:open" && f.job_id == null)).toBe(true);
  });
});

describe("scheduling helpers", () => {
  it("runDueJobs runs only due jobs and respects the budget; triggerJobsForEvent runs event-driven jobs for that provider", async () => {
    await store.seedSystemJobs(OWNER, NOW);
    const jobs = await store.listJobs(OWNER);
    // Nothing is due yet (all next_run_at are in the future).
    expect(await runner.runDueJobs(OWNER, jobs, NOW, 60_000)).toEqual({ ran: [], skipped: [] });
    const due = jobs.map((j) => (j.slug === "expense-creep-hunter" ? { ...j, next_run_at: daysAgo(1) } : j));
    const res = await runner.runDueJobs(OWNER, due, NOW, 60_000);
    expect(res.ran).toEqual(["expense-creep-hunter"]);
    expect(db.rows("job_runs").map((r) => r.mode)).toEqual(["scheduled"]);
    // Budget exhausted → skipped, not run.
    const tight = await runner.runDueJobs(OWNER, due, NOW, -1);
    expect(tight.skipped).toEqual(["expense-creep-hunter"]);

    const fired = await runner.triggerJobsForEvent(OWNER, jobs, "stripe", NOW);
    const expected = jobs.filter((j) => j.status === "active" && (j.schedule_type === "event_driven" || j.config.event_triggers === true) && j.sources.includes("stripe")).map((j) => j.slug);
    expect(fired).toEqual(expected);
    expect(await runner.triggerJobsForEvent(OWNER, jobs, "nonexistent", NOW)).toEqual([]);
  });
});

describe("store guards", () => {
  it("refuses to delete system jobs; user jobs can be created, updated and deleted", async () => {
    await store.seedSystemJobs(OWNER, NOW);
    expect(await store.deleteJob(OWNER, "blind-spot-scanner")).toEqual({ ok: false, reason: "system_jobs_cannot_be_deleted" });
    const created = await store.createJob(OWNER, { slug: "my-job", name: "My job", job_type: "user", schedule_type: "weekly", schedule_expression: "fri 07:05", sources: ["stripe"], detectors: ["failed_payment"] }, { createdBy: "owner", now: NOW });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.job.next_run_at).toBe("2026-09-18T13:05:00.000Z");
    const upd = await store.updateJob(OWNER, "my-job", { status: "paused" });
    expect(upd.ok && upd.changed).toEqual(["status"]);
    expect(upd.ok && upd.job.next_run_at).toBeNull();
    expect(await store.updateJob(OWNER, "my-job", { slug: "nope" })).toMatchObject({ ok: false });
    expect(await store.deleteJob(OWNER, "my-job")).toEqual({ ok: true });
  });
});
