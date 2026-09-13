import { evidenceOf, type CandidateFinding, type ExtendedContext, type SourceRow } from "./types";
import { calendarEvents, clientDomainsFrom, DAY, localParts, type CalEvent } from "./calendar-shared";

/**
 * Attention Cost Detector — fragmented days, meeting overload and missing
 * focus blocks, measured from the calendar over the last WINDOW_DAYS.
 */

export const WINDOW_DAYS = 7;
export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 18;
export const SHORT_MEETING_MIN = 30;
export const HEAVY_DAY_MEETINGS = 5;
export const FOCUS_BLOCK_MIN = 120;
export const FLAG_HEAVY_DAYS = 2;
export const FLAG_SHORT_MEETINGS = 8;
export const FLAG_MIN_FOCUS_BLOCKS = 2;

export interface DayStats {
  date: string;
  meetings: number;
  minutes: number;
  shortMeetings: number;
  focusBlocks: number;
  contextSwitches: number;
  medianGapMin: number | null;
}

export function dayStats(events: CalEvent[], date: string): DayStats {
  const day = events.filter((e) => e.localDate === date).sort((a, b) => a.start - b.start);
  const gaps: number[] = [];
  let focusBlocks = 0;
  let switches = 0;
  const workStart = day.length ? day[0]!.start - (day[0]!.localHour - WORK_START_HOUR) * 3_600_000 : null;
  let cursor = workStart;
  for (let i = 0; i < day.length; i++) {
    const e = day[i]!;
    if (cursor != null) {
      const free = (e.start - cursor) / 60_000;
      if (free >= FOCUS_BLOCK_MIN) focusBlocks++;
      if (i > 0) gaps.push(free);
    }
    if (i > 0 && day[i - 1]!.category !== e.category && e.category !== "unknown" && day[i - 1]!.category !== "unknown") switches++;
    cursor = Math.max(cursor ?? e.end, e.end);
  }
  if (cursor != null && workStart != null) {
    const workEnd = workStart + (WORK_END_HOUR - WORK_START_HOUR) * 3_600_000;
    if ((workEnd - cursor) / 60_000 >= FOCUS_BLOCK_MIN) focusBlocks++;
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const medianGap = sorted.length ? (sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2) : null;
  return { date, meetings: day.length, minutes: day.reduce((s, e) => s + e.minutes, 0), shortMeetings: day.filter((e) => e.minutes < SHORT_MEETING_MIN).length, focusBlocks, contextSwitches: switches, medianGapMin: medianGap == null ? null : Math.round(medianGap) };
}

export function attentionFragmentation(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const tz = typeof ctx.config?.timezone === "string" ? ctx.config.timezone : "America/Denver";
  const end = ctx.now.getTime();
  const start = end - WINDOW_DAYS * DAY;
  const events = calendarEvents(rows, start, end, tz, { clientDomains: clientDomainsFrom(rows), ownerEmail: ctx.ownerEmail ?? null }).filter((e) => e.category !== "personal" && e.localHour >= WORK_START_HOUR - 1 && e.localHour < WORK_END_HOUR + 1);
  if (events.length < 5) return [];
  const dates = new Set<string>();
  for (let t = start; t < end; t += DAY) {
    const lp = localParts(t, tz);
    if (lp.weekday >= 1 && lp.weekday <= 5) dates.add(lp.date);
  }
  const days = [...dates].map((d) => dayStats(events, d));
  const workdays = days.filter((d) => d.meetings > 0);
  const heavy = days.filter((d) => d.meetings >= HEAVY_DAY_MEETINGS);
  const shortTotal = days.reduce((s, d) => s + d.shortMeetings, 0);
  const focusTotal = days.reduce((s, d) => s + d.focusBlocks, 0);
  const switches = days.reduce((s, d) => s + d.contextSwitches, 0);
  const flagged = heavy.length >= FLAG_HEAVY_DAYS || shortTotal >= FLAG_SHORT_MEETINGS || (workdays.length >= 3 && focusTotal < FLAG_MIN_FOCUS_BLOCKS);
  if (!flagged) return [];
  const totalMin = events.reduce((s, e) => s + e.minutes, 0);
  const reasons: string[] = [];
  if (heavy.length >= FLAG_HEAVY_DAYS) reasons.push(`${heavy.length} days with ${HEAVY_DAY_MEETINGS}+ meetings`);
  if (shortTotal >= FLAG_SHORT_MEETINGS) reasons.push(`${shortTotal} meetings under ${SHORT_MEETING_MIN} minutes`);
  if (workdays.length >= 3 && focusTotal < FLAG_MIN_FOCUS_BLOCKS) reasons.push(`only ${focusTotal} focus block${focusTotal === 1 ? "" : "s"} of ${FOCUS_BLOCK_MIN}+ minutes across ${workdays.length} meeting days`);
  return [
    {
      fingerprint: `attention_fragmentation:${new Date(start).toISOString().slice(0, 10)}`,
      category: "attention_fragmentation",
      title: `Fragmented week: ${reasons.join(", ")}`,
      observed_facts: [
        `${events.length} work-hours events totalling ${Math.round(totalMin / 60)} hours in the last ${WINDOW_DAYS} days.`,
        ...days.filter((d) => d.meetings > 0).map((d) => `${d.date}: ${d.meetings} meetings (${Math.round(d.minutes / 60)}h), ${d.shortMeetings} short, ${d.focusBlocks} focus block(s), ${d.contextSwitches} category switches${d.medianGapMin != null ? `, median gap ${d.medianGapMin} min` : ""}.`),
      ],
      metrics: { window_days: WINDOW_DAYS, meetings: events.length, hours: Math.round(totalMin / 6) / 10, heavy_days: heavy.length, short_meetings: shortTotal, focus_blocks: focusTotal, context_switches: switches, formula: `heavy day = ≥${HEAVY_DAY_MEETINGS} meetings; short = <${SHORT_MEETING_MIN} min; focus block = ≥${FOCUS_BLOCK_MIN} free min in ${WORK_START_HOUR}:00–${WORK_END_HOUR}:00` },
      interpretation: "Interpretation: this pattern makes deep work structurally unlikely — not a productivity lecture, just what the calendar shows. Consolidating short meetings and protecting one morning usually restores a focus block without losing anything.",
      evidence: events.slice(0, 6).map((e) => evidenceOf(e.row)),
      range_start: new Date(start).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.65,
      limitations: "Calendar-only view: unscheduled interruptions and Slack/email churn are not measured; work hours assumed 8:00–18:00 local.",
      severity: heavy.length >= 3 ? "medium" : "low",
      proposed_mission: { title: "Propose a focus-block schedule", goal: "Suggest which short meetings could be batched and which morning could be protected next week, based on the last week's calendar. Nothing is changed without approval." },
    },
  ];
}
