import { evidenceOf, type CandidateFinding, type ExtendedContext, type GoalLite, type SourceRow } from "./types";
import { calendarEvents, clientDomainsFrom, DAY, type EventCategory } from "./calendar-shared";

/**
 * Time Allocation Auditor — compares where scheduled work time went (last
 * WINDOW_DAYS) with what the active goals say matters. Transparent keyword /
 * attendee classification; "unknown" is allowed and reported as a limitation.
 */

export const WINDOW_DAYS = 30;
export const MIN_SHARE_PCT = 15;
export const MIN_SCHEDULED_HOURS = 8;

const GOAL_CATEGORY: { category: EventCategory; words: RegExp }[] = [
  { category: "sales", words: /\b(client(s)? (onboard|acquire|sign|win)|new clients?|leads?|acquisition|sales|revenue|mrr|pipeline|cac|close rate|booked|estimates?)\b/i },
  { category: "client", words: /\b(retention|churn|delivery|onboarding time|client health|nps|satisfaction)\b/i },
  { category: "internal", words: /\b(margin|expenses?|profit|operations?|automation|hiring|process)\b/i },
  { category: "personal", words: /\b(fitness|health|family|travel|learn|home|personal)\b/i },
];

export function goalFocusCategory(goal: GoalLite): EventCategory | null {
  const text = `${goal.name} ${goal.keywords.join(" ")} ${goal.primary_metric ?? ""}`.toLowerCase();
  for (const g of GOAL_CATEGORY) if (g.words.test(text)) return g.category;
  return goal.scope === "personal" ? "personal" : null;
}

const LABEL: Record<EventCategory, string> = { sales: "sales & acquisition", client: "client delivery", internal: "internal & admin", personal: "personal", unknown: "unclassified" };

export function timeAllocationMismatch(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const goals = (ctx.goals ?? []).filter((g) => g.status === "active");
  if (!goals.length) return [];
  const tz = typeof ctx.config?.timezone === "string" ? ctx.config.timezone : "America/Denver";
  const end = ctx.now.getTime();
  const start = end - WINDOW_DAYS * DAY;
  const events = calendarEvents(rows, start, end, tz, { clientDomains: clientDomainsFrom(rows), ownerEmail: ctx.ownerEmail ?? null });
  const work = events.filter((e) => e.category !== "personal");
  const totalMin = work.reduce((s, e) => s + e.minutes, 0);
  if (totalMin < MIN_SCHEDULED_HOURS * 60) return [];
  const byCat = new Map<EventCategory, number>();
  for (const e of work) byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.minutes);
  const unknownPct = Math.round(((byCat.get("unknown") ?? 0) / totalMin) * 100);
  const out: CandidateFinding[] = [];
  const top = goals[0]!;
  const focus = goalFocusCategory(top);
  if (!focus || focus === "personal") return [];
  const focusMin = byCat.get(focus) ?? 0;
  const sharePct = Math.round((focusMin / totalMin) * 1000) / 10;
  if (sharePct >= MIN_SHARE_PCT) return [];
  const breakdown = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c, m]) => `${LABEL[c]} ${Math.round((m / totalMin) * 100)}% (${Math.round(m / 60)}h)`);
  out.push({
    fingerprint: `time_allocation_mismatch:${top.id}`,
    category: "time_allocation_mismatch",
    title: `Only ${sharePct}% of scheduled work time touched ${LABEL[focus]} — your #1 goal is "${top.name}"`,
    observed_facts: [
      `${Math.round(totalMin / 60)} hours of non-personal calendar events in the last ${WINDOW_DAYS} days (${work.length} events).`,
      `Breakdown: ${breakdown.join(" · ")}.`,
      `Goal "${top.name}" maps to the ${LABEL[focus]} category by its wording${top.trajectory ? `; current trajectory ${top.trajectory.replace(/_/g, " ")}` : ""}.`,
    ],
    metrics: { window_days: WINDOW_DAYS, scheduled_hours: Math.round(totalMin / 6) / 10, focus_category: focus, focus_share_pct: sharePct, unknown_share_pct: unknownPct, threshold_pct: MIN_SHARE_PCT, formula: "focus_share = minutes(focus category) / minutes(all non-personal events)" },
    interpretation: `Interpretation: your calendar says ${LABEL[focus]} is getting ${sharePct}% of scheduled time while your stated top goal depends on it. Either the work happens outside the calendar (then this is a data gap), or the week is drifting from the priority.`,
    evidence: work.filter((e) => e.category === focus).slice(0, 5).map((e) => evidenceOf(e.row)),
    range_start: new Date(start).toISOString(),
    range_end: ctx.now.toISOString(),
    confidence: unknownPct > 40 ? 0.4 : 0.6,
    limitations: `${unknownPct}% of scheduled time could not be classified from titles/attendees; unscheduled work is invisible. Classification is keyword/attendee based.`,
    severity: sharePct < 5 ? "medium" : "low",
    proposed_mission: { title: `Protect time for ${LABEL[focus]}`, goal: `Propose 2–3 recurring calendar blocks for ${LABEL[focus]} work next week based on current free windows. The owner accepts or edits; nothing is scheduled automatically.` },
    goal_id: top.id,
  });
  return out;
}
