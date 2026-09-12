import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ConnectionSummary } from "@/lib/integrations/types";

const setConnectionStatus = vi.fn(async () => {});
vi.mock("@/lib/integrations/store", () => ({
  readSecret: vi.fn(async () => ({ kind: "oauth_tokens", user_token: "xoxp-" + "1234567890-" + "t".repeat(24) })),
  setConnectionStatus: (...a: unknown[]) => setConnectionStatus(...(a as [])),
  writeSecret: vi.fn(),
  listConnections: vi.fn(async () => []),
}));

const calls: { method: string; params: URLSearchParams }[] = [];
let revoked = false;
let rateLimitOnce = false;
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    const u = new URL(url);
    const method = u.pathname.replace("/api/", "");
    calls.push({ method, params: u.searchParams });
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
    if (revoked) return json({ ok: false, error: "token_revoked" });
    if (rateLimitOnce && method === "conversations.history") {
      rateLimitOnce = false;
      return new Response("", { status: 429, headers: { "retry-after": "0" } });
    }
    switch (method) {
      case "auth.test":
        return json({ ok: true, url: "https://bizgrips.slack.com/", team: "BizGrips", user_id: "U1" });
      case "users.list":
        return json({ ok: true, members: [{ id: "U1", profile: { display_name: "noah" } }, { id: "U2", profile: { real_name: "Maya Patel" } }] });
      case "conversations.list":
        if (u.searchParams.get("cursor") === "next") return json({ ok: true, channels: [{ id: "C2", name: "random", is_member: false }] });
        return json({ ok: true, channels: [{ id: "C1", name: "project-atlas", is_member: true }], response_metadata: { next_cursor: "next" } });
      case "conversations.history":
        if (u.searchParams.get("cursor") === "h2") return json({ ok: true, messages: [{ type: "message", user: "U2", text: "second page", ts: "1726000002.000000" }], has_more: false });
        return json({
          ok: true,
          messages: [
            { type: "message", user: "U1", text: "I'll send the proposal Thursday", ts: "1726000000.000100", reply_count: 1 },
            { type: "message", bot_id: "B1", text: "Deploy finished", ts: "1726000001.000000" },
          ],
          has_more: true,
          response_metadata: { next_cursor: "h2" },
        });
      case "conversations.replies":
        return json({ ok: true, messages: [{ type: "message", user: "U1", text: "parent", ts: "1726000000.000100" }, { type: "message", user: "U2", text: "on it", ts: "1726000000.500000", thread_ts: "1726000000.000100" }] });
      case "search.messages":
        return json({ ok: true, messages: { matches: [{ channel: { id: "C1", name: "project-atlas" }, user: "U2", text: "<@U1> credentials are <https://x.y|here>", ts: "1726000000.000100", permalink: "https://bizgrips.slack.com/archives/C1/p1726000000000100" }] } });
      default:
        return json({ ok: false, error: "unknown_method" });
    }
  }),
);

const { slackSyncAdapter, searchSlackMessages } = await import("@/lib/integrations/sync/slack");

function conn(): ConnectionSummary {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    provider: "slack",
    displayName: "Slack · BizGrips",
    status: "connected",
    accessMode: "read",
    scopes: ["search:read", "channels:read", "channels:history", "users:read"],
    capabilities: ["search"],
    accountIdentifier: "BizGrips",
    lastTestAt: null,
    lastTestOk: true,
    lastError: null,
    lastSyncAt: null,
    createdAt: "",
    updatedAt: "",
    metadata: { team_id: "T1" },
  };
}

describe("Slack sync adapter", () => {
  beforeEach(() => {
    calls.length = 0;
    revoked = false;
    rateLimitOnce = false;
    setConnectionStatus.mockClear();
  });

  it("syncs member channels only, follows pagination, includes thread replies, skips bots, and stores per-channel cursors", async () => {
    const r = await slackSyncAdapter.capabilities.messages!(conn(), null);
    const hist = calls.filter((c) => c.method === "conversations.history");
    expect(hist).toHaveLength(2);
    expect(hist.every((c) => c.params.get("channel") === "C1")).toBe(true); // C2 (not a member) never read
    expect(hist[0]!.params.get("oldest")).toMatch(/^\d+\.\d{6}$/);
    expect(r.items.map((i) => i.title)).toEqual([
      "#project-atlas · noah: I'll send the proposal Thursday",
      "#project-atlas · Maya Patel: on it",
      "#project-atlas · Maya Patel: second page",
    ]);
    expect(JSON.parse(r.cursor!)).toEqual({ C1: "1726000002.000000" });
    expect(JSON.stringify(r.items)).not.toMatch(/xoxp/);
    expect(slackSyncAdapter.alwaysRun).toEqual(["channels", "messages"]);
  });

  it("resumes from the stored per-channel cursor", async () => {
    await slackSyncAdapter.capabilities.messages!(conn(), JSON.stringify({ C1: "1725999999.000000" }));
    expect(calls.find((c) => c.method === "conversations.history")!.params.get("oldest")).toBe("1725999999.000000");
  });

  it("backs off on 429 and retries", async () => {
    rateLimitOnce = true;
    const r = await slackSyncAdapter.capabilities.messages!(conn(), null);
    expect(calls.filter((c) => c.method === "conversations.history").length).toBe(3);
    expect(r.items.length).toBe(3);
  });

  it("marks the connection reconnect_required when the token is revoked", async () => {
    revoked = true;
    await expect(slackSyncAdapter.capabilities.channels!(conn(), null)).rejects.toThrow("token_revoked");
    expect(setConnectionStatus).toHaveBeenCalledWith(conn().id, expect.objectContaining({ status: "reconnect_required" }));
  });

  it("maps channels", async () => {
    const r = await slackSyncAdapter.capabilities.channels!(conn(), null);
    expect(r.items.map((i) => i.title)).toEqual(["#project-atlas", "#random"]);
    expect(r.items[0]!.source_url).toBe("https://bizgrips.slack.com/archives/C1");
  });

  it("search returns bounded, name-resolved hits without files or emails", async () => {
    const hits = await searchSlackMessages(conn(), "credentials", 5);
    expect(calls.find((c) => c.method === "search.messages")!.params.get("count")).toBe("5");
    expect(hits).toEqual([
      { channel: "#project-atlas", author: "Maya Patel", snippet: "@noah credentials are here (https://x.y)", permalink: "https://bizgrips.slack.com/archives/C1/p1726000000000100", ts: "2024-09-10T20:26:40.000Z" },
    ]);
  });
});
