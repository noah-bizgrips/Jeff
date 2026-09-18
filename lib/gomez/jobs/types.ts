import { z } from "zod";
import type { CandidateFinding, GoalLite, MemoryLite, ObligationLite, SourceRow } from "@/lib/gomez/monitors/types";
import type { ProviderFreshness } from "@/lib/gomez/freshness";

/**
 * Gomez's Jobs — recurring responsibilities Gomez owns. A Job is DECLARATIVE:
 * a bundle of detector ids, the sources it may look at, a schedule and a
 * notification policy. No job ever carries executable code.
 */

export const JOB_SCOPES = ["business", "personal", "financial", "all"] as const;
export type JobScope = (typeof JOB_SCOPES)[number];
export const JOB_TYPES = ["system", "user", "custom"] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JOB_STATUSES = ["active", "paused", "draft", "disabled", "error"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const SCHEDULE_TYPES = ["continuous", "event_driven", "hourly", "daily", "weekly", "monthly", "custom", "manual"] as const;
export type ScheduleType = (typeof SCHEDULE_TYPES)[number];
export const RUN_MODES = ["test", "run", "scheduled"] as const;
export type RunMode = (typeof RUN_MODES)[number];
export const IMPORTANCE = ["informational", "briefing", "important", "urgent", "actionable"] as const;

export const NotificationPolicySchema = z
  .object({
    /** Alerts below this importance are stored only (never pushed). */
    min_importance: z.enum(IMPORTANCE).default("important"),
    /** Whether this job may push at all. */
    push: z.boolean().default(true),
    /** Cap every alert from this job at briefing importance (next brief only). */
    briefing_only: z.boolean().default(false),
    /** Max NEW alerts this job may raise per owner-local day; the rest become informational. */
    max_per_day: z.number().int().min(0).max(50).default(5),
  })
  .strict();
export type NotificationPolicy = z.infer<typeof NotificationPolicySchema>;

/** Validated subset of cron syntax: "m h dom mon dow" with numbers, *, lists and steps only. */
const CRON_FIELD = /^(\*|\d{1,2}(-\d{1,2})?)(,(\*|\d{1,2}(-\d{1,2})?))*(\/\d{1,2})?$/;
export const CustomScheduleSchema = z.string().refine((s) => {
  const parts = s.trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => CRON_FIELD.test(p));
}, "custom schedule must be 5 cron fields using digits, *, ranges, lists or steps");

export const JobInputSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(3)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
    name: z.string().trim().min(3).max(80),
    icon: z.string().trim().max(24).default("briefcase"),
    description: z.string().trim().max(600).default(""),
    purpose: z.string().trim().max(2000).default(""),
    scope: z.enum(JOB_SCOPES).default("business"),
    job_type: z.enum(JOB_TYPES).default("custom"),
    status: z.enum(JOB_STATUSES).default("active"),
    schedule_type: z.enum(SCHEDULE_TYPES).default("daily"),
    schedule_expression: z.string().trim().max(60).nullable().default(null),
    timezone: z.string().trim().max(64).nullable().default(null),
    notification_policy: NotificationPolicySchema.default({ min_importance: "important", push: true, briefing_only: false, max_per_day: 5 }),
    minimum_severity: z.enum(["info", "low", "medium", "high"]).default("low"),
    sources: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    detectors: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type JobInput = z.infer<typeof JobInputSchema>;

/** Fields the owner may change on any job (system jobs included). Declared without defaults so a partial patch never resets untouched fields. */
export const JobPatchSchema = z
  .object({
    name: z.string().trim().min(3).max(80).optional(),
    description: z.string().trim().max(600).optional(),
    purpose: z.string().trim().max(2000).optional(),
    scope: z.enum(JOB_SCOPES).optional(),
    status: z.enum(JOB_STATUSES).optional(),
    schedule_type: z.enum(SCHEDULE_TYPES).optional(),
    schedule_expression: z.string().trim().max(60).nullable().optional(),
    timezone: z.string().trim().max(64).nullable().optional(),
    notification_policy: NotificationPolicySchema.optional(),
    minimum_severity: z.enum(["info", "low", "medium", "high"]).optional(),
    sources: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    detectors: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type JobPatch = z.infer<typeof JobPatchSchema>;

export interface JobRow extends JobInput {
  id: string;
  owner_id: string;
  system_managed: boolean;
  created_by: string;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  findings_30d: number;
  created_at: string;
  updated_at: string;
}

export interface CoverageEntry {
  source: string;
  status: "ok" | "missing" | "stale" | "error";
  freshness: string;
}

export interface RunStats {
  records_considered: number;
  candidates: number;
  rules_matched: number;
  findings_created: number;
  findings_updated: number;
  findings_resolved: number;
  duplicates_suppressed: number;
  alerts_created: number;
  ai_calls: number;
  tokens: number;
  cost_usd: number;
  progress?: string;
  notes?: string[];
}

export interface JobRunRow {
  id: string;
  owner_id: string;
  job_id: string;
  mode: RunMode;
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  coverage: CoverageEntry[];
  stats: Partial<RunStats>;
  results: TestResult[];
  error: string | null;
  created_at: string;
}

/** A would-be finding shown in TEST MODE (bounded, never persisted as a finding). */
export interface TestResult {
  fingerprint: string;
  category: string;
  title: string;
  severity: CandidateFinding["severity"];
  confidence: number;
  observed_facts: string[];
  interpretation: string;
  evidence_count: number;
  evidence: { title: string | null; url: string | null; provider: string }[];
  limitations: string;
  /** Already exists as an active finding (would be an update, not new). */
  existing: boolean;
}

/** Extra context a detector may declare via `needs`; loaded once per run. */
export type DetectorNeed = "goals" | "memories" | "obligations" | "owner";

/** What a job detector receives. Rows are already filtered by owner rules. */
export interface DetectorContext {
  now: Date;
  rows: SourceRow[];
  freshness: ProviderFreshness[];
  job: JobRow;
  ownerEmail?: string | null;
  goals?: GoalLite[];
  memories?: MemoryLite[];
  obligations?: ObligationLite[];
  /** Owner timezone (from settings) for calendar math. */
  timezone?: string;
}

/**
 * Detector registry entry. Detectors are pure (rows in → candidates out).
 * `monitor` wraps an existing lib/gomez/monitors monitor; `custom` runs a
 * job-only detector; `special` hands off to a subsystem (goals, blind spots)
 * whose runner is invoked by the job runner rather than as a pure function.
 */
export type DetectorKind = "monitor" | "custom" | "special";

export interface DetectorSpec {
  id: string;
  label: string;
  kind: DetectorKind;
  /** Providers whose data this detector reads (for coverage). */
  sources: string[];
  /** Categories it emits (for auto-resolve scoping of custom detectors). */
  categories: string[];
  /** Extra context the detector needs beyond rows (loaded by the runner). */
  needs?: DetectorNeed[];
  /** Pure detector (monitor/custom). Undefined for `special`. */
  run?: (ctx: DetectorContext) => CandidateFinding[];
}

export type ProgressStep =
  | "preparing"
  | "reviewing_goals"
  | "business_signals"
  | "commitments"
  | "obligations"
  | "financial"
  | "patterns"
  | "novel"
  | "ranking"
  | "complete";

export const PROGRESS_STEPS: ProgressStep[] = ["preparing", "reviewing_goals", "business_signals", "commitments", "obligations", "financial", "patterns", "novel", "ranking", "complete"];

export const PROGRESS_LABEL: Record<ProgressStep, string> = {
  preparing: "Preparing scan",
  reviewing_goals: "Reviewing goals",
  business_signals: "Checking business signals",
  commitments: "Checking commitments",
  obligations: "Checking unresolved obligations",
  financial: "Checking financial changes",
  patterns: "Comparing recent patterns",
  novel: "Looking for novel blind spots",
  ranking: "Ranking findings",
  complete: "Complete",
};
