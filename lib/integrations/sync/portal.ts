import "server-only";
import type { CapabilityFetch, CapabilityFetchResult, SyncAdapter } from "./runner";
import type { SourceItemInput } from "./types";
import { fetchPortalExport, portalBase, type PortalExport, type PortalRow } from "@/lib/integrations/providers/portal";
import { mapAppointment, mapClient, mapEvent, mapLead, mapLeadSource, mapNotification, mapStage, mapTask, summarizeClientUser, type ClientUserSummary } from "./portal-mappers";

/**
 * BizGrips Client Portal sync. Four capabilities share one export feed; each
 * keeps its own `since` cursor (the portal's `server_time` from its last
 * successful run) so a failure in one never advances the others.
 *
 * The feed is already PII-minimised; this adapter only reshapes it.
 */

const PAGE = 1000;

async function pull(cursor: string | null, fetchImpl?: typeof fetch): Promise<PortalExport> {
  return fetchPortalExport(cursor, PAGE, fetchImpl);
}

const str = (v: unknown) => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

export function buildClientsItems(data: PortalExport, base: string, now: Date): SourceItemInput[] {
  const items: SourceItemInput[] = [];
  // Each client row carries its users' hashed emails so the client can be joined to calendar, CRM and billing records.
  const usersByClient = new Map<string, ClientUserSummary[]>();
  for (const u of data.client_users?.rows ?? []) {
    const x = summarizeClientUser(u);
    if (!x.client_id) continue;
    usersByClient.set(x.client_id, [...(usersByClient.get(x.client_id) ?? []), x]);
  }
  for (const c of data.clients?.rows ?? []) items.push(mapClient(c, base, usersByClient.get(str(c.id) ?? "") ?? []));
  for (const st of data.client_stages?.rows ?? []) items.push(mapStage(st, base, now));
  for (const u of data.client_users?.rows ?? []) {
    const x = summarizeClientUser(u);
    const id = str(u.id);
    if (!id) continue;
    items.push({
      provider: "portal",
      capability: "clients",
      resource_type: "client_user",
      external_id: id,
      title: `Portal user · ${x.email_domain ?? "unknown domain"}${x.role ? ` · ${x.role}` : ""}`,
      summary: x.status,
      author: null,
      source_url: x.client_id ? `${base}/admin/#client/${x.client_id}` : null,
      source_timestamp: str(u.last_login_at) ?? str(u.invited_at),
      content_hash: null,
      tags: ["portal", "client_user", x.status ?? "unknown"],
      metadata: { client_id: x.client_id, email_hash: x.email_hash, email_domain: x.email_domain, role: x.role, status: x.status, last_login_at: str(u.last_login_at) },
    });
  }
  return items;
}

export function buildTasksItems(data: PortalExport, base: string, now: Date): SourceItemInput[] {
  const stageTitles = new Map<string, string>();
  for (const st of data.client_stages?.rows ?? []) {
    const id = str(st.id);
    const title = str(st.title);
    if (id && title) stageTitles.set(id, title);
  }
  return (data.client_tasks?.rows ?? []).map((t) => mapTask(t, base, now, stageTitles.get(str(t.client_stage_id) ?? "") ?? null));
}

export function buildLeadsItems(data: PortalExport, base: string): { items: SourceItemInput[]; removedLeadIds: string[] } {
  const items: SourceItemInput[] = [];
  const removedLeadIds: string[] = [];
  for (const l of data.leads?.rows ?? []) {
    if (str(l.deleted_at)) {
      const id = str(l.id);
      if (id) removedLeadIds.push(id);
      continue;
    }
    items.push(mapLead(l, base));
  }
  for (const a of data.appointments?.rows ?? []) items.push(mapAppointment(a, base));
  for (const ls of data.lead_sources?.rows ?? []) items.push(mapLeadSource(ls, base));
  return { items, removedLeadIds };
}

export function buildNotificationItems(data: PortalExport, base: string, now: Date): SourceItemInput[] {
  const items: SourceItemInput[] = [];
  for (const nr of data.notification_log?.rows ?? []) {
    const it = mapNotification(nr as PortalRow, base, now);
    if (it) items.push(it);
  }
  for (const e of data.events?.rows ?? []) items.push(mapEvent(e, base));
  return items;
}

function makeCapability(build: (data: PortalExport, base: string, now: Date) => { items: SourceItemInput[]; remove?: CapabilityFetchResult["remove"] }): CapabilityFetch {
  return async (_conn, cursor) => {
    const data = await pull(cursor);
    const { items, remove } = build(data, portalBase(), new Date());
    return { items, seen: items.length + (remove?.external_ids.length ?? 0), cursor: data.server_time ?? cursor, remove };
  };
}

/**
 * Clients: a full inventory pull every run (the client tables are small) so
 * every client row carries its current users, and accounts deleted in the
 * portal (hard-deleted there, no tombstone in the feed) disappear from Gomez —
 * and therefore from every goal, report and audit view.
 */
const clients: CapabilityFetch = async (_conn, cursor) => {
  const data = await pull(null);
  const items = buildClientsItems(data, portalBase(), new Date());
  return { items, seen: items.length, cursor: data.server_time ?? cursor, retain: inventoryOf(data) };
};

/** Ids present in a full export; undefined when the page was full (inventory incomplete → never delete). */
export function inventoryOf(full: PortalExport): CapabilityFetchResult["retain"] {
  const clients = full.clients?.rows ?? [];
  const users = full.client_users?.rows ?? [];
  if (clients.length >= PAGE || users.length >= PAGE) return undefined;
  const ids = (rows: PortalRow[]) => rows.map((r) => str(r.id)).filter((x): x is string => !!x);
  return [
    { resource_type: "client", external_ids: ids(clients) },
    { resource_type: "client_user", external_ids: ids(users) },
  ];
}
const tasks: CapabilityFetch = makeCapability((d, base, now) => ({ items: buildTasksItems(d, base, now) }));
const leads: CapabilityFetch = makeCapability((d, base) => {
  const { items, removedLeadIds } = buildLeadsItems(d, base);
  return { items, remove: removedLeadIds.length ? { resource_type: "lead", external_ids: removedLeadIds } : undefined };
});
const notifications: CapabilityFetch = makeCapability((d, base, now) => ({ items: buildNotificationItems(d, base, now) }));

export const portalSyncAdapter: SyncAdapter = {
  provider: "portal",
  capabilities: { clients, tasks, leads, notifications },
  alwaysRun: ["clients", "tasks", "leads", "notifications"],
};
