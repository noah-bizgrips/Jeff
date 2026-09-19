import { inQuietHours, type OwnerSettings, type Importance } from "@/lib/jeff/settings";
import { isOpportunityCategory } from "./emoji";

/**
 * Pure decision: should this alert be pushed to the owner's devices right now?
 * - urgent: always (quiet hours do not apply to genuinely urgent items)
 * - important / actionable: only when push_alerts is on and we are outside
 *   quiet hours (deferred alerts are pushed on the first run after the window ends)
 * - informational / briefing-level: never pushed
 * - one push per (alert, importance): a repeat of the same condition is not
 *   re-pushed; an escalation to a higher importance is.
 * - groups (kind "group"): one push per group per importance level, plus a
 *   re-push when the group has grown by GROUP_REPUSH_GROWTH members since the
 *   last push ("6 overdue tasks" → "9 overdue tasks" is news; 6 → 7 is not).
 */
export interface PushableAlert {
  id: string;
  status: string;
  kind?: string;
  category?: string | null;
  importance: Importance;
  deferred_until: string | null;
  pushed_at: string | null;
  pushed_importance: string | null;
  /** Groups only: live member count now, and at the last push. */
  member_count?: number | null;
  member_count_pushed?: number | null;
}

const RANK: Record<Importance, number> = { informational: 0, briefing: 1, important: 2, actionable: 2, urgent: 3 };
export const GROUP_REPUSH_GROWTH = 3;

function groupGrew(alert: PushableAlert): boolean {
  return alert.kind === "group" && typeof alert.member_count === "number" && alert.member_count - (alert.member_count_pushed ?? 0) >= GROUP_REPUSH_GROWTH;
}

export function shouldPushAlert(
  alert: PushableAlert,
  settings: Pick<OwnerSettings, "push_alerts" | "push_goal_alerts" | "push_opportunity_alerts" | "timezone" | "quiet_hours_start" | "quiet_hours_end">,
  now: Date,
): boolean {
  if (alert.status !== "open") return false;
  if (alert.category === "blind_spot") return false; // batched daily by the blind-spot runner
  // Goal and opportunity alerts have their own toggles and also push at "briefing" importance
  // (they are rarely urgent but the owner asked to hear about them as they happen).
  const isGoal = alert.kind === "goal";
  const isOpportunity = alert.kind === "finding" && isOpportunityCategory(alert.category);
  const minRank = (isGoal && settings.push_goal_alerts) || (isOpportunity && settings.push_opportunity_alerts) ? 1 : 2;
  if ((RANK[alert.importance] ?? 0) < minRank) return false;
  if (alert.pushed_at && alert.pushed_importance) {
    const prev = RANK[alert.pushed_importance as Importance] ?? 0;
    if (RANK[alert.importance] <= prev && !groupGrew(alert)) return false;
  }
  if (alert.importance === "urgent") return true;
  if (isGoal && !settings.push_goal_alerts) return false;
  if (isOpportunity && !settings.push_opportunity_alerts) return false;
  if (!isGoal && !isOpportunity && !settings.push_alerts) return false;
  if (alert.deferred_until && Date.parse(alert.deferred_until) > now.getTime()) return false;
  if (inQuietHours(now, settings)) return false;
  return true;
}

export function shouldPushBriefing(settings: Pick<OwnerSettings, "push_briefings">): boolean {
  return settings.push_briefings;
}
