import { apiError, json, withErrorBoundary } from "@/lib/api";
import { requireOwnerAal2 } from "@/lib/auth/guard";
import { effectiveMode } from "@/lib/mode";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async (req) => {
  const g = await requireOwnerAal2(req);
  if (!g.ok) return g.response;
  const mode = await effectiveMode();
  let q = g.supabase.from("findings").select("*").order("created_at", { ascending: false }).limit(200);
  if (mode === "live") q = q.eq("is_sample", false);
  const { data, error } = await q;
  if (error) return apiError("findings_list_failed", 500);
  return json({ findings: data ?? [] });
});
