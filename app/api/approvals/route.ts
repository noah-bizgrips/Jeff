import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const { data, error } = await g.supabase.from("approvals").select("*, missions(code, title, goal)").order("requested_at", { ascending: false }).limit(200);
  if (error) return apiError("approvals_list_failed", 500);
  return json({ approvals: data ?? [] });
});
