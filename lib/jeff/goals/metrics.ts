import { createHash } from "node:crypto";
import type { GoalMetric, IdentityKey, MetricFilter, MetricInput, MetricResult, RequireMatch, TimeRange } from "./schema";
import { describeInput as describeInputSpec, providerLabel } from "./format";

export { formatMetricValue, formatTarget, providerLabel } from "./format";

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

function lower(v: unknown): string {
  return String(v ?? "").toLowerCase();
}

/** Applies a filter to a row already known to be the right provider/resource. Exclusions are evaluated first and are absolute. */
export function matchesRowFilter(row: MetricRow, f: MetricFilter | undefined): boolean {
  if (!f) return true;
  const status = lower(meta(row, "status"));
  const stage = lower(meta(row, "stage"));
  const tags = (row.tags ?? []).map((t) => t.toLowerCase());
  if (f.status_not_in?.length && f.status_not_in.map((x) => x.toLowerCase()).includes(status)) return false;
  if (f.tags_none?.length && f.tags_none.some((t) => tags.includes(t.toLowerCase()))) return false;
  if (f.metadata_falsy?.length) for (const k of f.metadata_falsy) if (meta(row, k)) return false;
  if (f.status_in?.length) {
    const wanted = f.status_in.map((x) => x.toLowerCase());
    const stageLooksWon = WON_STAGE_WORDS.some((w) => stage.includes(w));
    if (!(wanted.includes(status) || (wanted.includes("won") && stageLooksWon))) return false;
  }
  if (f.stage_contains?.length && !f.stage_contains.some((x) => stage.includes(x.toLowerCase()))) return false;
  if (f.tags_any?.length && !f.tags_any.some((t) => tags.includes(t.toLowerCase()))) return false;
  if (f.title_contains?.length) {
    const title = lower(row.title);
    if (!f.title_contains.some((t) => title.includes(t.toLowerCase()))) return false;
  }
  if (f.metadata_equals) {
    for (const [k, v] of Object.entries(f.metadata_equals)) {
      const got = meta(row, k);
      if (typeof v === "string" ? lower(got) !== v.toLowerCase() : got !== v) return false;
    }
  }
  if (f.metadata_truthy?.length) for (const k of f.metadata_truthy) if (!meta(row, k)) return false;
  return true;
}

export function matchesFilter(row: MetricRow, input: Pick<MetricInput, "provider" | "resource_type" | "filter">): boolean {
  if (row.provider !== input.provider || row.resource_type !== input.resource_type) return false;
  return matchesRowFilter(row, input.filter);
}

/* ------------------------------------------------------------------ */
/* Identity resolution                                                 */
/* ------------------------------------------------------------------ */

/** Same normalisation every connector uses for `email_hash` (portal, HighLevel, Stripe). */
export function emailHashOf(email: string): string | null {
  const e = email.trim().toLowerCase();
  if (!e || !e.includes("@")) return null;
  return createHash("sha256").update(e).digest("hex");
}

/**
 * Lookup tables that let any row be reduced to the people it is about:
 * Stripe charges/invoices → customer email; HighLevel messages/events →
 * contact email; portal tasks/stages → the client's users' emails. Built once
 * per computation from every loaded row.
 */
export interface IdentityIndex {
  customerEmail: Map<string, string>; // stripe customer id → email_hash
  contactEmail: Map<string, string>; // highlevel contact id → email_hash
  clientEmails: Map<string, Set<string>>; // portal client id → email_hashes of its users
  clientByContact: Map<string, string>; // highlevel contact id → portal client id
  clientByEmail: Map<string, string>; // email_hash → portal client id
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null;
}

export function buildIdentityIndex(rows: MetricRow[]): IdentityIndex {
  const idx: IdentityIndex = { customerEmail: new Map(), contactEmail: new Map(), clientEmails: new Map(), clientByContact: new Map(), clientByEmail: new Map() };
  const addClientEmail = (clientId: string, eh: string) => {
    if (!idx.clientEmails.has(clientId)) idx.clientEmails.set(clientId, new Set());
    idx.clientEmails.get(clientId)!.add(eh);
    if (!idx.clientByEmail.has(eh)) idx.clientByEmail.set(eh, clientId);
  };
  for (const r of rows) {
    const eh = str(meta(r, "email_hash"));
    if (r.provider === "stripe" && r.resource_type === "customer" && eh) idx.customerEmail.set(r.external_id, eh);
    if (r.provider === "highlevel" && r.resource_type === "contact" && eh) idx.contactEmail.set(r.external_id, eh);
    if (r.provider === "portal") {
      const clientId = str(meta(r, "client_id"));
      if (r.resource_type === "client") {
        const ghl = str(meta(r, "ghl_contact_id"));
        if (ghl) idx.clientByContact.set(ghl, r.external_id);
        const users = meta(r, "client_users");
        if (Array.isArray(users)) for (const u of users as { email_hash?: unknown }[]) if (str(u?.email_hash)) addClientEmail(r.external_id, str(u.email_hash)!);
      }
      // Only portal users identify a client. Leads are the client's own customers, so their emails never do.
      if (r.resource_type === "client_user" && clientId && eh) addClientEmail(clientId, eh);
    }
  }
  return idx;
}

/** All values of `via` this row can be identified by (deduplicated, may be empty). */
export function identityKeys(row: MetricRow, via: IdentityKey, idx: IdentityIndex): string[] {
  const out = new Set<string>();
  const m = row.metadata ?? {};
  if (via === "email_hash") {
    const direct = str(m.email_hash);
    if (direct) out.add(direct);
    for (const k of ["attendees", "to"]) {
      const list = m[k];
      if (Array.isArray(list)) for (const e of list) if (typeof e === "string") { const h = emailHashOf(e); if (h) out.add(h); }
    }
    const assignee = str(m.assignee_email_hash);
    if (assignee) out.add(assignee);
    const cid = str(m.customerId);
    if (cid && idx.customerEmail.has(cid)) out.add(idx.customerEmail.get(cid)!);
    if (row.provider === "stripe" && row.resource_type === "customer" && idx.customerEmail.has(row.external_id)) out.add(idx.customerEmail.get(row.external_id)!);
    const contact = str(m.contactId) ?? str(m.ghl_contact_id);
    if (contact && idx.contactEmail.has(contact)) out.add(idx.contactEmail.get(contact)!);
    if (row.provider === "highlevel" && row.resource_type === "contact" && idx.contactEmail.has(row.external_id)) out.add(idx.contactEmail.get(row.external_id)!);
    const clientId = row.provider === "portal" && row.resource_type === "client" ? row.external_id : str(m.client_id);
    if (clientId && idx.clientEmails.has(clientId)) for (const h of idx.clientEmails.get(clientId)!) out.add(h);
  } else if (via === "contactId") {
    const c = str(m.contactId) ?? str(m.ghl_contact_id);
    if (c) out.add(c);
    if (row.provider === "highlevel" && row.resource_type === "contact") out.add(row.external_id);
  } else if (via === "customerId") {
    const c = str(m.customerId);
    if (c) out.add(c);
    if (row.provider === "stripe" && row.resource_type === "customer") out.add(row.external_id);
  } else if (via === "client_id") {
    const c = row.provider === "portal" && row.resource_type === "client" ? row.external_id : str(m.client_id);
    if (c) out.add(c);
    const contact = str(m.contactId) ?? str(m.ghl_contact_id);
    if (contact && idx.clientByContact.has(contact)) out.add(idx.clientByContact.get(contact)!);
    for (const eh of identityKeys(row, "email_hash", idx)) if (idx.clientByEmail.has(eh)) out.add(idx.clientByEmail.get(eh)!);
  }
  return Array.from(out);
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
  /** Rows that passed the input's own filter but failed a cross-source condition. */
  excluded_by_conditions: number;
}

export function describeInput(input: MetricInput): string {
  return describeInputSpec(input);
}

/** Rows satisfying a cross-source condition, keyed by identity. */
function matchKeySet(req: RequireMatch, rows: MetricRow[], window: Window, idx: IdentityIndex): Set<string> {
  const keys = new Set<string>();
  const asInput = { provider: req.provider, resource_type: req.resource_type, filter: req.filter, timestamp_field: req.timestamp_field } as MetricInput;
  for (const r of rows) {
    if (!matchesFilter(r, asInput)) continue;
    if (req.in_window && !inWindow(rowTime(r, asInput), window)) continue;
    for (const k of identityKeys(r, req.via, idx)) keys.add(k);
  }
  return keys;
}

/**
 * Applies `require_match` (every condition must hold, joined by identity) and
 * `distinct_by` to the rows that already passed the input's own filter and
 * window. Rows without a resolvable identity never satisfy a condition.
 */
export function applyConditions(hits: MetricRow[], input: MetricInput, allRows: MetricRow[], window: Window, idx: IdentityIndex): { rows: MetricRow[]; unmatched: number } {
  let rows = hits;
  let unmatched = 0;
  for (const req of input.require_match ?? []) {
    const keys = matchKeySet(req, allRows, window, idx);
    const before = rows.length;
    rows = rows.filter((r) => identityKeys(r, req.via, idx).some((k) => keys.has(k)));
    unmatched += before - rows.length;
  }
  if (input.distinct_by) {
    const seen = new Set<string>();
    rows = rows.filter((r) => {
      const k = identityKeys(r, input.distinct_by!, idx)[0] ?? `row:${r.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return { rows, unmatched };
}

export function computeInput(input: MetricInput, rows: MetricRow[], window: Window, idx?: IdentityIndex): InputResult {
  const direct = rows.filter((r) => matchesFilter(r, input) && inWindow(rowTime(r, input), window));
  const conditioned = input.require_match?.length || input.distinct_by ? applyConditions(direct, input, rows, window, idx ?? buildIdentityIndex(rows)) : { rows: direct, unmatched: 0 };
  const hits = conditioned.rows;
  const lastUpdated = hits.reduce<string | null>((acc, r) => (r.synced_at && (!acc || r.synced_at > acc) ? r.synced_at : acc), null);
  const source = describeInput(input);
  if (input.aggregation === "count") return { value: hits.length, sample_size: hits.length, source, last_updated: lastUpdated, rows: hits, excluded_by_conditions: conditioned.unmatched };
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
  return { value, sample_size: nums.length || hits.length, source, last_updated: lastUpdated, rows: hits, excluded_by_conditions: conditioned.unmatched };
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

/**
 * Pairs start rows with end rows through a shared identity (hashed email by
 * default: contacts, customers, portal users, calendar attendees and email
 * recipients all reduce to it). Returns durations in days, one per matched
 * start row (first end record at or after the start).
 */
export function pairDurations(
  startRows: MetricRow[],
  startInput: MetricInput,
  endRows: MetricRow[],
  endInput: MetricInput,
  via: IdentityKey,
  allRows: MetricRow[],
  idx: IdentityIndex = buildIdentityIndex(allRows),
): { days: number[]; unmatched: number } {
  const ends = new Map<string, number[]>();
  for (const r of endRows) {
    const ts = rowTime(r, endInput);
    if (!ts) continue;
    for (const k of identityKeys(r, via, idx)) ends.set(k, [...(ends.get(k) ?? []), Date.parse(ts)]);
  }
  const days: number[] = [];
  let unmatched = 0;
  for (const s of startRows) {
    const st = rowTime(s, startInput);
    const keys = st ? identityKeys(s, via, idx) : [];
    const startMs = st ? Date.parse(st) : NaN;
    const after = keys
      .flatMap((k) => ends.get(k) ?? [])
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

export function computeMetric(metric: GoalMetric, rows: MetricRow[], connections: ConnectionFreshness[], goalWindow: Window, now: Date, idx: IdentityIndex = buildIdentityIndex(rows)): MetricResult {
  const window = resolveWindow(metric.time_range, goalWindow, now);
  const providers = Object.values(metric.inputs).flatMap((i) => [i.provider, ...(i.require_match ?? []).map((r) => r.provider)]);
  const fresh = freshnessOf(providers, connections, now);
  const limitations = [...metric.limitations, ...fresh.limitations];
  const inputs: NonNullable<MetricResult["inputs"]> = {};
  const computed: Record<string, InputResult> = {};
  for (const [k, spec] of Object.entries(metric.inputs)) {
    const res = computeInput(spec, rows, window, idx);
    computed[k] = res;
    inputs[k] = { value: res.value, sample_size: res.sample_size, source: res.source };
    if (res.excluded_by_conditions) limitations.push(`${res.excluded_by_conditions} ${spec.resource_type}${res.excluded_by_conditions === 1 ? "" : "s"} did not meet every condition and ${res.excluded_by_conditions === 1 ? "was" : "were"} not counted.`);
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
    const paired = pairDurations(s.rows, sIn, e.rows, eIn, metric.duration.join.via, rows, idx);
    const agg = metric.duration.join.aggregation;
    if (metric.target != null && paired.days.length) {
      const within = paired.days.filter((d) => meetsTarget(d, metric)).length;
      limitations.push(`${within} of ${paired.days.length} matched pair${paired.days.length === 1 ? "" : "s"} meet${paired.days.length === 1 ? "s" : ""} the target individually${agg === "max" ? " (metric reports the slowest)" : ""}.`);
    }
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
  const idx = buildIdentityIndex(rows);
  for (const m of metrics) out[m.key] = computeMetric(m, rows, connections, goalWindow, now, idx);
  return out;
}
