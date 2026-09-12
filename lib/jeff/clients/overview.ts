import type { ClientMapEntry } from "./map-core";

/** Pure per-client summaries from synced rows (no I/O). PII-free by construction. */
export interface ClientRow {
  id: string;
  provider: string;
  resource_type: string;
  external_id: string;
  title: string | null;
  summary: string | null;
  source_url: string | null;
  source_timestamp: string | null;
  metadata: Record<string, unknown>;
}

export interface FindingLite {
  id: string;
  category: string;
  title: string;
  severity: string;
  status: string;
  evidence: unknown;
  metrics: Record<string, unknown>;
}

export interface ClientSummary {
  client_id: string;
  name: string;
  slug: string | null;
  status: string | null;
  admin_url: string | null;
  day_zero: string | null;
  plan_days: number | null;
  days_elapsed: number | null;
  stages: { total: number; complete: number; in_progress: string[] };
  tasks: { open: number; overdue_total: number; overdue_bizgrips: number; overdue_client: number; blocking_overdue: number; due_next_7d: number };
  tasks_overdue_list: { title: string; owner: string | null; due_at: string | null; overdue_days: number }[];
  leads: { total_30d: number; new_uncontacted: number; booked_30d: number; won_30d: number };
  recent_leads: { name: string; outcome: string | null; source: string | null; submitted_at: string | null }[];
  appointments_next_14d: number;
  notification_failures_7d: number;
  billing: { attributed_customers: number; unpaid_invoices: number; unpaid_minor: number; currency: string } | null;
  ads_7d: { spend_minor: number; leads_from_ads: number | null; currency: string } | null;
  identifiers: { meta_page_ids: number; highlevel_contacts: number; stripe_customers: number; portal_users: number };
  open_findings: { id: string; category: string; title: string; severity: string }[];
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const DAY = 86_400_000;

export function summarizeClients(map: ClientMapEntry[], rows: ClientRow[], findings: FindingLite[], now: Date): ClientSummary[] {
  const t = now.getTime();
  const byClient = new Map<string, ClientRow[]>();
  for (const r of rows) {
    const cid = s(r.metadata.client_id) ?? (r.provider === "portal" && r.resource_type === "client" ? r.external_id : null);
    if (!cid) continue;
    byClient.set(cid, [...(byClient.get(cid) ?? []), r]);
  }
  return map.map((c) => {
    const mine = byClient.get(c.portal_client_id) ?? [];
    const clientRow = mine.find((r) => r.provider === "portal" && r.resource_type === "client");
    const stages = mine.filter((r) => r.provider === "portal" && r.resource_type === "stage");
    const tasks = mine.filter((r) => r.provider === "portal" && r.resource_type === "task");
    const openTasks = tasks.filter((r) => s(r.metadata.status) !== "complete");
    const overdue = openTasks.filter((r) => r.metadata.is_overdue === true || (s(r.metadata.due_at) ? Date.parse(s(r.metadata.due_at)!) < t : false));
    const dueSoon = openTasks.filter((r) => {
      const d = s(r.metadata.due_at);
      return !!d && Date.parse(d) >= t && Date.parse(d) < t + 7 * DAY;
    });
    const leads = mine.filter((r) => r.provider === "portal" && r.resource_type === "lead");
    const leads30 = leads.filter((r) => r.source_timestamp && Date.parse(r.source_timestamp) >= t - 30 * DAY);
    const appts = mine.filter((r) => r.provider === "portal" && r.resource_type === "appointment" && s(r.metadata.status) === "scheduled" && r.source_timestamp && Date.parse(r.source_timestamp) >= t && Date.parse(r.source_timestamp) < t + 14 * DAY);
    const notif = mine.filter((r) => r.provider === "portal" && r.resource_type === "notification" && r.source_timestamp && Date.parse(r.source_timestamp) >= t - 7 * DAY);
    const invoices = mine.filter((r) => r.provider === "stripe" && r.resource_type === "invoice");
    const unpaid = invoices.filter((r) => ["open", "past_due", "uncollectible"].includes(String(r.metadata.status ?? "")));
    const ads = mine.filter((r) => r.provider === "meta" && r.resource_type === "ad_insight" && r.source_timestamp && Date.parse(r.source_timestamp) >= t - 7 * DAY);
    const dayZero = s(clientRow?.metadata.day_zero);
    const idPrefix = `"client_id":"${c.portal_client_id}"`;
    const mineFindings = findings.filter((f) => f.title.startsWith(`${c.name}:`) || JSON.stringify(f.metrics).includes(idPrefix) || JSON.stringify(f.evidence).includes(`/admin/#client/${c.portal_client_id}`));
    return {
      client_id: c.portal_client_id,
      name: c.name,
      slug: c.slug,
      status: c.status,
      admin_url: clientRow?.source_url ?? null,
      day_zero: dayZero,
      plan_days: typeof clientRow?.metadata.plan_days === "number" ? clientRow.metadata.plan_days : null,
      days_elapsed: dayZero ? Math.floor((t - Date.parse(dayZero)) / DAY) : null,
      stages: { total: stages.length, complete: stages.filter((r) => s(r.metadata.status) === "complete").length, in_progress: stages.filter((r) => s(r.metadata.status) === "in_progress").map((r) => r.title ?? "stage") },
      tasks: {
        open: openTasks.length,
        overdue_total: overdue.length,
        overdue_bizgrips: overdue.filter((r) => s(r.metadata.owner) !== "Client").length,
        overdue_client: overdue.filter((r) => s(r.metadata.owner) === "Client").length,
        blocking_overdue: overdue.filter((r) => r.metadata.blocking === true).length,
        due_next_7d: dueSoon.length,
      },
      tasks_overdue_list: overdue.slice(0, 10).map((r) => ({ title: r.title ?? "task", owner: s(r.metadata.owner), due_at: s(r.metadata.due_at), overdue_days: s(r.metadata.due_at) ? Math.round((t - Date.parse(s(r.metadata.due_at)!)) / DAY) : 0 })),
      leads: {
        total_30d: leads30.length,
        new_uncontacted: leads.filter((r) => s(r.metadata.outcome) === "new" && r.source_timestamp && t - Date.parse(r.source_timestamp) > DAY).length,
        booked_30d: leads30.filter((r) => s(r.metadata.outcome) === "booked").length,
        won_30d: leads30.filter((r) => s(r.metadata.outcome) === "won").length,
      },
      recent_leads: leads
        .slice()
        .sort((a, b) => (b.source_timestamp ?? "").localeCompare(a.source_timestamp ?? ""))
        .slice(0, 5)
        .map((r) => ({ name: r.title ?? "lead", outcome: s(r.metadata.outcome), source: s(r.metadata.source), submitted_at: r.source_timestamp })),
      appointments_next_14d: appts.length,
      notification_failures_7d: notif.length,
      billing: c.stripe_customer_ids.length || invoices.length ? { attributed_customers: c.stripe_customer_ids.length, unpaid_invoices: unpaid.length, unpaid_minor: unpaid.reduce((a, r) => a + num(r.metadata.amount_remaining ?? r.metadata.amount_due), 0), currency: s(unpaid[0]?.metadata.currency) ?? "usd" } : null,
      ads_7d: ads.length ? { spend_minor: ads.reduce((a, r) => a + num(r.metadata.spend), 0), leads_from_ads: ads.reduce((a, r) => a + num(r.metadata.leads), 0), currency: s(ads[0]?.metadata.currency) ?? "usd" } : null,
      identifiers: { meta_page_ids: c.meta_page_ids.length, highlevel_contacts: c.highlevel_contact_ids.length, stripe_customers: c.stripe_customer_ids.length, portal_users: c.email_hashes.length },
      open_findings: mineFindings.slice(0, 10).map((f) => ({ id: f.id, category: f.category, title: f.title, severity: f.severity })),
    };
  });
}
