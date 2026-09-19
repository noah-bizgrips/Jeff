import { localTime, minutesOf, type OwnerSettings } from "@/lib/jeff/settings";

/**
 * Briefing scheduling (pure). The cron runs every 15 minutes; a briefing is
 * "due" when the owner's local wall clock has passed the configured time for
 * a period that has not been generated yet. Periods are keyed by local date
 * so DST shifts never double-generate or skip.
 */

export type BriefingKind = "daily" | "weekly" | "monthly";

export interface DueBriefing {
  kind: BriefingKind;
  /** Local YYYY-MM-DD identifying the period (idempotency key with kind). */
  period_start: string;
  period_end: string;
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y!, m! - 1, d!) + n * 86_400_000;
  const x = new Date(t);
  return isoDate(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Returns the periods (per kind) that are due at `now` — regardless of whether they already exist. */
export function dueBriefings(now: Date, settings: OwnerSettings): DueBriefing[] {
  const lt = localTime(now, settings.timezone);
  const out: DueBriefing[] = [];
  if (settings.daily_brief_enabled && lt.minutesOfDay >= minutesOf(settings.daily_brief_time)) {
    out.push({ kind: "daily", period_start: lt.date, period_end: lt.date });
  }
  if (settings.weekly_review_enabled && lt.weekday === settings.weekly_review_day && lt.minutesOfDay >= minutesOf(settings.weekly_review_time)) {
    // Review covers the 7 days ending yesterday.
    out.push({ kind: "weekly", period_start: addDays(lt.date, -7), period_end: addDays(lt.date, -1) });
  }
  if (settings.monthly_review_enabled && lt.day === 1 && lt.minutesOfDay >= minutesOf(settings.monthly_review_time)) {
    const prevY = lt.month === 1 ? lt.year - 1 : lt.year;
    const prevM = lt.month === 1 ? 12 : lt.month - 1;
    out.push({ kind: "monthly", period_start: isoDate(prevY, prevM, 1), period_end: isoDate(prevY, prevM, lastDayOfMonth(prevY, prevM)) });
  }
  return out;
}

/** Period for an on-demand briefing of a kind, anchored at now. */
export function periodFor(kind: BriefingKind, now: Date, timezone: string): { period_start: string; period_end: string } {
  const lt = localTime(now, timezone);
  if (kind === "daily") return { period_start: lt.date, period_end: lt.date };
  if (kind === "weekly") return { period_start: addDays(lt.date, -7), period_end: addDays(lt.date, -1) };
  const prevY = lt.month === 1 ? lt.year - 1 : lt.year;
  const prevM = lt.month === 1 ? 12 : lt.month - 1;
  return { period_start: isoDate(prevY, prevM, 1), period_end: isoDate(prevY, prevM, lastDayOfMonth(prevY, prevM)) };
}

/** Start/end instants (UTC) of a local-date range in a timezone, approximated at local midnight via Intl offsets. */
export function periodInstants(period_start: string, period_end: string, timezone: string): { start: Date; end: Date } {
  const start = localMidnight(period_start, timezone);
  const end = new Date(localMidnight(addDays(period_end, 1), timezone).getTime() - 1);
  return { start, end };
}

/** Instant corresponding to 00:00 local on a date, found by inverting Intl (DST-safe). */
export function localMidnight(date: string, timezone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  let guess = Date.UTC(y!, m! - 1, d!, 0, 0);
  for (let i = 0; i < 3; i++) {
    const lt = localTime(new Date(guess), timezone);
    const diffMinutes = (Date.UTC(lt.year, lt.month - 1, lt.day, lt.hour, lt.minute) - Date.UTC(y!, m! - 1, d!, 0, 0)) / 60_000;
    if (diffMinutes === 0) break;
    guess -= diffMinutes * 60_000;
  }
  return new Date(guess);
}
