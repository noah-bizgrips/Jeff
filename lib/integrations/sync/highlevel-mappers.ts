import { createHash } from "node:crypto";
import type { SourceItemInput } from "./types";

/**
 * Pure mappers from HighLevel (LeadConnector) v2 API payloads to source_items.
 * PII is minimised: no full phone numbers, no email addresses — only a masked
 * suffix, the email domain and a sha256 hash usable for matching.
 *
 * Field names verified against the official OpenAPI specs in
 * GoHighLevel/highlevel-api-docs (apps/contacts.json, opportunities.json,
 * conversations.json, calendars.json).
 */

export interface HLContact {
  id: string;
  locationId?: string;
  firstName?: string | null;
  lastName?: string | null;
  contactName?: string | null;
  firstNameLowerCase?: string | null;
  lastNameLowerCase?: string | null;
  email?: string | null;
  phone?: string | null;
  tags?: string[];
  source?: string | null;
  assignedTo?: string | null;
  dateAdded?: string | null;
  dateUpdated?: string | null;
  lastActivity?: string | number | null;
  companyName?: string | null;
  type?: string | null;
}

export interface HLOpportunity {
  id: string;
  name?: string | null;
  monetaryValue?: number | null;
  pipelineId?: string | null;
  pipelineStageId?: string | null;
  assignedTo?: string | null;
  status?: string | null; // open | won | lost | abandoned
  source?: string | null;
  lastStatusChangeAt?: string | null;
  lastStageChangeAt?: string | null;
  lastActionDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  contactId?: string | null;
  locationId?: string | null;
  contact?: { id?: string; name?: string | null; companyName?: string | null } | null;
}

export interface HLPipeline {
  id: string;
  name?: string;
  stages?: { id: string; name?: string; position?: number }[];
}

export interface HLConversation {
  id: string;
  contactId?: string | null;
  locationId?: string | null;
  lastMessageBody?: string | null;
  lastMessageType?: string | null;
  lastMessageDirection?: string | null;
  lastMessageDate?: string | number | null;
  type?: string | null;
  unreadCount?: number | null;
  fullName?: string | null;
  contactName?: string | null;
  assignedTo?: string | null;
  dateAdded?: string | number | null;
  dateUpdated?: string | number | null;
}

export interface HLCalendarEvent {
  id: string;
  title?: string | null;
  calendarId?: string | null;
  locationId?: string | null;
  contactId?: string | null;
  groupId?: string | null;
  appointmentStatus?: string | null;
  assignedUserId?: string | null;
  address?: string | null;
  startTime?: string | number | { toString(): string } | null;
  endTime?: string | number | { toString(): string } | null;
  dateAdded?: string | number | null;
  dateUpdated?: string | number | null;
}

export function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Accepts ISO strings, epoch millis, or objects with toString(); returns ISO or null. */
export function toIso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value).toISOString() : null;
  const s = typeof value === "string" ? value : String(value);
  if (/^\d{11,}$/.test(s)) return new Date(Number(s)).toISOString();
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return `•••${digits.slice(-4)}`;
}

export function emailParts(email: string | null | undefined): { domain: string | null; hash: string | null } {
  if (!email || !email.includes("@")) return { domain: null, hash: null };
  const lower = email.trim().toLowerCase();
  return { domain: lower.split("@")[1] ?? null, hash: sha256(lower) };
}

function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function contactDisplayName(c: HLContact): string {
  const first = c.firstName ?? (c.firstNameLowerCase ? titleCase(c.firstNameLowerCase) : "");
  const last = c.lastName ?? (c.lastNameLowerCase ? titleCase(c.lastNameLowerCase) : "");
  const full = `${first ?? ""} ${last ?? ""}`.trim() || (c.contactName ?? "").trim();
  if (full) return full;
  const { domain } = emailParts(c.email);
  if (domain) return `Contact @${domain}`;
  const masked = maskPhone(c.phone);
  return masked ? `Contact ${masked}` : `Contact ${c.id.slice(0, 6)}`;
}

export function contactUrl(locationId: string, contactId: string) {
  return `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/contacts/detail/${encodeURIComponent(contactId)}`;
}

export function mapContact(c: HLContact, locationId: string): SourceItemInput | null {
  if (!c?.id) return null;
  const tags = (c.tags ?? []).map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 20);
  const { domain, hash } = emailParts(c.email);
  const lastActivity = toIso(c.lastActivity);
  const updated = toIso(c.dateUpdated) ?? toIso(c.dateAdded);
  const summaryBits = [tags.length ? `tags: ${tags.join(", ")}` : null, lastActivity ? `last activity ${lastActivity.slice(0, 10)}` : null, c.source ? `source: ${c.source}` : null].filter(Boolean);
  return {
    provider: "highlevel",
    capability: "contacts",
    resource_type: "contact",
    external_id: c.id,
    title: contactDisplayName(c).slice(0, 200),
    summary: summaryBits.length ? summaryBits.join(" · ") : null,
    author: c.assignedTo ? `owner:${c.assignedTo}` : (c.source ?? null),
    source_url: contactUrl(locationId, c.id),
    source_timestamp: updated,
    content_hash: sha256(`${c.id}|${updated ?? ""}|${tags.join(",")}`),
    tags,
    metadata: {
      locationId,
      tags,
      source: c.source ?? null,
      assignedTo: c.assignedTo ?? null,
      lastActivity,
      dateAdded: toIso(c.dateAdded),
      companyName: c.companyName ?? null,
      phone: maskPhone(c.phone),
      email_domain: domain,
      email_hash: hash,
    },
  };
}

export function mapOpportunity(o: HLOpportunity, locationId: string, pipelines: HLPipeline[] = []): SourceItemInput | null {
  if (!o?.id) return null;
  const pipeline = pipelines.find((p) => p.id === o.pipelineId);
  const stage = pipeline?.stages?.find((s) => s.id === o.pipelineStageId);
  const status = (o.status ?? "open").toLowerCase();
  const value = typeof o.monetaryValue === "number" ? o.monetaryValue : null;
  const updated = toIso(o.updatedAt) ?? toIso(o.createdAt);
  const summary = [pipeline?.name ? `pipeline: ${pipeline.name}` : null, stage?.name ? `stage: ${stage.name}` : null, `status: ${status}`, value != null ? `value: $${value.toLocaleString()}` : null]
    .filter(Boolean)
    .join(" · ");
  return {
    provider: "highlevel",
    capability: "opportunities",
    resource_type: "opportunity",
    external_id: o.id,
    title: (o.name ?? o.contact?.name ?? `Opportunity ${o.id.slice(0, 6)}`).slice(0, 200),
    summary,
    author: o.assignedTo ? `owner:${o.assignedTo}` : null,
    source_url: `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/opportunities/list`,
    source_timestamp: updated,
    content_hash: sha256(`${o.id}|${updated ?? ""}|${o.pipelineStageId ?? ""}|${status}|${value ?? ""}`),
    tags: ["pipeline", status],
    metadata: {
      locationId,
      pipelineId: o.pipelineId ?? null,
      pipeline: pipeline?.name ?? null,
      pipelineStageId: o.pipelineStageId ?? null,
      stage: stage?.name ?? null,
      stagePosition: stage?.position ?? null,
      status,
      monetaryValue: value,
      contactId: o.contactId ?? o.contact?.id ?? null,
      contactName: o.contact?.name ?? null,
      assignedTo: o.assignedTo ?? null,
      lastStageChangeAt: toIso(o.lastStageChangeAt),
      lastStatusChangeAt: toIso(o.lastStatusChangeAt),
      lastActionDate: toIso(o.lastActionDate),
      createdAt: toIso(o.createdAt),
    },
  };
}

export function mapConversation(c: HLConversation, locationId: string): SourceItemInput | null {
  if (!c?.id) return null;
  const name = (c.contactName ?? c.fullName ?? "Contact").trim();
  const preview = (c.lastMessageBody ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  const lastDate = toIso(c.lastMessageDate) ?? toIso(c.dateUpdated) ?? toIso(c.dateAdded);
  return {
    provider: "highlevel",
    capability: "conversations",
    resource_type: "message",
    external_id: c.id,
    title: preview ? `${name}: ${preview}`.slice(0, 200) : name.slice(0, 200),
    summary: [c.lastMessageType ? `type: ${c.lastMessageType}` : null, c.lastMessageDirection ? `direction: ${c.lastMessageDirection}` : null, c.unreadCount ? `unread: ${c.unreadCount}` : null].filter(Boolean).join(" · ") || null,
    author: name,
    source_url: `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/conversations/conversations/${encodeURIComponent(c.id)}`,
    source_timestamp: lastDate,
    content_hash: sha256(`${c.id}|${lastDate ?? ""}|${preview}`),
    tags: ["conversation", ...(c.lastMessageType ? [String(c.lastMessageType).toLowerCase()] : [])],
    metadata: {
      locationId,
      contactId: c.contactId ?? null,
      lastMessageType: c.lastMessageType ?? null,
      lastMessageDirection: c.lastMessageDirection ?? null,
      unreadCount: c.unreadCount ?? 0,
      lastMessageDate: lastDate,
      assignedTo: c.assignedTo ?? null,
    },
  };
}

export function mapCalendarEvent(e: HLCalendarEvent, locationId: string): SourceItemInput | null {
  if (!e?.id) return null;
  const start = toIso(e.startTime);
  const end = toIso(e.endTime);
  const status = (e.appointmentStatus ?? "").toLowerCase() || null;
  return {
    provider: "highlevel",
    capability: "calendars",
    resource_type: "event",
    external_id: e.id,
    title: (e.title ?? "Appointment").slice(0, 200),
    summary: [start ? `starts ${start}` : null, status ? `status: ${status}` : null, e.address ? `at ${String(e.address).slice(0, 80)}` : null].filter(Boolean).join(" · ") || null,
    author: e.assignedUserId ? `user:${e.assignedUserId}` : null,
    source_url: `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/calendars/view`,
    source_timestamp: start,
    content_hash: sha256(`${e.id}|${start ?? ""}|${end ?? ""}|${status ?? ""}`),
    tags: ["appointment", ...(status ? [status] : [])],
    metadata: {
      locationId,
      calendarId: e.calendarId ?? null,
      contactId: e.contactId ?? null,
      assignedUserId: e.assignedUserId ?? null,
      start,
      end,
      status,
    },
  };
}
