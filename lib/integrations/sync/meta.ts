import "server-only";
import { META_GRAPH_VERSION, type MetaSecret } from "@/lib/integrations/providers/meta";
import { readSecret, setConnectionStatus } from "@/lib/integrations/store";
import type { ConnectionSummary } from "@/lib/integrations/types";
import { redactString } from "@/lib/security/redact";
import { log } from "@/lib/security/log";
import {
  actIdOf,
  bareAccountId,
  insightsWindow,
  mapAdAccount,
  mapAdInsight,
  mapCampaign,
  mapIgAccount,
  mapIgInsights,
  mapIgMedia,
  mapPageInsights,
  mapPost,
  type MetaAdAccount,
  type MetaCampaign,
  type MetaIgAccount,
  type MetaIgMedia,
  type MetaInsightRow,
  type MetaPageInsight,
  type MetaPost,
} from "./meta-mappers";
import type { SourceItemInput } from "./types";
import type { CapabilityFetch, SyncAdapter } from "./runner";

/**
 * Meta read-only sync (Graph API v26.0): Ads insights, Facebook Pages,
 * Instagram Professional accounts.
 *
 * - Reads ONLY the assets the owner selected in Connections → Meta → Select
 *   accounts (connections.metadata.selected_*). Nothing selected → no reads.
 * - Ads insights are per campaign per day, incremental from the last cursor
 *   date minus OVERLAP_DAYS (Meta restates attribution for ~3 days).
 * - Page insights use a Page token fetched via /me/accounts and held only in
 *   memory for the duration of the run — never persisted.
 * - Token expiry (OAuthException code 190) flips the connection to
 *   reconnect_required. Rate-limit headers trigger a back-off between calls.
 *
 * Endpoints/fields verified against
 * https://developers.facebook.com/docs/marketing-api/reference/ad-account/insights/
 * (see meta-mappers.ts) and the Graph API Page/Instagram insights references.
 */

const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const INITIAL_DAYS = 30;
const OVERLAP_DAYS = 3;
const MAX_ITEMS_PER_RUN = 1000;
const MAX_PAGES = 20;
const INSIGHT_FIELDS = "campaign_id,campaign_name,spend,impressions,clicks,cpc,cpm,ctr,actions,cost_per_action_type,reach,frequency,date_start,date_stop,account_currency";
const CAMPAIGN_FIELDS = "id,name,status,effective_status,daily_budget,lifetime_budget,objective";
const PAGE_METRICS = "page_impressions,page_post_engagements,page_fans";
const IG_METRICS = "reach,impressions,profile_views";

export class MetaTokenExpiredError extends Error {
  constructor() {
    super("meta_token_expired");
  }
}

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

interface Paged<T> {
  data?: T[];
  paging?: { next?: string };
}

/** Parse the app/business usage headers and return a suggested pause in ms when usage is high. */
export function backoffFromHeaders(headers: Headers): number {
  const parse = (raw: string | null): number => {
    if (!raw) return 0;
    try {
      const v = JSON.parse(raw) as unknown;
      const nums: number[] = [];
      const walk = (x: unknown) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") Object.values(x).forEach(walk);
        else if (typeof x === "number") nums.push(x);
      };
      walk(v);
      return nums.length ? Math.max(...nums) : 0;
    } catch {
      return 0;
    }
  };
  const usage = Math.max(parse(headers.get("x-app-usage")), parse(headers.get("x-business-use-case-usage")), parse(headers.get("x-ad-account-usage")));
  if (usage >= 95) return 60_000;
  if (usage >= 80) return 10_000;
  if (usage >= 60) return 2_000;
  return 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function graphGet<T>(url: string, token: string): Promise<T> {
  const u = new URL(url);
  if (!u.searchParams.has("access_token")) u.searchParams.set("access_token", token);
  const res = await fetch(u.toString(), { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as (T & GraphError) | null;
  const pause = backoffFromHeaders(res.headers);
  if (pause) {
    log.info("meta_rate_backoff", { ms: pause });
    await sleep(pause);
  }
  if (!res.ok || body?.error) {
    const e = body?.error;
    if (e?.code === 190 || e?.type === "OAuthException") throw new MetaTokenExpiredError();
    if (e?.code === 4 || e?.code === 17 || e?.code === 32 || e?.code === 613) throw new Error("meta_rate_limited");
    throw new Error(`meta_graph_failed:${res.status}:${redactString(String(e?.code ?? e?.type ?? "")).slice(0, 40)}`);
  }
  if (!body) throw new Error("meta_graph_empty");
  return body;
}

/** Walks `paging.next` up to MAX_PAGES / MAX_ITEMS_PER_RUN. */
async function walk<T>(firstUrl: string, token: string, cap = MAX_ITEMS_PER_RUN): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = firstUrl;
  let pages = 0;
  while (url && pages < MAX_PAGES && out.length < cap) {
    const page: Paged<T> = await graphGet<Paged<T>>(url, token);
    out.push(...(page.data ?? []));
    url = page.paging?.next;
    pages++;
  }
  return out.slice(0, cap);
}

async function secretFor(conn: ConnectionSummary): Promise<MetaSecret> {
  const secret = await readSecret<MetaSecret>(conn.id);
  if (!secret || secret.kind !== "oauth_tokens" || !secret.user_token) throw new Error("secret_missing");
  return secret;
}

function selected(conn: ConnectionSummary, key: string): string[] {
  const v = conn.metadata[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/** Days until the stored token expires, or null when unknown. */
export function tokenDaysLeft(expiresAt: string | null | undefined, now = new Date()): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - now.getTime()) / 86_400_000);
}

async function withTokenGuard<T>(conn: ConnectionSummary, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MetaTokenExpiredError) {
      await setConnectionStatus(conn.id, { status: "reconnect_required", lastError: "meta_token_expired: re-authorize Meta in Connections" });
    }
    throw err;
  }
}

const ads: CapabilityFetch = async (conn, cursor) => {
  const accounts = selected(conn, "selected_ad_accounts");
  if (!accounts.length) return { items: [], seen: 0, cursor: cursor ?? null };
  const secret = await secretFor(conn);
  const token = secret.user_token;
  const now = new Date();
  const win = insightsWindow(cursor, now, { initialDays: INITIAL_DAYS, overlapDays: OVERLAP_DAYS });
  const items: SourceItemInput[] = [];
  let seen = 0;

  await withTokenGuard(conn, async () => {
    for (const rawId of accounts) {
      if (items.length >= MAX_ITEMS_PER_RUN) break;
      const act = actIdOf(rawId);
      const acct = await graphGet<MetaAdAccount>(`${GRAPH}/${act}?fields=name,currency,account_status,amount_spent`, token);
      const currency = (acct.currency ?? "USD").toUpperCase();
      items.push(mapAdAccount({ ...acct, id: act }));

      const campaigns = await walk<MetaCampaign>(`${GRAPH}/${act}/campaigns?fields=${CAMPAIGN_FIELDS}&limit=100`, token, 200);
      for (const c of campaigns) items.push(mapCampaign(c, act, currency));
      seen += campaigns.length;

      const insightsUrl = new URL(`${GRAPH}/${act}/insights`);
      insightsUrl.searchParams.set("level", "campaign");
      insightsUrl.searchParams.set("time_increment", "1");
      insightsUrl.searchParams.set("fields", INSIGHT_FIELDS);
      insightsUrl.searchParams.set("time_range", JSON.stringify({ since: win.since, until: win.until }));
      insightsUrl.searchParams.set("limit", "500");
      const rows = await walk<MetaInsightRow>(insightsUrl.toString(), token, MAX_ITEMS_PER_RUN - items.length);
      for (const r of rows) {
        seen++;
        const mapped = mapAdInsight(r, act, currency);
        if (mapped) items.push(mapped);
      }
    }
  });
  return { items, seen, cursor: win.nextCursor };
};

const pages: CapabilityFetch = async (conn, cursor) => {
  const pageIds = selected(conn, "selected_pages");
  if (!pageIds.length) return { items: [], seen: 0, cursor: cursor ?? null };
  const secret = await secretFor(conn);
  const token = secret.user_token;
  const now = new Date();
  const win = insightsWindow(cursor, now, { initialDays: INITIAL_DAYS, overlapDays: 1 });
  const items: SourceItemInput[] = [];
  let seen = 0;

  await withTokenGuard(conn, async () => {
    // Page tokens: in-memory only for this run.
    const managed = await walk<{ id: string; name?: string; access_token?: string }>(`${GRAPH}/me/accounts?fields=id,name,access_token&limit=100`, token, 200);
    const pageTokens = new Map(managed.map((p) => [p.id, { token: p.access_token ?? token, name: p.name ?? null }]));
    for (const pageId of pageIds) {
      if (items.length >= MAX_ITEMS_PER_RUN) break;
      const entry = pageTokens.get(pageId) ?? { token, name: null };
      const since = Math.floor(Date.parse(`${win.since}T00:00:00.000Z`) / 1000);
      const until = Math.floor(now.getTime() / 1000);
      const insights = await walk<MetaPageInsight>(`${GRAPH}/${pageId}/insights?metric=${PAGE_METRICS}&period=day&since=${since}&until=${until}`, entry.token, 50);
      const dayItems = mapPageInsights(insights, pageId, entry.name);
      items.push(...dayItems);
      seen += dayItems.length;
      const posts = await walk<MetaPost>(`${GRAPH}/${pageId}/posts?fields=id,message,created_time,permalink_url,insights.metric(post_impressions,post_engaged_users)&limit=50`, entry.token, 50);
      for (const p of posts) items.push(mapPost(p, pageId));
      seen += posts.length;
    }
  });
  return { items, seen, cursor: win.nextCursor };
};

const instagram: CapabilityFetch = async (conn, cursor) => {
  const igIds = selected(conn, "selected_instagram_accounts");
  if (!igIds.length) return { items: [], seen: 0, cursor: cursor ?? null };
  const secret = await secretFor(conn);
  const token = secret.user_token;
  const now = new Date();
  const win = insightsWindow(cursor, now, { initialDays: INITIAL_DAYS, overlapDays: 1 });
  const items: SourceItemInput[] = [];
  let seen = 0;

  await withTokenGuard(conn, async () => {
    for (const igId of igIds) {
      if (items.length >= MAX_ITEMS_PER_RUN) break;
      const acct = await graphGet<MetaIgAccount>(`${GRAPH}/${igId}?fields=followers_count,media_count,username`, token);
      items.push(mapIgAccount({ ...acct, id: igId }));
      const since = Math.floor(Date.parse(`${win.since}T00:00:00.000Z`) / 1000);
      const until = Math.floor(now.getTime() / 1000);
      const insights = await walk<MetaPageInsight>(`${GRAPH}/${igId}/insights?metric=${IG_METRICS}&period=day&since=${since}&until=${until}`, token, 50);
      const dayItems = mapIgInsights(insights, igId, acct.username ?? null);
      items.push(...dayItems);
      seen += dayItems.length;
      const media = await walk<MetaIgMedia>(`${GRAPH}/${igId}/media?fields=id,caption,media_type,timestamp,permalink,like_count,comments_count&limit=50`, token, 50);
      for (const m of media) items.push(mapIgMedia(m, igId));
      seen += media.length;
    }
  });
  return { items, seen, cursor: win.nextCursor };
};

export const metaSyncAdapter: SyncAdapter = {
  provider: "meta",
  capabilities: { ads, pages, instagram },
};

export const __test = { bareAccountId };
