import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Subscription = z.object({
  endpoint: z.string().url().max(2000).refine((u) => u.startsWith("https://"), "endpoint must be https"),
  keys: z.object({ p256dh: z.string().min(20).max(300), auth: z.string().min(10).max(100) }),
  expirationTime: z.number().nullable().optional(),
});

const SubscribeBody = z.object({ subscription: Subscription, deviceLabel: z.string().trim().max(80).optional() });
const UnsubscribeBody = z.object({ endpoint: z.string().url().max(2000) });

/** POST /api/push/subscribe — registers (or refreshes) this device's push subscription. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, SubscribeBody);
  if (!body.ok) return body.response;
  const { subscription, deviceLabel } = body.data;
  const admin = createAdminClient();
  const { error } = await admin.from("push_subscriptions").upsert(
    {
      owner_id: g.session.userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      user_agent: req.headers.get("user-agent")?.slice(0, 200) ?? null,
      device_label: deviceLabel ?? null,
      disabled_at: null,
      last_error: null,
    },
    { onConflict: "endpoint" },
  );
  if (error) return apiError("push_subscribe_failed", 500);
  await audit({ event: "push_subscribed", ownerId: g.session.userId, request: req, metadata: { deviceLabel: deviceLabel ?? null } });
  return json({ ok: true });
});

/** DELETE /api/push/subscribe — removes this device's subscription. */
export const DELETE = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, UnsubscribeBody);
  if (!body.ok) return body.response;
  const admin = createAdminClient();
  const { error } = await admin.from("push_subscriptions").delete().eq("owner_id", g.session.userId).eq("endpoint", body.data.endpoint);
  if (error) return apiError("push_unsubscribe_failed", 500);
  await audit({ event: "push_unsubscribed", ownerId: g.session.userId, request: req });
  return json({ ok: true });
});
