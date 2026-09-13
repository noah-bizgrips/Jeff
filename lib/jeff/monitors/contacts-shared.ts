import type { SourceRow } from "./types";
import { bareAddress, classifyAuthor } from "@/lib/jeff/rules/engine";

/**
 * Lightweight contact graph shared by Relationship Radar and Client Health.
 * Built purely from synced rows: Gmail (from/to), Calendar attendees,
 * HighLevel contacts/conversations, Slack authors and portal client users.
 * Identity: email address when known, otherwise a normalised display name.
 * Nothing here stores raw bodies; interaction = (timestamp, provider, kind).
 */

export const DAY = 86_400_000;

export type InteractionKind = "inbound" | "outbound" | "meeting" | "crm" | "chat";

export interface Interaction {
  at: number;
  provider: string;
  kind: InteractionKind;
  rowId: string;
}

export interface Contact {
  key: string;
  name: string;
  emails: string[];
  domain: string | null;
  /** HighLevel contact ids that resolve to this person. */
  ghlContactIds: string[];
  /** HighLevel `source` value for contacts referred by this person (referral partner signal). */
  interactions: Interaction[];
  /** Sorted ascending timestamps (derived). */
  timeline: number[];
  /** Median gap between interactions in days (null when < 3 interactions). */
  typicalGapDays: number | null;
  lastAt: number | null;
  firstAt: number | null;
  isClientUser: boolean;
  clientId: string | null;
}

export interface ContactGraph {
  contacts: Map<string, Contact>;
  byEmail: Map<string, string>;
  byName: Map<string, string>;
  ownerEmail: string | null;
}

const NOISE_DOMAINS = /(noreply|no-reply|notifications?|mailer|bounce|calendar-notification|docs\.google|accounts\.google|linkedin\.com|facebook(mail)?\.com|slack\.com|zoom\.us|stripe\.com|github\.com|vercel\.com|intuit\.com|plaid\.com|gohighlevel|leadconnector)/i;

export function normaliseName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/<[^>]*>/g, "")
    .replace(/["']/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.includes("@")) return null;
  return cleaned.toLowerCase();
}

export function displayFromAuthor(author: string | null | undefined): string | null {
  if (!author) return null;
  const m = author.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
  if (m) return m[1]!.trim() || null;
  return author.includes("@") ? null : author.trim() || null;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function domainOf(email: string | null): string | null {
  if (!email) return null;
  const i = email.indexOf("@");
  return i > 0 ? email.slice(i + 1) : null;
}

function isNoiseAddress(email: string | null, display: string | null): boolean {
  if (email && NOISE_DOMAINS.test(email)) return true;
  if (display && /\b(notifications?|no-?reply|team|support|billing|newsletter|digest)\b/i.test(display)) return true;
  return false;
}

/** Builds the contact graph from rows in the lookback window. Owner and bot/system senders are excluded. */
export function buildContactGraph(rows: SourceRow[], now: Date, ownerEmail: string | null, lookbackDays = 180): ContactGraph {
  const since = now.getTime() - lookbackDays * DAY;
  const graph: ContactGraph = { contacts: new Map(), byEmail: new Map(), byName: new Map(), ownerEmail: ownerEmail?.toLowerCase() ?? null };

  const upsert = (email: string | null, name: string | null, extra: Partial<Pick<Contact, "ghlContactIds" | "isClientUser" | "clientId">> = {}): Contact | null => {
    const e = email?.toLowerCase() ?? null;
    if (e && graph.ownerEmail && e === graph.ownerEmail) return null;
    if (isNoiseAddress(e, name)) return null;
    const n = normaliseName(name);
    let key = e ? graph.byEmail.get(e) : undefined;
    if (!key && n) key = graph.byName.get(n);
    if (!key) {
      if (!e && !n) return null;
      key = e ? `email:${e}` : `name:${n}`;
      graph.contacts.set(key, { key, name: name?.trim() || e || n || "Unknown", emails: [], domain: domainOf(e), ghlContactIds: [], interactions: [], timeline: [], typicalGapDays: null, lastAt: null, firstAt: null, isClientUser: false, clientId: null });
    }
    const c = graph.contacts.get(key)!;
    if (e && !c.emails.includes(e)) {
      c.emails.push(e);
      graph.byEmail.set(e, key);
      c.domain = c.domain ?? domainOf(e);
    }
    if (n && !graph.byName.has(n)) graph.byName.set(n, key);
    if (name && (c.name === c.emails[0] || c.name === "Unknown")) c.name = name.trim();
    if (extra.ghlContactIds) for (const id of extra.ghlContactIds) if (!c.ghlContactIds.includes(id)) c.ghlContactIds.push(id);
    if (extra.isClientUser) c.isClientUser = true;
    if (extra.clientId) c.clientId = extra.clientId;
    return c;
  };

  const touch = (c: Contact | null, at: number, provider: string, kind: InteractionKind, rowId: string) => {
    if (!c || !Number.isFinite(at) || at < since) return;
    c.interactions.push({ at, provider, kind, rowId });
  };

  for (const r of rows) {
    const at = r.source_timestamp ? Date.parse(r.source_timestamp) : NaN;
    if (r.provider === "google" && r.resource_type === "email") {
      if (classifyAuthor(r) !== "human") continue;
      const from = bareAddress(r.author);
      const fromOwner = !!from && !!graph.ownerEmail && from === graph.ownerEmail;
      const to = Array.isArray(r.metadata.to) ? (r.metadata.to as string[]) : [];
      if (fromOwner) {
        for (const addr of to) touch(upsert(addr, null), at, "google", "outbound", r.id);
      } else {
        touch(upsert(from, displayFromAuthor(r.author)), at, "google", "inbound", r.id);
      }
    } else if (r.provider === "google" && r.resource_type === "event") {
      const attendees = Array.isArray(r.metadata.attendees) ? (r.metadata.attendees as string[]) : [];
      for (const addr of attendees) touch(upsert(addr, null), at, "google", "meeting", r.id);
    } else if (r.provider === "highlevel" && r.resource_type === "contact") {
      const c = upsert(null, r.title, { ghlContactIds: [r.external_id] });
      const last = typeof r.metadata.lastActivity === "string" ? Date.parse(r.metadata.lastActivity) : at;
      touch(c, last, "highlevel", "crm", r.id);
    } else if (r.provider === "highlevel" && r.resource_type === "message") {
      const contactId = typeof r.metadata.contactId === "string" ? r.metadata.contactId : null;
      const name = r.title?.split("·")[0]?.trim() ?? null;
      const c = upsert(null, name, contactId ? { ghlContactIds: [contactId] } : {});
      const dir = r.metadata.lastMessageDirection === "outbound" ? "outbound" : "inbound";
      touch(c, at, "highlevel", dir, r.id);
    } else if (r.provider === "slack" && r.resource_type === "message") {
      if (classifyAuthor(r) !== "human") continue;
      touch(upsert(null, r.author), at, "slack", "chat", r.id);
    } else if (r.provider === "portal" && r.resource_type === "client") {
      const users = Array.isArray(r.metadata.client_users) ? (r.metadata.client_users as { email_domain?: string; name?: string }[]) : [];
      const clientId = typeof r.metadata.client_id === "string" ? r.metadata.client_id : r.external_id;
      for (const u of users) if (u.name) upsert(null, u.name, { isClientUser: true, clientId });
    }
  }

  for (const c of graph.contacts.values()) {
    c.timeline = c.interactions.map((i) => i.at).sort((a, b) => a - b);
    c.firstAt = c.timeline[0] ?? null;
    c.lastAt = c.timeline.at(-1) ?? null;
    const gaps: number[] = [];
    for (let i = 1; i < c.timeline.length; i++) gaps.push((c.timeline[i]! - c.timeline[i - 1]!) / DAY);
    c.typicalGapDays = c.timeline.length >= 3 ? median(gaps) : null;
  }
  return graph;
}

export interface ImportanceInput {
  /** Memory contents (any category) — names mentioned as important are honoured. */
  memories?: { content: string; category: string }[];
  topN?: number;
  minInteractions?: number;
}

/**
 * Which contacts matter: explicitly named in memories ("X is important", "our referral partner X"),
 * portal client users, HighLevel contacts with recent activity, or the top-N by interaction volume.
 * Never every contact.
 */
export function importantContacts(graph: ContactGraph, input: ImportanceInput = {}): { contact: Contact; reason: string }[] {
  const topN = input.topN ?? 12;
  const minInteractions = input.minInteractions ?? 4;
  const named = (input.memories ?? [])
    .filter((m) => /\b(important|matters|priority|key (contact|relationship)|referral|partner|mentor|friend|family)\b/i.test(m.content))
    .map((m) => m.content.toLowerCase());
  const out = new Map<string, { contact: Contact; reason: string }>();
  for (const c of graph.contacts.values()) {
    const nameL = c.name.toLowerCase();
    if (nameL.length >= 3 && named.some((m) => m.includes(nameL))) {
      out.set(c.key, { contact: c, reason: "named as important in your memories" });
      continue;
    }
    if (c.isClientUser) {
      out.set(c.key, { contact: c, reason: "client contact (portal)" });
      continue;
    }
  }
  const ranked = [...graph.contacts.values()].filter((c) => !out.has(c.key) && c.interactions.length >= minInteractions).sort((a, b) => b.interactions.length - a.interactions.length);
  for (const c of ranked.slice(0, topN)) out.set(c.key, { contact: c, reason: `${c.interactions.length} interactions in 180 days` });
  return [...out.values()];
}
