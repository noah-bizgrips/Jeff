import { createHash } from "node:crypto";
import type { SourceItemInput } from "./types";

/**
 * Pure mappers from Slack Web API payloads to source_items.
 *
 * Shapes verified against the Web API method docs:
 *   conversations.list  → { channels: [{ id, name, is_member, is_archived, num_members, topic: { value }, purpose: { value } }] }
 *   conversations.history / conversations.replies
 *                       → { messages: [{ type, subtype?, user?, bot_id?, text, ts, thread_ts?, reply_count?, reactions?: [{ name, count }] }] }
 *   users.list          → { members: [{ id, name, real_name, is_bot, deleted, profile: { display_name, real_name } }] }
 *
 * PII minimisation: only display names are stored (never emails, phones or
 * avatars); files/attachments are never read; text is truncated.
 */

export interface SlackChannel {
  id: string;
  name?: string;
  is_member?: boolean;
  is_archived?: boolean;
  num_members?: number;
  topic?: { value?: string } | null;
  purpose?: { value?: string } | null;
  updated?: number;
}

export interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: { name?: string; count?: number }[];
  files?: unknown[];
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: { display_name?: string; real_name?: string } | null;
}

/** id → display name; only names are kept. */
export type UserDirectory = Map<string, string>;

export function buildUserDirectory(members: SlackUser[]): UserDirectory {
  const dir: UserDirectory = new Map();
  for (const m of members) {
    const name = m.profile?.display_name?.trim() || m.profile?.real_name?.trim() || m.real_name?.trim() || m.name?.trim() || m.id;
    dir.set(m.id, name);
  }
  return dir;
}

const HUMAN_EXCLUDED_SUBTYPES = new Set([
  "bot_message",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "pinned_item",
  "unpinned_item",
  "file_comment",
  "tombstone",
  "joiner_notification",
  "reminder_add",
  "huddle_thread",
  "sh_room_created",
  "bot_add",
  "bot_remove",
  "ekm_access_denied",
]);

/** True for a message authored by a person (not a bot, integration or system event). */
export function isHumanMessage(m: SlackMessage, users?: UserDirectory, bots?: Set<string>): boolean {
  if (m.type && m.type !== "message") return false;
  if (m.bot_id) return false;
  if (m.subtype && HUMAN_EXCLUDED_SUBTYPES.has(m.subtype)) return false;
  if (!m.user) return false;
  if (bots?.has(m.user)) return false;
  if (users && !users.has(m.user)) return true; // unknown user still counts as a person; name falls back to the id
  return true;
}

export function truncate(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Replaces <@U123>, <#C123|name>, <http://x|label> markup with readable text. */
export function resolveMentions(text: string, users: UserDirectory): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${users.get(id) ?? "user"}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, (_, name: string) => `#${name}`)
    .replace(/<#([A-Z0-9]+)>/g, "#channel")
    .replace(/<!(?:channel|here|everyone)>/g, (m) => `@${m.slice(2, -1)}`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) => `${label} (${url})`)
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function permalinkFor(teamDomain: string | null, channelId: string, ts: string, threadTs?: string): string | null {
  if (!teamDomain) return null;
  const p = `https://${teamDomain}.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${p}?thread_ts=${threadTs}&cid=${channelId}` : p;
}

export function tsToIso(ts: string): string | null {
  const n = Number(ts);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : null;
}

export function mapChannel(c: SlackChannel, teamDomain: string | null): SourceItemInput {
  const name = c.name ?? c.id;
  return {
    provider: "slack",
    capability: "search",
    resource_type: "channel",
    external_id: c.id,
    title: `#${name}`,
    summary: truncate(c.topic?.value || c.purpose?.value || "", 200) || null,
    author: null,
    source_url: teamDomain ? `https://${teamDomain}.slack.com/archives/${c.id}` : null,
    source_timestamp: c.updated ? new Date(c.updated).toISOString() : null,
    content_hash: createHash("sha256").update(`${name}|${c.topic?.value ?? ""}|${c.purpose?.value ?? ""}`).digest("hex"),
    tags: ["slack", name],
    metadata: { channel_id: c.id, channel: name, num_members: c.num_members ?? null, is_member: !!c.is_member, is_archived: !!c.is_archived },
  };
}

export function mapMessage(m: SlackMessage, channel: { id: string; name: string }, users: UserDirectory, teamDomain: string | null): SourceItemInput | null {
  if (!isHumanMessage(m, users)) return null;
  const author = users.get(m.user!) ?? m.user!;
  const text = resolveMentions(m.text ?? "", users);
  const head = truncate(text, 100);
  const summary = truncate(text, 400) || null;
  return {
    provider: "slack",
    capability: "search",
    resource_type: "message",
    external_id: `${channel.id}:${m.ts}`,
    title: `#${channel.name} · ${author}: ${head || "(no text)"}`,
    summary,
    author,
    source_url: permalinkFor(teamDomain, channel.id, m.ts, m.thread_ts),
    source_timestamp: tsToIso(m.ts),
    content_hash: createHash("sha256").update(`${m.ts}|${text}`).digest("hex"),
    tags: ["slack", channel.name],
    metadata: {
      channel_id: channel.id,
      channel: channel.name,
      user_id: m.user,
      ts: m.ts,
      thread_ts: m.thread_ts ?? null,
      is_thread_reply: !!m.thread_ts && m.thread_ts !== m.ts,
      reply_count: m.reply_count ?? 0,
      reactions: (m.reactions ?? []).reduce((n, r) => n + (r.count ?? 0), 0),
      has_files: Array.isArray(m.files) && m.files.length > 0,
      author_type: "human",
    },
  };
}

/** Newest ts among messages, as a string cursor for the next `oldest`. */
export function newestTs(messages: { ts: string }[], current: string | null): string | null {
  let best = current ? Number(current) : 0;
  for (const m of messages) {
    const n = Number(m.ts);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best ? best.toFixed(6) : null;
}
