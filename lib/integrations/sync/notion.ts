import "server-only";
import { NOTION_VERSION, type NotionSecret } from "@/lib/integrations/providers/notion";
import { readSecret, setConnectionStatus } from "@/lib/integrations/store";
import type { ConnectionSummary } from "@/lib/integrations/types";
import { redactString } from "@/lib/security/redact";
import { blocksText, mapDatabase, mapPage, plain, type NotionBlock, type NotionDatabase, type NotionPage } from "./notion-mappers";
import type { SourceItemInput } from "./types";
import type { SyncAdapter, CapabilityFetch } from "./runner";

/**
 * Notion read-only sync (integration token from OAuth; only pages the owner
 * shared with the integration are visible to /v1/search).
 *
 *   POST /v1/search  { sort: { direction: "descending", timestamp: "last_edited_time" }, page_size, start_cursor }
 *   GET  /v1/blocks/:id/children?page_size=30   (excerpt only, for pages edited since the cursor)
 *
 * Throttled to ~3 requests/second; 429 → Retry-After back-off; 401 → reconnect_required.
 */

const API = "https://api.notion.com/v1";
const PAGE_SIZE = 100;
const MAX_RESULTS = 500;
const MAX_BLOCK_FETCHES = 100;
const BLOCKS_PAGE_SIZE = 30;
const MIN_GAP_MS = 350;
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30_000;

export class NotionAuthError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function secretFor(conn: ConnectionSummary): Promise<NotionSecret> {
  const secret = await readSecret<NotionSecret>(conn.id);
  if (!secret?.access_token) throw new Error("secret_missing");
  return secret;
}

class Throttle {
  private last = 0;
  async wait() {
    const gap = Date.now() - this.last;
    if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
    this.last = Date.now();
  }
}

export async function notionCall<T>(token: string, throttle: Throttle, path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}, attempt = 0): Promise<T> {
  await throttle.wait();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) {
    if (attempt >= MAX_RETRIES) throw new Error(`notion_${path.split("/")[1] ?? "call"}_rate_limited`);
    const retry = Number(res.headers.get("retry-after") ?? "1");
    await sleep(Math.min(MAX_BACKOFF_MS, (Number.isFinite(retry) ? retry : 1) * 1000));
    return notionCall<T>(token, throttle, path, init, attempt + 1);
  }
  if (res.status === 401) throw new NotionAuthError("unauthorized");
  let body: T | null = null;
  try {
    body = (await res.json()) as T;
  } catch {
    body = null;
  }
  if (res.status !== 200 || !body) {
    const code = (body as { code?: string } | null)?.code;
    throw new Error(`notion_${path.split("/")[1] ?? "call"}_failed:${res.status}:${redactString(code ?? "")}`);
  }
  return body;
}

async function markReconnect(conn: ConnectionSummary, err: unknown): Promise<never> {
  if (err instanceof NotionAuthError) {
    await setConnectionStatus(conn.id, { status: "reconnect_required", lastError: "notion_token_unauthorized" });
  }
  throw err;
}

interface SearchResponse {
  results?: (NotionPage | NotionDatabase)[];
  next_cursor?: string | null;
  has_more?: boolean;
}

const pages: CapabilityFetch = async (conn, cursor) => {
  const secret = await secretFor(conn);
  const throttle = new Throttle();
  const sinceMs = cursor && Number.isFinite(Date.parse(cursor)) ? Date.parse(cursor) : 0;
  const results: (NotionPage | NotionDatabase)[] = [];
  let seen = 0;
  let newest = sinceMs;
  try {
    let startCursor: string | undefined;
    let stop = false;
    while (!stop && results.length < MAX_RESULTS) {
      const body = await notionCall<SearchResponse>(secret.access_token, throttle, "/search", {
        method: "POST",
        body: { sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: PAGE_SIZE, ...(startCursor ? { start_cursor: startCursor } : {}) },
      });
      const page = body.results ?? [];
      seen += page.length;
      for (const r of page) {
        const edited = r.last_edited_time ? Date.parse(r.last_edited_time) : 0;
        if (edited > newest) newest = edited;
        // Results are newest-first: once we pass the cursor everything after is unchanged.
        if (sinceMs && edited && edited <= sinceMs) {
          stop = true;
          break;
        }
        results.push(r);
      }
      if (!body.has_more || !body.next_cursor) break;
      startCursor = body.next_cursor;
    }

    const databaseTitles = new Map<string, string>();
    for (const r of results) if (r.object === "database") databaseTitles.set(r.id, plain(r.title).trim() || "Untitled database");

    const items: SourceItemInput[] = [];
    let blockFetches = 0;
    for (const r of results) {
      if (r.object === "database") {
        const d = mapDatabase(r);
        if (d) items.push(d);
        continue;
      }
      let excerpt: string | null = null;
      if (blockFetches < MAX_BLOCK_FETCHES) {
        blockFetches++;
        try {
          const blocks = await notionCall<{ results?: NotionBlock[] }>(secret.access_token, throttle, `/blocks/${r.id}/children?page_size=${BLOCKS_PAGE_SIZE}`);
          excerpt = blocksText(blocks.results ?? []) || null;
        } catch (err) {
          if (err instanceof NotionAuthError) throw err;
          excerpt = null; // a single page's blocks failing must not fail the run
        }
      }
      const p = mapPage(r, { excerpt, databaseTitles });
      if (p) items.push(p);
    }
    return { items, seen, cursor: newest ? new Date(newest).toISOString() : cursor };
  } catch (err) {
    return markReconnect(conn, err);
  }
};

export const notionSyncAdapter: SyncAdapter = {
  provider: "notion",
  capabilities: { pages },
};
