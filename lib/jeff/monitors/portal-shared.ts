import type { SourceRow } from "./types";

/** Shared helpers for portal/client monitors. */

export const DAY = 86_400_000;

export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

export function clientIdOf(r: SourceRow): string | null {
  return str(r.metadata.client_id);
}

/** Portal client rows indexed by id → display name + slug + admin url. */
export function clientIndex(rows: SourceRow[]): Map<string, { name: string; slug: string | null; url: string | null; status: string | null }> {
  const idx = new Map<string, { name: string; slug: string | null; url: string | null; status: string | null }>();
  for (const r of rows) {
    if (r.provider !== "portal" || r.resource_type !== "client") continue;
    const id = clientIdOf(r) ?? r.external_id;
    idx.set(id, { name: r.title ?? `Client ${id}`, slug: str(r.metadata.slug), url: r.source_url, status: str(r.metadata.status) });
  }
  return idx;
}

export function clientLabel(idx: ReturnType<typeof clientIndex>, id: string | null, fallback: string | null = null): string {
  if (!id) return fallback ?? "Unknown client";
  return idx.get(id)?.name ?? fallback ?? `Client ${id}`;
}

export function groupBy<T>(items: T[], key: (t: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it) ?? "unknown";
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
}

export function isActiveClient(idx: ReturnType<typeof clientIndex>, id: string | null): boolean {
  if (!id) return true;
  const st = idx.get(id)?.status;
  return !st || st === "active_setup" || st === "delivery";
}
