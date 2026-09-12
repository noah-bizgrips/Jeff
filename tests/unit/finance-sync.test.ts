import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ConnectionSummary } from "@/lib/integrations/types";

const setConnectionStatus = vi.fn(async () => {});
const readSecret = vi.fn(async () => ({ kind: "plaid_access_token", access_token: "access-sandbox-0123456789abcdef-0123-4567-89ab-cdef01234567", item_id: "item_1" }));
vi.mock("@/lib/integrations/store", () => ({ readSecret: (...a: unknown[]) => readSecret(...(a as [])), setConnectionStatus: (...a: unknown[]) => setConnectionStatus(...(a as [])), writeSecret: vi.fn() }));

const pages = [
  { added: [{ transaction_id: "t1", account_id: "a", amount: 10, date: "2026-09-01", name: "A" }], modified: [], removed: [], next_cursor: "c1", has_more: true },
  { added: [], modified: [{ transaction_id: "t1", account_id: "a", amount: 11, date: "2026-09-01", name: "A" }], removed: [{ transaction_id: "t0" }], next_cursor: "c2", has_more: false },
];
let calls: { cursor?: string }[] = [];
let failWith: string | null = null;
vi.mock("@/lib/integrations/providers/plaid", () => ({
  plaidClient: () => ({
    transactionsSync: vi.fn(async (req: { cursor?: string }) => {
      if (failWith) throw { response: { data: { error_code: failWith, request_id: "req_secret" } } };
      calls.push({ cursor: req.cursor });
      return { data: pages[calls.length - 1] ?? pages[1] };
    }),
    accountsGet: vi.fn(async () => ({ data: { accounts: [{ account_id: "a", name: "Checking", mask: "1111", type: "depository", subtype: "checking", balances: { current: 10, available: 9, iso_currency_code: "USD" } }] } })),
  }),
}));

const { plaidSyncAdapter } = await import("@/lib/integrations/sync/plaid");
const { nextCursor } = await import("@/lib/integrations/sync/stripe");

const conn: ConnectionSummary = {
  id: "33333333-3333-4333-8333-333333333333",
  provider: "plaid",
  displayName: "Financial Accounts · Test Bank",
  status: "connected",
  accessMode: "read",
  scopes: [],
  capabilities: ["transactions"],
  accountIdentifier: "Test Bank",
  lastTestAt: null,
  lastTestOk: true,
  lastError: null,
  lastSyncAt: null,
  createdAt: "",
  updatedAt: "",
  metadata: {},
};

describe("Plaid transactions sync", () => {
  beforeEach(() => {
    calls = [];
    failWith = null;
    setConnectionStatus.mockClear();
  });

  it("follows has_more, passes the cursor through, upserts added+modified and reports removed ids", async () => {
    const res = await plaidSyncAdapter.capabilities.transactions!(conn, "start");
    expect(calls.map((c) => c.cursor)).toEqual(["start", "c1"]);
    expect(res.cursor).toBe("c2");
    expect(res.items.map((i) => i.external_id)).toEqual(["t1", "t1"]);
    expect(res.items[1]!.metadata.amount).toBe(1100);
    expect(res.remove).toEqual({ resource_type: "transaction", external_ids: ["t0"] });
    expect(JSON.stringify(res)).not.toContain("access-sandbox");
  });

  it("ITEM_LOGIN_REQUIRED flips the connection to reconnect_required and never leaks the request id", async () => {
    failWith = "ITEM_LOGIN_REQUIRED";
    await expect(plaidSyncAdapter.capabilities.transactions!(conn, null)).rejects.toThrow(/plaid_transactions_sync_failed:ITEM_LOGIN_REQUIRED/);
    expect(setConnectionStatus).toHaveBeenCalledWith(conn.id, expect.objectContaining({ status: "reconnect_required" }));
    let msg = "";
    try {
      await plaidSyncAdapter.capabilities.transactions!(conn, null);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain("req_secret");
  });

  it("accounts capability maps balances without account numbers", async () => {
    const res = await plaidSyncAdapter.capabilities.accounts!(conn, null);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.resource_type).toBe("account");
    expect(res.items[0]!.metadata.balance_current).toBe(1000);
    expect(res.items[0]!.metadata.item_id).toBe("item_1");
  });
});

describe("Stripe cursor", () => {
  it("never moves backwards and keeps the previous value when nothing was seen", () => {
    expect(nextCursor(null, 100)).toBe("100");
    expect(nextCursor("100", 50)).toBe("100");
    expect(nextCursor("100", null)).toBe("100");
    expect(nextCursor(null, null)).toBeNull();
  });
});
