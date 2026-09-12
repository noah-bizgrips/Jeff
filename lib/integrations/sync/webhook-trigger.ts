import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { toSummary } from "@/lib/integrations/store";
import { syncConnection } from "./runner";
import { errorMessage, log } from "@/lib/security/log";

/**
 * Webhook follow-through: a verified provider event triggers a bounded sync
 * of the matching connection. Webhooks carry no owner session, so the
 * connection is located by provider (+ external account id when the provider
 * scopes events to one item, e.g. Plaid item_id). Failures are logged only —
 * the webhook response never depends on this.
 */

const COLUMNS =
  "id, owner_id, provider, display_name, status, access_mode, scopes, capabilities, account_identifier, last_test_at, last_test_ok, last_error, last_sync_at, created_at, updated_at, metadata";

export const WEBHOOK_SYNC_BUDGET_MS = 20_000;

export async function syncFromWebhook(provider: string, opts: { externalAccountId?: string | null; capabilities?: string[] } = {}): Promise<void> {
  try {
    const admin = createAdminClient();
    let q = admin.from("connections").select(COLUMNS).eq("provider", provider).in("status", ["connected", "limited"]);
    if (opts.externalAccountId) q = q.eq("external_account_id", opts.externalAccountId);
    const { data, error } = await q.order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (error || !data) {
      log.info("webhook_sync_skipped", { provider, reason: error ? "lookup_failed" : "no_connection" });
      return;
    }
    const row = data as unknown as Parameters<typeof toSummary>[0] & { owner_id: string };
    const conn = toSummary(row);
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), WEBHOOK_SYNC_BUDGET_MS));
    const result = await Promise.race([syncConnection(row.owner_id, conn, { capabilities: opts.capabilities, trigger: "webhook" }), timeout]);
    if (result === "timeout") log.warn("webhook_sync_budget_exceeded", { provider, connectionId: conn.id });
  } catch (err) {
    log.warn("webhook_sync_failed", { provider, message: errorMessage(err) });
  }
}
