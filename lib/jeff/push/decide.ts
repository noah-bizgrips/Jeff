import { inQuietHours, type OwnerSettings, type Importance } from "@/lib/jeff/settings";

/**
 * Pure decision: should this alert be pushed to the owner's devices right now?
 * - urgent: always (quiet hours do not apply to genuinely urgent items)
 * - important / actionable: only when push_alerts is on and we are outside
 *   quiet hours (deferred alerts are pushed on the first run after the window ends)
 * - informational / briefing-level: never pushed
 * - one push per (alert, importance): a repeat of the same condition is not
 *   re-pushed; an escalation to a higher importance is.
 */
export interface PushableAlert {
  id: string;
  status: string;
  importance: Importance;
  deferred_until: string | null;
  pushed_at: string | null;
  pushed_importance: string | null;
}

const RANK: Record<Importance, number> = { informational: 0, briefing: 1, important: 2, actionable: 2, urgent: 3 };

export function shouldPushAlert(alert: PushableAlert, settings: Pick<OwnerSettings, "push_alerts" | "timezone" | "quiet_hours_start" | "quiet_hours_end">, now: Date): boolean {
  if (alert.status !== "open") return false;
  if ((RANK[alert.importance] ?? 0) < 2) return false;
  if (alert.pushed_at && alert.pushed_importance) {
    const prev = RANK[alert.pushed_importance as Importance] ?? 0;
    if (RANK[alert.importance] <= prev) return false;
  }
  if (alert.importance === "urgent") return true;
  if (!settings.push_alerts) return false;
  if (alert.deferred_until && Date.parse(alert.deferred_until) > now.getTime()) return false;
  if (inQuietHours(now, settings)) return false;
  return true;
}

export function shouldPushBriefing(settings: Pick<OwnerSettings, "push_briefings">): boolean {
  return settings.push_briefings;
}
