import { json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { pushConfigured } from "@/lib/gomez/push/send";

export const dynamic = "force-dynamic";

/** GET /api/push/status?endpoint=… — server-side view of push readiness. Never returns keys. */
export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const endpoint = new URL(req.url).searchParams.get("endpoint");
  const admin = createAdminClient();
  const { data } = await admin.from("push_subscriptions").select("endpoint, device_label, created_at, last_used_at, disabled_at").eq("owner_id", g.session.userId);
  const rows = data ?? [];
  const active = rows.filter((r) => !r.disabled_at);
  return json({
    configured: pushConfigured(),
    devices: active.length,
    thisDevice: endpoint ? active.some((r) => r.endpoint === endpoint) : false,
    list: active.map((r) => ({ label: r.device_label, since: r.created_at, lastUsed: r.last_used_at })),
  });
});
