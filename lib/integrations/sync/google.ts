import "server-only";
import { fetchJson } from "@/lib/integrations/providers/base";
import { googleAccessToken, type GoogleSecret } from "@/lib/integrations/providers/google";
import { readSecret, writeSecret, type SecretBundle } from "@/lib/integrations/store";
import type { ConnectionSummary } from "@/lib/integrations/types";
import { mapCalendarEvent, mapDriveFile, mapGmailMessage, type CalendarEvent, type DriveFile, type GmailMessageMeta } from "./google-mappers";
import type { SourceItemInput } from "./types";
import type { SyncAdapter, CapabilityFetch } from "./runner";

const MAX_ITEMS = 500;
const PAGE = 100;
const DAY = 86_400_000;

/** Resolves a usable access token, persisting a refreshed one when needed. */
async function tokenFor(conn: ConnectionSummary): Promise<string> {
  const secret = await readSecret<GoogleSecret>(conn.id);
  if (!secret) throw new Error("secret_missing");
  const r = await googleAccessToken(secret);
  if (r.refreshed) await writeSecret(conn.id, r.refreshed as SecretBundle, r.refreshed.expires_at ?? null);
  return r.token;
}

function auth(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

const gmail: CapabilityFetch = async (conn, cursor) => {
  const token = await tokenFor(conn);
  const since = cursor ? Date.parse(cursor) : Date.now() - 30 * DAY;
  const afterEpoch = Math.floor((Number.isFinite(since) ? since : Date.now() - 30 * DAY) / 1000);
  const ids: { id: string }[] = [];
  let pageToken: string | undefined;
  while (ids.length < MAX_ITEMS) {
    const u = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    u.searchParams.set("maxResults", String(PAGE));
    u.searchParams.set("q", `after:${afterEpoch} -category:promotions -in:spam -in:trash`);
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const { status, body } = await fetchJson<{ messages?: { id: string }[]; nextPageToken?: string }>(u.toString(), auth(token));
    if (status !== 200) throw new Error(`gmail_list_failed:${status}`);
    ids.push(...(body?.messages ?? []));
    pageToken = body?.nextPageToken;
    if (!pageToken) break;
  }
  const metas = await mapLimit(ids.slice(0, MAX_ITEMS), 6, async ({ id }) => {
    const u = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
    u.searchParams.set("format", "metadata");
    for (const h of ["Subject", "From", "To"]) u.searchParams.append("metadataHeaders", h);
    const { status, body } = await fetchJson<GmailMessageMeta>(u.toString(), auth(token));
    return status === 200 && body ? body : null;
  });
  const items = metas.map((m) => (m ? mapGmailMessage(m) : null)).filter((x): x is SourceItemInput => !!x);
  // Next run starts from the newest message seen minus a small overlap window.
  const newest = items.reduce((acc, it) => Math.max(acc, it.source_timestamp ? Date.parse(it.source_timestamp) : 0), 0);
  const nextCursor = newest ? new Date(newest - 6 * 60 * 60 * 1000).toISOString() : cursor ?? null;
  return { items, seen: ids.length, cursor: nextCursor };
};

const calendar: CapabilityFetch = async (conn) => {
  const token = await tokenFor(conn);
  const timeMin = new Date(Date.now() - 7 * DAY).toISOString();
  const timeMax = new Date(Date.now() + 60 * DAY).toISOString();
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  while (events.length < MAX_ITEMS) {
    const u = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    u.searchParams.set("singleEvents", "true");
    u.searchParams.set("orderBy", "startTime");
    u.searchParams.set("timeMin", timeMin);
    u.searchParams.set("timeMax", timeMax);
    u.searchParams.set("maxResults", String(PAGE));
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const { status, body } = await fetchJson<{ items?: CalendarEvent[]; nextPageToken?: string }>(u.toString(), auth(token));
    if (status !== 200) throw new Error(`calendar_list_failed:${status}`);
    events.push(...(body?.items ?? []));
    pageToken = body?.nextPageToken;
    if (!pageToken) break;
  }
  const items = events.slice(0, MAX_ITEMS).map(mapCalendarEvent).filter((x): x is SourceItemInput => !!x);
  return { items, seen: events.length, cursor: new Date().toISOString() };
};

const drive: CapabilityFetch = async (conn, cursor) => {
  const token = await tokenFor(conn);
  const since = cursor && Number.isFinite(Date.parse(cursor)) ? new Date(Date.parse(cursor)) : new Date(Date.now() - 30 * DAY);
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  while (files.length < MAX_ITEMS) {
    const u = new URL("https://www.googleapis.com/drive/v3/files");
    u.searchParams.set("q", `modifiedTime > '${since.toISOString()}' and trashed = false`);
    u.searchParams.set("fields", "nextPageToken, files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress),parents,trashed)");
    u.searchParams.set("orderBy", "modifiedTime desc");
    u.searchParams.set("pageSize", String(PAGE));
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const { status, body } = await fetchJson<{ files?: DriveFile[]; nextPageToken?: string }>(u.toString(), auth(token));
    if (status !== 200) throw new Error(`drive_list_failed:${status}`);
    files.push(...(body?.files ?? []));
    pageToken = body?.nextPageToken;
    if (!pageToken) break;
  }
  const items = files.slice(0, MAX_ITEMS).map(mapDriveFile).filter((x): x is SourceItemInput => !!x);
  const newest = items.reduce((acc, it) => Math.max(acc, it.source_timestamp ? Date.parse(it.source_timestamp) : 0), 0);
  return { items, seen: files.length, cursor: newest ? new Date(newest - 60 * 60 * 1000).toISOString() : (cursor ?? null) };
};

export const googleSyncAdapter: SyncAdapter = {
  provider: "google",
  capabilities: { gmail, calendar, drive },
};
