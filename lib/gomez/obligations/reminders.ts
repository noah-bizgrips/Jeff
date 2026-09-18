import { inQuietHours, localTime, quietHoursEnd, type OwnerSettings } from "@/lib/gomez/settings";
import { effectiveCadence } from "./cadence";
import { LIVE_STATUSES, type ObligationRow } from "./types";

/**
 * Reminder scheduling & escalation — pure.
 *
 * Persistent does not mean "every 15 minutes": follow-ups happen at bounded
 * intervals, inside business hours by default, capped per day, and escalate
 * importance the longer something stays unresolved. Critical ignores quiet
 * hours; everything else defers to the end of the quiet window.
 */

export type ReminderImportance = "briefing" | "important" | "urgent";

export interface ReminderDecision {
  remind: boolean;
  importance: ReminderImportance;
  reason: string;
  /** Next time a reminder may fire (set even when remind=false so the job can sleep). */
  next_reminder_at: string | null;
  escalation_level: number;
  copy: string;
}

const BUSINESS_START = 8 * 60;
const BUSINESS_END = 18 * 60;
const HOUR = 3_600_000;

function nextBusinessHour(from: Date, settings: Pick<OwnerSettings, "timezone">): Date {
  const lt = localTime(from, settings.timezone);
  const mins = lt.hour * 60 + lt.minute;
  if (mins >= BUSINESS_START && mins < BUSINESS_END) return from;
  // Move to 08:30 local of the same or next day.
  const addDays = mins >= BUSINESS_END ? 1 : 0;
  const target = new Date(from.getTime() + addDays * 86400000);
  const t2 = localTime(target, settings.timezone);
  const delta = BUSINESS_START + 30 - (t2.hour * 60 + t2.minute);
  return new Date(target.getTime() + delta * 60000);
}

function remindersToday(events: { kind: string; created_at: string }[], now: Date, timezone: string): number {
  const today = localTime(now, timezone).date;
  return events.filter((e) => e.kind === "reminded" && localTime(new Date(e.created_at), timezone).date === today).length;
}

export function escalationFor(o: ObligationRow, now: Date): number {
  if (!o.due_at) return 0;
  const overdueH = (now.getTime() - Date.parse(o.due_at)) / HOUR;
  if (overdueH <= 0) return 0;
  const cad = effectiveCadence(o);
  if (cad.no_escalation) return 0;
  const step = cad.escalate_after_hours ?? (o.tracking_mode === "critical" ? 4 : o.tracking_mode === "important" ? 8 : 24);
  return Math.min(3, Math.floor(overdueH / step) + 1);
}

export function importanceFor(o: ObligationRow, level: number): ReminderImportance {
  if (o.tracking_mode === "critical") return level >= 1 ? "urgent" : "important";
  if (o.tracking_mode === "important") return level >= 2 ? "urgent" : "important";
  if (o.priority === "high" || o.priority === "critical") return level >= 2 ? "urgent" : "important";
  return level >= 2 ? "important" : "briefing";
}

export function reminderCopy(o: ObligationRow, now: Date, level: number): string {
  const due = o.due_at ? Date.parse(o.due_at) : null;
  const overdueDays = due ? Math.floor((now.getTime() - due) / 86400000) : 0;
  const money = typeof o.metadata.amount_label === "string" ? ` · ${o.metadata.amount_label}` : "";
  if (o.assigned_to === "other") {
    const who = o.waiting_on ?? o.counterparty ?? "someone else";
    const days = Math.max(1, Math.floor((now.getTime() - Date.parse(o.created_at)) / 86400000));
    return `Still waiting on ${who}: "${o.title}" has been outstanding for ${days} day${days === 1 ? "" : "s"}${overdueDays > 0 ? ` and is ${overdueDays} day${overdueDays === 1 ? "" : "s"} past due` : ""}. Consider following up.`;
  }
  if (!due) return `${o.title}${money} — still open.`;
  if (overdueDays > 0) return `${o.title}${money} — ${overdueDays === 1 ? "1 day" : `${overdueDays} days`} overdue and still unresolved${level >= 2 ? " (escalated)" : ""}.`;
  if (due < now.getTime()) return `${o.title}${money} — due today and still unresolved.`;
  const hoursLeft = Math.round((due - now.getTime()) / HOUR);
  return `${o.title}${money} — due ${hoursLeft <= 24 ? "today" : `in ${Math.ceil(hoursLeft / 24)} days`}.`;
}

export interface DecideInput {
  obligation: ObligationRow;
  events: { kind: string; created_at: string; payload?: Record<string, unknown> }[];
  settings: Pick<OwnerSettings, "timezone" | "quiet_hours_start" | "quiet_hours_end">;
  now: Date;
  /** A related inbound message just arrived (context trigger) → elevate. */
  contextTrigger?: { from: string; snippet: string } | null;
}

export function decideReminder(input: DecideInput): ReminderDecision {
  const { obligation: o, events, settings, now } = input;
  const cad = effectiveCadence(o);
  const level = escalationFor(o, now);
  const importance = importanceFor(o, level);
  const none = (reason: string, next: string | null): ReminderDecision => ({ remind: false, importance, reason, next_reminder_at: next, escalation_level: level, copy: reminderCopy(o, now, level) });

  if (!LIVE_STATUSES.includes(o.status)) return none("not live", null);
  if (o.status === "snoozed" && o.snoozed_until && Date.parse(o.snoozed_until) > now.getTime()) return none("snoozed", o.snoozed_until);
  if (o.status === "possibly_complete") return none("awaiting confirmation", null);
  if (cad.briefing_only) return none("briefing only", null);

  const firstFire = o.remind_at ?? o.due_at;
  if (!firstFire) return none("no due or remind time", null);
  if (Date.parse(firstFire) > now.getTime()) return none("not due yet", firstFire);

  const todayCount = remindersToday(events, now, settings.timezone);
  const lastReminded = o.last_reminded_at ? Date.parse(o.last_reminded_at) : null;

  if (input.contextTrigger) {
    if (lastReminded && now.getTime() - lastReminded < HOUR) return none("context trigger within the last hour already reminded", null);
    return { remind: true, importance: importance === "briefing" ? "important" : "urgent", reason: "context trigger", next_reminder_at: null, escalation_level: level, copy: `${input.contextTrigger.from} just followed up: "${input.contextTrigger.snippet.slice(0, 120)}". Your reminder "${o.title}" is still unresolved.` };
  }

  // Never a second reminder for once-mode items.
  if (o.tracking_mode === "once" && o.reminder_count >= 1) return none("once-mode already reminded", null);

  if (todayCount >= cad.daily_cap) {
    const tomorrow = nextBusinessHour(new Date(now.getTime() + 24 * HOUR), settings);
    return none(`daily cap (${cad.daily_cap}) reached`, tomorrow.toISOString());
  }

  const quiet = inQuietHours(now, settings);
  if (quiet && o.tracking_mode !== "critical") return none("quiet hours", quietHoursEnd(now, settings).toISOString());

  if (cad.business_hours_only && o.tracking_mode !== "critical") {
    const lt = localTime(now, settings.timezone);
    const mins = lt.hour * 60 + lt.minute;
    if (mins < BUSINESS_START || mins >= BUSINESS_END) return none("outside business hours", nextBusinessHour(now, settings).toISOString());
  }

  if (lastReminded) {
    const followUp = cad.follow_up_hours ?? (o.tracking_mode === "critical" ? 3 : o.tracking_mode === "important" ? 4 : level >= 1 ? 6 : 24);
    if (now.getTime() - lastReminded < followUp * HOUR) return none("follow-up interval not elapsed", new Date(lastReminded + followUp * HOUR).toISOString());
  }

  return { remind: true, importance, reason: lastReminded ? "follow-up" : "initial", next_reminder_at: null, escalation_level: level, copy: reminderCopy(o, now, level) };
}
