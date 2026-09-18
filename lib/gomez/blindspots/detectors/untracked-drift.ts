import { daysAgo, money, pctChange, ts, type BlindSpotCandidate, type BlindSpotContext, type Detector } from "../types";
import type { SourceRow } from "@/lib/gomez/monitors/types";

/** Month-over-month movement above this is drift worth surfacing when no goal tracks the metric. */
export const DRIFT_PCT = 30;
/** Money metrics need at least this much movement (minor units) to matter. */
export const MIN_MONEY_DELTA_MINOR = 50_000;
export const MIN_COUNT_BASE = 5;

interface MetricDef {
  key: string;
  label: string;
  kind: "money" | "count";
  /** Goal metric keys that would mean this is already tracked. */
  tracked_by: string[];
  select: (r: SourceRow) => number | null; // minor units or 1 for a count
}

const amount = (r: SourceRow) => (typeof r.metadata?.amount === "number" ? Math.abs(r.metadata.amount as number) : null);

export const METRICS: MetricDef[] = [
  { key: "stripe_net", label: "Stripe collected", kind: "money", tracked_by: ["revenue", "mrr", "stripe_net", "cash_collected", "collected"], select: (r) => (r.provider === "stripe" && r.resource_type === "charge" && r.metadata?.status === "succeeded" ? amount(r) : null) },
  { key: "plaid_outflow", label: "Bank outflow", kind: "money", tracked_by: ["expenses", "outflow", "spend", "burn", "operating_reserve"], select: (r) => (r.provider === "plaid" && r.resource_type === "transaction" && typeof r.metadata?.amount === "number" && (r.metadata.amount as number) > 0 ? Math.round((r.metadata.amount as number) * 100) : null) },
  { key: "new_leads", label: "New leads", kind: "count", tracked_by: ["leads", "qualified_leads", "new_leads", "clients_onboarded", "booked"], select: (r) => ((r.provider === "portal" && r.resource_type === "lead") || (r.provider === "highlevel" && r.resource_type === "contact") ? 1 : null) },
  { key: "ad_spend", label: "Ad spend", kind: "money", tracked_by: ["ad_spend", "cac", "spend"], select: (r) => (r.provider === "meta" && r.resource_type === "ad_insight" && typeof r.metadata?.spend === "number" ? (r.metadata.spend as number) : null) },
  { key: "portal_overdue_tasks", label: "Overdue portal tasks", kind: "count", tracked_by: ["overdue_tasks", "onboarding"], select: (r) => (r.provider === "portal" && r.resource_type === "task" && r.metadata?.is_overdue === true ? 1 : null) },
];

export const untrackedDrift: Detector = {
  id: "untracked_drift",
  run(ctx: BlindSpotContext): BlindSpotCandidate[] {
    const tracked = new Set(ctx.goals.filter((g) => g.status === "active").flatMap((g) => g.metric_keys.map((k) => k.toLowerCase())));
    const thisStart = daysAgo(ctx, 30);
    const prevStart = daysAgo(ctx, 60);
    const out: BlindSpotCandidate[] = [];
    for (const m of METRICS) {
      if (m.tracked_by.some((k) => tracked.has(k)) || tracked.has(m.key)) continue;
      let cur = 0;
      let prev = 0;
      let curN = 0;
      let prevN = 0;
      for (const r of ctx.sourceItems) {
        const v = m.select(r);
        if (v == null) continue;
        const t = ts(r.source_timestamp);
        if (!Number.isFinite(t)) continue;
        if (t >= thisStart) {
          cur += v;
          curN++;
        } else if (t >= prevStart) {
          prev += v;
          prevN++;
        }
      }
      if (m.kind === "count" && prev < MIN_COUNT_BASE) continue;
      if (m.kind === "money" && Math.abs(cur - prev) < MIN_MONEY_DELTA_MINOR) continue;
      const change = pctChange(cur, prev);
      if (change == null || Math.abs(change) < DRIFT_PCT) continue;
      const fmt = (v: number) => (m.kind === "money" ? money(v) : String(v));
      out.push({
        fingerprint: `blindspot:untracked_drift:${m.key}`,
        subtype: "untracked_drift",
        ref: m.key,
        title: `${m.label} moved ${change > 0 ? "+" : ""}${change}% month over month — and no goal tracks it`,
        observed_facts: [`Last 30 days: ${fmt(cur)} (${curN} records).`, `Previous 30 days: ${fmt(prev)} (${prevN} records).`, `No active goal has a metric covering ${m.label.toLowerCase()}.`],
        metrics: { current_30d: cur, previous_30d: prev, change_pct: change, unit: m.kind === "money" ? "minor_units" : "count", formula: "(current_30d − previous_30d) / previous_30d" },
        interpretation: `${m.label} is moving materially while nothing is watching it. Tracking it as a goal metric (or an explicit rule to ignore it) would turn this from a surprise into a signal.`,
        attention: "No goal or alert threshold covers this metric, so its movement never reaches you.",
        evidence: [],
        range_start: new Date(prevStart).toISOString(),
        range_end: ctx.now.toISOString(),
        confidence: Math.min(0.85, 0.5 + Math.min(Math.abs(change), 100) / 200),
        limitations: "Calendar-month proxies (30-day windows); partial syncs or seasonality can exaggerate the change.",
        impact: m.kind === "money" ? "financial" : "operational",
      });
    }
    return out;
  },
};
