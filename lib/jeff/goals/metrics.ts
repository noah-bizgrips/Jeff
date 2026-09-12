import type { GoalMetric, MetricInput, MetricResult, TimeRange } from "./schema";

/**
 * Deterministic metric computation over normalised source_items rows.
 * Pure: rows + connection freshness in, MetricResult out. No AI, no I/O.
 *
 * Money is always integer minor units (cents). A missing source produces
 * value = null with a limitation — never a silent 0.
 */

export interface MetricRow {
  id: string;
  provider: string;
  capability: string | null;
  resource_type: string;
  external_id: string;
  title: string | null;
  source_timestamp: string | null;
  synced_at: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface ConnectionFreshness {
  provider: string;
  status: string;
  last_sync_at: string | null;
}

export interface Window {
  start: string; // ISO
  end: string; // ISO
}

const STALE_HOURS = 36;

export function resolveWindow(range: TimeRange, goalWindow: Window, now: Date): Window {
  if (range.kind === "goal_window") return goalWindow;
  if (range.kind === "trailing_days") return { start: new Date(now.getTime() - range.days * 86_400_000).toISOString(), end: now.toISOString() };
  return { start: new Date(range.since).toISOString(), end: now.toISOString() };
}

function meta(row: MetricRow, field: string): unknown {
  return field.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), row.metadata);
}

function rowTime(row: MetricRow, input: MetricInput): string | null {
  if (input.timestamp_field) {
    const v = meta(row, input.timestamp_field);
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  }
  return row.source_timestamp;
}

function inWindow(ts: string | null, w: Window): boolean {
  if (!ts) return false;
  const t = Date.parse(ts);
  return t >= Date.parse(w.start) && t <= Date.parse(w.end);
}

const WON_STAGE_WORDS = ["won", "signed", "client", "closed won"];

export function matchesFilter(row: MetricRow, input: MetricInput): boolean {
  if (row.provider !== input.provider || row.resource_type !== input.resource_type) return false;
  const f = input.filter ?? {};
  if (f.status_in?.length) {
    const status = String(meta(row, "status") ?? "").toLowerCase();
    const stage = String(meta(row, "stage") ?? "").toLowerCase();
    const wantsWon = f.status_in.map((s) => s.toLowerCase()).includes("won");
    const stageLooksWon = WON_STAGE_WORDS.some((w) => stage.includes(w));
    if (!(f.status_in.map((s) => s.toLowerCase()).includes(status) || (wantsWon && stageLooksWon))) return false;
  }
  if (f.stage_contains?.length) {
    const stage = String(meta(row, "stage") ?? "").toLowerCase();
    if (!f.stage_contains.some((s) => stage.includes(s.toLowerCase()))) return false;
  }
  if (f.tags_any?.length) {
    const tags = (row.tags ?? []).map((t) => t.toLowerCase());
    if (!f.tags_any.some((t) => tags.includes(t.toLowerCase()))) return false;
  }
  if (f.metadata_equals) {
    for (const [k, v] of Object.entries(f.metadata_equals)) {
      const got = meta(row, k);
      if (typeof v === "string" ? String(got ?? "").toLowerCase() !== v.toLowerCase() : got !== v) return false;
    }
  }
  if (f.metadata_truthy?.length) {
    for (const k of f.metadata_truthy) if (!meta(row, k)) return false;
  }
  return true;
}

/** Subscription helper: normalise Stripe subscription items to a monthly amount in minor units. */
function monthlyAmount(row: MetricRow): number {
  const items = meta(row, "items");
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const it of items as { unit_amount?: number; quantity?: number; interval?: string; interval_count?: number }[]) {
    const unit = typeof it.unit_amount === "number" ? it.unit_amount : 0;
    const qty = typeof it.quantity === "number" ? it.quantity : 1;
    const count = typeof it.interval_count === "number" && it.interval_count > 0 ? it.interval_count : 1;
    const perMonth = it.interval === "year" ? 1 / (12 * count) : it.interval === "week" ? 4.345 / count : it.interval === "day" ? 30.4 / count : 1 / count;
    total += unit * qty * perMonth;
  }
  return Math.round(total);
}

function numericField(row: MetricRow, field: string | undefined): number | null {
  if (!field) return null;
  if (field === "monthly_amount") return monthlyAmount(row);
  const v = meta(row, field);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface InputResult {
  value: number | null;
  sample_size: number;
  source: string;
  last_updated: string | null;
  rows: MetricRow[];
}

export function describeInput(input: MetricInput): string {
  const bits: string[] = [];
  const f = input.filter ?? {};
  if (f.status_in?.length) bits.push(`status ${f.status_in.join("/")}`);
  if (f.stage_contains?.length) bits.push(`stage ~ ${f.stage_contains.join("/")}`);
  if (f.tags_any?.length) bits.push(`tags ${f.tags_any.join("/")}`);
  if (f.metadata_equals) bits.push(Object.entries(f.metadata_equals).map(([k, v]) => `${k}=${String(v)}`).join(", "));
  if (f.metadata_truthy?.length) bits.push(f.metadata_truthy.join("&"));
  const agg = input.aggregation === "count" ? "count" : `${input.aggregation}(${input.field ?? "value"})`;
  return `${input.provider} ${input.resource_type}s${bits.length ? ` (${bits.join("; ")})` : ""} · ${agg}`;
}

export function computeInput(input: MetricInput, rows: MetricRow[], window: Window): InputResult {
  const hits = rows.filter((r) => matchesFilter(r, input) && inWindow(rowTime(r, input), window));
  const lastUpdated = hits.reduce<string | null>((acc, r) => (r.synced_at && (!acc || r.synced_at > acc) ? r.synced_at : acc), null);
  const source = describeInput(input);
  if (input.aggregation === "count") return { value: hits.length, sample_size: hits.length, source, last_updated: lastUpdated, rows: hits };
  const nums = hits.map((r) => numericField(r, input.field)).filter((v): v is number => v != null);
  let value: number | null = null;
  switch (input.aggregation) {
    case "sum":
      value = nums.length ? nums.reduce((a, b) => a + b, 0) : hits.length ? 0 : null;
      break;
    case "avg":
      value = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
      break;
    case "median":
      value = median(nums);
      break;
    case "max":
      value = nums.length ? Math.max(...nums) : null;
      break;
    case "latest": {
      const latest = [...hits].sort((a, b) => (rowTime(b, input) ?? "").localeCompare(rowTime(a, input) ?? ""))[0];
      value = latest ? numericField(latest, input.field) : null;
      break;
    }
  }
  return { value, sample_size: nums.length || hits.length, source, last_updated: lastUpdated, rows: hits };
}

/* ------------------------------------------------------------------ */
/* Safe formula evaluation: numbers, identifiers, + - * / ( )          */
/* ------------------------------------------------------------------ */

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([a-z_][a-z0-9_]*)|([-+*/()]))/gy;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(src))) {
    last = re.lastIndex;
    if (m[1]) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2]) out.push({ t: "id", v: m[2] });
    else if (m[3]) out.push({ t: "op", v: m[3] });
  }
  if (last !== src.length && src.slice(last).trim() !== "") throw new Error("formula_syntax");
  return out;
}

/** Evaluates `formula` with the given variables. Returns null when any variable is null or division by zero. */
export function evaluateFormula(formula: string, vars: Record<string, number | null>): number | null {
  const toks = tokenize(formula.toLowerCase());
  let i = 0;
  let nullHit = false;
  const peek = () => toks[i];
  const next = () => toks[i++];
  function primary(): number {
    const tk = next();
    if (!tk) throw new Error("formula_syntax");
    if (tk.t === "num") return tk.v;
    if (tk.t === "id") {
      if (!(tk.v in vars)) throw new Error(`formula_unknown_variable:${tk.v}`);
      const v = vars[tk.v];
      if (v == null) {
        nullHit = true;
        return 0;
      }
      return v;
    }
    if (tk.v === "(") {
      const v = expr();
      const close = next();
      if (!close || close.t !== "op" || close.v !== ")") throw new Error("formula_syntax");
      return v;
    }
    if (tk.v === "-") return -primary();
    throw new Error("formula_syntax");
  }
  const isOp = (c: string) => {
    const tk = peek();
    return !!tk && tk.t === "op" && tk.v === c;
  };
  function term(): number {
    let v = primary();
    while (isOp("*") || isOp("/")) {
      const op = (next() as { v: string }).v;
      const r = primary();
      if (op === "*") v *= r;
      else {
        if (r === 0) {
          nullHit = true;
          v = 0;
        } else v /= r;
      }
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = (next() as { v: string }).v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const result = expr();
  if (i !== toks.length) throw new Error("formula_syntax");
  return nullHit ? null : result;
}

/* ------------------------------------------------------------------ */
/* Duration pairing                                                    */
/* ------------------------------------------------------------------ */

function joinKey(row: MetricRow, via: "email_hash" | "contactId" | "customerId"): string | null {
  const v = meta(row, via);
  return typeof v === "string" && v ? v : null;
}

/**
 * Pairs start rows with end rows through a shared key. For HighLevel→Stripe
 * the key is the hashed email (contacts carry email_hash; Stripe customers
 * carry email_hash and charges carry customerId → resolved through customer
 * rows). Returns durations in days, one per matched start row.
 */
export function pairDurations(
  startRows: MetricRow[],
  startInput: MetricInput,
  endRows: MetricRow[],
  endInput: MetricInput,
  via: "email_hash" | "contactId" | "customerId",
  allRows: MetricRow[],
): { days: number[]; unmatched: number } {
  // Build lookup for end rows keyed by join key; Stripe charges resolve customerId → email_hash via customer rows.
  const customerEmail = new Map<string, string>();
  const contactEmail = new Map<string, string>();
  for (const r of allRows) {
    if (r.provider === "stripe" && r.resource_type === "customer") {
      const eh = joinKey(r, "email_hash");
      if (eh) customerEmail.set(r.external_id, eh);
    }
    if (r.provider === "highlevel" && r.resource_type === "contact") {
      const eh = joinKey(r, "email_hash");
      if (eh) contactEmail.set(r.external_id, eh);
    }
  }
  const keyOf = (r: MetricRow): string | null => {
    if (via === "email_hash") {
      const direct = joinKey(r, "email_hash");
      if (direct) return direct;
      const cid = joinKey(r, "customerId");
      if (cid && customerEmail.has(cid)) return customerEmail.get(cid)!;
      const contact = joinKey(r, "contactId");
      if (contact && contactEmail.has(contact)) return contactEmail.get(contact)!;
      return null;
    }
    return joinKey(r, via);
  };
  const ends = new Map<string, string[]>();
  for (const r of endRows) {
    const k = keyOf(r);
    const ts = rowTime(r, endInput);
    if (!k || !ts) continue;
    ends.set(k, [...(ends.get(k) ?? []), ts]);
  }
  const days: number[] = [];
  let unmatched = 0;
  for (const s of startRows) {
    const k = keyOf(s);
    const st = rowTime(s, startInput);
    if (!k || !st || !ends.has(k)) {
      unmatched++;
      continue;
    }
    const startMs = Date.parse(st);
    const after = ends
      .get(k)!
      .map((e) => Date.parse(e))
      .filter((e) => e >= startMs)
      .sort((a, b) => a - b)[0];
    if (after == null) {
      unmatched++;
      continue;
    }
    days.push((after - startMs) / 86_400_000);
  }
  return { days, unmatched };
}

/* ------------------------------------------------------------------ */
/* Metric computation                                                  */
/* ------------------------------------------------------------------ */

function freshnessOf(providers: string[], connections: ConnectionFreshness[], now: Date): { freshness: MetricResult["freshness"]; limitations: string[]; missing: Set<string> } {
  const limitations: string[] = [];
  const missing = new Set<string>();
  let worst: MetricResult["freshness"] = "fresh";
  for (const p of Array.from(new Set(providers))) {
    const conn = connections.find((c) => c.provider === p && ["connected", "limited"].includes(c.status));
    if (!conn) {
      limitations.push(`${providerLabel(p)} not connected`);
      missing.add(p);
      worst = "missing";
      continue;
    }
    if (!conn.last_sync_at) {
      limitations.push(`${providerLabel(p)} has not synced yet`);
      if (worst !== "missing") worst = "stale";
      continue;
    }
    const ageH = (now.getTime() - Date.parse(conn.last_sync_at)) / 3_600_000;
    if (ageH > STALE_HOURS) {
      limitations.push(`${providerLabel(p)} data is ${Math.round(ageH)}h old`);
      if (worst !== "missing") worst = "stale";
    }
  }
  return { freshness: worst, limitations, missing };
}

export function providerLabel(p: string): string {
  return { highlevel: "HighLevel", stripe: "Stripe", plaid: "Financial Accounts", meta: "Meta", google: "Google", slack: "Slack", notion: "Notion", github: "GitHub", n8n: "n8n" }[p] ?? p;
}

export function meetsTarget(value: number | null, m: Pick<GoalMetric, "target" | "comparator" | "target_upper">): boolean | null {
  if (value == null || m.target == null) return null;
  switch (m.comparator) {
    case "gte":
      return value >= m.target;
    case "lte":
      return value <= m.target;
    case "eq":
      return Math.abs(value - m.target) < 1e-9;
    case "between":
      return value >= m.target && (m.target_upper == null || value <= m.target_upper);
  }
}

export function computeMetric(metric: GoalMetric, rows: MetricRow[], connections: ConnectionFreshness[], goalWindow: Window, now: Date): MetricResult {
  const window = resolveWindow(metric.time_range, goalWindow, now);
  const providers = Object.values(metric.inputs).map((i) => i.provider);
  const fresh = freshnessOf(providers, connections, now);
  const limitations = [...metric.limitations, ...fresh.limitations];
  const inputs: NonNullable<MetricResult["inputs"]> = {};
  const computed: Record<string, InputResult> = {};
  for (const [k, spec] of Object.entries(metric.inputs)) {
    const res = computeInput(spec, rows, window);
    computed[k] = res;
    inputs[k] = { value: res.value, sample_size: res.sample_size, source: res.source };
  }
  const lastUpdated = Object.values(computed).reduce<string | null>((acc, r) => (r.last_updated && (!acc || r.last_updated > acc) ? r.last_updated : acc), null);

  let value: number | null = null;
  let sampleSize = 0;
  const base = {
    key: metric.key,
    unit: metric.unit,
    kind: metric.kind,
    target: metric.target,
    comparator: metric.comparator,
    target_upper: metric.target_upper,
    formula: metric.formula,
    time_range: window,
    last_updated: lastUpdated,
    inputs,
  };
  const source = Object.values(computed).map((c) => c.source).join(" + ") || "manual";

  if (Object.keys(metric.inputs).length === 0) {
    return { ...base, value: null, source, sample_size: 0, limitations: limitations.length ? limitations : ["No data source mapped to this metric yet."], freshness: "missing", meets_target: null };
  }

  if (metric.kind === "duration_days") {
    if (!metric.duration) {
      return { ...base, value: null, source, sample_size: 0, limitations: [...limitations, "Duration metric has no start/end inputs."], freshness: "missing", meets_target: null };
    }
    const s = computed[metric.duration.start];
    const e = computed[metric.duration.end];
    const sIn = metric.inputs[metric.duration.start];
    const eIn = metric.inputs[metric.duration.end];
    if (!s || !e || !sIn || !eIn) {
      return { ...base, value: null, source, sample_size: 0, limitations: [...limitations, "Duration inputs are not defined."], freshness: "missing", meets_target: null };
    }
    const paired = pairDurations(s.rows, sIn, e.rows, eIn, metric.duration.join.via, rows);
    const agg = metric.duration.join.aggregation;
    let daysValue = agg === "median" ? median(paired.days) : agg === "avg" ? (paired.days.length ? paired.days.reduce((a, b) => a + b, 0) / paired.days.length : null) : paired.days.length ? Math.max(...paired.days) : null;
    if (daysValue != null && metric.unit === "minutes") daysValue = daysValue * 1440;
    if (daysValue != null && metric.unit === "hours") daysValue = daysValue * 24;
    value = daysValue == null ? null : Math.round(daysValue * 10) / 10;
    sampleSize = paired.days.length;
    if (paired.unmatched) limitations.push(`${paired.unmatched} start record${paired.unmatched === 1 ? "" : "s"} could not be matched to an end record.`);
  } else if (metric.kind === "ratio" || (metric.kind === "currency" && metric.formula && Object.keys(metric.inputs).length > 1) || (metric.kind === "percentage" && Object.keys(metric.inputs).length > 1)) {
    // An input whose provider is not connected is unknown (null), never 0.
    const vars: Record<string, number | null> = {};
    for (const [k, r] of Object.entries(computed)) vars[k] = fresh.missing.has(metric.inputs[k]!.provider) && r.sample_size === 0 ? null : r.value;
    try {
      value = evaluateFormula(metric.formula, vars);
    } catch {
      value = null;
      limitations.push("Formula could not be evaluated.");
    }
    if (value != null && metric.kind === "percentage") value = Math.round(value * 1000) / 10;
    if (value != null && metric.kind === "currency") value = Math.round(value);
    sampleSize = Math.min(...Object.values(computed).map((c) => c.sample_size));
    if (value == null && Object.values(vars).some((v) => v === 0 || v == null)) limitations.push("Denominator is zero or a source is missing, so the ratio is undefined.");
  } else {
    const onlyKey = Object.keys(computed)[0]!;
    const only = computed[onlyKey]!;
    value = fresh.missing.has(metric.inputs[onlyKey]!.provider) && only.sample_size === 0 ? null : only.value;
    sampleSize = only.sample_size;
  }

  return {
    ...base,
    value,
    source,
    sample_size: Number.isFinite(sampleSize) ? sampleSize : 0,
    limitations,
    freshness: fresh.freshness,
    meets_target: meetsTarget(value, metric),
  };
}

export function computeAllMetrics(metrics: GoalMetric[], rows: MetricRow[], connections: ConnectionFreshness[], goalWindow: Window, now: Date): Record<string, MetricResult> {
  const out: Record<string, MetricResult> = {};
  for (const m of metrics) out[m.key] = computeMetric(m, rows, connections, goalWindow, now);
  return out;
}

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
