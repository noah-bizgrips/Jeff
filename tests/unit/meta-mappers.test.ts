import { describe, expect, it } from "vitest";
import { insightsWindow, leadsFromActions, mapAdInsight, mapCampaign, mapIgMedia, mapPageInsights, mapPost, toMinor } from "@/lib/integrations/sync/meta-mappers";
import { summarizeAds } from "@/lib/gomez/tools";
import { computeMetric } from "@/lib/gomez/goals/metrics";
import { GoalMetricSchema } from "@/lib/gomez/goals/schema";

describe("Meta mappers", () => {
  it("stores spend in minor units and extracts leads from actions without double counting", () => {
    const item = mapAdInsight(
      {
        campaign_id: "c1",
        campaign_name: "Spring leads",
        spend: "123.45",
        impressions: "1000",
        clicks: "40",
        cpc: "3.08",
        ctr: "4",
        actions: [
          { action_type: "lead", value: "7" },
          { action_type: "onsite_conversion.lead_grouped", value: "7" },
          { action_type: "link_click", value: "40" },
        ],
        date_start: "2026-09-10",
        date_stop: "2026-09-10",
        account_currency: "USD",
      },
      "act_123",
      "USD",
    )!;
    expect(item.resource_type).toBe("ad_insight");
    expect(item.external_id).toBe("c1:2026-09-10");
    expect(item.metadata.spend).toBe(12345);
    expect(item.metadata.leads).toBe(7);
    expect(item.metadata.cost_per_lead).toBe(1764);
    expect(item.metadata.account_id).toBe("123");
    expect(item.source_url).toContain("act=123");
    expect(JSON.stringify(item)).not.toMatch(/access_token/);
  });

  it("returns null for rows without a campaign or date", () => {
    expect(mapAdInsight({ spend: "1" }, "act_1", "USD")).toBeNull();
  });

  it("leadsFromActions takes the max of overlapping lead types and ignores others", () => {
    expect(leadsFromActions([{ action_type: "lead", value: 3 }, { action_type: "offsite_conversion.fb_pixel_lead", value: "5" }, { action_type: "post_engagement", value: 99 }])).toBe(5);
    expect(leadsFromActions(undefined)).toBe(0);
    expect(toMinor("0.10")).toBe(10);
  });

  it("maps campaigns with budgets already in minor units", () => {
    const c = mapCampaign({ id: "c1", name: "X", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "5000", objective: "OUTCOME_LEADS" }, "act_1", "usd");
    expect(c.metadata.daily_budget_minor).toBe(5000);
    expect(c.metadata.currency).toBe("USD");
    expect(c.tags).toContain("active");
  });

  it("pivots page insight series into one item per day", () => {
    const items = mapPageInsights(
      [
        { name: "page_impressions", period: "day", values: [{ value: 10, end_time: "2026-09-10T07:00:00+0000" }, { value: 12, end_time: "2026-09-11T07:00:00+0000" }] },
        { name: "page_fans", period: "day", values: [{ value: 500, end_time: "2026-09-10T07:00:00+0000" }] },
      ],
      "p1",
      "BizGrips",
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.external_id).toBe("p1:2026-09-10");
    expect(items[0]!.metadata).toMatchObject({ page_impressions: 10, page_fans: 500 });
  });

  it("truncates post and media text to 200 characters", () => {
    const long = "x".repeat(500);
    const post = mapPost({ id: "po1", message: long, created_time: "2026-09-10T00:00:00+0000", permalink_url: "https://facebook.com/po1" }, "p1");
    expect(post.summary!.length).toBeLessThanOrEqual(200);
    const media = mapIgMedia({ id: "m1", caption: long, media_type: "IMAGE", timestamp: "2026-09-10T00:00:00+0000", like_count: 3, comments_count: 1 }, "ig1");
    expect(media.summary!.length).toBeLessThanOrEqual(200);
    expect(media.metadata).toMatchObject({ like_count: 3, comments_count: 1 });
  });

  it("incremental window overlaps 3 days behind the cursor and never exceeds the initial lookback", () => {
    const now = new Date("2026-09-12T12:00:00Z");
    const w = insightsWindow("2026-09-10", now, { initialDays: 30, overlapDays: 3 });
    expect(w).toEqual({ since: "2026-09-07", until: "2026-09-12", nextCursor: "2026-09-12" });
    const first = insightsWindow(null, now, { initialDays: 30, overlapDays: 3 });
    expect(first.since).toBe("2026-08-13");
    const old = insightsWindow("2020-01-01", now, { initialDays: 30, overlapDays: 3 });
    expect(old.since).toBe("2026-08-13");
  });
});

describe("get_ad_performance summary", () => {
  const rows = [
    { metadata: { campaign_id: "c1", campaign_name: "A", spend: 10000, leads: 4, clicks: 100, impressions: 5000, currency: "USD", date: "2026-09-10" }, source_timestamp: "2026-09-10T00:00:00Z" },
    { metadata: { campaign_id: "c1", campaign_name: "A", spend: 5000, leads: 1, clicks: 50, impressions: 2500, currency: "USD", date: "2026-09-11" }, source_timestamp: "2026-09-11T00:00:00Z" },
    { metadata: { campaign_id: "c2", campaign_name: "B", spend: 20000, leads: 0, clicks: 10, impressions: 4000, currency: "USD", date: "2026-09-11" }, source_timestamp: "2026-09-11T00:00:00Z" },
  ];
  it("aggregates totals, by campaign and by day with formulas", () => {
    const s = summarizeAds(rows, 30) as Record<string, unknown>;
    expect(s.totals).toMatchObject({ spend: 35000, leads: 5, cost_per_lead: 7000, ctr_pct: 1.39 });
    const byCampaign = s.by_campaign as { campaign_id: string; spend: number; cost_per_lead: number | null }[];
    expect(byCampaign[0]).toMatchObject({ campaign_id: "c2", spend: 20000, cost_per_lead: null });
    expect(s.by_day).toEqual([
      { date: "2026-09-10", spend: 10000, leads: 4 },
      { date: "2026-09-11", spend: 25000, leads: 1 },
    ]);
    expect(JSON.stringify(s)).not.toMatch(/email|phone/);
  });
  it("explains when nothing is synced", () => {
    expect(summarizeAds([], 7)).toMatchObject({ days: 7 });
    expect(String((summarizeAds([], 7) as { note: string }).note)).toMatch(/No Meta Ads data/);
  });
});

describe("goal metrics read Meta ad_insight rows", () => {
  const NOW = new Date("2026-09-30T12:00:00Z");
  const WINDOW = { start: "2026-09-01T00:00:00Z", end: "2026-10-31T00:00:00Z" };
  const conns = [{ provider: "meta", status: "connected", last_sync_at: "2026-09-30T11:00:00Z" }];
  const insight = mapAdInsight({ campaign_id: "c1", campaign_name: "A", spend: "250.00", actions: [{ action_type: "lead", value: "5" }], date_start: "2026-09-10", account_currency: "USD" }, "act_1", "USD")!;
  const row = { id: "r1", provider: "meta", capability: "ads", resource_type: "ad_insight", external_id: insight.external_id, title: insight.title, source_timestamp: insight.source_timestamp, synced_at: "2026-09-30T11:00:00Z", tags: [], metadata: insight.metadata };
  it("sums spend (minor units) and leads from mapper output", () => {
    const spend = GoalMetricSchema.parse({ key: "ad_spend", name: "Ad spend", kind: "currency", target: 100000, comparator: "lte", unit: "USD", formula: "value", inputs: { value: { provider: "meta", resource_type: "ad_insight", filter: {}, aggregation: "sum", field: "spend" } }, time_range: { kind: "goal_window" } });
    const leads = GoalMetricSchema.parse({ key: "leads", name: "Leads", kind: "count", target: 10, comparator: "gte", unit: "leads", formula: "value", inputs: { value: { provider: "meta", resource_type: "ad_insight", filter: {}, aggregation: "sum", field: "leads" } }, time_range: { kind: "goal_window" } });
    expect(computeMetric(spend, [row], conns, WINDOW, NOW).value).toBe(25000);
    expect(computeMetric(leads, [row], conns, WINDOW, NOW).value).toBe(5);
  });
});
