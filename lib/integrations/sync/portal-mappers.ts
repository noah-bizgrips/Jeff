import { createHash } from "node:crypto";
import type { SourceItemInput } from "./types";
import type { PortalRow } from "@/lib/integrations/providers/portal";

/**
 * Maps the portal export feed (already PII-minimised at the source: hashed
 * emails, last-4 phones, no free text) into source_items. The portal is the
 * source of truth for client identity, so every row carries `client_id` in
 * metadata for later attribution.
 *
 * Admin deep link: the portal answers exactly one, `/admin/#client/<id>`.
 */

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const b = (v: unknown): boolean => v === true || v === 1 || v === "1";

export function hashOf(...parts: (string | null | undefined)[]) {
  return createHash("sha256").update(parts.map((p) => p ?? "").join("|")).digest("hex");
}

export function clientAdminUrl(base: string, clientId: string | number | null): string | null {
  return clientId == null ? null : `${base.replace(/\/$/, "")}/admin/#client/${clientId}`;
}

export interface ClientUserSummary {
  email_hash: string | null;
  email_domain: string | null;
  role: string | null;
  status: string | null;
}

export function mapClient(c: PortalRow, base: string, users: ClientUserSummary[] = []): SourceItemInput {
  const id = s(c.id)!;
  const status = s(c.status) ?? "unknown";
  return {
    provider: "portal",
    capability: "clients",
    resource_type: "client",
    external_id: id,
    title: s(c.name) ?? `Client ${id}`,
    summary: [status.replace(/_/g, " "), s(c.industry), s(c.location), s(c.day_zero) ? `day 0 ${String(c.day_zero).slice(0, 10)}` : null].filter(Boolean).join(" · "),
    author: null,
    source_url: clientAdminUrl(base, id),
    source_timestamp: s(c.updated_at) ?? s(c.created_at),
    content_hash: hashOf(id, status, s(c.updated_at)),
    tags: ["portal", "client", status],
    metadata: {
      client_id: id,
      slug: s(c.slug),
      status,
      industry: s(c.industry),
      location: s(c.location),
      template_id: s(c.template_id),
      owner_staff_id: s(c.owner_staff_id),
      ghl_contact_id: s(c.ghl_contact_id),
      ghl_calendar_id: s(c.ghl_calendar_id),
      day_zero: s(c.day_zero),
      intake_completed_at: s(c.intake_completed_at),
      intake_required: b(c.intake_required),
      plan_days: n(c.plan_days),
      timezone: s(c.timezone),
      booking_link: s(c.booking_link),
      business_phone_last4: s(c.business_phone_last4),
      client_users: users.map((u) => ({ email_hash: u.email_hash, email_domain: u.email_domain, role: u.role, status: u.status })),
      created_at: s(c.created_at),
    },
  };
}

export function mapStage(st: PortalRow, base: string, now: Date): SourceItemInput {
  const id = s(st.id)!;
  const clientId = s(st.client_id);
  const status = s(st.status) ?? "not_started";
  const startedAt = s(st.started_at);
  const dayStart = n(st.day_start) ?? 0;
  const dayEnd = n(st.day_end) ?? 0;
  const windowDays = Math.max(0, dayEnd - dayStart);
  const ageDays = startedAt ? (now.getTime() - Date.parse(startedAt)) / 86_400_000 : null;
  return {
    provider: "portal",
    capability: "clients",
    resource_type: "stage",
    external_id: id,
    title: s(st.title) ?? `Stage ${id}`,
    summary: [status.replace(/_/g, " "), s(st.subtitle), `days ${dayStart}–${dayEnd}`].filter(Boolean).join(" · "),
    author: null,
    source_url: clientAdminUrl(base, clientId),
    source_timestamp: s(st.completed_at) ?? startedAt ?? s(st.changed_at),
    content_hash: hashOf(id, status, startedAt, s(st.completed_at)),
    tags: ["portal", "stage", status],
    metadata: {
      client_id: clientId,
      status,
      position: n(st.position),
      day_start: dayStart,
      day_end: dayEnd,
      window_days: windowDays,
      started_at: startedAt,
      completed_at: s(st.completed_at),
      age_days: ageDays != null ? Math.round(ageDays * 10) / 10 : null,
      visibility: s(st.visibility),
    },
  };
}

export function mapTask(t: PortalRow, base: string, now: Date, stageTitle: string | null = null): SourceItemInput {
  const id = s(t.id)!;
  const clientId = s(t.client_id);
  const status = s(t.status) ?? "not_started";
  const dueAt = s(t.due_at);
  const overdue = status !== "complete" && !!dueAt && Date.parse(dueAt) < now.getTime();
  const owner = s(t.owner) ?? "BizGrips";
  return {
    provider: "portal",
    capability: "tasks",
    resource_type: "task",
    external_id: id,
    title: s(t.title) ?? `Task ${id}`,
    summary: [status.replace(/_/g, " "), `owner ${owner}`, b(t.blocking) ? "blocking" : null, dueAt ? `due ${dueAt.slice(0, 10)}` : null, s(t.summary)].filter(Boolean).join(" · ").slice(0, 400),
    author: owner,
    source_url: clientAdminUrl(base, clientId),
    source_timestamp: dueAt ?? s(t.created_at),
    content_hash: hashOf(id, status, dueAt, s(t.completed_at), s(t.response_at)),
    tags: ["portal", "task", status, owner.toLowerCase(), s(t.category) ?? "onboarding"],
    metadata: {
      client_id: clientId,
      client_stage_id: s(t.client_stage_id),
      stage_title: stageTitle,
      status,
      owner,
      blocking: b(t.blocking),
      category: s(t.category),
      due_at: dueAt,
      is_overdue: overdue,
      overdue_days: overdue && dueAt ? Math.round(((now.getTime() - Date.parse(dueAt)) / 86_400_000) * 10) / 10 : 0,
      assignee_email_hash: s(t.assignee_email_hash),
      assignee_email_domain: s(t.assignee_email_domain),
      started_at: s(t.started_at),
      completed_at: s(t.completed_at),
      completed_by: s(t.completed_by),
      response_at: s(t.response_at),
      visibility: s(t.visibility),
      created_at: s(t.created_at),
    },
  };
}

export function mapLead(l: PortalRow, base: string): SourceItemInput {
  const id = s(l.id)!;
  const clientId = s(l.client_id);
  const outcome = s(l.outcome) ?? "new";
  const name = [s(l.first_name), s(l.last_name)].filter(Boolean).join(" ") || `Lead ${id}`;
  return {
    provider: "portal",
    capability: "leads",
    resource_type: "lead",
    external_id: id,
    title: name,
    summary: [outcome, s(l.source) ? `via ${s(l.source)}` : null, s(l.phone_last4) ? `phone ···${s(l.phone_last4)}` : null].filter(Boolean).join(" · "),
    author: null,
    source_url: clientAdminUrl(base, clientId),
    source_timestamp: s(l.submitted_at) ?? s(l.created_at),
    content_hash: hashOf(id, outcome, s(l.updated_at)),
    tags: ["portal", "lead", outcome],
    metadata: {
      client_id: clientId,
      outcome,
      source: s(l.source),
      ghl_contact_id: s(l.ghl_contact_id),
      email_hash: s(l.email_hash),
      email_domain: s(l.email_domain),
      phone_last4: s(l.phone_last4),
      submitted_at: s(l.submitted_at),
      created_at: s(l.created_at),
      updated_at: s(l.updated_at),
    },
  };
}

export function mapAppointment(a: PortalRow, base: string): SourceItemInput {
  const id = s(a.id)!;
  const clientId = s(a.client_id);
  const status = s(a.status) ?? "scheduled";
  return {
    provider: "portal",
    capability: "leads",
    resource_type: "appointment",
    external_id: id,
    title: `Appointment · ${status}${s(a.starts_at) ? ` · ${String(a.starts_at).slice(0, 16).replace("T", " ")}` : ""}`,
    summary: status,
    author: null,
    source_url: clientAdminUrl(base, clientId),
    source_timestamp: s(a.starts_at),
    content_hash: hashOf(id, status, s(a.updated_at)),
    tags: ["portal", "appointment", status],
    metadata: { client_id: clientId, lead_id: s(a.lead_id), ghl_appointment_id: s(a.ghl_appointment_id), status, starts_at: s(a.starts_at) },
  };
}

const NOTIFY_KEEP = new Set(["failed", "bounced"]);

/** Only delivery problems are worth a row; successes are noise. Queued > 1h counts as stuck. */
export function mapNotification(nr: PortalRow, base: string, now: Date): SourceItemInput | null {
  const status = s(nr.status) ?? "sent";
  const sentAt = s(nr.sent_at);
  const stuck = status === "queued" && !!sentAt && now.getTime() - Date.parse(sentAt) > 3_600_000;
  if (!NOTIFY_KEEP.has(status) && !stuck) return null;
  const id = s(nr.id)!;
  const clientId = s(nr.client_id);
  return {
    provider: "portal",
    capability: "notifications",
    resource_type: "notification",
    external_id: id,
    title: `${s(nr.channel) ?? "notification"} ${stuck ? "stuck" : status}${s(nr.client_name) ? ` · ${s(nr.client_name)}` : ""}`,
    summary: [s(nr.event), s(nr.title), s(nr.reason)].filter(Boolean).join(" · ").slice(0, 300),
    author: null,
    source_url: clientAdminUrl(base, clientId),
    source_timestamp: sentAt,
    content_hash: hashOf(id, status),
    tags: ["portal", "notification", stuck ? "stuck" : status],
    metadata: { client_id: clientId, event: s(nr.event), channel: s(nr.channel), status: stuck ? "stuck" : status, reason: s(nr.reason), recipient_hash: s(nr.recipient_hash), sent_at: sentAt },
  };
}

export function mapEvent(e: PortalRow, base: string): SourceItemInput {
  const id = s(e.id)!;
  const clientId = s(e.client_id);
  const type = s(e.type) ?? "event";
  return {
    provider: "portal",
    capability: "notifications",
    resource_type: "portal_event",
    external_id: id,
    title: `${type.replace(/_/g, " ")}${s(e.subject) ? ` · ${String(e.subject).slice(0, 120)}` : ""}`,
    summary: s(e.subject),
    author: s(e.actor),
    source_url: clientAdminUrl(base, clientId),
    source_timestamp: s(e.at),
    content_hash: hashOf(id, type),
    tags: ["portal", "event", type],
    metadata: { client_id: clientId, type, task_id: s(e.task_id), stage_id: s(e.stage_id), actor: s(e.actor) },
  };
}

export interface LeadSourceSummary {
  id: string;
  client_id: string | null;
  source_type: string | null;
  routing_key: string | null;
  meta_form_id: string | null;
  sheet_id: string | null;
  active: boolean;
}

export function summarizeLeadSource(ls: PortalRow): LeadSourceSummary {
  return { id: s(ls.id)!, client_id: s(ls.client_id), source_type: s(ls.source_type), routing_key: s(ls.routing_key), meta_form_id: s(ls.meta_form_id), sheet_id: s(ls.sheet_id), active: b(ls.active) };
}

export function summarizeClientUser(u: PortalRow): ClientUserSummary & { client_id: string | null } {
  return { client_id: s(u.client_id), email_hash: s(u.email_hash), email_domain: s(u.email_domain), role: s(u.role), status: s(u.status) };
}

/** A lead_sources row as its own source item so the client map can be rebuilt from synced data alone. */
export function mapLeadSource(ls: PortalRow, base: string): SourceItemInput {
  const x = summarizeLeadSource(ls);
  return {
    provider: "portal",
    capability: "leads",
    resource_type: "lead_source",
    external_id: x.id,
    title: `${x.source_type ?? "source"}${x.routing_key ? ` ${x.routing_key}` : ""}`,
    summary: x.active ? "active" : "inactive",
    author: null,
    source_url: clientAdminUrl(base, x.client_id),
    source_timestamp: s(ls.updated_at) ?? s(ls.created_at),
    content_hash: hashOf(x.id, x.routing_key, String(x.active)),
    tags: ["portal", "lead_source", x.source_type ?? "unknown"],
    metadata: { client_id: x.client_id, source_type: x.source_type, routing_key: x.routing_key, meta_form_id: x.meta_form_id, sheet_id: x.sheet_id, active: x.active },
  };
}
