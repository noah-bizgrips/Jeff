import { describe, expect, it } from "vitest";
import { adSpendChange } from "@/lib/gomez/monitors/ad-spend-change";
import { underperformingAcquisition } from "@/lib/gomez/monitors/underperforming-acquisition";
import type { SourceRow } from "@/lib/gomez/monitors/types";

const NOW = new Date("2026-09-15T12:00:00Z");
const DAY = 86_400_000;

function day(offset: number, campaign: string, spend: number, leads: number, account = "1"): SourceRow {
  const d = new Date(NOW.getTime() - offset * DAY);
  const date = d.toISOString().slice(0, 10);
  return {
    id: `${campaign}-${date}`,
    provider: "meta",
    capability: "ads",
    resource_type: "ad_insight",
    external_id: `${campaign}:${date}`,
    title: `${campaign} · ${date}`,
    summary: null,
    author: null,
    source_url: "https://adsmanager.facebook.com/x",
    source_timestamp: `${date}T00:00:00.000Z`,
    tags: ["ads"],
    metadata: { account_id: account, campaign_id: campaign, campaign_name: campaign, date, spend, leads, clicks: 10, impressions: 1000, currency: "USD" },
  };
}

describe("ad_spend_change", () => {
  it("flags a > 30% and > $200 week-over-week change", () => {
    const rows: SourceRow[] = [];
    for (let i = 0; i < 7; i++) rows.push(day(i, "A", 10000, 1)); // last 7d: $700
    for (let i = 7; i < 14; i++) rows.push(day(i, "A", 4000, 1)); // prior 7d: $280
    const out = adSpendChange.run(rows, { now: NOW });
    const weekly = out.find((f) => f.fingerprint.endsWith(":weekly"))!;
    expect(weekly).toBeTruthy();
    expect(weekly.category).toBe("ad_spend_change");
    expect(weekly.metrics).toMatchObject({ spend_last_7_minor: 70000, spend_prior_7_minor: 28000, change_pct: 150 });
    expect(weekly.title).toMatch(/up 150%/);
    expect(String(weekly.metrics.formula)).toMatch(/spend_prior_7/);
  });

  it("stays quiet for small or low-dollar changes", () => {
    const rows: SourceRow[] = [];
    for (let i = 0; i < 7; i++) rows.push(day(i, "A", 1200, 1));
    for (let i = 7; i < 14; i++) rows.push(day(i, "A", 1000, 1));
    expect(adSpendChange.run(rows, { now: NOW })).toHaveLength(0);
  });

  it("flags a single-day spike against the 14-day median", () => {
    const rows: SourceRow[] = [];
    for (let i = 1; i <= 14; i++) rows.push(day(i, "A", i === 3 ? 40000 : 5000, 1));
    const out = adSpendChange.run(rows, { now: NOW });
    const spike = out.find((f) => f.fingerprint.includes(":spike:"))!;
    expect(spike).toBeTruthy();
    expect(spike.metrics).toMatchObject({ day_spend_minor: 40000, median_daily_minor: 5000 });
  });

  it("ignores non-Meta rows", () => {
    expect(adSpendChange.run([{ ...day(1, "A", 100000, 0), provider: "stripe", resource_type: "charge" }], { now: NOW })).toHaveLength(0);
  });
});

describe("underperforming_acquisition", () => {
  it("flags a campaign whose CPL is > 1.5× the account median (≥ 10 leads)", () => {
    const rows: SourceRow[] = [];
    for (let i = 1; i <= 10; i++) {
      rows.push(day(i, "Good", 5000, 2)); // $25 CPL
      rows.push(day(i, "Ok", 6000, 2)); // $30 CPL
      rows.push(day(i, "Bad", 20000, 2)); // $100 CPL
    }
    const out = underperformingAcquisition.run(rows, { now: NOW });
    const bad = out.find((f) => f.fingerprint.endsWith(":Bad:cpl"))!;
    expect(bad).toBeTruthy();
    expect(bad.category).toBe("underperforming_acquisition");
    expect(bad.metrics).toMatchObject({ leads: 20, cpl_minor: 10000, median_cpl_minor: 3000 });
    expect(bad.severity).toBe("high");
    expect(out.some((f) => f.fingerprint.endsWith(":Good:cpl"))).toBe(false);
    expect(bad.limitations).toMatch(/attribution/);
  });

  it("does not flag campaigns with fewer than 10 leads on CPL, but flags $100+ spend with zero leads", () => {
    const rows: SourceRow[] = [];
    for (let i = 0; i < 7; i++) {
      rows.push(day(i, "Small", 3000, 1)); // 7 leads, excluded from CPL comparison
      rows.push(day(i, "Dead", 3000, 0)); // $210 with no leads
      rows.push(day(i, "Base", 3000, 3));
    }
    const out = underperformingAcquisition.run(rows, { now: NOW });
    expect(out.some((f) => f.fingerprint.includes(":Small:"))).toBe(false);
    const dead = out.find((f) => f.fingerprint.endsWith(":Dead:noleads"))!;
    expect(dead).toBeTruthy();
    expect(dead.metrics).toMatchObject({ spend_7d_minor: 21000, leads_7d: 0 });
    expect(dead.observed_facts[0]).toMatch(/0 lead actions/);
  });

  it("returns nothing without ad data", () => {
    expect(underperformingAcquisition.run([], { now: NOW })).toHaveLength(0);
  });
});
