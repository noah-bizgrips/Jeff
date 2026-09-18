import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { pushConfigured, sendPush } from "@/lib/gomez/push/send";

export const dynamic = "force-dynamic";

const Body = z.object({ endpoint: z.string().url().max(2000).optional() }).default({});

/** POST /api/push/test — sends a test notification to this device (or all devices). */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  if (!pushConfigured()) return apiError("push_not_configured", 409, { missingEnv: ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] });
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const res = await sendPush(
    g.session.userId,
    { title: "Gomez is connected", body: "Push notifications are working on this device.", url: "/settings", tag: `test:${Date.now()}` },
    body.data.endpoint ? { endpoint: body.data.endpoint } : {},
  );
  return json(res);
});
