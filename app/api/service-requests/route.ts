import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { classifyServiceRequest } from "@/lib/integrations/service-requests";
import { looksSensitive } from "@/lib/security/redact";

export const dynamic = "force-dynamic";

const Body = z.object({
  serviceName: z.string().trim().min(2).max(80),
  desiredCapability: z.string().trim().min(3).max(1000),
  accessIntent: z.enum(["read", "read_write"]).default("read"),
  requestedResources: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
});

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase.from("service_requests").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) return apiError("service_requests_failed", 500);
  return json({ requests: data ?? [] });
});

/** POST "Add a service": records + classifies. Never installs or executes anything. */
export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  if (looksSensitive(`${body.data.serviceName} ${body.data.desiredCapability}`)) return apiError("sensitive_content_rejected", 400);
  const c = classifyServiceRequest(body.data.serviceName, body.data.desiredCapability);
  const { data, error } = await g.supabase
    .from("service_requests")
    .insert({
      owner_id: g.session.userId,
      service_name: body.data.serviceName,
      desired_capability: body.data.desiredCapability,
      access_intent: body.data.accessIntent,
      requested_resources: body.data.requestedResources,
      status: c.status,
      classification_notes: c.notes,
      matched_provider: c.matchedProvider,
    })
    .select("*")
    .single();
  if (error) return apiError("service_request_create_failed", 500);
  await audit({ event: "service_request_created", ownerId: g.session.userId, targetId: data.id, request: req, metadata: { service: body.data.serviceName, status: c.status } });
  return json({ request: data }, { status: 201 });
});
