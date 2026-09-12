import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { redactString } from "@/lib/security/redact";
import { OwnerSettingsSchema, SettingsPatchSchema, withDefaults, type OwnerSettings, type SettingsPatch } from "./settings";

const COLUMNS =
  "timezone, daily_brief_enabled, daily_brief_time, weekly_review_enabled, weekly_review_day, weekly_review_time, monthly_review_enabled, monthly_review_time, quiet_hours_start, quiet_hours_end, alert_min_importance, goal_alerts, opportunity_alerts, business_notifications, personal_notifications, financial_notifications, learn_from_feedback, auto_apply_safe_rules, ask_before_major_changes, brief_max_items";

export async function getSettings(ownerId: string): Promise<OwnerSettings> {
  const admin = createAdminClient();
  const { data } = await admin.from("owner_settings").select(COLUMNS).eq("owner_id", ownerId).maybeSingle();
  const parsed = OwnerSettingsSchema.safeParse(withDefaults((data ?? null) as Partial<OwnerSettings> | null));
  return parsed.success ? parsed.data : withDefaults(null);
}

export async function updateSettings(ownerId: string, raw: unknown): Promise<{ ok: true; settings: OwnerSettings; changed: string[] } | { ok: false; reason: string }> {
  const parsed = SettingsPatchSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) };
  const patch: SettingsPatch = parsed.data;
  const changed = Object.keys(patch);
  if (!changed.length) return { ok: true, settings: await getSettings(ownerId), changed: [] };
  const admin = createAdminClient();
  const { error } = await admin.from("owner_settings").upsert({ owner_id: ownerId, ...patch }, { onConflict: "owner_id" });
  if (error) return { ok: false, reason: `settings_write_failed:${redactString(error.message ?? "").slice(0, 120)}` };
  return { ok: true, settings: await getSettings(ownerId), changed };
}
