import { resolveMonitorId, type RuleInput } from "./schema";

/**
 * Safety tiers (spec §5).
 * Tier 1 — safe/reversible: applied immediately.
 * Tier 2 — important behavioural change: created disabled, needs confirmation.
 * Tier 3 — protected: refused outright. Learned rules can never touch these.
 */

export type TierResult = { tier: 1 | 2; reason: string } | { tier: 3; refused: true; reason: string };

/**
 * Vocabulary that marks a rule as touching a protected area. Rules only ever
 * configure monitors/alerts/briefings/chat, so anything about auth, secrets,
 * approvals, permissions or money movement is refused outright.
 */
const PROTECTED = /\b(auth(entication)?|log-?in|mfa|2fa|totp|aal2|rls|row[- ]level|encrypt(ion|ed)?|credential(s)?|secret(s| key)?|api[- ]key|password(s)?|approval(s| gate)?|approve|audit( log)?|permission(s)?|webhook signature|csp|refund(s)?|payout(s)?|money movement|charge (a |the )?customer|transfer funds)\b/i;

const FINANCIAL_MONITORS = new Set(["failed_payment", "cashflow_change", "recurring_expense_change"]);

function mentionsProtected(text: string): string | null {
  const m = text.match(PROTECTED);
  return m ? m[0] : null;
}

/** Counts how narrow the conditions are (0 = whole monitor). */
function narrowness(rule: RuleInput): number {
  const c = rule.conditions;
  return [c.sender_matches?.length, c.sender_domain?.length, c.author_type?.length, c.subject_patterns?.length, c.tags_any?.length, c.metadata_equals && Object.keys(c.metadata_equals).length, c.amount_min != null ? 1 : 0, c.amount_max != null ? 1 : 0, c.confidence_max != null ? 1 : 0, c.provider ? 1 : 0].filter((n) => (n ?? 0) > 0).length;
}

export function classifyTier(rule: RuleInput): TierResult {
  const hay = `${rule.name} ${rule.description ?? ""} ${rule.target_system} ${JSON.stringify(rule.conditions)} ${JSON.stringify(rule.action)}`;
  if (!["monitors", "alerts", "briefings", "chat"].includes(rule.target_system)) {
    return { tier: 3, refused: true, reason: "Rules can only target monitors, alerts, briefings, or chat behaviour." };
  }
  const hit = mentionsProtected(hay);
  if (hit) {
    return { tier: 3, refused: true, reason: `This touches a protected area ("${hit}"). Security, access, approvals, secrets and money-movement safeguards cannot be changed by learned rules.` };
  }
  const monitor = resolveMonitorId(rule.target_monitor);
  const broad = narrowness(rule) === 0;
  if (rule.action.type === "exclude" || rule.action.type === "suppress_alert") {
    if (broad && monitor && FINANCIAL_MONITORS.has(monitor)) return { tier: 2, reason: `Muting the entire "${monitor}" financial monitor is an important change and needs your confirmation.` };
    if (broad && !monitor) return { tier: 2, reason: "Excluding everything across all monitors is too broad to apply automatically." };
    if (rule.conditions.metadata_equals && Object.keys(rule.conditions.metadata_equals).some((k) => /stage|pipeline/i.test(k))) return { tier: 2, reason: "Excluding a CRM stage changes what counts as a lead; please confirm." };
    return { tier: 1, reason: "Suppressing a specific pattern is safe and reversible." };
  }
  if (rule.action.type === "require_min_confidence") return { tier: 1, reason: "Confidence thresholds are safe and reversible." };
  if (rule.action.type === "set_severity" || rule.action.type === "set_importance" || rule.action.type === "escalate" || rule.action.type === "include") {
    if (rule.conditions.amount_min != null && rule.conditions.amount_min >= 100_000_00) return { tier: 2, reason: "Large KPI/threshold changes need confirmation." };
    return { tier: 1, reason: "Adjusting importance for a specific pattern is safe and reversible." };
  }
  return { tier: 1, reason: "Safe and reversible." };
}
