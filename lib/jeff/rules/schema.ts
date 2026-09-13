import { z } from "zod";

/**
 * Operating rules are CONFIGURATION, never code. Every field below is
 * validated with Zod before it is stored or evaluated; unknown keys are
 * rejected. Patterns are simple wildcards compiled with escaping — user input
 * is never turned into an arbitrary RegExp.
 */

export const MONITOR_IDS = [
  "lead_followup_gap",
  "pipeline_aging",
  "missed_commitment",
  "automation_failure",
  "operational_bottleneck",
  "failed_payment",
  "cashflow_change",
  "recurring_expense_change",
  "onboarding_blocker",
  "ad_spend_change",
  "underperforming_acquisition",
  "automation_opportunity",
  "portal_task_overdue",
  "portal_stage_stalled",
  "portal_notification_failure",
  "lead_not_contacted",
  "client_unpaid_invoice",
  "client_ad_spend_no_leads",
  "blind_spots",
  "follow_through",
  "goal_trajectory",
  "goal_coach",
  "relationship_quiet",
  "relationship_promise",
  "referral_source_declining",
  "contact_resurfaced",
  "important_date",
  "time_allocation_mismatch",
  "attention_fragmentation",
  "personal_project_stalled",
  "personal_renewal_due",
  "new_recurring_charge",
  "duplicate_tool",
  "price_increase",
  "unused_software",
  "annual_renewal_upcoming",
  "webhook_broken",
  "repeated_error",
  "manual_repetition",
  "client_engagement_drop",
  "client_missed_meeting",
  "client_negative_signal",
  "quiet_client",
  "client_scope_creep",
] as const;
export type MonitorId = (typeof MONITOR_IDS)[number];

/** Friendly aliases accepted in rules and chat; resolved to canonical ids. */
export const MONITOR_ALIASES: Record<string, MonitorId> = {
  open_commitments: "missed_commitment",
  open_commitment: "missed_commitment",
  commitments: "missed_commitment",
  missed_commitments: "missed_commitment",
  lead_followup: "lead_followup_gap",
  follow_up_gap: "lead_followup_gap",
  followup_gap: "lead_followup_gap",
  failed_payments: "failed_payment",
  cashflow: "cashflow_change",
  cash_flow: "cashflow_change",
  recurring_expenses: "recurring_expense_change",
  calendar_bottleneck: "operational_bottleneck",
  bottleneck: "operational_bottleneck",
  ad_spend: "ad_spend_change",
  ads: "ad_spend_change",
  underperforming_ads: "underperforming_acquisition",
  acquisition: "underperforming_acquisition",
  cost_per_lead: "underperforming_acquisition",
  overdue_tasks: "portal_task_overdue",
  portal_tasks: "portal_task_overdue",
  task_overdue: "portal_task_overdue",
  stalled_stages: "portal_stage_stalled",
  stage_stalled: "portal_stage_stalled",
  notification_failures: "portal_notification_failure",
  portal_notifications: "portal_notification_failure",
  uncontacted_leads: "lead_not_contacted",
  speed_to_lead: "lead_not_contacted",
  client_invoices: "client_unpaid_invoice",
  unpaid_invoices: "client_unpaid_invoice",
  client_ads: "client_ad_spend_no_leads",
  ad_spend_no_leads: "client_ad_spend_no_leads",
  blind_spot: "blind_spots",
  blindspot: "blind_spots",
  blindspots: "blind_spots",
  follow_through: "follow_through",
  "follow-through": "follow_through",
  obligations: "follow_through",
  obligation: "follow_through",
  reminders: "follow_through",
  reminder: "follow_through",
  "follow-through-watchdog": "follow_through",
  follow_through_watchdog: "follow_through",
  things_im_missing: "blind_spots",
  find_what_im_missing: "blind_spots",
  "find-what-im-missing": "blind_spots",
  "blind-spot-scanner": "blind_spots",
  goals: "goal_trajectory",
  goal: "goal_trajectory",
  goal_trajectories: "goal_trajectory",
  coach: "goal_coach",
  coaching: "goal_coach",
  "goal-coach": "goal_coach",
  relationships: "relationship_quiet",
  relationship: "relationship_quiet",
  relationship_radar: "relationship_quiet",
  "relationship-radar": "relationship_quiet",
  quiet_relationship: "relationship_quiet",
  quiet_relationships: "relationship_quiet",
  promises: "relationship_promise",
  promise: "relationship_promise",
  referral_sources: "referral_source_declining",
  referral_source: "referral_source_declining",
  referrals: "referral_source_declining",
  resurfaced: "contact_resurfaced",
  resurfaced_contacts: "contact_resurfaced",
  important_dates: "important_date",
  birthdays: "important_date",
  anniversaries: "important_date",
  time_allocation: "time_allocation_mismatch",
  "time-allocation": "time_allocation_mismatch",
  "time-allocation-auditor": "time_allocation_mismatch",
  time_allocation_auditor: "time_allocation_mismatch",
  attention: "attention_fragmentation",
  attention_cost: "attention_fragmentation",
  "attention-cost-detector": "attention_fragmentation",
  fragmentation: "attention_fragmentation",
  focus: "attention_fragmentation",
  personal_projects: "personal_project_stalled",
  personal_project: "personal_project_stalled",
  "personal-project-tracker": "personal_project_stalled",
  personal_project_tracker: "personal_project_stalled",
  personal_renewals: "personal_renewal_due",
  personal_renewal: "personal_renewal_due",
  new_charges: "new_recurring_charge",
  new_charge: "new_recurring_charge",
  new_subscription: "new_recurring_charge",
  new_subscriptions: "new_recurring_charge",
  duplicate_tools: "duplicate_tool",
  overlapping_tools: "duplicate_tool",
  price_increases: "price_increase",
  price_hike: "price_increase",
  unused_tools: "unused_software",
  unused_subscriptions: "unused_software",
  annual_renewals: "annual_renewal_upcoming",
  annual_renewal: "annual_renewal_upcoming",
  renewals: "annual_renewal_upcoming",
  broken_webhooks: "webhook_broken",
  webhooks: "webhook_broken",
  repeated_errors: "repeated_error",
  recurring_errors: "repeated_error",
  manual_work: "manual_repetition",
  repeated_manual_work: "manual_repetition",
  engagement_drop: "client_engagement_drop",
  client_engagement: "client_engagement_drop",
  missed_meetings: "client_missed_meeting",
  cancelled_meetings: "client_missed_meeting",
  negative_signals: "client_negative_signal",
  client_sentiment: "client_negative_signal",
  quiet_clients: "quiet_client",
  scope_creep: "client_scope_creep",
};

export const MONITOR_LABELS: Record<MonitorId, string> = {
  lead_followup_gap: "Lead follow-up gaps",
  pipeline_aging: "Pipeline aging",
  missed_commitment: "Open commitments",
  automation_failure: "Automation failures",
  operational_bottleneck: "Calendar bottlenecks",
  failed_payment: "Failed payments",
  cashflow_change: "Cash-flow changes",
  recurring_expense_change: "Recurring expense changes",
  onboarding_blocker: "Onboarding blockers",
  ad_spend_change: "Ad spend changes",
  underperforming_acquisition: "Underperforming acquisition",
  automation_opportunity: "Automation opportunities",
  portal_task_overdue: "Overdue portal tasks",
  portal_stage_stalled: "Stalled onboarding stages",
  portal_notification_failure: "Portal notification failures",
  lead_not_contacted: "Uncontacted leads",
  client_unpaid_invoice: "Client unpaid invoices",
  client_ad_spend_no_leads: "Client ad spend without leads",
  blind_spots: "Blind spots",
  follow_through: "Follow-Through (open obligations)",
  goal_trajectory: "Goal trajectory",
  goal_coach: "Goal coaching",
  relationship_quiet: "Relationships going quiet",
  relationship_promise: "Promises to people",
  referral_source_declining: "Referral sources declining",
  contact_resurfaced: "Contacts resurfacing",
  important_date: "Important dates",
  time_allocation_mismatch: "Time allocation vs goals",
  attention_fragmentation: "Attention fragmentation",
  personal_project_stalled: "Stalled personal projects",
  personal_renewal_due: "Personal renewals due",
  new_recurring_charge: "New recurring charges",
  duplicate_tool: "Duplicate tools",
  price_increase: "Price increases",
  unused_software: "Unused software",
  annual_renewal_upcoming: "Annual renewals upcoming",
  webhook_broken: "Broken notification channels",
  repeated_error: "Repeated workflow errors",
  manual_repetition: "Repeated manual work",
  client_engagement_drop: "Client engagement drops",
  client_missed_meeting: "Client missed meetings",
  client_negative_signal: "Client negative signals",
  quiet_client: "Quiet clients",
  client_scope_creep: "Client scope creep",
};

export function resolveMonitorId(id: string | null | undefined): MonitorId | null {
  if (!id) return null;
  const k = id.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((MONITOR_IDS as readonly string[]).includes(k)) return k as MonitorId;
  return MONITOR_ALIASES[k] ?? null;
}

const SOURCE_TYPES = ["email", "message", "contact", "opportunity", "event", "file", "charge", "invoice", "transaction", "subscription", "any"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
const AUTHOR_TYPES = ["human", "bot", "system"] as const;
const SEVERITIES = ["info", "low", "medium", "high"] as const;
const IMPORTANCE = ["informational", "briefing", "important", "urgent", "actionable"] as const;

/** Pattern: plain text (case-insensitive substring) or `*` wildcards; `^`/`$` anchors allowed. Max 200 chars, no control chars. */
const SafePattern = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !/[\p{Cc}]/u.test(s), "control characters are not allowed");

const SenderMatch = z
  .string()
  .min(1)
  .max(200)
  .toLowerCase()
  .refine((s) => /^(\*@)?[a-z0-9._%+\-*]+(@[a-z0-9.\-]+)?$/i.test(s.trim()), "sender must be an address, *@domain, or a domain");

export const RuleConditionSchema = z
  .object({
    source_type: z.enum(SOURCE_TYPES).optional(),
    provider: z.string().min(1).max(40).optional(),
    sender_matches: z.array(SenderMatch).max(50).optional(),
    sender_domain: z.array(z.string().min(1).max(200).toLowerCase()).max(50).optional(),
    author_type: z.array(z.enum(AUTHOR_TYPES)).max(3).optional(),
    subject_patterns: z.array(SafePattern).max(50).optional(),
    tags_any: z.array(z.string().min(1).max(60).toLowerCase()).max(50).optional(),
    metadata_equals: z.record(z.string().min(1).max(60), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
    amount_min: z.number().int().min(0).optional(),
    amount_max: z.number().int().min(0).optional(),
    confidence_max: z.number().min(0).max(1).optional(),
    monitor: z.string().min(1).max(60).optional(),
    category: z.string().min(1).max(60).optional(),
    severity_min: z.enum(SEVERITIES).optional(),
  })
  .strict();
export type RuleCondition = z.infer<typeof RuleConditionSchema>;

export const RuleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exclude") }).strict(),
  z.object({ type: z.literal("include") }).strict(),
  z.object({ type: z.literal("set_severity"), severity: z.enum(SEVERITIES) }).strict(),
  z.object({ type: z.literal("set_importance"), level: z.enum(IMPORTANCE) }).strict(),
  z.object({ type: z.literal("suppress_alert") }).strict(),
  z.object({ type: z.literal("require_min_confidence"), value: z.number().min(0).max(1) }).strict(),
  z.object({ type: z.literal("escalate"), level: z.enum(IMPORTANCE) }).strict(),
  // Follow-Through actions (obligations): configuration only, never code.
  z.object({ type: z.literal("set_tracking_mode"), mode: z.enum(["once", "persistent", "important", "critical"]) }).strict(),
  z.object({ type: z.literal("set_daily_cap"), value: z.number().int().min(0).max(24) }).strict(),
  z.object({ type: z.literal("briefing_only") }).strict(),
  z.object({ type: z.literal("no_escalation") }).strict(),
]);
export type RuleAction = z.infer<typeof RuleActionSchema>;

export const RuleTypeSchema = z.enum(["monitor_filter", "alert_policy", "briefing_pref", "classification"]);
export const ScopeSchema = z.enum(["business", "personal", "financial", "all"]);

export const RuleInputSchema = z
  .object({
    name: z.string().trim().min(3).max(140),
    description: z.string().trim().max(1000).optional(),
    rule_type: RuleTypeSchema.default("monitor_filter"),
    scope: ScopeSchema.default("business"),
    target_system: z.enum(["monitors", "alerts", "briefings", "chat"]).default("monitors"),
    target_monitor: z.string().max(60).nullable().optional(),
    /** Job slug: the rule applies only inside that job's runs (Jeff's Jobs). */
    target_job: z.string().max(60).nullable().optional(),
    conditions: RuleConditionSchema.default({}),
    action: RuleActionSchema.default({ type: "exclude" }),
    priority: z.number().int().min(0).max(1000).default(100),
    enabled: z.boolean().default(true),
  })
  .strict();
export type RuleInput = z.infer<typeof RuleInputSchema>;

export interface OperatingRule extends RuleInput {
  id: string;
  owner_id: string;
  tier: 1 | 2;
  pending_confirmation: boolean;
  source: "chat" | "settings" | "system" | "feedback";
  source_quote: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_triggered_at: string | null;
  trigger_count: number;
  target_monitor: string | null;
  target_job?: string | null;
}

export const MemoryCategorySchema = z.enum(["preference", "definition", "working_style", "priority", "dislike", "business_context", "personal_context", "communication_style", "exception"]);
export const MemoryInputSchema = z
  .object({
    content: z.string().trim().min(3).max(1000),
    category: MemoryCategorySchema.default("preference"),
    scope: ScopeSchema.default("business"),
    confidence: z.number().min(0).max(1).default(0.8),
  })
  .strict();
export type MemoryInput = z.infer<typeof MemoryInputSchema>;

/** Normalises free text for de-duplication of memories. */
export function normalizeContent(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

/** Compiles a safe wildcard pattern into a tester. Never uses user text as a RegExp body. */
export function compilePattern(pattern: string): (text: string) => boolean {
  const anchoredStart = pattern.startsWith("^");
  const anchoredEnd = pattern.endsWith("$");
  const core = pattern.slice(anchoredStart ? 1 : 0, anchoredEnd ? -1 : undefined);
  const parts = core.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const body = parts.join(".*");
  const re = new RegExp(`${anchoredStart ? "^" : ""}${body}${anchoredEnd ? "$" : ""}`, "i");
  return (text) => re.test(text);
}

/** Human-readable summary used in the UI and chat replies. */
export function describeRule(rule: { target_monitor?: string | null; conditions: RuleCondition; action: RuleAction }): string {
  const c = rule.conditions;
  const where: string[] = [];
  if (c.source_type && c.source_type !== "any") where.push(`${c.source_type}s`);
  if (c.provider) where.push(`from ${c.provider}`);
  if (c.sender_matches?.length) where.push(`sender ${c.sender_matches.join(", ")}`);
  if (c.sender_domain?.length) where.push(`sender domain ${c.sender_domain.join(", ")}`);
  if (c.author_type?.length) where.push(`${c.author_type.join("/")}-authored`);
  if (c.subject_patterns?.length) where.push(`subject matches "${c.subject_patterns.join('" or "')}"`);
  if (c.tags_any?.length) where.push(`tagged ${c.tags_any.join(", ")}`);
  if (c.amount_min != null) where.push(`amount ≥ $${(c.amount_min / 100).toFixed(2)}`);
  if (c.amount_max != null) where.push(`amount ≤ $${(c.amount_max / 100).toFixed(2)}`);
  if (c.confidence_max != null) where.push(`confidence ≤ ${c.confidence_max}`);
  if (c.severity_min) where.push(`severity ≥ ${c.severity_min}`);
  if (c.metadata_equals) where.push(Object.entries(c.metadata_equals).map(([k, v]) => `${k} = ${String(v)}`).join(", "));
  const target = rule.target_monitor ? (MONITOR_LABELS[resolveMonitorId(rule.target_monitor) ?? "missed_commitment"] ?? rule.target_monitor) : "all monitors";
  const a = rule.action;
  const verb =
    a.type === "exclude"
      ? "ignore"
      : a.type === "include"
        ? "always include"
        : a.type === "set_severity"
          ? `set severity to ${a.severity} for`
          : a.type === "set_importance"
            ? `treat as ${a.level}`
            : a.type === "suppress_alert"
              ? "do not alert on"
              : a.type === "require_min_confidence"
                ? `require confidence ≥ ${a.value} for`
                : a.type === "escalate"
                  ? `escalate to ${a.level}`
                  : a.type === "set_tracking_mode"
                    ? `track as ${a.mode} until resolved:`
                    : a.type === "set_daily_cap"
                      ? `at most ${a.value} reminder${a.value === 1 ? "" : "s"} per day for`
                      : a.type === "briefing_only"
                        ? "only mention in the daily brief:"
                        : "never escalate reminders for";
  return `${target} → ${verb} ${where.length ? where.join(" · ") : "everything"}`;
}
