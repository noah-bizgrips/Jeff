/**
 * One emoji per notification type so the owner can recognise a push at a glance.
 * Order of precedence for alerts: kind (goal/commitment) → category → importance.
 */
export const BRIEFING_EMOJI: Record<string, string> = { daily: "☀️", weekly: "📊", monthly: "🗓️" };

const CATEGORY_EMOJI: Record<string, string> = {
  goal_trajectory: "🎯",
  failed_payment: "💳",
  client_unpaid_invoice: "💳",
  cashflow_change: "📉",
  recurring_expense_change: "🔁",
  ad_spend_change: "📣",
  underperforming_acquisition: "📣",
  client_ad_spend_no_leads: "📣",
  lead_followup_gap: "🧲",
  lead_not_contacted: "🧲",
  pipeline_aging: "⏳",
  missed_commitment: "🤝",
  operational_bottleneck: "🗓️",
  automation_failure: "⚙️",
  automation_opportunity: "💡",
  portal_task_overdue: "📋",
  portal_stage_stalled: "🚧",
  portal_notification_failure: "📵",
};

const OPPORTUNITY_CATEGORIES = new Set(["automation_opportunity", "underperforming_acquisition", "lead_followup_gap", "pipeline_aging", "client_ad_spend_no_leads"]);

export function isOpportunityCategory(category: string | null | undefined): boolean {
  return !!category && OPPORTUNITY_CATEGORIES.has(category);
}

export function alertEmoji(a: { kind: string; category: string | null; importance: string }): string {
  if (a.kind === "goal") return "🎯";
  if (a.kind === "commitment") return "🤝";
  if (a.kind === "system") return "🛠️";
  if (a.category && CATEGORY_EMOJI[a.category]) return CATEGORY_EMOJI[a.category]!;
  if (isOpportunityCategory(a.category)) return "💡";
  if (a.importance === "urgent") return "🚨";
  if (a.importance === "actionable") return "🛠️";
  return "⚠️";
}
