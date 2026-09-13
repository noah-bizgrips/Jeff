import type { SourceRow } from "./types";
import { str } from "./portal-shared";

/** Shared calendar classification for Time Allocation Auditor and Attention Cost Detector. */

export const DAY = 86_400_000;
export type EventCategory = "sales" | "client" | "internal" | "personal" | "unknown";

export interface CalEvent {
  row: SourceRow;
  start: number;
  end: number;
  minutes: number;
  category: EventCategory;
  attendees: string[];
  localDate: string;
  localHour: number;
}

const SALES = /\b(lead|estimate|quote|proposal|discovery|demo|prospect|sales|pitch|consult(ation)?|intro call|kickoff call|new client|walkthrough|bid)\b/i;
const CLIENT = /\b(client|onboarding|delivery|check-?in|review|status|weekly sync|qbr|launch|site build|handoff|training)\b/i;
const INTERNAL = /\b(internal|admin|team|standup|stand-up|1:1|one on one|planning|retro|ops|finance|bookkeeping|payroll|invoice|hiring|interview)\b/i;
const PERSONAL = /\b(dentist|doctor|gym|workout|lunch with|dinner|family|kids?|school|vacation|pto|birthday|personal|haircut|vet|church|date night|flight|travel|errand)\b/i;

export function localParts(t: number, tz: string): { date: string; hour: number; weekday: number } {
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short" });
    const parts = Object.fromEntries(f.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const hour = Number(parts.hour === "24" ? 0 : parts.hour);
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "Sun");
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour, weekday: wd };
  } catch {
    const d = new Date(t);
    return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), weekday: d.getUTCDay() };
  }
}

export interface ClassifyInput {
  /** Domains belonging to portal clients (client meetings). */
  clientDomains?: Set<string>;
  /** Emails/names of HighLevel contacts (sales meetings). */
  crmEmails?: Set<string>;
  ownerEmail?: string | null;
}

export function classifyEvent(r: SourceRow, input: ClassifyInput = {}): EventCategory {
  const title = r.title ?? "";
  const attendees = Array.isArray(r.metadata.attendees) ? (r.metadata.attendees as string[]) : [];
  const domains = attendees.map((a) => a.split("@")[1] ?? "").filter(Boolean);
  if (input.clientDomains && domains.some((d) => input.clientDomains!.has(d))) return "client";
  if (input.crmEmails && attendees.some((a) => input.crmEmails!.has(a.toLowerCase()))) return "sales";
  if (SALES.test(title)) return "sales";
  if (CLIENT.test(title)) return "client";
  if (PERSONAL.test(title)) return "personal";
  if (INTERNAL.test(title)) return "internal";
  const external = attendees.filter((a) => a.toLowerCase() !== (input.ownerEmail ?? "").toLowerCase());
  if (!external.length && attendees.length <= 1) return "unknown";
  return "unknown";
}

/** Calendar events in [start, end) with duration and category. Cancelled events are skipped. */
export function calendarEvents(rows: SourceRow[], start: number, end: number, tz: string, input: ClassifyInput = {}): CalEvent[] {
  const out: CalEvent[] = [];
  for (const r of rows) {
    if (r.provider !== "google" || r.resource_type !== "event") continue;
    if (str(r.metadata.status) === "cancelled") continue;
    const s = Date.parse(str(r.metadata.start) ?? r.source_timestamp ?? "");
    const e = Date.parse(str(r.metadata.end) ?? "");
    if (!Number.isFinite(s) || s < start || s >= end) continue;
    const rawMinutes = Number.isFinite(e) && e > s ? (e - s) / 60_000 : 30;
    if (rawMinutes >= 23 * 60) continue; // all-day blocks are not meetings
    const minutes = Math.min(rawMinutes, 12 * 60);
    const lp = localParts(s, tz);
    out.push({ row: r, start: s, end: Number.isFinite(e) ? e : s + minutes * 60_000, minutes, category: classifyEvent(r, input), attendees: Array.isArray(r.metadata.attendees) ? (r.metadata.attendees as string[]) : [], localDate: lp.date, localHour: lp.hour });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function clientDomainsFrom(rows: SourceRow[]): Set<string> {
  const set = new Set<string>();
  for (const r of rows) {
    if (r.provider !== "portal" || r.resource_type !== "client") continue;
    const users = Array.isArray(r.metadata.client_users) ? (r.metadata.client_users as { email_domain?: string }[]) : [];
    for (const u of users) if (u.email_domain && !/gmail|yahoo|hotmail|icloud|outlook|aol|live\.com|me\.com/.test(u.email_domain)) set.add(u.email_domain);
  }
  return set;
}
