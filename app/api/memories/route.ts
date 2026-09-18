import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
import { forgetMemory, listMemories, rememberMemory, updateMemory } from "@/lib/gomez/rules/store";
import { MemoryCategorySchema, MemoryInputSchema, ScopeSchema } from "@/lib/gomez/rules/schema";
import { looksSensitive } from "@/lib/security/redact";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  return json({ memories: await listMemories(g.session.userId) });
});

export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, MemoryInputSchema);
  if (!body.ok) return body.response;
  if (looksSensitive(body.data.content)) return apiError("sensitive_content_rejected", 400);
  const res = await rememberMemory(g.session.userId, body.data, { source: "settings" });
  if (!res.ok) return apiError("memory_invalid", 400, { reason: res.reason });
  await audit({ event: "memory_created", ownerId: g.session.userId, targetId: res.memory.id, request: req, metadata: { category: res.memory.category, scope: res.memory.scope, source: "settings" } });
  return json({ memory: res.memory }, { status: res.created ? 201 : 200 });
});

const Patch = z.object({ id: z.string().uuid(), content: z.string().trim().min(3).max(1000).optional(), category: MemoryCategorySchema.optional(), scope: ScopeSchema.optional(), active: z.boolean().optional() }).strict();

export const PATCH = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Patch);
  if (!body.ok) return body.response;
  if (body.data.content && looksSensitive(body.data.content)) return apiError("sensitive_content_rejected", 400);
  const { id, ...patch } = body.data;
  const memory = await updateMemory(g.session.userId, id, patch);
  if (!memory) return apiError("memory_not_found", 404);
  await audit({ event: "memory_updated", ownerId: g.session.userId, targetId: id, request: req, metadata: { fields: Object.keys(patch) } });
  return json({ memory });
});

export const DELETE = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const res = await forgetMemory(g.session.userId, { id });
  if (!res.removed) return apiError("memory_not_found", 404);
  await audit({ event: "memory_deleted", ownerId: g.session.userId, targetId: id, request: req });
  return json({ ok: true });
});
