import { z } from "zod";

/**
 * Goal interpretation contract. Everything the goal engine stores about a
 * goal's structure is validated against these schemas — including anything
 * the model proposes. Nothing here executes; it is configuration.
 */

export const GOAL_SCOPES = ["business", "personal", "financial"] as const;
export const METRIC_KINDS = ["count", "currency", "ratio", "duration_days", "percentage"] as const;
export const COMPARATORS = ["gte", "lte", "eq", "between"] as const;
export const AGGREGATIONS = ["sum", "count", "avg", "median", "max", "latest"] as const;
export const PROVIDERS_FOR_GOALS = ["highlevel", "stripe", "plaid", "meta", "google", "slack", "notion", "github", "n8n", "portal"] as const;
/** Keys two records can share so they can be joined (see metrics.ts identity resolution). */
export const IDENTITY_KEYS = ["email_hash", "contactId", "customerId", "client_id"] as const;
export type IdentityKey = (typeof IDENTITY_KEYS)[number];

/** Deterministic row filter over source_items. Exclusions are hard: a row they reject never reaches any computation or evidence view. */
export const MetricFilterSchema = z
  .object({
    status_in: z.array(z.string().max(40)).max(10).optional(),
    /** Hard exclusion by status (e.g. removed/deleted/churned/test accounts). */
    status_not_in: z.array(z.string().max(40)).max(10).optional(),
    stage_contains: z.array(z.string().max(40)).max(10).optional(),
    tags_any: z.array(z.string().max(40)).max(10).optional(),
    /** Hard exclusion by tag (e.g. "test"). */
    tags_none: z.array(z.string().max(40)).max(10).optional(),
    /** Case-insensitive substring match on the row title (any of). E.g. ["Right Fit Call"]. */
    title_contains: z.array(z.string().max(60)).max(10).optional(),
    metadata_equals: z.record(z.string().max(40), z.union([z.string().max(80), z.number(), z.boolean()])).optional(),
    metadata_truthy: z.array(z.string().max(40)).max(10).optional(),
    metadata_falsy: z.array(z.string().max(40)).max(10).optional(),
    /** Numeric lower bounds on metadata fields, e.g. { amount_paid: 100000 } (cents). */
    metadata_min: z.record(z.string().max(40), z.number()).optional(),
  })
  .default({});
export type MetricFilter = z.infer<typeof MetricFilterSchema>;

/**
 * Cross-source existence condition: a primary row only counts when a matching
 * record exists in another source for the same person (joined through
 * `via`). Lets a metric say "portal client WITH a calendar appointment AND a
 * HighLevel conversation".
 */
export const RequireMatchSchema = z.object({
  provider: z.enum(PROVIDERS_FOR_GOALS),
  resource_type: z.string().min(1).max(40),
  filter: MetricFilterSchema,
  /** How the two records are matched (default: hashed email). */
  via: z.enum(IDENTITY_KEYS).default("email_hash"),
  /** Only accept matching records dated inside the metric's time window (default true). */
  in_window: z.boolean().default(true),
  timestamp_field: z.string().max(60).optional(),
  /** Human label shown in provenance, e.g. "Right Fit Call on the calendar". */
  label: z.string().max(80).optional(),
});
export type RequireMatch = z.infer<typeof RequireMatchSchema>;

/** Where one metric input comes from. `filter` is matched against source_items (deterministically). */
export const MetricInputSchema = z.object({
  provider: z.enum(PROVIDERS_FOR_GOALS),
  resource_type: z.string().min(1).max(40),
  filter: MetricFilterSchema,
  aggregation: z.enum(AGGREGATIONS).default("count"),
  /** metadata field for sum/avg/median/max/latest (e.g. "amount", "spend"). */
  field: z.string().max(60).optional(),
  /** metadata field holding the timestamp used for duration pairing and time windows (defaults to source_timestamp). */
  timestamp_field: z.string().max(60).optional(),
  /** Every condition must hold for a row to count (AND). */
  require_match: z.array(RequireMatchSchema).max(6).optional(),
  /** Count each identity once (e.g. one client with three portal users counts once). */
  distinct_by: z.enum(IDENTITY_KEYS).optional(),
});
export type MetricInput = z.infer<typeof MetricInputSchema>;

export const TimeRangeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("goal_window") }),
    z.object({ kind: z.literal("trailing_days"), days: z.number().int().min(1).max(730) }),
    z.object({ kind: z.literal("since"), since: z.string().min(8).max(40) }),
  ])
  .default({ kind: "goal_window" });
export type TimeRange = z.infer<typeof TimeRangeSchema>;

export const DurationJoinSchema = z.object({
  /** how start and end records are matched to each other */
  via: z.enum(IDENTITY_KEYS).default("email_hash"),
  /** aggregation across matched pairs */
  aggregation: z.enum(["avg", "median", "max"]).default("median"),
});

export const GoalMetricSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name: z.string().min(1).max(120),
  kind: z.enum(METRIC_KINDS),
  /** currency targets are in MINOR units (cents). */
  target: z.number().nullable().default(null),
  comparator: z.enum(COMPARATORS).default("gte"),
  target_upper: z.number().nullable().default(null),
  unit: z.string().max(20).default(""),
  /** Safe arithmetic over input keys, e.g. "ad_spend / clients". */
  formula: z.string().max(200).default(""),
  /** Added to the computed value: progress that predates tracking ("Steve already signed counts as #1"). Count/currency metrics only. */
  baseline: z.number().default(0),
  /** Named inputs. count/currency/percentage metrics normally use a single "value" input. */
  inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), MetricInputSchema).default({}),
  /** duration_days only: which inputs are start/end and how they pair. */
  duration: z
    .object({ start: z.string().max(40), end: z.string().max(40), join: DurationJoinSchema.default({ via: "email_hash", aggregation: "median" }) })
    .optional(),
  time_range: TimeRangeSchema,
  is_primary: z.boolean().default(false),
  is_constraint: z.boolean().default(false),
  constraint_strength: z.enum(["soft", "hard"]).default("soft"),
  limitations: z.array(z.string().max(300)).max(10).default([]),
});
export type GoalMetric = z.infer<typeof GoalMetricSchema>;

export const GoalDriverSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name: z.string().min(1).max(80),
  input: MetricInputSchema,
  /** Implied requirement over the goal window (assumption-based). Null = informational only. */
  implied_target: z.number().nullable().default(null),
  assumption: z.string().max(300).optional(),
});
export type GoalDriver = z.infer<typeof GoalDriverSchema>;

export const AmbiguitySchema = z.object({
  field: z.string().min(1).max(80),
  question: z.string().min(1).max(400),
  options: z.array(z.string().max(160)).min(1).max(6),
  /** Chosen option or free text, set by the owner at approval time. */
  resolution: z.string().max(400).nullable().default(null),
});
export type Ambiguity = z.infer<typeof AmbiguitySchema>;

/** "Starting from X's sign date": which records to look for to find the start date. */
export const TimeframeAnchorSchema = z.object({
  description: z.string().min(1).max(160),
  /** Names/terms to look for in record titles (person or company), e.g. ["Steve Seaver", "Seaver"]. */
  search_terms: z.array(z.string().min(2).max(60)).min(1).max(5),
  /** Which kind of moment the anchor is. */
  event: z.enum(["signed", "first_payment", "created", "custom"]).default("signed"),
});
export type TimeframeAnchor = z.infer<typeof TimeframeAnchorSchema>;

export const GoalInterpretationSchema = z.object({
  name: z.string().min(1).max(140),
  outcome: z.string().min(1).max(600),
  timeframe: z.object({
    /** ISO dates; start may be null (= approval date). */
    start: z.string().nullable().default(null),
    end: z.string().nullable().default(null),
    days: z.number().int().min(1).max(3650).nullable().default(null),
    /** The window starts at a real-world event ("Steve Seaver's sign date"); resolved from synced records before review. */
    anchor: TimeframeAnchorSchema.nullable().default(null),
  }),
  metrics: z.array(GoalMetricSchema).min(1).max(12),
  constraints: z.array(z.string().max(300)).max(12).default([]),
  milestones: z.array(z.object({ name: z.string().max(120), due_in_days: z.number().int().min(0).max(3650).nullable().default(null), target: z.number().nullable().default(null) })).max(12).default([]),
  drivers: z.array(GoalDriverSchema).max(8).default([]),
  assumptions: z.array(z.string().max(300)).max(20).default([]),
  ambiguities: z.array(AmbiguitySchema).max(12).default([]),
  scope: z.enum(GOAL_SCOPES).default("business"),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type GoalInterpretation = z.infer<typeof GoalInterpretationSchema>;

export const TRAJECTORIES = ["on_track", "slightly_at_risk", "at_risk", "severely_at_risk", "unknown"] as const;
export type Trajectory = (typeof TRAJECTORIES)[number];

export const TRAJECTORY_LABEL: Record<Trajectory, string> = {
  on_track: "On track",
  slightly_at_risk: "Slightly at risk",
  at_risk: "At risk",
  severely_at_risk: "Severely at risk",
  unknown: "Not enough data",
};

/** Result of computing one metric. Everything the UI needs to show provenance. */
export interface MetricResult {
  key: string;
  value: number | null;
  unit: string;
  kind: GoalMetric["kind"];
  target: number | null;
  comparator: GoalMetric["comparator"];
  target_upper: number | null;
  source: string; // e.g. "highlevel opportunities (status won)"
  formula: string;
  time_range: { start: string; end: string };
  last_updated: string | null;
  sample_size: number;
  limitations: string[];
  freshness: "fresh" | "stale" | "missing";
  /** Constraint evaluation, when the metric has a target. */
  meets_target: boolean | null;
  inputs?: Record<string, { value: number | null; sample_size: number; source: string }>;
}

/* ------------------------------------------------------------------ */
/* Model-facing tool schema (strict tool use)                          */
/* ------------------------------------------------------------------ */

/**
 * Strict tool use only allows a JSON-schema subset: no `additionalProperties`
 * other than false (so no maps), no type arrays, no string/number bounds, at
 * most 24 optional parameters and at most 16 union-typed (anyOf) parameters
 * per request. The tool therefore takes `inputs` and `metadata_equals` as
 * ARRAYS of keyed entries, uses "" / 0 as "not set" for optional scalars, and
 * keeps anyOf-null only where a genuine null matters; `fromToolInput`
 * converts the model's output into the internal shape before Zod validation.
 */
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const strArray = { type: "array", items: { type: "string" } };

const FILTER_JSON_SCHEMA = {
  type: "object",
  properties: {
    status_in: strArray,
    status_not_in: strArray,
    stage_contains: strArray,
    tags_any: strArray,
    tags_none: strArray,
    title_contains: strArray,
    metadata_equals: { type: "array", items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"], additionalProperties: false } },
    metadata_truthy: strArray,
    metadata_falsy: strArray,
    metadata_min: { type: "array", items: { type: "object", properties: { key: { type: "string" }, value: { type: "number" } }, required: ["key", "value"], additionalProperties: false } },
  },
  // Strict tool use caps optional parameters (24 per request), so every field is required; empty arrays mean "no constraint".
  required: ["status_in", "status_not_in", "stage_contains", "tags_any", "tags_none", "title_contains", "metadata_equals", "metadata_truthy", "metadata_falsy", "metadata_min"],
  additionalProperties: false,
};

const REQUIRE_MATCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    provider: { type: "string", enum: [...PROVIDERS_FOR_GOALS] },
    resource_type: { type: "string" },
    filter: FILTER_JSON_SCHEMA,
    via: { type: "string", enum: [...IDENTITY_KEYS] },
    in_window: { type: "boolean" },
    timestamp_field: { type: "string" },
    label: { type: "string" },
  },
  required: ["provider", "resource_type", "filter", "via", "in_window", "timestamp_field", "label"],
  additionalProperties: false,
};

const INPUT_PROPERTIES = {
  provider: { type: "string", enum: [...PROVIDERS_FOR_GOALS] },
  resource_type: { type: "string" },
  filter: FILTER_JSON_SCHEMA,
  aggregation: { type: "string", enum: [...AGGREGATIONS] },
  field: { type: "string" },
  timestamp_field: { type: "string" },
  require_match: { type: "array", items: REQUIRE_MATCH_JSON_SCHEMA },
  distinct_by: { type: "string", enum: [...IDENTITY_KEYS, ""] },
};
const INPUT_REQUIRED = ["provider", "resource_type", "filter", "aggregation", "field", "timestamp_field", "require_match", "distinct_by"];

/** One keyed metric input: `key` is the variable name used in the formula ("value" for single-input metrics). */
const KEYED_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: { key: { type: "string" }, ...INPUT_PROPERTIES },
  required: ["key", ...INPUT_REQUIRED],
  additionalProperties: false,
};

/** JSON-schema mirror of GoalInterpretationSchema used for strict tool output from the model. */
export const GOAL_INTERPRETATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    outcome: { type: "string" },
    timeframe: {
      type: "object",
      properties: {
        start: nullable({ type: "string" }),
        end: nullable({ type: "string" }),
        days: nullable({ type: "integer" }),
        anchor: nullable({
          type: "object",
          properties: { description: { type: "string" }, search_terms: strArray, event: { type: "string", enum: ["signed", "first_payment", "created", "custom"] } },
          required: ["description", "search_terms", "event"],
          additionalProperties: false,
        }),
      },
      required: ["start", "end", "days", "anchor"],
      additionalProperties: false,
    },
    metrics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          name: { type: "string" },
          kind: { type: "string", enum: [...METRIC_KINDS] },
          target: nullable({ type: "number" }),
          comparator: { type: "string", enum: [...COMPARATORS] },
          target_upper: nullable({ type: "number" }),
          unit: { type: "string" },
          formula: { type: "string" },
          baseline: { type: "number" },
          inputs: { type: "array", items: KEYED_INPUT_JSON_SCHEMA },
          duration: {
            type: "object",
            properties: {
              start: { type: "string" },
              end: { type: "string" },
              join: { type: "object", properties: { via: { type: "string", enum: [...IDENTITY_KEYS] }, aggregation: { type: "string", enum: ["avg", "median", "max"] } }, required: ["via", "aggregation"], additionalProperties: false },
            },
            required: ["start", "end", "join"],
            additionalProperties: false,
          },
          time_range: {
            type: "object",
            properties: { kind: { type: "string", enum: ["goal_window", "trailing_days", "since"] }, days: { type: "integer" }, since: { type: "string" } },
            required: ["kind", "days", "since"],
            additionalProperties: false,
          },
          is_primary: { type: "boolean" },
          is_constraint: { type: "boolean" },
          constraint_strength: { type: "string", enum: ["soft", "hard"] },
          limitations: strArray,
        },
        required: ["key", "name", "kind", "target", "comparator", "target_upper", "unit", "formula", "baseline", "inputs", "time_range", "is_primary", "is_constraint", "constraint_strength", "limitations"],
        additionalProperties: false,
      },
    },
    constraints: strArray,
    milestones: { type: "array", items: { type: "object", properties: { name: { type: "string" }, due_in_days: { type: "integer" }, target: { type: "number" } }, required: ["name"], additionalProperties: false } },
    drivers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          name: { type: "string" },
          input: { type: "object", properties: INPUT_PROPERTIES, required: INPUT_REQUIRED, additionalProperties: false },
          implied_target: { type: "number" },
          assumption: { type: "string" },
        },
        required: ["key", "name", "input", "assumption"],
        additionalProperties: false,
      },
    },
    assumptions: strArray,
    ambiguities: {
      type: "array",
      items: { type: "object", properties: { field: { type: "string" }, question: { type: "string" }, options: strArray }, required: ["field", "question", "options"], additionalProperties: false },
    },
    scope: { type: "string", enum: [...GOAL_SCOPES] },
    confidence: { type: "number" },
  },
  required: ["name", "outcome", "timeframe", "metrics", "constraints", "milestones", "drivers", "assumptions", "ambiguities", "scope", "confidence"],
  additionalProperties: false,
} as const;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function filterFromTool(f: unknown): unknown {
  if (!isObj(f)) return f;
  const out: Json = {};
  for (const [k, v] of Object.entries(f)) {
    if (k === "metadata_equals" || k === "metadata_min") {
      if (Array.isArray(v)) {
        const rec: Record<string, string | number> = {};
        for (const e of v) if (isObj(e) && typeof e.key === "string" && (typeof e.value === "string" || typeof e.value === "number")) rec[e.key] = e.value;
        if (Object.keys(rec).length) out[k] = rec;
      } else if (isObj(v) && Object.keys(v).length) out[k] = v;
      continue;
    }
    // Empty arrays and nulls mean "no constraint".
    if (v == null || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

function inputFromTool(i: unknown): unknown {
  if (!isObj(i)) return i;
  const out: Json = { ...i };
  delete out.key;
  out.filter = filterFromTool(i.filter);
  if (Array.isArray(i.require_match) && i.require_match.length) {
    out.require_match = i.require_match.map((r) => {
      if (!isObj(r)) return r;
      const req: Json = { ...r, filter: filterFromTool(r.filter) };
      if (req.timestamp_field == null || req.timestamp_field === "") delete req.timestamp_field;
      if (req.label == null || req.label === "") delete req.label;
      return req;
    });
  } else delete out.require_match;
  for (const k of ["field", "timestamp_field", "distinct_by"]) if (out[k] == null || out[k] === "") delete out[k];
  return out;
}

/** Converts the strict tool output (arrays for maps, explicit nulls) into the internal interpretation shape. Accepts the internal shape unchanged. */
export function fromToolInput(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const out: Json = { ...raw };
  if (Array.isArray(raw.metrics)) {
    out.metrics = raw.metrics.map((m) => {
      if (!isObj(m)) return m;
      const metric: Json = { ...m };
      if (Array.isArray(m.inputs)) {
        const rec: Json = {};
        for (const i of m.inputs) if (isObj(i) && typeof i.key === "string") rec[i.key] = inputFromTool(i);
        metric.inputs = rec;
      } else if (isObj(m.inputs)) {
        metric.inputs = Object.fromEntries(Object.entries(m.inputs).map(([k, v]) => [k, inputFromTool(isObj(v) ? { ...v, key: k } : v)]));
      }
      if (metric.duration == null || (isObj(m.duration) && !m.duration.start)) delete metric.duration;
      if (isObj(m.time_range)) {
        const tr: Json = { ...m.time_range };
        if (tr.days == null || tr.days === 0) delete tr.days;
        if (tr.since == null || tr.since === "") delete tr.since;
        metric.time_range = tr;
      }
      return metric;
    });
  }
  if (Array.isArray(raw.drivers)) {
    out.drivers = raw.drivers.map((d) => {
      if (!isObj(d)) return d;
      const drv: Json = { ...d, input: inputFromTool(d.input) };
      if (drv.assumption == null || drv.assumption === "") delete drv.assumption;
      if (drv.implied_target === 0) drv.implied_target = null;
      return drv;
    });
  }
  return out;
}
