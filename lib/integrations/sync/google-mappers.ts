import { createHash } from "node:crypto";
import type { SourceItemInput } from "./types";

/**
 * Pure mappers from Google API payloads to source_items rows.
 * Deliberately narrow: Gmail keeps only the snippet Google already computed,
 * never the message body.
 */

export interface GmailMessageMeta {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: { name: string; value: string }[] };
}

const SKIP_LABELS = new Set(["SPAM", "TRASH", "CATEGORY_PROMOTIONS"]);

function header(m: GmailMessageMeta, name: string) {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

/** Strip display names down to bare addresses and cap the list. */
export function minimiseAddresses(value: string | null, max = 5): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => {
      const m = s.match(/<([^>]+)>/);
      return (m ? m[1]! : s).trim().toLowerCase();
    })
    .filter(Boolean)
    .slice(0, max);
}

export function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function mapGmailMessage(m: GmailMessageMeta): SourceItemInput | null {
  const labels = m.labelIds ?? [];
  if (labels.some((l) => SKIP_LABELS.has(l))) return null;
  const subject = header(m, "Subject") ?? "(no subject)";
  const snippet = (m.snippet ?? "").slice(0, 500);
  const ts = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null;
  const tags = labels
    .filter((l) => !l.startsWith("Label_"))
    .map((l) => l.replace(/^CATEGORY_/, "").toLowerCase())
    .slice(0, 12);
  return {
    provider: "google",
    capability: "gmail",
    resource_type: "email",
    external_id: m.id,
    title: subject.slice(0, 300),
    summary: snippet || null,
    author: (header(m, "From") ?? "").slice(0, 200) || null,
    source_url: m.threadId ? `https://mail.google.com/mail/u/0/#all/${m.threadId}` : null,
    source_timestamp: ts,
    content_hash: sha256(`${subject}\n${snippet}`),
    tags,
    metadata: { threadId: m.threadId ?? null, labelIds: labels, to: minimiseAddresses(header(m, "To")) },
  };
}

export interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string }[];
}

export function mapCalendarEvent(e: CalendarEvent): SourceItemInput | null {
  if (e.status === "cancelled") return null;
  const start = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
  const end = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null);
  const attendees = (e.attendees ?? []).map((a) => a.email).filter((x): x is string => !!x);
  const names = (e.attendees ?? [])
    .map((a) => a.displayName ?? a.email)
    .filter(Boolean)
    .slice(0, 8)
    .join(", ");
  const desc = (e.description ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  const summaryParts = [desc, attendees.length ? `Attendees (${attendees.length}): ${names}` : ""].filter(Boolean);
  return {
    provider: "google",
    capability: "calendar",
    resource_type: "event",
    external_id: e.id,
    title: (e.summary ?? "(untitled event)").slice(0, 300),
    summary: summaryParts.join(" · ") || null,
    author: null,
    source_url: e.htmlLink ?? null,
    source_timestamp: start,
    content_hash: sha256(`${e.summary ?? ""}\n${start ?? ""}\n${desc}`),
    tags: ["meeting"],
    metadata: { start, end, location: e.location ?? null, attendees, htmlLink: e.htmlLink ?? null, status: e.status ?? null },
  };
}

export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  owners?: { displayName?: string; emailAddress?: string }[];
  parents?: string[];
  trashed?: boolean;
}

export function mapDriveFile(f: DriveFile): SourceItemInput | null {
  if (f.trashed) return null;
  const owner = f.owners?.[0]?.displayName ?? f.owners?.[0]?.emailAddress ?? null;
  const kind = (f.mimeType ?? "file").replace("application/vnd.google-apps.", "google ");
  return {
    provider: "google",
    capability: "drive",
    resource_type: "file",
    external_id: f.id,
    title: (f.name ?? "(untitled)").slice(0, 300),
    summary: [kind, owner ? `owner ${owner}` : ""].filter(Boolean).join(" · "),
    author: owner,
    source_url: f.webViewLink ?? null,
    source_timestamp: f.modifiedTime ?? null,
    content_hash: sha256(`${f.name ?? ""}\n${f.modifiedTime ?? ""}`),
    tags: ["document"],
    metadata: { mimeType: f.mimeType ?? null, parents: f.parents ?? [] },
  };
}
