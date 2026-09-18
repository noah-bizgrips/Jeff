import { describe, expect, it, vi, beforeEach } from "vitest";

const ledger: { estimated_usd: number }[] = [];
const inserted: Record<string, unknown>[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ gte: async () => ({ data: ledger, error: null }) }) }),
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return { error: null };
      },
    }),
  }),
}));

const { estimateCostUsd, dailyBudgetUsd, priceFor } = await import("@/lib/gomez/pricing");
const { budgetStatus, recordUsage, utcDayStart } = await import("@/lib/gomez/budget");

describe("cost estimator", () => {
  it("uses per-model prices with cache discounts", () => {
    // 1M input on opus-5 = $5; 1M output = $25; cache read 0.1x; cache write 1.25x
    expect(estimateCostUsd("claude-opus-5", { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 })).toBe(5);
    expect(estimateCostUsd("claude-opus-5", { input_tokens: 0, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 })).toBe(25);
    expect(estimateCostUsd("claude-sonnet-5", { input_tokens: 10_000, output_tokens: 1_000, cache_read_tokens: 20_000, cache_write_tokens: 0 })).toBeCloseTo(0.02 + 0.01 + 0.004, 6);
    expect(estimateCostUsd("claude-haiku-4-5", { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 })).toBe(1.25);
    expect(priceFor("something-unknown")).toEqual({ input: 5, output: 25 });
  });
  it("reads the daily budget from env with a safe default", () => {
    delete process.env.JEFF_DAILY_BUDGET_USD;
    expect(dailyBudgetUsd()).toBe(2);
    process.env.JEFF_DAILY_BUDGET_USD = "0.50";
    expect(dailyBudgetUsd()).toBe(0.5);
    process.env.JEFF_DAILY_BUDGET_USD = "nonsense";
    expect(dailyBudgetUsd()).toBe(2);
  });
});

describe("budget guard", () => {
  beforeEach(() => {
    ledger.length = 0;
    inserted.length = 0;
    process.env.JEFF_DAILY_BUDGET_USD = "1.00";
  });
  it("allows when under budget", async () => {
    ledger.push({ estimated_usd: 0.4 }, { estimated_usd: 0.3 });
    const s = await budgetStatus("owner");
    expect(s).toEqual({ spentUsd: 0.7, budgetUsd: 1, exhausted: false });
  });
  it("blocks when today's spend reaches the budget", async () => {
    ledger.push({ estimated_usd: 0.6 }, { estimated_usd: 0.4 });
    expect((await budgetStatus("owner")).exhausted).toBe(true);
  });
  it("records usage with an estimate", async () => {
    const usd = await recordUsage("owner", "claude-sonnet-5", { input_tokens: 5000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 });
    expect(usd).toBeCloseTo(0.015, 6);
    expect(inserted[0]).toMatchObject({ owner_id: "owner", model: "claude-sonnet-5", input_tokens: 5000, output_tokens: 500 });
  });
  it("utcDayStart is midnight UTC", () => {
    expect(utcDayStart(new Date("2026-09-12T13:45:00Z"))).toBe("2026-09-12T00:00:00.000Z");
  });
});
