import { describe, expect, it } from "vitest";
import { computeMetric, evaluateFormula, formatMetricValue, formatTarget, pairDurations, type ConnectionFreshness, type MetricRow } from "@/lib/jeff/goals/metrics";
import { computeTrajectory } from "@/lib/jeff/goals/trajectory";
import { recommendForGoal } from "@/lib/jeff/goals/recommend";
import { GoalMetricSchema, type GoalMetric } from "@/lib/jeff/goals/schema";

const NOW = new Date("2026-09-30T12:00:00Z");
const WINDOW = { start: "2026-09-01T00:00:00Z", end: "2026-10-31T00:00:00Z" };
const CONNECTED: ConnectionFreshness[] = [
  { provider: "highlevel", status: "connected", last_sync_at: "2026-09-30T11:00:00Z" },
  { provider: "stripe", status: "connected", last_sync_at: "2026-09-30T11:00:00Z" },
];

function row(p: Partial<MetricRow> & { provider: string; resource_type: string; external_id: string }): MetricRow {
  return { id: `id-${p.external_id}`, capability: null, title: null, source_timestamp: "2026-09-15T00:00:00Z", synced_at: "2026-09-30T11:00:00Z", tags: [], metadata: {}, ...p };
}

const rows: MetricRow[] = [
  row({ provider: "highlevel", resource_type: "opportunity", external_id: "o1", metadata: { status: "won", contactId: "c1", lastStatusChangeAt: "2026-09-05T00:00:00Z" } }),
  row({ provider: "highlevel", resource_type: "opportunity", external_id: "o2", metadata: { status: "open", stage: "Closed Won", contactId: "c2", lastStatusChangeAt: "2026-09-10T00:00:00Z" } }),
  row({ provider: "highlevel", resource_type: "opportunity", external_id: "o3", metadata: { status: "open", stage: "Proposal", contactId: "c3" } }),
  row({ provider: "highlevel", resource_type: "opportunity", external_id: "o4", metadata: { status: "won", contactId: "c4", lastStatusChangeAt: "2026-08-01T00:00:00Z" }, source_timestamp: "2026-08-01T00:00:00Z" }),
  row({ provider: "highlevel", resource_type: "contact", external_id: "c1", metadata: { email_hash: "h1" } }),
  row({ provider: "highlevel", resource_type: "contact", external_id: "c2", metadata: { email_hash: "h2" } }),
  row({ provider: "stripe", resource_type: "customer", external_id: "cus_1", metadata: { email_hash: "h1" } }),
  row({ provider: "stripe", resource_type: "customer", external_id: "cus_2", metadata: { email_hash: "h2" } }),
  row({ provider: "stripe", resource_type: "charge", external_id: "ch_1", metadata: { paid: true, amount: 50000, customerId: "cus_1" }, source_timestamp: "2026-09-12T00:00:00Z" }),
  row({ provider: "stripe", resource_type: "charge", external_id: "ch_2", metadata: { paid: true, amount: 25000, customerId: "cus_2" }, source_timestamp: "2026-09-30T00:00:00Z" }),
  row({ provider: "stripe", resource_type: "charge", external_id: "ch_3", metadata: { paid: false, amount: 999, customerId: "cus_2" } }),
];

const clientsMetric: GoalMetric = GoalMetricSchema.parse({
  key: "clients_onboarded",
  name: "Clients",
  kind: "count",
  target: 10,
  comparator: "gte",
  unit: "clients",
  formula: "",
  inputs: { value: { provider: "highlevel", resource_type: "opportunity", filter: { status_in: ["won"] }, aggregation: "count", timestamp_field: "lastStatusChangeAt" } },
  time_range: { kind: "goal_window" },
  is_primary: true,
});

const cacMetric: GoalMetric = GoalMetricSchema.parse({
  key: "cac",
  name: "CAC",
  kind: "currency",
  target: 100000,
  comparator: "lte",
  unit: "USD",
  formula: "ad_spend / clients_acquired",
  inputs: {
    ad_spend: { provider: "meta", resource_type: "ad_insight", aggregation: "sum", field: "spend" },
    clients_acquired: { provider: "highlevel", resource_type: "opportunity", filter: { status_in: ["won"] }, aggregation: "count", timestamp_field: "lastStatusChangeAt" },
  },
  time_range: { kind: "goal_window" },
  is_constraint: true,
});

const durationMetric: GoalMetric = GoalMetricSchema.parse({
  key: "sign_to_first_payment_days",
  name: "Sign → payment",
  kind: "duration_days",
  target: 14,
  comparator: "lte",
  unit: "days",
  formula: "median(paid - signed)",
  inputs: {
    signed: { provider: "highlevel", resource_type: "opportunity", filter: { status_in: ["won"] }, aggregation: "count", timestamp_field: "lastStatusChangeAt" },
    paid: { provider: "stripe", resource_type: "charge", filter: { metadata_truthy: ["paid"] }, aggregation: "latest" },
  },
  duration: { start: "signed", end: "paid", join: { via: "email_hash", aggregation: "median" } },
  time_range: { kind: "goal_window" },
  is_constraint: true,
});

describe("metric computation", () => {
  it("counts won opportunities in the window (status won OR won-like stage) and excludes out-of-window rows", () => {
    const r = computeMetric(clientsMetric, rows, CONNECTED, WINDOW, NOW);
    expect(r.value).toBe(2); // o1 (won) + o2 (stage Closed Won); o4 is before the window
    expect(r.freshness).toBe("fresh");
    expect(r.source).toMatch(/HighLevel opportunitys? \(status won\)/);
    expect(r.meets_target).toBe(false);
    expect(r.time_range).toEqual(WINDOW);
  });

  it("sums currency in minor units", () => {
    const m = GoalMetricSchema.parse({ key: "collected", name: "Collected", kind: "currency", target: 100000, comparator: "gte", unit: "USD", formula: "", inputs: { value: { provider: "stripe", resource_type: "charge", filter: { metadata_truthy: ["paid"] }, aggregation: "sum", field: "amount" } }, time_range: { kind: "goal_window" } });
    const r = computeMetric(m, rows, CONNECTED, WINDOW, NOW);
    expect(r.value).toBe(75000);
    expect(formatMetricValue(r)).toBe("$750");
  });

  it("returns null with a limitation when a ratio's source is not connected (never 0)", () => {
    const r = computeMetric(cacMetric, rows, CONNECTED, WINDOW, NOW);
    expect(r.value).toBeNull();
    expect(r.freshness).toBe("missing");
    expect(r.limitations.join(" ")).toMatch(/Meta not connected/);
    expect(r.meets_target).toBeNull();
  });

  it("computes the ratio when the source is present", () => {
    const withMeta = [...rows, row({ provider: "meta", resource_type: "ad_insight", external_id: "ai1", metadata: { spend: 120000 } })];
    const conns = [...CONNECTED, { provider: "meta", status: "connected", last_sync_at: "2026-09-30T11:00:00Z" }];
    const r = computeMetric(cacMetric, withMeta, conns, WINDOW, NOW);
    expect(r.value).toBe(60000); // $1,200 / 2 clients = $600
    expect(r.meets_target).toBe(true);
    expect(formatTarget(cacMetric)).toBe("≤ $1,000");
  });

  it("pairs HighLevel wins with the first later Stripe payment through hashed email", () => {
    const r = computeMetric(durationMetric, rows, CONNECTED, WINDOW, NOW);
    // o1 signed 09-05 → paid 09-12 = 7d ; o2 signed 09-10 → paid 09-30 = 20d ; median = 13.5
    expect(r.value).toBe(13.5);
    expect(r.sample_size).toBe(2);
    expect(r.meets_target).toBe(true);
  });

  it("reports unmatched starts", () => {
    const signedIn = durationMetric.inputs.signed!;
    const paidIn = durationMetric.inputs.paid!;
    const starts = rows.filter((r) => r.resource_type === "opportunity" && (r.metadata.status === "won" || String(r.metadata.stage ?? "").includes("Won")));
    const ends = rows.filter((r) => r.resource_type === "charge" && r.metadata.paid);
    const paired = pairDurations(starts, signedIn, ends, paidIn, "email_hash", rows);
    expect(paired.days.length).toBe(2);
    expect(paired.unmatched).toBe(1); // o4 has no contact email hash
  });

  it("marks data stale when the last sync is old", () => {
    const stale: ConnectionFreshness[] = [{ provider: "highlevel", status: "connected", last_sync_at: "2026-09-20T00:00:00Z" }];
    const r = computeMetric(clientsMetric, rows, stale, WINDOW, NOW);
    expect(r.freshness).toBe("stale");
  });

  it("safe formula evaluation supports arithmetic and rejects unknown identifiers", () => {
    expect(evaluateFormula("(a + b) / 2", { a: 4, b: 6 })).toBe(5);
    expect(evaluateFormula("a / b", { a: 4, b: 0 })).toBeNull();
    expect(evaluateFormula("a / b", { a: 4, b: null })).toBeNull();
    expect(() => evaluateFormula("process.exit()", { a: 1 })).toThrow();
    expect(() => evaluateFormula("a + c", { a: 1 })).toThrow(/unknown_variable/);
  });
});

describe("trajectory", () => {
  const base = { now: NOW, start: "2026-09-01", end: "2026-10-31", primary: clientsMetric, definitions: [clientsMetric, cacMetric, durationMetric], history: [] as { taken_at: string; value: number | null }[] };
  const res = (value: number | null, extra: Record<string, { value: number | null }> = {}) => ({
    clients_onboarded: { ...computeMetric(clientsMetric, [], [], WINDOW, NOW), value, meets_target: value != null ? value >= 10 : null },
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { ...computeMetric(k === "cac" ? cacMetric : durationMetric, [], [], WINDOW, NOW), value: v.value, meets_target: v.value == null ? null : k === "cac" ? v.value <= 100000 : v.value <= 14 }])),
  });

  it("on track when pace projects past the target", () => {
    const t = computeTrajectory({ ...base, metrics: res(6) }); // 29/60 days elapsed, 6 of 10
    expect(t.trajectory).toBe("on_track");
    expect(t.completion_pct).toBe(60);
    expect(t.forecast.value).toBeGreaterThanOrEqual(10);
  });

  it("slightly at risk when a soft constraint fails", () => {
    const t = computeTrajectory({ ...base, metrics: res(6, { cac: { value: 105000 } }) });
    expect(t.trajectory).toBe("slightly_at_risk");
    expect(t.violations[0]!.key).toBe("cac");
    expect(t.constraint_key).toBe("cac");
  });

  it("at risk when the projection falls 10–30% short", () => {
    const t = computeTrajectory({ ...base, metrics: res(4) }); // pace 4/29d → ~8.4 by day 60 → 16% short
    expect(t.trajectory).toBe("at_risk");
    expect(t.required_pace).toBeGreaterThan(t.observed_pace!);
  });

  it("severely at risk when far behind", () => {
    const t = computeTrajectory({ ...base, metrics: res(1) });
    expect(t.trajectory).toBe("severely_at_risk");
  });

  it("unknown without data", () => {
    const t = computeTrajectory({ ...base, metrics: res(null) });
    expect(t.trajectory).toBe("unknown");
    expect(t.reasons[0]).toMatch(/no data/);
  });

  it("identifies the weakest driver as the constraint", () => {
    const drivers = [
      { driver: { key: "qualified_leads", name: "Leads", input: clientsMetric.inputs.value!, implied_target: 90 }, value: 40 },
      { driver: { key: "booked_appointments", name: "Booked", input: clientsMetric.inputs.value!, implied_target: 30 }, value: 4 },
    ];
    const t = computeTrajectory({ ...base, metrics: res(4), drivers });
    expect(t.constraint_key).toBe("booked_appointments");
    expect(t.constraint_reason).toMatch(/Booked/);
  });

  it("uses snapshot history for pace when available", () => {
    const history = [
      { taken_at: "2026-09-10T12:00:00Z", value: 1 },
      { taken_at: "2026-09-20T12:00:00Z", value: 3 },
    ];
    const t = computeTrajectory({ ...base, metrics: res(6), history });
    expect(t.observed_pace).toBeGreaterThan(0.2);
    expect(t.forecast.basis).toMatch(/snapshots|average pace/);
  });
});

describe("recommendations", () => {
  it("proposes connecting missing sources and a driver-specific intervention, never an ROI claim", () => {
    const metrics = { clients_onboarded: computeMetric(clientsMetric, rows, CONNECTED, WINDOW, NOW), cac: computeMetric(cacMetric, rows, CONNECTED, WINDOW, NOW) };
    const trajectory = computeTrajectory({ now: NOW, start: "2026-09-01", end: "2026-10-31", primary: clientsMetric, definitions: [clientsMetric, cacMetric], metrics, history: [], drivers: [{ driver: { key: "booked_appointments", name: "Booked", input: clientsMetric.inputs.value!, implied_target: 30 }, value: 2 }] });
    const recs = recommendForGoal({ goalId: "g", goalName: "10 clients", primary: clientsMetric, definitions: [clientsMetric, cacMetric], metrics, trajectory, drivers: [{ key: "booked_appointments", name: "Booked", value: 2, implied_target: 30 }] });
    expect(recs.some((r) => r.fingerprint.startsWith("connect:"))).toBe(true);
    expect(recs.some((r) => r.fingerprint === "driver:booked_appointments")).toBe(true);
    for (const r of recs) {
      expect(r.why.length).toBeGreaterThan(0);
      expect(r.mechanism.length).toBeGreaterThan(0);
      expect(r.downside.length).toBeGreaterThan(0);
      expect(r.why + r.mechanism).not.toMatch(/ROI|guaranteed/i);
    }
  });
});
