import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log } from "@/lib/security/log";
import type { AttentionRow, AttentionSignal } from "./types";

/** Records attention signals via the service role. Never throws (attention is best-effort). */
export async function recordAttention(ownerId: string, signals: AttentionSignal[]): Promise<number> {
  if (!signals.length) return 0;
  const admin = createAdminClient();
  const rows = signals.slice(0, 50).map((s) => ({
    owner_id: ownerId,
    kind: s.kind,
    ref_id: s.ref_id ? String(s.ref_id).slice(0, 120) : null,
    path: s.path ? String(s.path).slice(0, 200) : null,
  }));
  const { error } = await admin.from("owner_attention").insert(rows);
  if (error) {
    log.warn("attention_write_failed", { message: error.message });
    return 0;
  }
  return rows.length;
}

export async function listAttention(ownerId: string, days = 30): Promise<AttentionRow[]> {
  const admin = createAdminClient();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("owner_attention")
    .select("kind, ref_id, path, created_at")
    .eq("owner_id", ownerId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) {
    log.warn("attention_read_failed", { message: error.message });
    return [];
  }
  return (data ?? []) as AttentionRow[];
}
