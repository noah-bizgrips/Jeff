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
export const PROVIDERS_FOR_GOALS = ["highlevel", "stripe", "plaid", "meta", "google", "slack", "notion", "github", "n8n"] as const;

/** Where one metric input comes from. `filter` is matched against source_items (deterministically). */
export const MetricInputSchema = z.object({
  provider: z.enum(PROVIDERS_FOR_GOALS),
  resource_type: z.string().min(1).max(40),
  filter: z
    .object({
      status_in: z.array(z.string().max(40)).max(10).optional(),
      stage_contains: z.array(z.string().max(40)).max(10).optional(),
      tags_any: z.array(z.string().max(40)).max(10).optional(),
      metadata_equals: z.record(z.string().max(40), z.union([z.string().max(80), z.number(), z.boolean()])).optional(),
      metadata_truthy: z.array(z.string().max(40)).max(10).optional(),
    })
    .default({}),
  aggregation: z.enum(AGGREGATIONS).default("count"),
  /** metadata field for sum/avg/median/max/latest (e.g. "amount", "spend"). */
  field: z.string().max(60).optional(),
  /** metadata field holding the timestamp used for duration pairing and time windows (defaults to source_timestamp). */
  timestamp_field: z.string().max(60).optional(),
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
  via: z.enum(["email_hash", "contactId", "customerId"]).default("email_hash"),
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

export const GoalInterpretationSchema = z.object({
  name: z.string().min(1).max(140),
  outcome: z.string().min(1).max(600),
  timeframe: z.object({
    /** ISO dates; start may be null (= approval date). */
    start: z.string().nullable().default(null),
    end: z.string().nullable().default(null),
    days: z.number().int().min(1).max(3650).nullable().default(null),
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

/** JSON-schema mirror of GoalInterpretationSchema used for strict tool output from the model. */
export const GOAL_INTERPRETATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    outcome: { type: "string" },
    timeframe: {
      type: "object",
      properties: { start: { type: ["string", "null"] }, end: { type: ["string", "null"] }, days: { type: ["integer", "null"] } },
      required: ["start", "end", "days"],
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
          target: { type: ["number", "null"] },
          comparator: { type: "string", enum: [...COMPARATORS] },
          target_upper: { type: ["number", "null"] },
          unit: { type: "string" },
          formula: { type: "string" },
          inputs: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                provider: { type: "string", enum: [...PROVIDERS_FOR_GOALS] },
                resource_type: { type: "string" },
                filter: {
                  type: "object",
                  properties: {
                    status_in: { type: "array", items: { type: "string" } },
                    stage_contains: { type: "array", items: { type: "string" } },
                    tags_any: { type: "array", items: { type: "string" } },
                    metadata_truthy: { type: "array", items: { type: "string" } },
                  },
                  additionalProperties: false,
                },
                aggregation: { type: "string", enum: [...AGGREGATIONS] },
                field: { type: "string" },
                timestamp_field: { type: "string" },
              },
              required: ["provider", "resource_type"],
              additionalProperties: false,
            },
          },
          duration: {
            type: ["object", "null"],
            properties: {
              start: { type: "string" },
              end: { type: "string" },
              join: { type: "object", properties: { via: { type: "string", enum: ["email_hash", "contactId", "customerId"] }, aggregation: { type: "string", enum: ["avg", "median", "max"] } }, additionalProperties: false },
            },
            required: ["start", "end"],
            additionalProperties: false,
          },
          time_range: {
            type: "object",
            properties: { kind: { type: "string", enum: ["goal_window", "trailing_days", "since"] }, days: { type: "integer" }, since: { type: "string" } },
            required: ["kind"],
            additionalProperties: false,
          },
          is_primary: { type: "boolean" },
          is_constraint: { type: "boolean" },
          constraint_strength: { type: "string", enum: ["soft", "hard"] },
          limitations: { type: "array", items: { type: "string" } },
        },
        required: ["key", "name", "kind", "target", "comparator", "unit", "formula", "inputs", "time_range", "is_primary", "is_constraint"],
        additionalProperties: false,
      },
    },
    constraints: { type: "array", items: { type: "string" } },
    milestones: { type: "array", items: { type: "object", properties: { name: { type: "string" }, due_in_days: { type: ["integer", "null"] }, target: { type: ["number", "null"] } }, required: ["name"], additionalProperties: false } },
    drivers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          name: { type: "string" },
          input: { type: "object", properties: { provider: { type: "string" }, resource_type: { type: "string" }, filter: { type: "object" }, aggregation: { type: "string" }, field: { type: "string" } }, required: ["provider", "resource_type"] },
          implied_target: { type: ["number", "null"] },
          assumption: { type: "string" },
        },
        required: ["key", "name", "input"],
        additionalProperties: false,
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
    ambiguities: {
      type: "array",
      items: { type: "object", properties: { field: { type: "string" }, question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["field", "question", "options"], additionalProperties: false },
    },
    scope: { type: "string", enum: [...GOAL_SCOPES] },
    confidence: { type: "number" },
  },
  required: ["name", "outcome", "timeframe", "metrics", "assumptions", "ambiguities", "scope", "confidence"],
  additionalProperties: false,
} as const;
