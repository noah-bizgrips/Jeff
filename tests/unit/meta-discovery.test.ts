import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ requireEnv: (n: string) => n, publicEnv: () => ({ appUrl: "https://jeff.bizgrips.com" }), hasEnv: () => true }));

const { discoverAdAccounts, ensureAnalyzeAccess } = await import("@/lib/integrations/providers/meta");

const SECRET = { kind: "oauth_tokens" as const, user_token: "tok" };

function graph(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url).pathname.replace(/^\/v\d+\.\d+/, "");
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
      const hit = Object.entries(routes).find(([k]) => path === k);
      const status = hit?.[1].status ?? (hit ? 200 : 400);
      return { ok: status < 400, status, json: async () => hit?.[1].body ?? { error: { code: 100, message: "unknown path" } }, headers: new Headers() } as Response;
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("business-wide ad account discovery", () => {
  it("merges directly assigned, owned and client-shared accounts and marks which are readable", async () => {
    graph({
      "/me/adaccounts": { body: { data: [{ id: "act_1", name: "BizGrips" }] } },
      "/me/businesses": { body: { data: [{ id: "biz_9", name: "BizGrips LLC" }] } },
      "/biz_9/owned_ad_accounts": { body: { data: [{ id: "act_1", name: "BizGrips" }, { id: "act_2", name: "BizGrips Test" }] } },
      "/biz_9/client_ad_accounts": { body: { data: [{ id: "act_77", name: "Pure Bath of Michigan" }] } },
    });
    const r = await discoverAdAccounts(SECRET);
    expect(r.businessIds).toEqual(["biz_9"]);
    expect(r.limitations).toEqual([]);
    expect(r.accounts).toEqual([
      { id: "act_1", name: "BizGrips", businessId: "biz_9", relation: "owned", accessible: true },
      { id: "act_2", name: "BizGrips Test", businessId: "biz_9", relation: "owned", accessible: false },
      { id: "act_77", name: "Pure Bath of Michigan", businessId: "biz_9", relation: "client", accessible: false },
    ]);
  });

  it("degrades to directly assigned accounts when business_management is missing", async () => {
    graph({ "/me/adaccounts": { body: { data: [{ id: "act_1", name: "BizGrips" }] } } });
    const r = await discoverAdAccounts(SECRET);
    expect(r.accounts.map((a) => a.id)).toEqual(["act_1"]);
    expect(r.limitations[0]).toMatch(/business_management permission missing/);
  });

  it("self-provisions only the ANALYZE task for the token's own user", async () => {
    const calls = graph({ "/me": { body: { id: "su_5" } }, "/act_77/assigned_users": { body: { success: true } } });
    const r = await ensureAnalyzeAccess(SECRET, { id: "act_77", name: "x", businessId: "biz_9", relation: "client", accessible: false });
    expect(r).toEqual({ ok: true });
    const post = calls.find((c) => c.method === "POST")!;
    const params = new URLSearchParams(post.body);
    expect(params.get("user")).toBe("su_5");
    expect(params.get("tasks")).toBe('["ANALYZE"]');
    expect(params.get("business")).toBe("biz_9");
    expect(await ensureAnalyzeAccess(SECRET, { id: "act_1", name: "x", businessId: null, relation: "direct", accessible: false })).toEqual({ ok: false, reason: "no_business" });
  });
});
