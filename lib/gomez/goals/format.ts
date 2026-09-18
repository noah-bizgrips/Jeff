import type { GoalMetric, MetricResult } from "./schema";

/** Display helpers shared by server and client code (no Node imports here). */

export function formatMetricValue(r: Pick<MetricResult, "value" | "kind" | "unit">): string {
  if (r.value == null) return "—";
  if (r.kind === "currency") return `$${(r.value / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (r.kind === "percentage") return `${Math.round(r.value * 10) / 10}%`;
  if (r.kind === "duration_days") return `${Math.round(r.value * 10) / 10}${r.unit === "minutes" ? "m" : r.unit === "hours" ? "h" : "d"}`;
  return `${Math.round(r.value * 10) / 10}`;
}

export function formatTarget(m: Pick<GoalMetric, "target" | "comparator" | "kind" | "unit" | "target_upper">): string {
  if (m.target == null) return "—";
  const fmt = (v: number) => formatMetricValue({ value: v, kind: m.kind, unit: m.unit });
  const sym = m.comparator === "gte" ? "≥" : m.comparator === "lte" ? "≤" : m.comparator === "eq" ? "=" : "";
  if (m.comparator === "between") return `${fmt(m.target)} – ${m.target_upper != null ? fmt(m.target_upper) : "∞"}`;
  return `${sym} ${fmt(m.target)}`;
}

export function providerLabel(p: string): string {
  return { highlevel: "HighLevel", stripe: "Stripe", plaid: "Financial Accounts", meta: "Meta", google: "Google", slack: "Slack", notion: "Notion", github: "GitHub", n8n: "n8n", portal: "Client Portal" }[p] ?? p;
}

/** Human description of one metric input, including cross-source conditions. */
export function describeInput(input: {
  provider: string;
  resource_type: string;
  filter?: Record<string, unknown>;
  aggregation?: string;
  field?: string;
  require_match?: { provider: string; resource_type: string; filter?: Record<string, unknown>; label?: string }[];
  distinct_by?: string;
}): string {
  const agg = !input.aggregation || input.aggregation === "count" ? (input.distinct_by ? `distinct ${input.distinct_by === "client_id" ? "clients" : "people"}` : "count") : `${input.aggregation}(${input.field ?? "value"})`;
  const reqs = (input.require_match ?? []).map((r) => r.label ?? `${providerLabel(r.provider)} ${r.resource_type}${describeFilter(r.filter)}`);
  return `${providerLabel(input.provider)} ${input.resource_type}s${describeFilter(input.filter)}${reqs.length ? ` with ${reqs.join(" and ")}` : ""} · ${agg}`;
}

export function describeFilter(f: Record<string, unknown> | undefined): string {
  if (!f) return "";
  const bits: string[] = [];
  const arr = (k: string) => (Array.isArray(f[k]) ? (f[k] as unknown[]).map(String) : []);
  if (arr("status_in").length) bits.push(`status ${arr("status_in").join("/")}`);
  if (arr("status_not_in").length) bits.push(`excluding ${arr("status_not_in").join("/")}`);
  if (arr("stage_contains").length) bits.push(`stage ~ ${arr("stage_contains").join("/")}`);
  if (arr("tags_any").length) bits.push(`tags ${arr("tags_any").join("/")}`);
  if (arr("tags_none").length) bits.push(`not tagged ${arr("tags_none").join("/")}`);
  if (arr("title_contains").length) bits.push(`titled "${arr("title_contains").join('" or "')}"`);
  if (f.metadata_equals && typeof f.metadata_equals === "object") bits.push(Object.entries(f.metadata_equals as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`).join(", "));
  if (arr("metadata_truthy").length) bits.push(arr("metadata_truthy").join("&"));
  if (arr("metadata_falsy").length) bits.push(`not ${arr("metadata_falsy").join("&")}`);
  if (f.metadata_min && typeof f.metadata_min === "object") bits.push(Object.entries(f.metadata_min as Record<string, number>).map(([k, v]) => `${k} ≥ ${/amount|spend|value|total/.test(k) ? `$${(v / 100).toLocaleString()}` : v}`).join(", "));
  return bits.length ? ` (${bits.join("; ")})` : "";
}
