import { z } from "zod";

/**
 * Owner settings: notification, briefing and learning preferences.
 * Security controls are intentionally NOT settings (Tier 3); nothing here can
 * weaken auth, MFA, RLS, approvals or secret handling.
 */

export const IMPORTANCE_LEVELS = ["informational", "briefing", "important", "urgent", "actionable"] as const;
export type Importance = (typeof IMPORTANCE_LEVELS)[number];

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

export const OwnerSettingsSchema = z
  .object({
    timezone: z
      .string()
      .min(3)
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, "unknown IANA timezone"),
    daily_brief_enabled: z.boolean(),
    daily_brief_time: HHMM,
    weekly_review_enabled: z.boolean(),
    weekly_review_day: z.number().int().min(0).max(6),
    weekly_review_time: HHMM,
    monthly_review_enabled: z.boolean(),
    monthly_review_time: HHMM,
    quiet_hours_start: HHMM,
    quiet_hours_end: HHMM,
    alert_min_importance: z.enum(IMPORTANCE_LEVELS),
    goal_alerts: z.boolean(),
    opportunity_alerts: z.boolean(),
    business_notifications: z.boolean(),
    personal_notifications: z.boolean(),
    financial_notifications: z.boolean(),
    learn_from_feedback: z.boolean(),
    auto_apply_safe_rules: z.boolean(),
    ask_before_major_changes: z.boolean(),
    brief_max_items: z.number().int().min(1).max(10),
  })
  .strict();
export type OwnerSettings = z.infer<typeof OwnerSettingsSchema>;

/** Only these keys may be changed through chat / settings (all Tier 1). */
export const SettingsPatchSchema = OwnerSettingsSchema.partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const DEFAULT_SETTINGS: OwnerSettings = {
  timezone: "America/Denver",
  daily_brief_enabled: true,
  daily_brief_time: "07:30",
  weekly_review_enabled: true,
  weekly_review_day: 1,
  weekly_review_time: "07:30",
  monthly_review_enabled: true,
  monthly_review_time: "07:30",
  quiet_hours_start: "21:00",
  quiet_hours_end: "07:00",
  alert_min_importance: "important",
  goal_alerts: true,
  opportunity_alerts: true,
  business_notifications: true,
  personal_notifications: true,
  financial_notifications: true,
  learn_from_feedback: true,
  auto_apply_safe_rules: true,
  ask_before_major_changes: true,
  brief_max_items: 3,
};

export function withDefaults(row: Partial<OwnerSettings> | null | undefined): OwnerSettings {
  return { ...DEFAULT_SETTINGS, ...(row ?? {}) };
}

/* ------------------------------------------------------------------ */
/* Timezone helpers (DST-safe via Intl)                                */
/* ------------------------------------------------------------------ */

export interface LocalTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
  /** YYYY-MM-DD in the target timezone. */
  date: string;
  minutesOfDay: number;
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Breaks an instant into wall-clock parts in the given IANA timezone. */
export function localTime(now: Date, timezone: string): LocalTime {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) if (p.type !== "literal") parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return { year, month, day, hour, minute, weekday: WD[parts.weekday ?? "Sun"] ?? 0, date: `${parts.year}-${parts.month}-${parts.day}`, minutesOfDay: hour * 60 + minute };
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when the local wall-clock time falls inside quiet hours (window may cross midnight). */
export function inQuietHours(now: Date, settings: Pick<OwnerSettings, "timezone" | "quiet_hours_start" | "quiet_hours_end">): boolean {
  const t = localTime(now, settings.timezone).minutesOfDay;
  const start = minutesOf(settings.quiet_hours_start);
  const end = minutesOf(settings.quiet_hours_end);
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** The next instant at which quiet hours end (UTC), or `now` when not in quiet hours. */
export function quietHoursEnd(now: Date, settings: Pick<OwnerSettings, "timezone" | "quiet_hours_start" | "quiet_hours_end">): Date {
  if (!inQuietHours(now, settings)) return now;
  // Walk forward in 15-minute steps (bounded to 24h) until we leave the window; exact enough for deferral.
  let t = new Date(now.getTime());
  for (let i = 0; i < 96; i++) {
    t = new Date(t.getTime() + 15 * 60_000);
    if (!inQuietHours(t, settings)) return t;
  }
  return t;
}
