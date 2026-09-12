import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/jeff/settings-store";
import { shouldPushAlert, type PushableAlert } from "./decide";
import { pushConfigured, sendPush } from "./send";
import { log, errorMessage } from "@/lib/security/log";

const PREFIX: Record<string, string> = { urgent: "Urgent", important: "Important", actionable: "Action available" };

/**
 * Pushes every open alert that qualifies and has not been pushed at its
 * current importance. Called at the end of each alert run, so deferred
 * (quiet-hours) alerts go out on the first run after the window ends.
 */
export async function pushPendingAlerts(ownerId: string, now = new Date()): Promise<{ pushed: number; checked: number }> {
  if (!pushConfigured()) return { pushed: 0, checked: 0 };
  const admin = createAdminClient();
  const settings = await getSettings(ownerId);
  const { data } = await admin
    .from("alerts")
    .select("id, status, importance, title, summary, deferred_until, pushed_at, pushed_importance")
    .eq("owner_id", ownerId)
    .eq("status", "open")
    .in("importance", ["important", "urgent", "actionable"])
    .order("last_seen", { ascending: false })
    .limit(50);
  const rows = (data ?? []) as (PushableAlert & { title: string; summary: string })[];
  let pushed = 0;
  for (const a of rows) {
    if (!shouldPushAlert(a, settings, now)) continue;
    try {
      const res = await sendPush(ownerId, {
        title: `${PREFIX[a.importance] ?? "Alert"}: ${a.title}`,
        body: a.summary || a.title,
        url: "/alerts",
        tag: `alert:${a.id}`,
      });
      // Record the push even when no device is subscribed, so a later subscription doesn't replay history.
      await admin.from("alerts").update({ pushed_at: now.toISOString(), pushed_importance: a.importance }).eq("id", a.id).eq("owner_id", ownerId);
      if (res.delivered) pushed++;
    } catch (err) {
      log.warn("alert_push_failed", { id: a.id, message: errorMessage(err) });
    }
  }
  return { pushed, checked: rows.length };
}
