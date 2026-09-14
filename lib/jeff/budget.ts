import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log } from "@/lib/security/log";
import { dailyBudgetUsd, estimateCostUsd, type UsageCounts } from "./pricing";

export { estimateCostUsd, dailyBudgetUsd } from "./pricing";

/** Start of the current UTC day as ISO. */
export function utcDayStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** Sum of estimated spend so far today (UTC) for the owner. */
export async function spentTodayUsd(ownerId: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("ai_usage").select("estimated_usd").eq("owner_id", ownerId).gte("created_at", utcDayStart());
  if (error) {
    // Fail closed: if the ledger is unreadable, treat the budget as exhausted.
    log.warn("ai_usage_read_failed", { message: error.message });
    return Number.POSITIVE_INFINITY;
  }
  return (data ?? []).reduce((acc, r) => acc + Number(r.estimated_usd ?? 0), 0);
}

export interface BudgetStatus {
  spentUsd: number;
  budgetUsd: number;
  exhausted: boolean;
}

export async function budgetStatus(ownerId: string): Promise<BudgetStatus> {
  const budgetUsd = dailyBudgetUsd();
  const spentUsd = await spentTodayUsd(ownerId);
  return { spentUsd: Number.isFinite(spentUsd) ? spentUsd : budgetUsd, budgetUsd, exhausted: spentUsd >= budgetUsd };
}

/** Records one model call. Never throws. */
export type AiFeature = "chat" | "briefing" | "goal" | "blind_spot" | "rule" | "grouping" | "other" | `job:${string}`;

export async function recordUsage(ownerId: string, model: string, usage: UsageCounts, feature: AiFeature = "other"): Promise<number> {
  const estimated = estimateCostUsd(model, usage);
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("ai_usage").insert({
      owner_id: ownerId,
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      estimated_usd: estimated,
      feature,
    });
    if (error) log.warn("ai_usage_write_failed", { message: error.message });
  } catch (err) {
    log.warn("ai_usage_write_failed", { message: err instanceof Error ? err.message : "unknown" });
  }
  return estimated;
}
