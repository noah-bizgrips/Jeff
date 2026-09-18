import "server-only";
import type { SlackSecret } from "@/lib/integrations/providers/slack";
import { readSecret, setConnectionStatus } from "@/lib/integrations/store";
import type { ConnectionSummary } from "@/lib/integrations/types";
import { redactString } from "@/lib/security/redact";
import {
  buildUserDirectory,
  isHumanMessage,
  mapChannel,
  mapMessage,
  newestTs,
  resolveMentions,
  truncate,
  tsToIso,
  type SlackChannel,
  type SlackMessage,
  type SlackUser,
  type UserDirectory,
} from "./slack-mappers";
import type { SourceItemInput } from "./types";
import type { SyncAdapter, CapabilityFetch } from "./runner";

/**
 * Slack read-only sync using the owner's user token (scopes: search:read,
 * channels:read, channels:history, users:read — nothing else).
 *
 * Methods (Web API, GET with Bearer auth):
 *   auth.test                       → team domain for permalinks
 *   users.list                      → display names only (cached per run)
 *   conversations.list              → public channels (paginated)
 *   conversations.history/replies   → messages since the per-channel cursor
 *   search.messages                 → Ask Gomez `search_slack` tool
 *
 * Rate limits: 429 → sleep `Retry-After` (capped) and retry; Tier-3 methods
 * (history/replies) are called sequentially with a small pause.
 */

const API = "https://slack.com/api";
const MAX_CHANNELS = 30;
const MAX_MESSAGES_PER_CHANNEL = 300;
const MAX_REPLIES_PER_THREAD = 50;
const PAGE = 200;
const DEFAULT_LOOKBACK_DAYS = 14;
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30_000;
const PAUSE_MS = 250;

const REVOKED = new Set(["invalid_auth", "token_revoked", "account_inactive", "not_authed", "token_expired"]);

export class SlackAuthError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SlackEnvelope {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

async function secretFor(conn: ConnectionSummary): Promise<SlackSecret> {
  const secret = await readSecret<SlackSecret>(conn.id);
  if (!secret?.user_token) throw new Error("secret_missing");
  return secret;
}

/** Calls a Slack method; handles ok:false, revoked tokens and 429 back-off. */
export async function slackCall<T extends SlackEnvelope>(token: string, method: string, params: Record<string, string | number | undefined>, attempt = 0): Promise<T> {
  const u = new URL(`${API}/${method}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) {
    if (attempt >= MAX_RETRIES) throw new Error(`slack_${method}_rate_limited`);
    const retry = Number(res.headers.get("retry-after") ?? "1");
    await sleep(Math.min(MAX_BACKOFF_MS, (Number.isFinite(retry) ? retry : 1) * 1000));
    return slackCall<T>(token, method, params, attempt + 1);
  }
  let body: T | null = null;
  try {
    body = (await res.json()) as T;
  } catch {
    body = null;
  }
  if (!body) throw new Error(`slack_${method}_failed:${res.status}`);
  if (!body.ok) {
    if (body.error && REVOKED.has(body.error)) throw new SlackAuthError(body.error);
    throw new Error(`slack_${method}_failed:${redactString(body.error ?? "unknown")}`);
  }
  return body;
}

async function markReconnect(conn: ConnectionSummary, err: unknown): Promise<never> {
  if (err instanceof SlackAuthError) {
    await setConnectionStatus(conn.id, { status: "reconnect_required", lastError: `slack_token_${err.message}` });
  }
  throw err;
}

interface RunContext {
  token: string;
  teamDomain: string | null;
  users: UserDirectory;
}

async function context(conn: ConnectionSummary): Promise<RunContext> {
  const secret = await secretFor(conn);
  try {
    const auth = await slackCall<SlackEnvelope & { url?: string }>(secret.user_token, "auth.test", {});
    const teamDomain = auth.url ? (new URL(auth.url).hostname.split(".")[0] ?? null) : null;
    const users = await loadUsers(secret.user_token);
    return { token: secret.user_token, teamDomain, users };
  } catch (err) {
    return markReconnect(conn, err);
  }
}

async function loadUsers(token: string): Promise<UserDirectory> {
  const members: SlackUser[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const body = await slackCall<SlackEnvelope & { members?: SlackUser[] }>(token, "users.list", { limit: PAGE, cursor });
    members.push(...(body.members ?? []));
    cursor = body.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return buildUserDirectory(members);
}

async function listChannels(token: string): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const body = await slackCall<SlackEnvelope & { channels?: SlackChannel[] }>(token, "conversations.list", {
      types: "public_channel",
      exclude_archived: "true",
      limit: PAGE,
      cursor,
    });
    out.push(...(body.channels ?? []));
    cursor = body.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

const channels: CapabilityFetch = async (conn) => {
  const ctx = await context(conn);
  try {
    const list = await listChannels(ctx.token);
    return { items: list.map((c) => mapChannel(c, ctx.teamDomain)), seen: list.length, cursor: new Date().toISOString() };
  } catch (err) {
    return markReconnect(conn, err);
  }
};

type ChannelCursors = Record<string, string>;

function parseCursors(cursor: string | null): ChannelCursors {
  if (!cursor) return {};
  try {
    const v = JSON.parse(cursor) as unknown;
    return v && typeof v === "object" ? (v as ChannelCursors) : {};
  } catch {
    return {};
  }
}

async function history(ctx: RunContext, channel: { id: string; name: string }, oldest: string): Promise<{ items: SourceItemInput[]; seen: number; newest: string | null }> {
  const items: SourceItemInput[] = [];
  const raw: SlackMessage[] = [];
  let cursor: string | undefined;
  let seen = 0;
  while (raw.length < MAX_MESSAGES_PER_CHANNEL) {
    const body = await slackCall<SlackEnvelope & { messages?: SlackMessage[]; has_more?: boolean }>(ctx.token, "conversations.history", {
      channel: channel.id,
      oldest,
      limit: Math.min(PAGE, MAX_MESSAGES_PER_CHANNEL - raw.length),
      cursor,
    });
    const page = body.messages ?? [];
    seen += page.length;
    raw.push(...page);
    cursor = body.has_more ? body.response_metadata?.next_cursor || undefined : undefined;
    if (!cursor) break;
    await sleep(PAUSE_MS);
  }
  for (const m of raw) {
    const mapped = mapMessage(m, channel, ctx.users, ctx.teamDomain);
    if (mapped) items.push(mapped);
    if ((m.reply_count ?? 0) > 0 && m.ts) {
      await sleep(PAUSE_MS);
      const replies = await slackCall<SlackEnvelope & { messages?: SlackMessage[] }>(ctx.token, "conversations.replies", {
        channel: channel.id,
        ts: m.ts,
        limit: MAX_REPLIES_PER_THREAD,
      });
      for (const r of (replies.messages ?? []).filter((x) => x.ts !== m.ts)) {
        seen++;
        const rm = mapMessage(r, channel, ctx.users, ctx.teamDomain);
        if (rm) items.push(rm);
      }
    }
  }
  return { items, seen, newest: newestTs(raw, null) };
}

/**
 * Messages from public channels the owner is a member of. The list endpoint
 * has no activity ordering, so member channels are taken in API order and
 * capped per run; incremental cursors mean each run picks up where it left off.
 */
const messages: CapabilityFetch = async (conn, cursor) => {
  const ctx = await context(conn);
  const cursors = parseCursors(cursor);
  const defaultOldest = ((Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000) / 1000).toFixed(6);
  const items: SourceItemInput[] = [];
  let seen = 0;
  try {
    const member = (await listChannels(ctx.token)).filter((c) => c.is_member && !c.is_archived).slice(0, MAX_CHANNELS);
    for (const c of member) {
      const oldest = cursors[c.id] ?? defaultOldest;
      const res = await history(ctx, { id: c.id, name: c.name ?? c.id }, oldest);
      items.push(...res.items);
      seen += res.seen;
      if (res.newest) cursors[c.id] = res.newest;
      await sleep(PAUSE_MS);
    }
  } catch (err) {
    return markReconnect(conn, err);
  }
  return { items, seen, cursor: JSON.stringify(cursors) };
};

export const slackSyncAdapter: SyncAdapter = {
  provider: "slack",
  capabilities: { channels, messages },
  // The connection's granted capability is "search"; both fetches ride on it.
  alwaysRun: ["channels", "messages"],
};

export interface SlackSearchHit {
  channel: string | null;
  author: string | null;
  snippet: string;
  permalink: string | null;
  ts: string | null;
}

/**
 * search.messages for the Ask Gomez `search_slack` tool. Returns bounded,
 * PII-minimised hits (no files, no emails). The token never leaves this module.
 */
export async function searchSlackMessages(conn: ConnectionSummary, query: string, count = 10): Promise<SlackSearchHit[]> {
  const ctx = await context(conn);
  try {
    const body = await slackCall<
      SlackEnvelope & { messages?: { matches?: { channel?: { id?: string; name?: string }; user?: string; username?: string; text?: string; ts?: string; permalink?: string }[] } }
    >(ctx.token, "search.messages", { query: query.slice(0, 200), count: Math.min(Math.max(count, 1), 20), sort: "timestamp", sort_dir: "desc" });
    return (body.messages?.matches ?? []).map((m) => ({
      channel: m.channel?.name ? `#${m.channel.name}` : null,
      author: m.user ? (ctx.users.get(m.user) ?? m.username ?? null) : (m.username ?? null),
      snippet: truncate(resolveMentions(m.text ?? "", ctx.users), 300),
      permalink: m.permalink ?? null,
      ts: m.ts ? tsToIso(m.ts) : null,
    }));
  } catch (err) {
    return markReconnect(conn, err);
  }
}

export { isHumanMessage };
