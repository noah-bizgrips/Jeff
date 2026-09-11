import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { looksSensitive } from "@/lib/security/redact";

export const dynamic = "force-dynamic";

const Body = z.object({
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(100_000),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(12).default([]),
});

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase.from("notes").select("*").order("created_at", { ascending: false }).limit(500);
  if (error) return apiError("notes_failed", 500);
  return json({ notes: data ?? [] });
});

export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  if (looksSensitive(`${body.data.title} ${body.data.content}`)) return apiError("sensitive_content_rejected", 400);
  const { data, error } = await g.supabase
    .from("notes")
    .insert({ owner_id: g.session.userId, title: body.data.title, content: body.data.content, tags: body.data.tags.length ? body.data.tags : ["ideas"] })
    .select("*")
    .single();
  if (error) return apiError("note_create_failed", 500);
  return json({ note: data }, { status: 201 });
});

export const DELETE = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const { error } = await g.supabase.from("notes").delete().eq("id", id);
  if (error) return apiError("note_delete_failed", 500);
  return json({ ok: true });
});
