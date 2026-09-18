import { z } from "zod";

/**
 * BriefingSummary — the validated shape every briefing is stored in,
 * whether it came from the model or from the deterministic template.
 */

const Item = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().max(600).default(""),
  /** Where the reader can go: alert | finding | goal | commitment | mission | connection. */
  ref_kind: z.enum(["alert", "finding", "goal", "commitment", "obligation", "mission", "connection", "none"]).default("none"),
  ref_id: z.string().max(80).nullable().default(null),
  importance: z.enum(["informational", "briefing", "important", "urgent", "actionable"]).default("briefing"),
});
export type BriefingItem = z.infer<typeof Item>;

const GoalLine = z.object({
  goal_id: z.string().max(80),
  name: z.string().max(200),
  trajectory: z.string().max(40),
  progress: z.string().max(120),
  constraint: z.string().max(200).nullable().default(null),
  change: z.string().max(300).nullable().default(null),
});

const Metric = z.object({
  label: z.string().max(120),
  value: z.string().max(80),
  change: z.string().max(120).nullable().default(null),
  note: z.string().max(200).nullable().default(null),
});

export const BriefingSummarySchema = z
  .object({
    title: z.string().min(1).max(160),
    greeting: z.string().max(200).default(""),
    top_attention: z.array(Item).max(10),
    goals: z.array(GoalLine).max(20),
    today: z.array(Item).max(20),
    business_signals: z.array(Item).max(20),
    financial: z.array(Metric).max(20),
    recommends: z.array(Item).max(10),
    /** Weekly/monthly: what changed, wins, misses, whether previous changes worked. */
    changes: z.array(Item).max(20).default([]),
    wins: z.array(z.string().max(300)).max(10).default([]),
    misses: z.array(z.string().max(300)).max(10).default([]),
    outcomes: z.array(Item).max(10).default([]),
    freshness: z.array(z.string().max(200)).max(20).default([]),
    omitted_count: z.number().int().min(0).default(0),
    /** Rules/memories that shaped this brief (names only). */
    applied_preferences: z.array(z.string().max(160)).max(20).default([]),
  })
  .strict();
export type BriefingSummary = z.infer<typeof BriefingSummarySchema>;

/** JSON schema mirror for strict tool use (kept in sync by tests). */
const ITEM_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    detail: { type: "string" },
    ref_kind: { type: "string", enum: ["alert", "finding", "goal", "commitment", "obligation", "mission", "connection", "none"] },
    ref_id: { type: ["string", "null"] },
    importance: { type: "string", enum: ["informational", "briefing", "important", "urgent", "actionable"] },
  },
  required: ["title", "detail", "ref_kind", "ref_id", "importance"],
  additionalProperties: false,
} as const;

export const BRIEFING_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    greeting: { type: "string" },
    top_attention: { type: "array", items: ITEM_SCHEMA },
    goals: {
      type: "array",
      items: {
        type: "object",
        properties: { goal_id: { type: "string" }, name: { type: "string" }, trajectory: { type: "string" }, progress: { type: "string" }, constraint: { type: ["string", "null"] }, change: { type: ["string", "null"] } },
        required: ["goal_id", "name", "trajectory", "progress", "constraint", "change"],
        additionalProperties: false,
      },
    },
    today: { type: "array", items: ITEM_SCHEMA },
    business_signals: { type: "array", items: ITEM_SCHEMA },
    financial: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, change: { type: ["string", "null"] }, note: { type: ["string", "null"] } }, required: ["label", "value", "change", "note"], additionalProperties: false },
    },
    recommends: { type: "array", items: ITEM_SCHEMA },
    changes: { type: "array", items: ITEM_SCHEMA },
    wins: { type: "array", items: { type: "string" } },
    misses: { type: "array", items: { type: "string" } },
    outcomes: { type: "array", items: ITEM_SCHEMA },
    freshness: { type: "array", items: { type: "string" } },
    omitted_count: { type: "integer" },
    applied_preferences: { type: "array", items: { type: "string" } },
  },
  required: ["title", "greeting", "top_attention", "goals", "today", "business_signals", "financial", "recommends", "changes", "wins", "misses", "outcomes", "freshness", "omitted_count", "applied_preferences"],
  additionalProperties: false,
} as const;
