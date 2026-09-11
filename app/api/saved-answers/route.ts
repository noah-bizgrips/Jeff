import { z } from "zod";
import { apiError, json, parseBody, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const Body = z.object({
  question: z.string().trim().min(1).max(4000),
  answer: z.string().trim().min(1).max(50_000),
  mode: z.string().max(40).default("ai"),
  citations: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
});

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase.from("saved_answers").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) return apiError("saved_answers_failed", 500);
  return json({ saved: data ?? [] });
});

export const POST = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const body = await parseBody(req, Body);
  if (!body.ok) return body.response;
  const { data, error } = await g.supabase.from("saved_answers").insert({ owner_id: g.session.userId, ...body.data }).select("*").single();
  if (error) return apiError("saved_answer_create_failed", 500);
  return json({ saved: data }, { status: 201 });
});

export const DELETE = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !z.string().uuid().safeParse(id).success) return apiError("invalid_id", 400);
  const { error } = await g.supabase.from("saved_answers").delete().eq("id", id);
  if (error) return apiError("saved_answer_delete_failed", 500);
  return json({ ok: true });
});
