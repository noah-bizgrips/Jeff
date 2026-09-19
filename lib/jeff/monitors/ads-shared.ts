import type { SourceRow } from "./types";
import { num, tsOf } from "./finance-shared";

/** Shared helpers for Meta Ads monitors. Spend is integer minor units. */

export interface AdDay {
  row: SourceRow;
  ts: number;
  date: string;
  accountId: string;
  campaignId: string;
  campaignName: string;
  spend: number;
  leads: number;
  clicks: number;
  impressions: number;
  currency: string;
}

export function adDays(rows: SourceRow[]): AdDay[] {
  const out: AdDay[] = [];
  for (const r of rows) {
    if (r.provider !== "meta" || r.resource_type !== "ad_insight") continue;
    const ts = tsOf(r);
    if (ts === null) continue;
    out.push({
      row: r,
      ts,
      date: String(r.metadata.date ?? r.source_timestamp?.slice(0, 10) ?? ""),
      accountId: String(r.metadata.account_id ?? ""),
      campaignId: String(r.metadata.campaign_id ?? r.external_id.split(":")[0]),
      campaignName: String(r.metadata.campaign_name ?? r.title ?? ""),
      spend: num(r.metadata.spend),
      leads: num(r.metadata.leads),
      clicks: num(r.metadata.clicks),
      impressions: num(r.metadata.impressions),
      currency: String(r.metadata.currency ?? "USD"),
    });
  }
  return out;
}

export function sumSpend(days: AdDay[]): number {
  return days.reduce((a, d) => a + d.spend, 0);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export const ADS_LIMITATIONS =
  "Meta reports attribution with a delay and may restate the last ~3 days; figures reflect the last sync. Leads are Meta-reported lead actions (lead forms / pixel leads), not CRM-confirmed leads.";
