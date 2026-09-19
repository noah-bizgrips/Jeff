import "server-only";
import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasEnv, requireEnv } from "@/lib/env";
import { audit } from "@/lib/audit";
import { log, errorMessage } from "@/lib/security/log";

/**
 * Web Push delivery. The VAPID private key stays in env; subscription keys
 * (p256dh/auth) are read server-side only and never logged. Failures never
 * propagate to callers — a dead device must not break an alert or briefing run.
 */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Collapses repeats of the same thing on the device. */
  tag: string;
}

export interface PushSendResult {
  attempted: number;
  delivered: number;
  disabled: number;
  failed: number;
}

export function pushConfigured(): boolean {
  return hasEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY") && hasEnv("VAPID_PRIVATE_KEY");
}

function configure() {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT?.trim() || "mailto:noah@bizgrips.com",
    requireEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY"),
    requireEnv("VAPID_PRIVATE_KEY"),
  );
}

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function trimBody(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Sends one payload to every enabled subscription of the owner (or a single endpoint). */
export async function sendPush(ownerId: string, payload: PushPayload, opts: { endpoint?: string } = {}): Promise<PushSendResult> {
  const result: PushSendResult = { attempted: 0, delivered: 0, disabled: 0, failed: 0 };
  if (!pushConfigured()) return result;
  const admin = createAdminClient();
  let q = admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("owner_id", ownerId).is("disabled_at", null);
  if (opts.endpoint) q = q.eq("endpoint", opts.endpoint);
  const { data } = await q;
  const subs = (data ?? []) as SubRow[];
  if (!subs.length) return result;
  try {
    configure();
  } catch (err) {
    log.warn("push_not_configured", { message: errorMessage(err) });
    return result;
  }
  const body = JSON.stringify({ title: payload.title.slice(0, 120), body: trimBody(payload.body), url: payload.url, tag: payload.tag });
  const now = new Date().toISOString();
  for (const s of subs) {
    result.attempted++;
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 60 * 60 * 6, urgency: "high" });
      result.delivered++;
      await admin.from("push_subscriptions").update({ last_used_at: now, last_error: null }).eq("id", s.id);
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) {
        result.disabled++;
        await admin.from("push_subscriptions").update({ disabled_at: now, last_error: `gone:${status}` }).eq("id", s.id);
      } else {
        result.failed++;
        await admin.from("push_subscriptions").update({ last_error: errorMessage(err).slice(0, 200) }).eq("id", s.id);
        log.warn("push_send_failed", { status: status ?? null, message: errorMessage(err) });
      }
    }
  }
  if (result.delivered) await audit({ event: "push_sent", ownerId, actor: "system", metadata: { tag: payload.tag, delivered: result.delivered, disabled: result.disabled, failed: result.failed } });
  return result;
}
