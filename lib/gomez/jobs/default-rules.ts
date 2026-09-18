import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log } from "@/lib/security/log";
import { createRule, listRules } from "@/lib/gomez/rules/store";
import type { OperatingRule, RuleInput } from "@/lib/gomez/rules/schema";
import type { JobRow } from "./types";

/**
 * Per-job default rules (spec §12 / §86). Seeded once per owner per job as
 * ordinary Tier-1 rules with `target_job` set, so they show up in RULES with
 * the job name, can be disabled or deleted, and rank *below* anything the
 * owner writes (created_by "gomez", source "settings" → preference class).
 *
 * A job's `config.default_rules_seeded` marks the seed as done so deleting a
 * default never brings it back.
 */

export const DEFAULT_RULES_VERSION = 1;

export interface JobDefaultRule extends Omit<RuleInput, "target_job"> {
  slug: string;
}

export const JOB_DEFAULT_RULES: JobDefaultRule[] = [
  {
    slug: "relationship-radar",
    name: "Relationship Radar: skip LinkedIn notifications and casual LinkedIn contacts",
    description: "LinkedIn connection requests, InMail and digest emails are not relationships. Only people you actually correspond with count.",
    rule_type: "monitor_filter",
    scope: "all",
    target_system: "monitors",
    target_monitor: null,
    conditions: { source_type: "email", sender_domain: ["linkedin.com"] },
    action: { type: "exclude" },
    priority: 200,
    enabled: true,
  },
  {
    slug: "relationship-radar",
    name: "Relationship Radar: ignore bots and automated senders",
    description: "Newsletters, receipts and system notifications never count as contact with a person.",
    rule_type: "monitor_filter",
    scope: "all",
    target_system: "monitors",
    target_monitor: null,
    conditions: { author_type: ["bot", "system"] },
    action: { type: "exclude" },
    priority: 200,
    enabled: true,
  },
  {
    slug: "client-health-analyst",
    name: "Client Health: keep negative-language findings out of alerts",
    description: "Keyword sentiment is a weak signal. It goes in the briefing and the Findings list, never a push alert, unless you say otherwise.",
    rule_type: "alert_policy",
    scope: "business",
    target_system: "alerts",
    target_monitor: "client_negative_signal",
    conditions: { category: "client_negative_signal" },
    action: { type: "suppress_alert" },
    priority: 200,
    enabled: true,
  },
  {
    slug: "expense-creep-hunter",
    name: "Expense Creep: ignore new charges under $10",
    description: "Small one-off or trial charges are not worth an interruption. Raise or lower the threshold in this rule.",
    rule_type: "monitor_filter",
    scope: "financial",
    target_system: "monitors",
    target_monitor: "new_recurring_charge",
    conditions: { category: "new_recurring_charge", amount_max: 999 },
    action: { type: "exclude" },
    priority: 200,
    enabled: true,
  },
  {
    slug: "automation-auditor",
    name: "Automation Auditor: repeated manual work needs confidence ≥ 0.5",
    description: "Only propose automating something Gomez has seen enough times to be sure it repeats.",
    rule_type: "monitor_filter",
    scope: "business",
    target_system: "monitors",
    target_monitor: "manual_repetition",
    conditions: { category: "manual_repetition" },
    action: { type: "require_min_confidence", value: 0.5 },
    priority: 200,
    enabled: true,
  },
  {
    slug: "attention-cost-detector",
    name: "Attention Cost: briefing only",
    description: "Fragmented-week findings are for the weekly review, not push alerts.",
    rule_type: "alert_policy",
    scope: "all",
    target_system: "alerts",
    target_monitor: "attention_fragmentation",
    conditions: { category: "attention_fragmentation" },
    action: { type: "suppress_alert" },
    priority: 200,
    enabled: true,
  },
  {
    slug: "time-allocation-auditor",
    name: "Time Allocation: briefing only",
    description: "Where your week went is a weekly-review item, not an interruption.",
    rule_type: "alert_policy",
    scope: "all",
    target_system: "alerts",
    target_monitor: "time_allocation_mismatch",
    conditions: { category: "time_allocation_mismatch" },
    action: { type: "suppress_alert" },
    priority: 200,
    enabled: true,
  },
  {
    slug: "personal-project-tracker",
    name: "Personal Project Tracker: renewals stay in the briefing",
    description: "Personal renewals are surfaced in the Sunday briefing; nothing personal becomes a push alert by default.",
    rule_type: "alert_policy",
    scope: "personal",
    target_system: "alerts",
    target_monitor: "personal_renewal_due",
    conditions: { category: "personal_renewal_due" },
    action: { type: "suppress_alert" },
    priority: 200,
    enabled: true,
  },
  {
    slug: "personal-project-tracker",
    name: "Personal Project Tracker: stalled projects stay in the briefing",
    description: "A stalled personal project is a Sunday-review item, not a push alert.",
    rule_type: "alert_policy",
    scope: "personal",
    target_system: "alerts",
    target_monitor: "personal_project_stalled",
    conditions: { category: "personal_project_stalled" },
    action: { type: "suppress_alert" },
    priority: 200,
    enabled: true,
  },
  {
    slug: "blind-spot-scanner",
    name: "Find what I'm missing: only surface findings with confidence ≥ 0.4",
    description: "Blind spots are speculative by nature; anything Gomez is less than 40% sure about is dropped rather than shown.",
    rule_type: "monitor_filter",
    scope: "all",
    target_system: "monitors",
    target_monitor: "blind_spots",
    conditions: {},
    action: { type: "require_min_confidence", value: 0.4 },
    priority: 200,
    enabled: true,
  },
];

export function defaultRulesFor(slug: string): JobDefaultRule[] {
  return JOB_DEFAULT_RULES.filter((r) => r.slug === slug);
}

function seededVersion(job: JobRow): number {
  const v = job.config?.default_rules_seeded;
  return typeof v === "number" ? v : 0;
}

/** Seeds the default rules for any job that has not been seeded yet. Idempotent; never re-creates a rule the owner deleted. */
export async function ensureJobDefaultRules(ownerId: string, jobs: JobRow[], existing?: OperatingRule[]): Promise<{ created: number }> {
  const todo = jobs.filter((j) => j.system_managed && seededVersion(j) < DEFAULT_RULES_VERSION && defaultRulesFor(j.slug).length);
  if (!todo.length) return { created: 0 };
  const rules = existing ?? (await listRules(ownerId, { enabledOnly: false }).catch(() => [] as OperatingRule[]));
  const admin = createAdminClient();
  let created = 0;
  for (const job of todo) {
    for (const def of defaultRulesFor(job.slug)) {
      if (rules.some((r) => r.target_job === job.slug && r.name === def.name)) continue;
      const { slug, ...input } = def;
      const res = await createRule(ownerId, { ...input, target_job: slug }, { source: "settings", createdBy: "gomez", pendingConfirmation: false });
      if (res.ok) created++;
      else log.warn("job_default_rule_seed_failed", { slug, name: def.name, reason: res.reason });
    }
    const { error } = await admin
      .from("jobs")
      .update({ config: { ...(job.config ?? {}), default_rules_seeded: DEFAULT_RULES_VERSION } })
      .eq("id", job.id)
      .eq("owner_id", ownerId);
    if (error) log.warn("job_default_rule_mark_failed", { slug: job.slug, message: error.message });
  }
  return { created };
}
