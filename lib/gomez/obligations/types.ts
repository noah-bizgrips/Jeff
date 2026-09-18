import { z } from "zod";

/**
 * Follow-Through — Open Obligations.
 *
 * The governing rule: an obligation is resolved when the underlying thing
 * actually happened (or the owner explicitly dismissed/cancelled it), never
 * because a reminder was delivered.
 */

export const OBLIGATION_STATUSES = ["open", "due", "overdue", "waiting_on_me", "waiting_on_other", "possibly_complete", "completed", "dismissed", "cancelled", "snoozed"] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];
/** Statuses that still need something to happen. */
export const LIVE_STATUSES: ObligationStatus[] = ["open", "due", "overdue", "waiting_on_me", "waiting_on_other", "possibly_complete", "snoozed"];
export const TERMINAL_STATUSES: ObligationStatus[] = ["completed", "dismissed", "cancelled"];

export const TRACKING_MODES = ["once", "persistent", "important", "critical"] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];
export const PRIORITIES = ["low", "normal", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const SCOPES = ["business", "personal", "financial", "all"] as const;
export type ObligationScope = (typeof SCOPES)[number];

export const STRATEGY_KINDS = ["outbound_message", "payment", "calendar_event", "deploy", "workflow_run", "crm_activity", "cancellation", "manual", "custom"] as const;
export type StrategyKind = (typeof STRATEGY_KINDS)[number];

export const CompletionStrategySchema = z
  .object({
    kind: z.enum(STRATEGY_KINDS).default("manual"),
    match: z
      .object({
        people: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
        keywords: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
        amount_minor: z.number().int().nonnegative().nullable().default(null),
        provider: z.string().max(40).nullable().default(null),
        vendor: z.string().max(80).nullable().default(null),
      })
      .default({ people: [], keywords: [], amount_minor: null, provider: null, vendor: null }),
    /** Confidence at or above which Gomez may close the obligation on its own. */
    min_confidence: z.number().min(0.5).max(1).default(0.85),
    /** Human wording of what counts as done, shown in the UI. */
    description: z.string().max(300).nullable().default(null),
  })
  .strict();
export type CompletionStrategy = z.infer<typeof CompletionStrategySchema>;

export const CadenceSchema = z
  .object({
    /** Hours between follow-up reminders for persistent modes. */
    follow_up_hours: z.number().min(1).max(168).nullable().default(null),
    business_hours_only: z.boolean().default(true),
    /** Max reminders per owner-local day for this obligation. */
    daily_cap: z.number().int().min(0).max(24).default(2),
    /** Hours overdue after which importance escalates one level. */
    escalate_after_hours: z.number().min(1).max(720).nullable().default(null),
    /** Only surface in briefings, never as a separate reminder. */
    briefing_only: z.boolean().default(false),
    /** Rules may pin escalation off (e.g. low-priority personal errands). */
    no_escalation: z.boolean().default(false),
  })
  .strict();
export type Cadence = z.infer<typeof CadenceSchema>;

export const DEFAULT_CADENCE: Cadence = { follow_up_hours: null, business_hours_only: true, daily_cap: 2, escalate_after_hours: null, briefing_only: false, no_escalation: false };

export interface EvidenceRef {
  source_item_id: string | null;
  provider: string;
  external_id: string | null;
  url: string | null;
  title: string | null;
  observed_at: string | null;
  /** Why this record supports completion (one sentence, no raw content). */
  reason: string;
}

export const ObligationInputSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(2000).nullable().default(null),
    scope: z.enum(SCOPES).default("business"),
    origin: z.string().trim().max(40).default("gomez"),
    assigned_to: z.enum(["me", "other"]).default("me"),
    waiting_on: z.string().trim().max(120).nullable().default(null),
    priority: z.enum(PRIORITIES).default("normal"),
    due_at: z.string().datetime({ offset: true }).nullable().default(null),
    remind_at: z.string().datetime({ offset: true }).nullable().default(null),
    tracking_mode: z.enum(TRACKING_MODES).default("once"),
    completion_strategy: CompletionStrategySchema.default({ kind: "manual", match: { people: [], keywords: [], amount_minor: null, provider: null, vendor: null }, min_confidence: 0.85, description: null }),
    cadence: CadenceSchema.partial().default({}),
    related_goal_id: z.string().uuid().nullable().default(null),
    related_mission_id: z.string().uuid().nullable().default(null),
    related_client_id: z.string().max(80).nullable().default(null),
    counterparty: z.string().trim().max(120).nullable().default(null),
    source_provider: z.string().max(40).nullable().default(null),
    source_external_id: z.string().max(200).nullable().default(null),
    source_url: z.string().url().max(2000).nullable().default(null),
    commitment_id: z.string().uuid().nullable().default(null),
    fingerprint: z.string().max(200).nullable().default(null),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type ObligationInput = z.infer<typeof ObligationInputSchema>;

export interface ObligationRow {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  scope: ObligationScope;
  origin: string;
  source_provider: string | null;
  source_external_id: string | null;
  source_url: string | null;
  commitment_id: string | null;
  assigned_to: "me" | "other";
  waiting_on: string | null;
  status: ObligationStatus;
  priority: Priority;
  due_at: string | null;
  remind_at: string | null;
  snoozed_until: string | null;
  tracking_mode: TrackingMode;
  completion_strategy: CompletionStrategy;
  completion_confidence: number | null;
  completion_evidence: EvidenceRef[];
  completion_question: string | null;
  cadence: Partial<Cadence>;
  escalation_level: number;
  reminder_count: number;
  last_checked_at: string | null;
  last_reminded_at: string | null;
  next_reminder_at: string | null;
  related_goal_id: string | null;
  related_mission_id: string | null;
  related_client_id: string | null;
  counterparty: string | null;
  fingerprint: string | null;
  metadata: Record<string, unknown>;
  completed_at: string | null;
  dismissed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export const EVENT_KINDS = ["created", "reminded", "snoozed", "dismissed", "cancelled", "completed", "auto_completed", "possibly_complete", "confirmed", "reopened", "escalated", "note", "context_trigger", "source_linked", "tracking_stopped", "cadence_changed"] as const;
export type ObligationEventKind = (typeof EVENT_KINDS)[number];

export interface ObligationEventRow {
  id: number;
  obligation_id: string;
  kind: ObligationEventKind;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ObligationSourceRow {
  id: string;
  obligation_id: string;
  provider: string;
  external_id: string;
  url: string | null;
  kind: string | null;
  is_primary: boolean;
}

export const OBLIGATION_ACTIONS = ["complete", "confirm_complete", "not_complete", "snooze", "dismiss", "cancel", "reopen", "stop_tracking", "set_cadence", "set_strategy", "set_tracking_mode"] as const;
export type ObligationAction = (typeof OBLIGATION_ACTIONS)[number];

export const ObligationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("complete"), note: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal("confirm_complete") }).strict(),
  z.object({ action: z.literal("not_complete") }).strict(),
  z.object({ action: z.literal("snooze"), until: z.string().datetime({ offset: true }) }).strict(),
  z.object({ action: z.literal("dismiss"), note: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal("cancel"), note: z.string().max(500).optional() }).strict(),
  z.object({ action: z.literal("reopen") }).strict(),
  z.object({ action: z.literal("stop_tracking") }).strict(),
  z.object({ action: z.literal("set_cadence"), cadence: CadenceSchema.partial() }).strict(),
  z.object({ action: z.literal("set_strategy"), completion_strategy: CompletionStrategySchema }).strict(),
  z.object({ action: z.literal("set_tracking_mode"), tracking_mode: z.enum(TRACKING_MODES) }).strict(),
]);
export type ObligationActionInput = z.infer<typeof ObligationActionSchema>;

/** Derives the "live" status bucket shown in the queue. */
export function bucketOf(o: Pick<ObligationRow, "status" | "due_at" | "assigned_to" | "snoozed_until">, now: Date): "overdue" | "waiting_on_me" | "waiting_on_other" | "possibly_complete" | "snoozed" | "done" {
  if (TERMINAL_STATUSES.includes(o.status)) return "done";
  if (o.status === "snoozed" && o.snoozed_until && Date.parse(o.snoozed_until) > now.getTime()) return "snoozed";
  if (o.status === "possibly_complete") return "possibly_complete";
  if (o.assigned_to === "other" || o.status === "waiting_on_other") return "waiting_on_other";
  if (o.due_at && Date.parse(o.due_at) < now.getTime()) return "overdue";
  return "waiting_on_me";
}

export function isLive(status: ObligationStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

/** Stable fingerprint for dedupe across sources: normalised title + due day + people. */
export function obligationFingerprint(title: string, dueAt: string | null, people: string[] = []): string {
  const t = title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an|to|for|with|and|please|re|fwd)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const day = dueAt ? dueAt.slice(0, 10) : "nodate";
  const p = people
    .map((x) => x.toLowerCase().trim())
    .filter(Boolean)
    .sort()
    .join(",");
  return `ob:${t}|${day}|${p}`;
}
