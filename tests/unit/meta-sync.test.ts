import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ConnectionSummary } from "@/lib/integrations/types";

const setConnectionStatus = vi.fn(async () => {});
const readSecret = vi.fn(async () => ({ kind: "oauth_tokens", user_token: "EAA" + "x".repeat(40), expires_at: "2026-11-01T00:00:00Z" }));
vi.mock("@/lib/integrations/store", () => ({
  readSecret: (...a: unknown[]) => readSecret(...(a as [])),
  setConnectionStatus: (...a: unknown[]) => setConnectionStatus(...(a as [])),
  writeSecret: vi.fn(),
}));

const requests: string[] = [];
let expired = false;
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    requests.push(url);
    const u = new URL(url);
    const json = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (expired) return new Response(JSON.stringify({ error: { message: "Error validating access token", type: "OAuthException", code: 190 } }), { status: 400 });
    if (/\/act_123\?/.test(url)) return json({ id: "act_123", name: "BizGrips Ads", currency: "USD", account_status: 1, amount_spent: "1000" });
    if (/\/act_123\/campaigns/.test(url)) return json({ data: [{ id: "c1", name: "Leads", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "5000" }] });
    if (/\/act_123\/insights/.test(url)) {
      if (u.searchParams.get("after") === "p2") return json({ data: [{ campaign_id: "c1", campaign_name: "Leads", spend: "20.00", date_start: "2026-09-11", actions: [] }] });
      return json(
        { data: [{ campaign_id: "c1", campaign_name: "Leads", spend: "50.00", date_start: "2026-09-10", actions: [{ action_type: "lead", value: "2" }] }], paging: { next: `${u.origin}${u.pathname}?after=p2` } },
        { "x-app-usage": JSON.stringify({ call_count: 10, total_cputime: 5, total_time: 5 }) },
      );
    }
    return json({ data: [] });
  }),
);

const { metaSyncAdapter, backoffFromHeaders, tokenDaysLeft } = await import("@/lib/integrations/sync/meta");

function conn(metadata: Record<string, unknown>): ConnectionSummary {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    provider: "meta",
    displayName: "Meta · Noah",
    status: "connected",
    accessMode: "read",
    scopes: ["ads_read"],
    capabilities: ["ads", "pages", "instagram"],
    accountIdentifier: "Noah",
    lastTestAt: null,
    lastTestOk: true,
    lastError: null,
    lastSyncAt: null,
    createdAt: "",
    updatedAt: "",
    metadata,
  };
}

describe("Meta sync adapter", () => {
  beforeEach(() => {
    requests.length = 0;
    expired = false;
    setConnectionStatus.mockClear();
  });

  it("does nothing when no assets are selected", async () => {
    const r = await metaSyncAdapter.capabilities.ads!(conn({}), null);
    expect(r).toEqual({ items: [], seen: 0, cursor: null });
    expect(requests).toHaveLength(0);
  });

  it("reads only selected ad accounts, follows paging, and uses an incremental overlapped window", async () => {
    const r = await metaSyncAdapter.capabilities.ads!(conn({ selected_ad_accounts: ["123"] }), "2026-09-10");
    const insightsCall = requests.find((x) => x.includes("/insights") && !x.includes("after="))!;
    const tr = JSON.parse(new URL(insightsCall).searchParams.get("time_range")!);
    expect(tr.since).toBe("2026-09-07");
    expect(new URL(insightsCall).searchParams.get("level")).toBe("campaign");
    expect(r.items.map((i) => i.resource_type).sort()).toEqual(["ad_account", "ad_insight", "ad_insight", "campaign"]);
    expect(r.cursor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Token never lands in stored items.
    expect(JSON.stringify(r.items)).not.toMatch(/EAAx/);
  });

  it("flips the connection to reconnect_required on an expired token", async () => {
    expired = true;
    await expect(metaSyncAdapter.capabilities.ads!(conn({ selected_ad_accounts: ["123"] }), null)).rejects.toThrow(/meta_token_expired/);
    expect(setConnectionStatus).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: "reconnect_required" }));
  });

  it("backs off from usage headers and computes token days left", () => {
    expect(backoffFromHeaders(new Headers({ "x-app-usage": JSON.stringify({ call_count: 96 }) }))).toBe(60_000);
    expect(backoffFromHeaders(new Headers({ "x-business-use-case-usage": JSON.stringify({ "123": [{ call_count: 85 }] }) }))).toBe(10_000);
    expect(backoffFromHeaders(new Headers())).toBe(0);
    expect(tokenDaysLeft("2026-09-20T00:00:00Z", new Date("2026-09-12T00:00:00Z"))).toBe(8);
    expect(tokenDaysLeft(null)).toBeNull();
  });
});
