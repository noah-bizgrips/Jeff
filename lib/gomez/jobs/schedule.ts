import { localTime, minutesOf } from "@/lib/gomez/settings";
import type { JobRow, ScheduleType } from "./types";

/**
 * Pure schedule math in the owner's timezone (DST-safe via Intl). Every
 * schedule resolves to "the next instant this job should run" or null.
 */

export const DEFAULT_TIME = "07:05";
const DAY = 86_400_000;
const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export interface ParsedExpression {
  time: string; // HH:MM
  weekday: number | null; // 0-6
  dayOfMonth: number | null; // 1-28
}

/** "mon 07:05" · "1 07:05" · "07:05" · "" → parsed parts with defaults. */
export function parseExpression(type: ScheduleType, expr: string | null | undefined): ParsedExpression {
  const parts = (expr ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  let time = DEFAULT_TIME;
  let weekday: number | null = null;
  let dayOfMonth: number | null = null;
  for (const p of parts) {
    if (/^\d{1,2}:\d{2}$/.test(p)) {
      const [h, m] = p.split(":").map(Number);
      if ((h ?? 0) < 24 && (m ?? 0) < 60) time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    } else if (p.slice(0, 3) in WEEKDAYS) weekday = WEEKDAYS[p.slice(0, 3)]!;
    else if (/^\d{1,2}$/.test(p)) dayOfMonth = Math.min(28, Math.max(1, Number(p)));
  }
  if (type === "weekly" && weekday == null) weekday = 1;
  if (type === "monthly" && dayOfMonth == null) dayOfMonth = 1;
  return { time, weekday, dayOfMonth };
}

/** Wall-clock (y, m, d, HH:MM) in a timezone → UTC instant, DST-safe (two-pass offset search). */
export function zonedToUtc(year: number, month: number, day: number, hhmm: string, timezone: string): Date {
  const minutes = minutesOf(hhmm);
  let guess = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  for (let i = 0; i < 3; i++) {
    const lt = localTime(new Date(guess), timezone);
    const diff = (Date.UTC(lt.year, lt.month - 1, lt.day, lt.hour, lt.minute) - Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60)) / 60_000;
    if (diff === 0) break;
    guess -= diff * 60_000;
  }
  return new Date(guess);
}

function nextDailyLike(now: Date, timezone: string, time: string, matches: (lt: ReturnType<typeof localTime>) => boolean): Date {
  // Walk day by day (max 62) from today until a matching local day whose instant is in the future.
  for (let i = 0; i < 62; i++) {
    const probe = new Date(now.getTime() + i * DAY);
    const lt = localTime(probe, timezone);
    if (!matches(lt)) continue;
    const at = zonedToUtc(lt.year, lt.month, lt.day, time, timezone);
    if (at.getTime() > now.getTime()) return at;
  }
  return new Date(now.getTime() + 62 * DAY);
}

/** Minimal cron evaluator for the validated 5-field subset (minute hour dom month dow), owner-local. */
function cronMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = 0;
      hi = 60;
    } else if (range!.includes("-")) {
      const [a, b] = range!.split("-").map(Number);
      lo = a ?? 0;
      hi = b ?? lo;
    } else {
      lo = hi = Number(range);
      if (step > 1) hi = 60;
    }
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  });
}

export function nextCustom(now: Date, timezone: string, expr: string): Date | null {
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/);
  if (!min || !hour || !dom || !mon || !dow) return null;
  // Scan minute by minute up to 35 days ahead (bounded; custom schedules are coarse).
  const start = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  for (let t = start; t < start + 35 * DAY; t += 60_000) {
    const lt = localTime(new Date(t), timezone);
    if (cronMatches(min, lt.minute) && cronMatches(hour, lt.hour) && cronMatches(dom, lt.day) && cronMatches(mon, lt.month) && cronMatches(dow, lt.weekday)) return new Date(t);
  }
  return null;
}

/**
 * Next run instant for a job. `manual` never runs on its own; `continuous`
 * runs on every scheduler tick; `event_driven` runs on triggers plus a daily
 * safety tick.
 */
export function nextRunAt(job: Pick<JobRow, "schedule_type" | "schedule_expression" | "status">, now: Date, timezone: string): Date | null {
  if (job.status !== "active") return null;
  const p = parseExpression(job.schedule_type, job.schedule_expression);
  switch (job.schedule_type) {
    case "manual":
      return null;
    case "continuous":
      return new Date(now.getTime() + 60_000);
    case "hourly":
      return new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
    case "daily":
    case "event_driven":
      return nextDailyLike(now, timezone, p.time, () => true);
    case "weekly":
      return nextDailyLike(now, timezone, p.time, (lt) => lt.weekday === p.weekday);
    case "monthly":
      return nextDailyLike(now, timezone, p.time, (lt) => lt.day === p.dayOfMonth);
    case "custom":
      return job.schedule_expression ? nextCustom(now, timezone, job.schedule_expression) : nextDailyLike(now, timezone, p.time, () => true);
  }
}

/** Jobs whose next_run_at has passed (or was never computed) and that can run unattended. */
export function dueJobs<T extends Pick<JobRow, "status" | "schedule_type" | "next_run_at" | "schedule_expression">>(jobs: T[], now: Date): T[] {
  return jobs.filter((j) => {
    if (j.status !== "active" || j.schedule_type === "manual") return false;
    if (!j.next_run_at) return true;
    return Date.parse(j.next_run_at) <= now.getTime();
  });
}

export function describeSchedule(job: Pick<JobRow, "schedule_type" | "schedule_expression">): string {
  const p = parseExpression(job.schedule_type, job.schedule_expression);
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  switch (job.schedule_type) {
    case "manual":
      return "Manual";
    case "continuous":
      return "Continuous";
    case "event_driven":
      return "Event-driven + daily check";
    case "hourly":
      return "Hourly";
    case "daily":
      return `Daily · ${p.time}`;
    case "weekly":
      return `Weekly · ${names[p.weekday ?? 1]} ${p.time}`;
    case "monthly":
      return `Monthly · day ${p.dayOfMonth ?? 1} ${p.time}`;
    case "custom":
      return `Custom · ${job.schedule_expression ?? ""}`;
  }
}
