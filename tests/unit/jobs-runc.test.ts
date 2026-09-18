import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "../fake-db";
import { fakeSupabase, OWNER_ID, req, type Claims } from "../helpers";
import type { ProviderFreshness } from "@/lib/gomez/freshness";
import type { BlindSpotCandidate } from "@/lib/gomez/blindspots/types";
import { assessNovelty, daysUntil, findOverlaps, rankScore, titleTokens, worsenedKeys, EMPTY_RESULT_MESSAGE, THEME_OF } from "@/lib/gomez/blindspots/novelty";
import { applyNovelty } from "@/lib/gomez/blindspots/index";
import { toFinding } from "@/lib/gomez/blindspots/detect";
import { unresolvedCostlyObligation } from "@/lib/gomez/blindspots/detectors/unresolved-costly-obligation";
import { filterAlreadyCovered, proposeLearnings, type LearningSignal } from "@/lib/gomez/jobs/learning";
import { computeMetrics, type MetricsInputs } from "@/lib/gomez/jobs/metrics";
import { bestMatch, scoreMatches, stem, tokens } from "@/lib/gomez/obligations/match";
import { JOB_DEFAULT_RULES } from "@/lib/gomez/jobs/default-rules";
import { isoWeek } from "@/lib/gomez/jobs/runner";

const OWNER = OWNER_ID;
const NOW = new Date("2026-09-12T18:00:00Z"); // Saturday 12:00 Denver
const DAY = 86_400_000;
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

let db = new FakeDb();
let claims: Claims = null;
let freshness: ProviderFreshness[] = [];
const audit = vi.fn(async () => {});
const alerts = vi.fn(async () => ({ created: 0 }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.client() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase(claims) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/gomez/settings-store", () => ({ getSettings: async () => ({ timezone: "America/Denver", jobs_auto_create_safe: true }) }));
vi.mock("@/lib/gomez/freshness-store", () => ({ loadFreshness: async () => freshness }));
vi.mock("@/lib/gomez/alerts/store", () => ({ runAlertsForOwner: (...a: unknown[]) => alerts(...(a as [])) }));
vi.mock("@/lib/gomez/goals/refresh", () => ({ refreshGoals: async () => [] }));
vi.mock("@/lib/gomez/goals/store", () => ({ latestSnapshot: async () => null, listGoals: async () => [], listGoalMetrics: async () => [], listRecommendations: async () => [] }));
vi.mock("@/lib/integrations/store", () => ({ listConnections: async () => [{ provider: "stripe", status: "connected" }, { provider: "portal", status: "connected" }] }));
vi.mock("@/lib/gomez/monitors", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/gomez/monitors")>();
  return { ...mod };
});

const store = await import("@/lib/gomez/jobs/store");
const runner = await import("@/lib/gomez/jobs/runner");
const rulesStore = await import("@/lib/gomez/rules/store");
const learningStore = await import("@/lib/gomez/jobs/learning-store");
const metricsStore = await import("@/lib/gomez/jobs/metrics");
const metricsRoute = await import("@/app/api/jobs/metrics/route");
const { inferNarrowRule } = await import("@/lib/gomez/rules/feedback");
const { ensureJobDefaultRules } = await import("@/lib/gomez/jobs/default-rules");

function fresh(provider: string): ProviderFreshness {
  return { provider, connection_id: `c-${provider}`, display_name: provider, status: "connected", level: "fresh", age_hours: 1, last_success_at: ago(0), last_error: null, text: `${provider} fresh` } as ProviderFreshness;
}

function candidate(p: Partial<BlindSpotCandidate> & { fingerprint: string }): BlindSpotCandidate {
  return { subtype: "quiet_client", ref: "c1", title: "Acme Roofing has gone quiet", observed_facts: [], metrics: {}, interpretation: "i", attention: "a", evidence: [], range_start: null, range_end: null, confidence: 0.7, limitations: "", impact: "client", ...p };
}

beforeEach(() => {
  db = new FakeDb();
  claims = null;
  freshness = ["stripe", "plaid", "highlevel", "google", "meta", "portal", "slack", "n8n", "notion", "github"].map(fresh);
  audit.mockClear();
  alerts.mockClear();
});

/* ------------------------------------------------------------------ */
/* §84 novelty · §51 ranking · §85 zero result                         */
/* ------------------------------------------------------------------ */

describe("§84 novelty", () => {
  it("title tokens ignore stop-words and numbers; overlap is by ref, evidence or title", () => {
    expect([...titleTokens("Acme Roofing has gone quiet for 23 days")]).toEqual(["acme", "roof"]);
    const c = candidate({ fingerprint: "a", evidence: [{ source_item_id: "s1", provider: "portal", external_id: "x", url: null, title: "t" }] });
    expect(findOverlaps(c, [{ kind: "finding", id: "f", title: "Totally different", ref: "c1", status: "open" }]).map((k) => k.id)).toEqual(["f"]);
    expect(findOverlaps(c, [{ kind: "alert", id: "a", title: "Nothing alike", status: "open", evidence_ids: ["s1"] }]).map((k) => k.id)).toEqual(["a"]);
    expect(findOverlaps(c, [{ kind: "briefing_item", id: "b", title: "Acme Roofing quiet — check in" }]).map((k) => k.id)).toEqual(["b"]);
    expect(findOverlaps(c, [{ kind: "finding", id: "r", title: "Acme Roofing quiet", ref: "c1", status: "resolved" }])).toEqual([]);
    expect(findOverlaps(c, [{ kind: "finding", id: "bs", title: "Acme Roofing quiet", category: "blind_spot", status: "open" }])).toEqual([]);
  });
  it("a first-time candidate is novel unless another surface already shows it (except with an urgent deadline)", () => {
    const c = candidate({ fingerprint: "a" });
    const inputs = { known: [{ kind: "obligation" as const, id: "o1", title: "Check in with Acme Roofing", status: "open" }], prior: new Map() };
    const v = assessNovelty(c, "medium", inputs, NOW);
    expect(v).toMatchObject({ novel: false, score: 0.15, exception: null, repeat: false });
    expect(v.reason).toMatch(/Already visible as obligation/);
    expect(assessNovelty(c, "medium", { known: [], prior: new Map() }, NOW)).toMatchObject({ novel: true, score: 1, reason: "Not surfaced anywhere else." });
    const urgent = candidate({ fingerprint: "u", metrics: { days_until: 2 } });
    expect(assessNovelty(urgent, "medium", inputs, NOW)).toMatchObject({ novel: true, exception: "urgent_deadline" });
  });
  it("repeats are allowed only for the §47 exceptions and each is recorded", () => {
    const prior = (p: Partial<{ status: string; severity: string; metrics: Record<string, unknown>; evidence_ids: string[]; feedback: string | null }>) => new Map([["a", { fingerprint: "a", status: "dismissed", severity: "medium", metrics: { days_quiet: 20 }, evidence_ids: ["s1"], updated_at: ago(7), feedback: "not_useful", ...p }]]);
    const base = candidate({ fingerprint: "a", metrics: { days_quiet: 20 }, evidence: [{ source_item_id: "s1", provider: "portal", external_id: "x", url: null, title: "t" }] });
    // Unchanged after a dismissal → not novel, score 0.
    expect(assessNovelty(base, "medium", { known: [], prior: prior({}) }, NOW)).toMatchObject({ novel: false, score: 0, repeat: true });
    // Worsened ≥25% after being set aside → "ignored recommendation with consequence".
    expect(assessNovelty({ ...base, metrics: { days_quiet: 40 } }, "medium", { known: [], prior: prior({}) }, NOW)).toMatchObject({ novel: true, exception: "ignored_recommendation", score: 1 });
    // Severity change on an open one.
    expect(assessNovelty(base, "high", { known: [], prior: prior({ status: "open", feedback: null }) }, NOW)).toMatchObject({ novel: true, exception: "severity_changed" });
    // Worsened on an open one.
    expect(assessNovelty({ ...base, metrics: { days_quiet: 30 } }, "medium", { known: [], prior: prior({ status: "open", feedback: null }) }, NOW)).toMatchObject({ exception: "worsened" });
    // New evidence.
    expect(assessNovelty({ ...base, evidence: [{ source_item_id: "s2", provider: "portal", external_id: "y", url: null, title: "t" }] }, "medium", { known: [], prior: prior({ status: "open", feedback: null }) }, NOW)).toMatchObject({ exception: "new_evidence" });
    // Urgent deadline that was not urgent before.
    expect(assessNovelty({ ...base, metrics: { days_quiet: 20, days_until: 1 } }, "medium", { known: [], prior: prior({ status: "open", feedback: null, metrics: { days_quiet: 20, days_until: 9 } }) }, NOW)).toMatchObject({ exception: "urgent_deadline" });
    // Resolved earlier and back again → novel recurrence.
    expect(assessNovelty(base, "medium", { known: [], prior: prior({ status: "resolved", feedback: null }) }, NOW)).toMatchObject({ novel: true, score: 0.9 });
    expect(worsenedKeys({ overdue_days: 10, threshold_days: 99 }, { overdue_days: 8, threshold_days: 1 })).toEqual(["overdue_days"]);
    expect(daysUntil({ due_at: ago(-3) }, NOW)).toBe(3);
  });
  it("§51 ranking is deterministic: impact × urgency × confidence × novelty × goal relevance × financial exposure × rules", () => {
    const plain = candidate({ fingerprint: "p", confidence: 0.8, impact: "client" });
    expect(rankScore(plain)).toBe(0.72);
    expect(rankScore(plain, NOW)).toBe(Math.round(0.8 * 0.9 * 0.8 * 1 * 0.85 * 1 * 1000) / 1000);
    const money = candidate({ fingerprint: "m", confidence: 0.8, impact: "financial", metrics: { amount_minor: 1_000_000, days_until: 2, goal_id: "g" } });
    expect(rankScore(money, NOW, { novelty: 0.5 })).toBe(Math.round(0.8 * 1 * 1 * 0.5 * 1 * 1.5 * 1000) / 1000);
    expect(rankScore(money, NOW, { ruleBoost: 1.2 })).toBeGreaterThan(rankScore(money, NOW));
    const ranked = applyNovelty([plain, money], { known: [], prior: new Map() }, NOW);
    expect(ranked.kept.map((k) => k.c.fingerprint)).toEqual(["m", "p"]);
    expect(ranked.kept[0]!.rank).toBeGreaterThan(ranked.kept[1]!.rank);
  });
  it("applyNovelty drops non-novel first-timers, keeps still-active repeats so they can clear, and toFinding records novelty + theme", () => {
    const seen = candidate({ fingerprint: "seen" });
    const active = candidate({ fingerprint: "active", ref: "c9", title: "Something else entirely" });
    const known = [{ kind: "mission" as const, id: "m1", title: "Check in with Acme Roofing", status: "queued" }];
    const prior = new Map([["active", { fingerprint: "active", status: "open", severity: "medium", metrics: {}, evidence_ids: [], updated_at: ago(1), feedback: null }]]);
    const res = applyNovelty([seen, active], { known, prior }, NOW);
    expect(res.suppressed).toBe(1);
    expect(res.kept.map((k) => k.c.fingerprint)).toEqual(["active"]);
    const f = toFinding(active, { novelty: res.kept[0]!.novelty, rank: res.kept[0]!.rank });
    expect(f.metrics).toMatchObject({ theme: "neglect", subtype: "quiet_client", novelty: { novel: false, reason: "Already surfaced; nothing has changed since." } });
    expect(THEME_OF.unresolved_costly_obligation).toBe("unresolved_obligation");
  });
  it("§85 zero result: when nothing survives novelty the run reports the exact owner line and creates nothing", async () => {
    // Everything the scanner could find is already an open obligation → the runner's TEST path notes the §49 line.
    const { runJob } = runner;
    await store.seedSystemJobs(OWNER, NOW);
    const job = (await store.getJob(OWNER, "blind-spot-scanner"))!;
    const out = await runJob(OWNER, job, { mode: "test", now: NOW });
    expect(out.results).toEqual([]);
    expect(out.notes).toContain(EMPTY_RESULT_MESSAGE);
    expect(db.rows("findings")).toHaveLength(0);
    expect(db.rows("alerts")).toHaveLength(0);
  });
});

describe("unresolved_costly_obligation", () => {
  const charge = (d: number) => ({ id: `tx${d}`, provider: "plaid", capability: null, resource_type: "transaction", external_id: `tx${d}`, title: "Calendly", summary: null, author: null, source_url: null, source_timestamp: ago(d), tags: [], metadata: { amount: 1_600, direction: "outflow", merchant_key: "calendly", merchant_name: "Calendly", currency: "usd" } });
  const ctx = (obligations: { title: string; reminder_count: number; status?: string }[]) => ({ now: NOW, ownerEmail: null, sourceItems: [charge(80), charge(50), charge(20)], findings: [], alerts: [], goals: [], clients: [], connections: [], attention: [], commitments: [], obligations: obligations.map((o, i) => ({ id: `o${i}`, title: o.title, status: o.status ?? "overdue", scope: "business", priority: "medium", due_at: ago(5), reminder_count: o.reminder_count, updated_at: ago(1), counterparty: null, metadata: {} })) });
  it("flags an obligation reminded ≥3 times that names a merchant whose next charge is within 14 days", () => {
    const out = unresolvedCostlyObligation.run(ctx([{ title: "Cancel the Calendly subscription", reminder_count: 3 }]));
    expect(out).toHaveLength(1);
    expect(out[0]!.metrics).toMatchObject({ reminders: 3, merchant: "calendly", next_charge_minor: 1_600, days_until: 10, consequence_minor: 1_600 });
  });
  it("stays silent below 3 reminders, when completed, or when no charge matches", () => {
    expect(unresolvedCostlyObligation.run(ctx([{ title: "Cancel the Calendly subscription", reminder_count: 2 }]))).toHaveLength(0);
    expect(unresolvedCostlyObligation.run(ctx([{ title: "Cancel the Calendly subscription", reminder_count: 5, status: "completed" }]))).toHaveLength(0);
    expect(unresolvedCostlyObligation.run(ctx([{ title: "Send Brian the proposal", reminder_count: 5 }]))).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* §64 learning                                                        */
/* ------------------------------------------------------------------ */

describe("§64 job learning", () => {
  const sig = (p: Partial<LearningSignal> & { at: string }): LearningSignal => ({ kind: "finding_set_aside", job_slug: "client-health-analyst", subtype: "client_negative_signal", title: "Acme: negative language", ...p });
  it("three set-asides of the same job + subtype within 14 days become one pending Tier-2 proposal with a one-liner", () => {
    const proposals = proposeLearnings([sig({ at: ago(1) }), sig({ at: ago(5), title: "Beta: negative language" }), sig({ at: ago(13) })], NOW);
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p).toMatchObject({ job_slug: "client-health-analyst", subtype: "client_negative_signal", count: 3 });
    expect(p.rule).toMatchObject({ target_job: "client-health-analyst", conditions: { category: "client_negative_signal" }, action: { type: "suppress_alert" }, enabled: false });
    expect(p.rule.name).toMatch(/^Learned:/);
    expect(p.suggestion).toMatch(/3 "client negative signal" findings in 14 days/);
    // Two in the window plus one outside it is not enough.
    expect(proposeLearnings([sig({ at: ago(1) }), sig({ at: ago(5) }), sig({ at: ago(20) })], NOW)).toHaveLength(0);
  });
  it("personal errands snoozed/dismissed ≥3 times propose 'briefing only' for personal obligations", () => {
    const s = (i: number, kind: LearningSignal["kind"]) => sig({ kind, job_slug: "follow-through-watchdog", subtype: "personal", title: `Errand ${i}`, at: ago(i) });
    const [p] = proposeLearnings([s(1, "obligation_snoozed"), s(2, "obligation_dismissed"), s(3, "obligation_snoozed")], NOW);
    expect(p).toMatchObject({ subtype: "personal_errands", count: 3 });
    expect(p!.rule).toMatchObject({ target_monitor: "follow_through", conditions: { tags_any: ["personal"] }, action: { type: "briefing_only" } });
    expect(p!.suggestion).toMatch(/personal errands only in the daily brief/);
  });
  it("explicit feedback outranks proposals: an enabled rule on the same target, or the same proposal already on file, blocks it", () => {
    const [p] = proposeLearnings([sig({ at: ago(1) }), sig({ at: ago(2) }), sig({ at: ago(3) })], NOW);
    const base = { enabled: true, pending_confirmation: false, target_monitor: null, target_job: null, conditions: {} };
    expect(filterAlreadyCovered([p!], [{ ...base, name: "owner rule", conditions: { category: "client_negative_signal" } }])).toEqual([]);
    expect(filterAlreadyCovered([p!], [{ ...base, name: p!.rule.name, enabled: false, pending_confirmation: true }])).toEqual([]);
    expect(filterAlreadyCovered([p!], [{ ...base, name: "unrelated", conditions: { category: "failed_payment" } }])).toHaveLength(1);
  });
  it("runJobLearning turns finding feedback + obligation events into a pending rule once, audited as rule_proposed", async () => {
    await store.seedSystemJobs(OWNER, NOW);
    const job = (await store.getJob(OWNER, "client-health-analyst"))!;
    db.seed("findings", [1, 2, 3].map((i) => ({ id: `f${i}`, owner_id: OWNER, category: "client_negative_signal", title: `Client ${i}: negative language`, job_id: job.id, status: "dismissed", is_sample: false })));
    db.seed("finding_feedback", [1, 2, 3].map((i) => ({ owner_id: OWNER, finding_id: `f${i}`, verdict: "not_useful", job_id: job.id, created_at: ago(i) })));
    const first = await learningStore.runJobLearning(OWNER, NOW);
    expect(first).toMatchObject({ signals: 3, proposals: 1 });
    expect(first.created).toEqual(["Learned: Client Health Analyst — keep \"client negative signal\" out of alerts"]);
    const rule = db.rows("operating_rules")[0]!;
    expect(rule).toMatchObject({ pending_confirmation: true, enabled: false, target_job: "client-health-analyst", created_by: "gomez", source: "feedback" });
    expect(rule.source_quote).toMatch(/should I stop alerting/);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: "rule_proposed" }));
    // Idempotent: nothing new on the next run, and the suggestion is visible to Ask Gomez / the brief.
    expect((await learningStore.runJobLearning(OWNER, NOW)).created).toEqual([]);
    const suggestions = await learningStore.listPendingSuggestions(OWNER);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.job_slug).toBe("client-health-analyst");
  });
});

/* ------------------------------------------------------------------ */
/* §55 metrics                                                         */
/* ------------------------------------------------------------------ */

describe("§55 jobs metrics", () => {
  const inputs = (): MetricsInputs => ({
    now: NOW,
    windowDays: 30,
    jobs: [
      { id: "j1", slug: "revenue-leakage-hunter", name: "Revenue Leakage Hunter", status: "active" },
      { id: "j2", slug: "blind-spot-scanner", name: "Blind Spot Scanner", status: "active" },
    ],
    runs: [
      { job_id: "j1", mode: "scheduled", status: "succeeded", started_at: ago(1), created_at: ago(1), duration_ms: 1000, stats: { duplicates_suppressed: 2, ai_calls: 0 } },
      { job_id: "j1", mode: "run", status: "partial", started_at: ago(2), created_at: ago(2), duration_ms: 3000, stats: { duplicates_suppressed: 1 } },
      { job_id: "j1", mode: "test", status: "succeeded", started_at: ago(3), created_at: ago(3), duration_ms: 500, stats: {} },
      { job_id: "j2", mode: "scheduled", status: "failed", started_at: ago(4), created_at: ago(4), duration_ms: null, stats: { ai_calls: 1 } },
    ],
    usage: [{ feature: "job:blind-spot-scanner", estimated_usd: "0.0123" }, { feature: "job:blind-spot-scanner", estimated_usd: 0.01 }, { feature: "chat", estimated_usd: 9 }],
    findings: [{ job_id: "j1", created_at: ago(1) }, { job_id: "j1", created_at: ago(2) }, { job_id: "j2", created_at: ago(4) }, { job_id: null, created_at: ago(1) }],
    feedback: [{ job_id: "j1", finding_id: "a", verdict: "useful" }, { job_id: "j1", finding_id: "b", verdict: "wrong" }, { job_id: "j1", finding_id: "b", verdict: "not_useful" }],
    obligations: [
      { status: "open", due_at: ago(-2), completed_at: null, dismissed_at: null, metadata: {} },
      { status: "overdue", due_at: ago(3), completed_at: null, dismissed_at: null, metadata: {} },
      { status: "snoozed", due_at: ago(3), completed_at: null, dismissed_at: null, metadata: {} },
      { status: "completed", due_at: null, completed_at: ago(5), dismissed_at: null, metadata: {} },
      { status: "dismissed", due_at: null, completed_at: null, dismissed_at: ago(40), metadata: {} },
    ],
    obligationEvents: [{ kind: "reminded", created_at: ago(1) }, { kind: "reminded", created_at: ago(2) }, { kind: "auto_completed", created_at: ago(5) }, { kind: "reminded", created_at: ago(45) }],
    pendingProposals: 1,
  });
  it("computeMetrics aggregates runs/day, outcomes, AI cost by job tag, findings, feedback, false-positive rate and Follow-Through", () => {
    const m = computeMetrics(inputs());
    expect(m.totals).toMatchObject({ runs: 3, runs_per_day: 0.1, succeeded: 1, partial: 1, failed: 1, ai_calls: 2, ai_cost_usd: 0.0223, findings_created: 3, findings_suppressed: 3, feedback: 3, false_positive_rate: 0.5, pending_proposals: 1 });
    const leak = m.jobs.find((j) => j.slug === "revenue-leakage-hunter")!;
    expect(leak).toMatchObject({ runs: 2, succeeded: 1, partial: 1, failed: 0, avg_duration_ms: 2000, findings_created: 2, findings_suppressed: 3, feedback: { useful: 1, wrong: 1, not_useful: 1 }, false_positive_rate: 0.5, ai_calls: 0, ai_cost_usd: 0 });
    expect(leak.last_run_at).toBe(ago(1));
    const scan = m.jobs.find((j) => j.slug === "blind-spot-scanner")!;
    expect(scan).toMatchObject({ runs: 1, failed: 1, ai_calls: 2, ai_cost_usd: 0.0223, false_positive_rate: null });
    expect(m.follow_through).toEqual({ open: 3, overdue: 1, waiting_on_other: 0, snoozed: 1, possibly_complete: 0, completed_30d: 1, auto_completed_30d: 1, dismissed_30d: 0, reminders_30d: 2, reminders_per_day: 0.07 });
  });
  it("GET /api/jobs/metrics requires the owner and returns the read model with a clamped window", async () => {
    expect((await metricsRoute.GET(req("/api/jobs/metrics"), { params: Promise.resolve({}) })).status).toBe(401);
    claims = { sub: OWNER, email: "noah@bizgrips.com", aal: "aal2" };
    await store.seedSystemJobs(OWNER, NOW);
    const res = await metricsRoute.GET(req("/api/jobs/metrics?days=400"), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metrics: { window_days: number; jobs: unknown[]; totals: Record<string, unknown>; follow_through: Record<string, unknown> } };
    expect(body.metrics.window_days).toBe(90);
    expect(body.metrics.jobs).toHaveLength(13);
    expect(Object.keys(body.metrics.totals)).toEqual(expect.arrayContaining(["runs_per_day", "ai_cost_usd", "false_positive_rate", "pending_proposals"]));
    expect(body.metrics.follow_through).toHaveProperty("reminders_per_day");
    const direct = await metricsStore.loadJobsMetrics(OWNER, NOW);
    expect(direct.window_days).toBe(30);
  });
});

/* ------------------------------------------------------------------ */
/* §86 rule feedback through the job runner · default rules            */
/* ------------------------------------------------------------------ */

describe("§86 rule feedback through the job runner", () => {
  function seedStripeTrouble() {
    db.seed("source_items", [
      { owner_id: OWNER, is_sample: false, provider: "stripe", capability: null, resource_type: "invoice", external_id: "in_1", title: "Invoice A-1", summary: null, author: "acme.com", source_url: null, source_timestamp: ago(3), tags: [], metadata: { status: "open", amount_due: 60000, amount_remaining: 60000, due_date: ago(3), number: "A-1", currency: "usd" } },
      { owner_id: OWNER, is_sample: false, provider: "stripe", capability: null, resource_type: "charge", external_id: "ch_1", title: "Charge", summary: null, author: null, source_url: null, source_timestamp: ago(2), tags: [], metadata: { status: "failed", amount: 2500, currency: "usd", failure_code: "card_declined" } },
    ]);
  }
  it("'Don't show this again' on a job finding creates a narrow rule scoped to that job; the next run suppresses it there and nowhere else", async () => {
    seedStripeTrouble();
    await store.seedSystemJobs(OWNER, NOW);
    const job = (await store.getJob(OWNER, "revenue-leakage-hunter"))!;
    const first = await runner.runJob(OWNER, job, { mode: "run", now: NOW });
    expect(first.stats.findings_created).toBeGreaterThanOrEqual(1);
    const finding = db.rows("findings").find((f) => f.fingerprint === "failed_payment:stripe:open")!;
    // Feedback: infer the narrowest rule from the finding's own evidence, scoped to the job (what the feedback route does).
    const evidenceRow = db.rows("source_items").find((r) => r.external_id === "ch_1")!;
    const inferred = inferNarrowRule({ id: finding.id as string, category: "failed_payment", title: finding.title as string, evidence: finding.evidence as never, metrics: finding.metrics as Record<string, unknown> }, evidenceRow as never);
    expect(inferred).not.toBeNull();
    const created = await rulesStore.createRule(OWNER, { ...inferred!, target_job: job.slug }, { source: "feedback", createdBy: "owner", pendingConfirmation: false });
    expect(created.ok).toBe(true);
    const second = await runner.runJob(OWNER, job, { mode: "run", now: new Date(NOW.getTime() + 3_600_000) });
    expect(second.stats.rules_matched).toBeGreaterThanOrEqual(1);
    expect(db.rows("findings").find((f) => f.fingerprint === "failed_payment:stripe:open")!.status).toBe("resolved");
    // The same rule does not touch another job's run of the same detector.
    const cash = (await store.getJob(OWNER, "cash-flow-watchdog"))!;
    const other = await runner.runJob(OWNER, cash, { mode: "test", now: NOW });
    expect(other.stats.rules_matched).toBe(0);
    expect(other.results.some((r) => r.category === "failed_payment")).toBe(true);
  });
  it("per-job default rules are seeded once with target_job, visible in RULES, and never re-created after deletion", async () => {
    await store.seedSystemJobs(OWNER, NOW);
    const jobs = await store.listJobs(OWNER);
    const first = await ensureJobDefaultRules(OWNER, jobs);
    expect(first.created).toBe(JOB_DEFAULT_RULES.length);
    const rules = db.rows("operating_rules");
    expect(rules.every((r) => typeof r.target_job === "string" && r.created_by === "gomez" && r.source === "settings" && r.pending_confirmation === false)).toBe(true);
    expect(rules.find((r) => r.target_job === "relationship-radar" && String(r.name).includes("LinkedIn"))).toBeDefined();
    // Owner deletes one; re-seeding does not bring it back.
    const victim = rules.find((r) => r.target_job === "expense-creep-hunter")!;
    await rulesStore.deleteRule(OWNER, victim.id as string);
    const again = await ensureJobDefaultRules(OWNER, await store.listJobs(OWNER));
    expect(again.created).toBe(0);
    expect(db.rows("operating_rules").some((r) => r.target_job === "expense-creep-hunter")).toBe(false);
  });
  it("Goal Coach fingerprints are one per goal per ISO week", () => {
    expect(isoWeek(new Date("2026-09-12T18:00:00Z"))).toBe("2026-W37");
    expect(isoWeek(new Date("2026-09-14T00:00:00Z"))).toBe("2026-W38");
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });
});

/* ------------------------------------------------------------------ */
/* Ask Gomez fuzzy obligation matching                                  */
/* ------------------------------------------------------------------ */

describe("Ask Gomez fuzzy obligation matching", () => {
  const rows = [
    { id: "1", title: "Cancel Calendly subscription", counterparty: null, description: null },
    { id: "2", title: "Dentist appointment — book cleaning", counterparty: "Dr. Lee", description: null },
    { id: "3", title: "Send Brian the proposal", counterparty: "Brian", description: "Roofing estimate follow-up" },
    { id: "4", title: "Send Brian the invoice", counterparty: "Brian", description: null },
  ];
  it("stems and prefix-matches title words so natural phrasings resolve", () => {
    expect(stem("cancellation")).toBe("cancel");
    expect(tokens("Snooze the Calendly cancellation until Monday")).toEqual(["calendly", "cancel", "monday"]);
    expect(bestMatch("snooze the Calendly cancellation until Monday", rows)).toMatchObject({ ok: true, item: { id: "1" } });
    expect(bestMatch("mark the dentist thing done", rows)).toMatchObject({ ok: true, item: { id: "2" } });
    expect(bestMatch("Brian's roofing estimate", rows)).toMatchObject({ ok: true, item: { id: "3" } });
  });
  it("reports ambiguity when two rows tie, and no match when nothing overlaps", () => {
    const amb = bestMatch("the Brian thing", rows);
    expect(amb).toMatchObject({ ok: false, error: "ambiguous_match" });
    expect((amb as { candidates: { id: string }[] }).candidates.map((c) => c.id)).toEqual(["4", "3"]);
    expect(bestMatch("water the plants", rows)).toEqual({ ok: false, error: "no_matching_obligation" });
    expect(scoreMatches("invoice", rows).map((s) => s.item.id)).toEqual(["4"]);
  });
});
