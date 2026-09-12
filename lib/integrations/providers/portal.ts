import "server-only";
import type { TestResult } from "./base";
import { hasEnv, requireEnv } from "@/lib/env";

/**
 * BizGrips Client Portal — read-only export feed. The token lives only in
 * Vercel env (PORTAL_EXPORT_TOKEN) and is used exclusively here; Claude tools
 * consume the synced rows, never the feed directly.
 *
 * Endpoint contract: GET <base>/api/hooks/jeff-export?since=<iso>&limit=<n>
 * with header x-bg-token. See BizGrips_Portal docs/INTEGRATIONS.md §6.
 */

export function portalConfigured() {
  return hasEnv("PORTAL_BASE_URL") && hasEnv("PORTAL_EXPORT_TOKEN");
}

export function portalBase(): string {
  return requireEnv("PORTAL_BASE_URL").replace(/\/$/, "");
}

export interface PortalResource<T> {
  truncated: boolean;
  rows: T[];
}

export type PortalRow = Record<string, unknown>;

export interface PortalExport {
  server_time: string;
  since: string;
  clients: PortalResource<PortalRow>;
  client_stages: PortalResource<PortalRow>;
  client_tasks: PortalResource<PortalRow>;
  leads: PortalResource<PortalRow>;
  lead_sources: PortalResource<PortalRow>;
  appointments: PortalResource<PortalRow>;
  notification_log: PortalResource<PortalRow>;
  events: PortalResource<PortalRow>;
  client_users: PortalResource<PortalRow>;
}

export async function fetchPortalExport(since: string | null, limit = 500, fetchImpl: typeof fetch = fetch): Promise<PortalExport> {
  const u = new URL(`${portalBase()}/api/hooks/jeff-export`);
  if (since) u.searchParams.set("since", since);
  u.searchParams.set("limit", String(limit));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetchImpl(u.toString(), {
      headers: { "x-bg-token": requireEnv("PORTAL_EXPORT_TOKEN"), Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (res.status === 401) throw new Error("portal_unauthorised");
    if (res.status === 503) throw new Error("portal_export_not_configured");
    if (!res.ok) throw new Error(`portal_export_failed:${res.status}`);
    return (await res.json()) as PortalExport;
  } finally {
    clearTimeout(timer);
  }
}

/** Harmless read: one row per resource. */
export async function testPortal(fetchImpl: typeof fetch = fetch): Promise<TestResult> {
  if (!portalConfigured()) return { ok: false, error: "portal_not_configured" };
  try {
    const data = await fetchPortalExport(null, 1, fetchImpl);
    let host = "portal";
    try {
      host = new URL(portalBase()).host;
    } catch {
      /* ignore */
    }
    return { ok: true, accountIdentifier: host, details: { reachable: true, clients_seen: data.clients?.rows?.length ?? 0, server_time: data.server_time } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "portal_test_failed" };
  }
}
