import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConnection, listConnections, setConnectionStatus } from "@/lib/integrations/store";
import type { ConnectionSummary } from "@/lib/integrations/types";
import { audit } from "@/lib/audit";
import { errorMessage, log } from "@/lib/security/log";
import { redactString } from "@/lib/security/redact";
import type { CapabilitySyncResult, SourceItemInput, SyncSummary } from "./types";

/**
 * Generic sync runner. A provider adapter exposes one fetch function per
 * capability; the runner handles sync_runs bookkeeping, upserts, cursors,
 * auditing and error isolation. Adapters never see the database.
 */

export interface CapabilityFetchResult {
  items: SourceItemInput[];
  seen: number;
  cursor?: string | null;
  /** Records the provider reports as deleted (e.g. Plaid `removed`). */
  remove?: { resource_type: string; external_ids: string[] };
}

export type CapabilityFetch = (conn: ConnectionSummary, cursor: string | null) => Promise<CapabilityFetchResult>;

export interface SyncAdapter {
  provider: string;
  capabilities: Record<string, CapabilityFetch>;
  /** Capabilities that run whenever the connection is synced, even if not in its granted list (e.g. Plaid account balances ride on the transactions product). */
  alwaysRun?: string[];
}

const ADAPTERS: Record<string, () => Promise<SyncAdapter>> = {
  google: async () => (await import("./google")).googleSyncAdapter,
  highlevel: async () => (await import("./highlevel")).highlevelSyncAdapter,
  stripe: async () => (await import("./stripe")).stripeSyncAdapter,
  plaid: async () => (await import("./plaid")).plaidSyncAdapter,
  meta: async () => (await import("./meta")).metaSyncAdapter,
  slack: async () => (await import("./slack")).slackSyncAdapter,
  notion: async () => (await import("./notion")).notionSyncAdapter,
};

export function hasSyncAdapter(provider: string) {
  return provider in ADAPTERS;
}

export const SYNCABLE_PROVIDERS = Object.keys(ADAPTERS);

const UPSERT_CHUNK = 200;

async function upsertItems(ownerId: string, connectionId: string, items: SourceItemInput[]): Promise<number> {
  if (!items.length) return 0;
  const admin = createAdminClient();
  let count = 0;
  for (let i = 0; i < items.length; i += UPSERT_CHUNK) {
    const rows = items.slice(i, i + UPSERT_CHUNK).map((it) => ({
      owner_id: ownerId,
      connection_id: connectionId,
      provider: it.provider,
      capability: it.capability,
      resource_type: it.resource_type,
      external_id: it.external_id,
      title: it.title,
      summary: it.summary,
      author: it.author,
      source_url: it.source_url,
      source_timestamp: it.source_timestamp,
      synced_at: new Date().toISOString(),
      content_hash: it.content_hash,
      tags: it.tags,
      metadata: it.metadata,
      is_sample: false,
    }));
    const { error } = await admin.from("source_items").upsert(rows, { onConflict: "owner_id,provider,resource_type,external_id" });
    if (error) throw new Error(`source_items_upsert_failed:${error.code ?? ""}`);
    count += rows.length;
  }
  return count;
}

async function removeItems(ownerId: string, provider: string, remove: CapabilityFetchResult["remove"]): Promise<number> {
  if (!remove?.external_ids.length) return 0;
  const admin = createAdminClient();
  let removed = 0;
  for (let i = 0; i < remove.external_ids.length; i += UPSERT_CHUNK) {
    const ids = remove.external_ids.slice(i, i + UPSERT_CHUNK);
    const { error, count } = await admin
      .from("source_items")
      .delete({ count: "exact" })
      .eq("owner_id", ownerId)
      .eq("provider", provider)
      .eq("resource_type", remove.resource_type)
      .in("external_id", ids);
    if (error) throw new Error(`source_items_delete_failed:${error.code ?? ""}`);
    removed += count ?? 0;
  }
  return removed;
}

function cursorsOf(conn: ConnectionSummary): Record<string, string | null> {
  const c = conn.metadata.sync_cursors;
  return c && typeof c === "object" ? (c as Record<string, string | null>) : {};
}

async function runCapability(
  ownerId: string,
  conn: ConnectionSummary,
  capability: string,
  fetchFn: CapabilityFetch,
  trigger: string,
): Promise<CapabilitySyncResult> {
  const admin = createAdminClient();
  const startedAt = new Date().toISOString();
  const { data: run } = await admin
    .from("sync_runs")
    .insert({ owner_id: ownerId, connection_id: conn.id, provider: conn.provider, resource_type: capability, trigger, status: "running", started_at: startedAt })
    .select("id")
    .single();
  const runId = run?.id as string | undefined;
  const cursor = cursorsOf(conn)[capability] ?? null;
  try {
    const res = await fetchFn(conn, cursor);
    const upserted = await upsertItems(ownerId, conn.id, res.items);
    const removed = await removeItems(ownerId, conn.provider, res.remove);
    if (removed) log.info("sync_items_removed", { provider: conn.provider, capability, removed });
    if (runId) {
      await admin
        .from("sync_runs")
        .update({ status: "succeeded", finished_at: new Date().toISOString(), items_seen: res.seen, items_upserted: upserted, cursor: res.cursor ?? cursor })
        .eq("id", runId);
    }
    return { capability, seen: res.seen, upserted, cursor: res.cursor ?? cursor };
  } catch (err) {
    const message = redactString(errorMessage(err)).slice(0, 300);
    if (runId) await admin.from("sync_runs").update({ status: "failed", finished_at: new Date().toISOString(), error: message }).eq("id", runId);
    log.warn("sync_capability_failed", { provider: conn.provider, capability, message });
    return { capability, seen: 0, upserted: 0, error: message };
  }
}

/**
 * Syncs one connection. Capabilities default to the connection's granted
 * capabilities that the adapter supports.
 */
export async function syncConnection(
  ownerId: string,
  conn: ConnectionSummary,
  opts: { capabilities?: string[]; trigger?: string } = {},
): Promise<SyncSummary> {
  const load = ADAPTERS[conn.provider];
  if (!load) throw new Error("no_sync_adapter");
  const adapter = await load();
  const trigger = opts.trigger ?? "manual";
  const requested = opts.capabilities?.length ? opts.capabilities : conn.capabilities.length ? conn.capabilities : Object.keys(adapter.capabilities);
  const wanted = [...new Set([...requested, ...(opts.capabilities?.length ? [] : (adapter.alwaysRun ?? []))])].filter((c) => c in adapter.capabilities);
  await audit({ event: "sync_started", ownerId, provider: conn.provider, targetId: conn.id, actor: trigger === "schedule" ? "system" : "owner", metadata: { capabilities: wanted, trigger } });

  const results: CapabilitySyncResult[] = [];
  for (const cap of wanted) {
    results.push(await runCapability(ownerId, conn, cap, adapter.capabilities[cap]!, trigger));
  }

  const cursors = { ...cursorsOf(conn) };
  for (const r of results) if (!r.error && r.cursor !== undefined) cursors[r.capability] = r.cursor ?? null;
  const failed = results.filter((r) => r.error);
  const fresh = (await getConnection(ownerId, conn.id)) ?? conn;
  await setConnectionStatus(conn.id, {
    metadata: { ...fresh.metadata, sync_cursors: cursors, last_sync_results: results.map((r) => ({ capability: r.capability, seen: r.seen, upserted: r.upserted, error: r.error ?? null })) },
    lastSyncAt: new Date().toISOString(),
    ...(failed.length === results.length && results.length ? { lastError: failed[0]!.error ?? "sync_failed" } : {}),
  });
  await audit({
    event: failed.length ? "sync_failed" : "sync_completed",
    ownerId,
    provider: conn.provider,
    targetId: conn.id,
    actor: trigger === "schedule" ? "system" : "owner",
    metadata: { results: results.map((r) => ({ capability: r.capability, seen: r.seen, upserted: r.upserted, error: r.error ?? null })) },
  });
  return { connectionId: conn.id, provider: conn.provider, results };
}

/** Syncs every syncable, healthy connection for the owner (used by cron). */
export async function syncAllForOwner(ownerId: string, trigger = "schedule"): Promise<SyncSummary[]> {
  const conns = await listConnections(ownerId);
  const out: SyncSummary[] = [];
  for (const c of conns) {
    if (!hasSyncAdapter(c.provider)) continue;
    if (!["connected", "limited"].includes(c.status)) continue;
    try {
      out.push(await syncConnection(ownerId, c, { trigger }));
    } catch (err) {
      log.warn("sync_connection_failed", { provider: c.provider, message: errorMessage(err) });
    }
  }
  return out;
}
