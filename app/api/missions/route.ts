import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { looksSensitive } from "@/lib/security/redact";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const Create = z.object({
  goal: z.string().trim().min(8).max(4000),
  title: z.string().trim().min(3).max(120).optional(),
  worker: z.enum(["claude", "n8n", "manual"]).default("claude"),
  target: z.record(z.string(), z.unknown()).default({}),
});

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase.from("missions").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) return apiError("missions_list_failed", 500);
  return json({ missions: data ?? [] });
});

/** POST creates a sandbox-only draft. Production environment is not assignable here. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Create);
  if (!body.ok) return body.response;
  if (looksSensitive(body.data.goal)) return apiError("sensitive_content_rejected", 400);
  const admin = createAdminClient();
  const { count } = await admin.from("missions").select("id", { count: "exact", head: true }).eq("owner_id", g.session.userId);
  const code = `M-${String((count ?? 0) + 1).padStart(4, "0")}`;
  const { data, error } = await g.supabase
    .from("missions")
    .insert({
      owner_id: g.session.userId,
      code,
      title: body.data.title ?? body.data.goal.slice(0, 95),
      goal: body.data.goal,
      status: "draft",
      worker: body.data.worker,
      target: body.data.target,
      environment: "sandbox",
    })
    .select("*")
    .single();
  if (error) return apiError("mission_create_failed", 500);
  await audit({ event: "mission_created", ownerId: g.session.userId, targetId: data.id, request: req, metadata: { code, worker: body.data.worker } });
  return json({ mission: data }, { status: 201 });
});
