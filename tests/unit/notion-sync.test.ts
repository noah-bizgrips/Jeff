import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ConnectionSummary } from "@/lib/integrations/types";
import { blocksText, mapDatabase, mapPage, pageTitle, propertySummary, type NotionPage } from "@/lib/integrations/sync/notion-mappers";

const setConnectionStatus = vi.fn(async () => {});
vi.mock("@/lib/integrations/store", () => ({
  readSecret: vi.fn(async () => ({ kind: "oauth_tokens", access_token: "ntn_" + "s".repeat(40) })),
  setConnectionStatus: (...a: unknown[]) => setConnectionStatus(...(a as [])),
  writeSecret: vi.fn(),
}));

const page = (id: string, edited: string, title: string, extra: Partial<NotionPage> = {}): NotionPage => ({
  object: "page",
  id,
  url: `https://www.notion.so/${id}`,
  created_time: "2026-09-01T00:00:00.000Z",
  last_edited_time: edited,
  icon: { type: "emoji", emoji: "🚀" },
  parent: { type: "database_id", database_id: "db1" },
  properties: {
    Task: { type: "title", title: [{ plain_text: title }] },
    Status: { type: "status", status: { name: "In progress" } },
    Tags: { type: "multi_select", multi_select: [{ name: "atlas" }, { name: "client" }] },
    Due: { type: "date", date: { start: "2026-09-18", end: null } },
    Notes: { type: "rich_text", rich_text: [{ plain_text: "secret body text" }] },
  },
  ...extra,
});

const calls: { path: string; body?: { sort?: unknown; start_cursor?: string }; at: number }[] = [];
let unauthorized = false;
let rateLimitOnce = false;
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace("/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, at: Date.now() });
    const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
    if (unauthorized) return json({ object: "error", code: "unauthorized" }, 401);
    if (path === "/search") {
      if (rateLimitOnce) {
        rateLimitOnce = false;
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      }
      if (body?.start_cursor === "c2") return json({ results: [page("p3", "2026-09-01T00:00:00.000Z", "Old page")], has_more: false, next_cursor: null });
      return json({
        results: [
          { object: "database", id: "db1", url: "https://www.notion.so/db1", title: [{ plain_text: "Client Projects" }], last_edited_time: "2026-09-12T00:00:00.000Z", properties: { Task: { type: "title" }, Status: { type: "status" } } },
          page("p1", "2026-09-11T00:00:00.000Z", "Atlas launch plan"),
          page("p2", "2026-09-10T00:00:00.000Z", "Archived thing", { archived: true }),
        ],
        has_more: true,
        next_cursor: "c2",
      });
    }
    if (path.startsWith("/blocks/")) return json({ results: [{ type: "heading_2", heading_2: { rich_text: [{ plain_text: "Plan" }] } }, { type: "to_do", to_do: { rich_text: [{ plain_text: "Get credentials" }], checked: false } }] });
    return json({}, 404);
  }),
);

const { notionSyncAdapter } = await import("@/lib/integrations/sync/notion");

function conn(): ConnectionSummary {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    provider: "notion",
    displayName: "Notion · BizGrips",
    status: "connected",
    accessMode: "read",
    scopes: ["read_content"],
    capabilities: ["pages"],
    accountIdentifier: "BizGrips",
    lastTestAt: null,
    lastTestOk: true,
    lastError: null,
    lastSyncAt: null,
    createdAt: "",
    updatedAt: "",
    metadata: {},
  };
}

describe("Notion mappers", () => {
  it("extracts the title from whichever property is the title type", () => {
    expect(pageTitle(page("p", "2026-09-11T00:00:00.000Z", "Atlas"))).toBe("Atlas");
    expect(pageTitle({ object: "page", id: "x", properties: { Name: { type: "title", title: [{ plain_text: "By Name" }] } } })).toBe("By Name");
    expect(pageTitle({ object: "page", id: "x", properties: {} })).toBe("Untitled");
  });

  it("summarises select/status/date properties but never rich text bodies", () => {
    const props = propertySummary(page("p", "2026-09-11T00:00:00.000Z", "Atlas"));
    expect(props).toEqual({ Status: "In progress", Tags: "atlas, client", Due: "2026-09-18" });
    const item = mapPage(page("p", "2026-09-11T00:00:00.000Z", "Atlas"), { excerpt: "x".repeat(500), databaseTitles: new Map([["db1", "Client Projects"]]) })!;
    expect(item.summary!.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(item)).not.toContain("secret body text");
    expect(item.tags).toEqual(["notion", "client projects"]);
    expect(item.metadata).toMatchObject({ parent_type: "database_id", parent_id: "db1", database_title: "Client Projects", icon: "🚀" });
  });

  it("drops archived pages, maps databases with property names only, and renders block text", () => {
    expect(mapPage(page("p", "2026-09-11T00:00:00.000Z", "Gone", { archived: true }))).toBeNull();
    const db = mapDatabase({ object: "database", id: "db1", title: [{ plain_text: "Clients" }], properties: { Name: { type: "title" }, Owner: { type: "people" } } })!;
    expect(db).toMatchObject({ resource_type: "database", title: "Clients", summary: "Properties: Name, Owner" });
    expect(blocksText([{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "Hello" }] } }, { type: "to_do", to_do: { rich_text: [{ plain_text: "Ship" }], checked: true } }])).toBe("Hello [x] Ship");
  });
});

describe("Notion sync adapter", () => {
  beforeEach(() => {
    calls.length = 0;
    unauthorized = false;
    rateLimitOnce = false;
    setConnectionStatus.mockClear();
  });

  it("paginates search newest-first, stops at the cursor, fetches excerpts, and returns the newest edit time as cursor", async () => {
    const r = await notionSyncAdapter.capabilities.pages!(conn(), null);
    expect(calls.filter((c) => c.path === "/search").map((c) => c.body?.sort)).toEqual([{ direction: "descending", timestamp: "last_edited_time" }, { direction: "descending", timestamp: "last_edited_time" }]);
    expect(r.items.map((i) => `${i.resource_type}:${i.title}`)).toEqual(["database:Client Projects", "page:Atlas launch plan", "page:Old page"]);
    expect(r.items[1]!.summary).toContain("Plan [ ] Get credentials");
    expect(r.cursor).toBe("2026-09-12T00:00:00.000Z");
    expect(JSON.stringify(r.items)).not.toMatch(/ntn_/);

    calls.length = 0;
    const r2 = await notionSyncAdapter.capabilities.pages!(conn(), "2026-09-10T12:00:00.000Z");
    expect(calls.filter((c) => c.path === "/search")).toHaveLength(1); // stopped before page 2
    expect(r2.items.map((i) => i.title)).toEqual(["Client Projects", "Atlas launch plan"]);
  });

  it("throttles requests to roughly 3 per second and retries after 429", async () => {
    rateLimitOnce = true;
    const r = await notionSyncAdapter.capabilities.pages!(conn(), null);
    expect(r.items.length).toBe(3);
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i]!.at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(300);
  });

  it("marks the connection reconnect_required on 401", async () => {
    unauthorized = true;
    await expect(notionSyncAdapter.capabilities.pages!(conn(), null)).rejects.toThrow("unauthorized");
    expect(setConnectionStatus).toHaveBeenCalledWith(conn().id, expect.objectContaining({ status: "reconnect_required" }));
  });
});
