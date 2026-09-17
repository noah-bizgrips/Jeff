import "server-only";
import { fetchJson } from "@/lib/integrations/providers/base";
import { HIGHLEVEL_VERSION, highlevelAccessToken, type HighLevelSecret } from "@/lib/integrations/providers/highlevel";
import { readSecret, writeSecret, type SecretBundle } from "@/lib/integrations/store";
import type { ConnectionSummary } from "@/lib/integrations/types";
import {
  mapCalendarEvent,
  mapContact,
  mapConversation,
  mapOpportunity,
  toIso,
  type HLCalendarEvent,
  type HLContact,
  type HLConversation,
  type HLOpportunity,
  type HLPipeline,
} from "./highlevel-mappers";
import type { SourceItemInput } from "./types";
import type { SyncAdapter, CapabilityFetch } from "./runner";

/**
 * HighLevel / LeadConnector read-only sync. One connection = one location.
 *
 * Endpoints and parameters verified against the official OpenAPI specs in
 * GoHighLevel/highlevel-api-docs (apps/contacts.json, opportunities.json,
 * conversations.json, calendars.json):
 *   GET /contacts/?locationId&limit&startAfterId&startAfter   (marked deprecated in favour of
 *       POST /contacts/search, whose body schema is not published in the spec; the GET is
 *       still served and fully described, so V1 uses it — see note below)
 *   GET /opportunities/search?location_id&limit&startAfterId&startAfter   (+ meta.startAfterId/startAfter)
 *   GET /opportunities/pipelines?locationId
 *   GET /conversations/search?locationId&limit&sort&sortBy&startAfterDate
 *   GET /calendars/?locationId  and  GET /calendars/events?locationId&calendarId&startTime&endTime (millis)
 */

const BASE = "https://services.leadconnectorhq.com";
const PAGE = 100;
const MAX_CONTACTS = 500;
const MAX_OPPORTUNITIES = 500;
const MAX_CONVERSATIONS = 300;
const MAX_CALENDARS = 20;
const DAY = 86_400_000;

interface Session {
  token: string;
  locationId: string;
}

async function sessionFor(conn: ConnectionSummary): Promise<Session> {
  const secret = await readSecret<HighLevelSecret>(conn.id);
  if (!secret) throw new Error("secret_missing");
  const locationId = secret.location_id ?? (typeof conn.metadata.locationId === "string" ? conn.metadata.locationId : null);
  if (!locationId) throw new Error("highlevel_location_missing");
  const r = await highlevelAccessToken(secret);
  if (r.refreshed) await writeSecret(conn.id, r.refreshed as SecretBundle, r.refreshed.expires_at ?? null);
  return { token: r.token, locationId };
}

function headers(token: string) {
  return { headers: { Authorization: `Bearer ${token}`, Version: HIGHLEVEL_VERSION, Accept: "application/json" } };
}

async function get<T>(s: Session, path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const u = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  const { status, body } = await fetchJson<T>(u.toString(), { ...headers(s.token), timeoutMs: 20000 });
  if (status !== 200 || !body) throw new Error(`highlevel_${path.replace(/\W+/g, "_")}_failed:${status}`);
  return body;
}

interface PageMeta {
  startAfterId?: string;
  startAfter?: number | string;
  nextPageUrl?: string;
  total?: number;
}

/** Contacts: newest-updated first is not supported on the list endpoint, so we page from the start and rely on the run cap + upsert idempotency. */
const contacts: CapabilityFetch = async (conn, cursor) => {
  const s = await sessionFor(conn);
  const all: HLContact[] = [];
  let startAfterId: string | undefined;
  let startAfter: string | number | undefined;
  let seen = 0;
  // Incremental hint: only re-emit contacts updated after the last run (still paginates from the start; the API has no updated-since filter).
  const sinceMs = cursor && Number.isFinite(Date.parse(cursor)) ? Date.parse(cursor) - 6 * 60 * 60 * 1000 : 0;
  while (all.length < MAX_CONTACTS) {
    const body = await get<{ contacts?: HLContact[]; meta?: PageMeta }>(s, "/contacts/", { locationId: s.locationId, limit: PAGE, startAfterId, startAfter });
    const page = body.contacts ?? [];
    seen += page.length;
    all.push(...page);
    if (page.length < PAGE) break;
    const meta = body.meta ?? {};
    const last = page[page.length - 1]!;
    const nextId = meta.startAfterId ?? last.id;
    const nextAfter = meta.startAfter ?? (last.dateAdded ? Date.parse(last.dateAdded) : undefined);
    if (!nextId || nextId === startAfterId) break;
    startAfterId = nextId;
    startAfter = nextAfter;
  }
  const items = all
    .slice(0, MAX_CONTACTS)
    .filter((c) => !sinceMs || (toIso(c.dateUpdated ?? c.dateAdded) ? Date.parse(toIso(c.dateUpdated ?? c.dateAdded)!) >= sinceMs : true))
    .map((c) => mapContact(c, s.locationId))
    .filter((x): x is SourceItemInput => !!x);
  return { items, seen, cursor: new Date().toISOString() };
};

const opportunities: CapabilityFetch = async (conn) => {
  const s = await sessionFor(conn);
  let pipelines: HLPipeline[] = [];
  try {
    pipelines = (await get<{ pipelines?: HLPipeline[] }>(s, "/opportunities/pipelines", { locationId: s.locationId })).pipelines ?? [];
  } catch {
    pipelines = []; // stage names are a nicety; ids are still stored
  }
  const all: HLOpportunity[] = [];
  let startAfterId: string | undefined;
  let startAfter: string | number | undefined;
  let seen = 0;
  while (all.length < MAX_OPPORTUNITIES) {
    const body = await get<{ opportunities?: HLOpportunity[]; meta?: PageMeta }>(s, "/opportunities/search", {
      location_id: s.locationId,
      limit: PAGE,
      startAfterId,
      startAfter,
    });
    const page = body.opportunities ?? [];
    seen += page.length;
    all.push(...page);
    const meta = body.meta ?? {};
    if (page.length < PAGE || !meta.startAfterId || meta.startAfterId === startAfterId) break;
    startAfterId = meta.startAfterId;
    startAfter = meta.startAfter;
  }
  const items = all
    .slice(0, MAX_OPPORTUNITIES)
    .map((o) => mapOpportunity(o, s.locationId, pipelines))
    .filter((x): x is SourceItemInput => !!x);
  return { items, seen, cursor: new Date().toISOString() };
};

const conversations: CapabilityFetch = async (conn) => {
  const s = await sessionFor(conn);
  const all: HLConversation[] = [];
  let startAfterDate: string | number | undefined;
  let seen = 0;
  while (all.length < MAX_CONVERSATIONS) {
    const body = await get<{ conversations?: HLConversation[]; total?: number }>(s, "/conversations/search", {
      locationId: s.locationId,
      limit: PAGE,
      sort: "desc",
      sortBy: "last_message_date",
      startAfterDate,
    });
    const page = body.conversations ?? [];
    seen += page.length;
    all.push(...page);
    if (page.length < PAGE) break;
    const last = page[page.length - 1]!;
    const next = last.lastMessageDate ?? last.dateUpdated ?? last.dateAdded;
    if (next == null || next === startAfterDate) break;
    startAfterDate = typeof next === "number" ? next : Date.parse(String(next)) || undefined;
    if (!startAfterDate) break;
  }
  const items = all
    .slice(0, MAX_CONVERSATIONS)
    .map((c) => mapConversation(c, s.locationId))
    .filter((x): x is SourceItemInput => !!x);
  return { items, seen, cursor: new Date().toISOString() };
};

const calendars: CapabilityFetch = async (conn) => {
  const s = await sessionFor(conn);
  const list = (await get<{ calendars?: { id: string; name?: string; isActive?: boolean }[] }>(s, "/calendars/", { locationId: s.locationId })).calendars ?? [];
  // Look back far enough that a client's first appointment (booked weeks before they sign) is on record for goals.
  const startTime = Date.now() - 120 * DAY;
  const endTime = Date.now() + 60 * DAY;
  const events: HLCalendarEvent[] = [];
  let seen = 0;
  for (const cal of list.slice(0, MAX_CALENDARS)) {
    try {
      const body = await get<{ events?: HLCalendarEvent[] }>(s, "/calendars/events", { locationId: s.locationId, calendarId: cal.id, startTime, endTime });
      const page = body.events ?? [];
      seen += page.length;
      events.push(...page);
    } catch {
      // one broken calendar must not fail the whole capability
    }
  }
  const items = events.map((e) => mapCalendarEvent(e, s.locationId)).filter((x): x is SourceItemInput => !!x);
  return { items, seen, cursor: new Date().toISOString() };
};

export const highlevelSyncAdapter: SyncAdapter = {
  provider: "highlevel",
  capabilities: { contacts, opportunities, conversations, calendars },
};
