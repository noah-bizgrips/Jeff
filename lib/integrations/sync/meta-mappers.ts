import { createHash } from "node:crypto";
import type { SourceItemInput } from "./types";

/**
 * Pure mappers from Meta Graph API objects to normalised source_items.
 * Money is stored as integer minor units with the account currency; text is
 * truncated; no tokens or personal identifiers are ever copied through.
 *
 * Field names verified against
 * https://developers.facebook.com/docs/marketing-api/reference/ad-account/insights/
 * (level, time_increment, time_range, fields: campaign_id, campaign_name, spend,
 * impressions, clicks, cpc, cpm, ctr, actions, cost_per_action_type, reach,
 * frequency, date_start, date_stop, account_currency).
 */

const TEXT_LIMIT = 200;

export const LEAD_ACTION_TYPES = new Set(["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "leadgen_grouped"]);

export interface MetaAction {
  action_type?: string;
  value?: string | number;
}

export interface MetaInsightRow {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string | number;
  impressions?: string | number;
  clicks?: string | number;
  cpc?: string | number;
  cpm?: string | number;
  ctr?: string | number;
  reach?: string | number;
  frequency?: string | number;
  actions?: MetaAction[];
  cost_per_action_type?: MetaAction[];
  date_start?: string;
  date_stop?: string;
  account_currency?: string;
}

export interface MetaAdAccount {
  id: string; // "act_123"
  name?: string;
  currency?: string;
  account_status?: number;
  amount_spent?: string | number;
}

export interface MetaCampaign {
  id: string;
  name?: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string | number;
  lifetime_budget?: string | number;
  objective?: string;
}

export interface MetaPageInsightValue {
  value?: number | Record<string, number>;
  end_time?: string;
}

export interface MetaPageInsight {
  name?: string;
  period?: string;
  values?: MetaPageInsightValue[];
}

export interface MetaPost {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  insights?: { data?: { name?: string; values?: { value?: number }[] }[] };
}

export interface MetaIgAccount {
  id: string;
  username?: string;
  followers_count?: number;
  media_count?: number;
}

export interface MetaIgMedia {
  id: string;
  caption?: string;
  media_type?: string;
  timestamp?: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
}

export function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

/** Meta reports money as decimal strings in the account currency; store integer minor units. */
export function toMinor(v: unknown): number {
  return Math.round(num(v) * 100);
}

export function truncate(text: unknown, limit = TEXT_LIMIT): string | null {
  if (typeof text !== "string") return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > limit ? `${t.slice(0, limit - 1)}…` : t;
}

export function actIdOf(accountId: string): string {
  return accountId.startsWith("act_") ? accountId : `act_${accountId}`;
}

export function bareAccountId(accountId: string): string {
  return accountId.replace(/^act_/, "");
}

function hash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/** Sum of lead-type actions. Meta may report several overlapping lead action types; take the max to avoid double counting. */
export function leadsFromActions(actions: MetaAction[] | undefined): number {
  if (!Array.isArray(actions)) return 0;
  let best = 0;
  for (const a of actions) {
    if (a?.action_type && LEAD_ACTION_TYPES.has(a.action_type)) best = Math.max(best, num(a.value));
  }
  return best;
}

export function adsManagerUrl(accountId: string, campaignId?: string): string {
  const id = bareAccountId(accountId);
  const base = `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(id)}`;
  return campaignId ? `${base}&selected_campaign_ids=${encodeURIComponent(campaignId)}` : base;
}

export function mapAdInsight(row: MetaInsightRow, accountId: string, currency: string): SourceItemInput | null {
  const campaignId = row.campaign_id;
  const date = row.date_start;
  if (!campaignId || !date) return null;
  const spend = toMinor(row.spend);
  const leads = leadsFromActions(row.actions);
  const name = truncate(row.campaign_name, 120) ?? campaignId;
  const cur = (row.account_currency ?? currency ?? "USD").toUpperCase();
  const metadata = {
    account_id: bareAccountId(accountId),
    campaign_id: campaignId,
    campaign_name: name,
    date,
    currency: cur,
    spend,
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    cpc: num(row.cpc),
    cpm: num(row.cpm),
    ctr: num(row.ctr),
    reach: num(row.reach),
    frequency: num(row.frequency),
    leads,
    cost_per_lead: leads > 0 ? Math.round(spend / leads) : null,
  };
  return {
    provider: "meta",
    capability: "ads",
    resource_type: "ad_insight",
    external_id: `${campaignId}:${date}`,
    title: `${name} · ${date}`,
    summary: `Spend ${(spend / 100).toFixed(2)} ${cur} · ${metadata.impressions} impressions · ${metadata.clicks} clicks · ${leads} leads`,
    author: null,
    source_url: adsManagerUrl(accountId, campaignId),
    source_timestamp: `${date}T00:00:00.000Z`,
    content_hash: hash([spend, metadata.impressions, metadata.clicks, leads]),
    tags: ["ads", "meta"],
    metadata,
  };
}

export function mapAdAccount(acct: MetaAdAccount): SourceItemInput {
  const id = bareAccountId(acct.id);
  const currency = (acct.currency ?? "USD").toUpperCase();
  return {
    provider: "meta",
    capability: "ads",
    resource_type: "ad_account",
    external_id: id,
    title: acct.name ?? `Ad account ${id}`,
    summary: `${currency} · status ${acct.account_status ?? "?"} · lifetime spend ${num(acct.amount_spent) / 100}`,
    author: null,
    source_url: adsManagerUrl(id),
    source_timestamp: null,
    content_hash: hash([acct.account_status, acct.amount_spent]),
    tags: ["ads", "meta"],
    metadata: { account_id: id, currency, account_status: acct.account_status ?? null, amount_spent_minor: toMinor(num(acct.amount_spent) / 100) },
  };
}

export function mapCampaign(c: MetaCampaign, accountId: string, currency: string): SourceItemInput {
  const cur = currency.toUpperCase();
  return {
    provider: "meta",
    capability: "ads",
    resource_type: "campaign",
    external_id: c.id,
    title: truncate(c.name, 120) ?? c.id,
    summary: `${c.effective_status ?? c.status ?? "unknown"} · ${c.objective ?? ""}`.trim(),
    author: null,
    source_url: adsManagerUrl(accountId, c.id),
    source_timestamp: null,
    content_hash: hash([c.status, c.effective_status, c.daily_budget, c.lifetime_budget]),
    tags: ["ads", "meta", String(c.effective_status ?? c.status ?? "").toLowerCase()].filter(Boolean),
    metadata: {
      account_id: bareAccountId(accountId),
      status: c.status ?? null,
      effective_status: c.effective_status ?? null,
      objective: c.objective ?? null,
      currency: cur,
      // Meta returns budgets already in minor units (cents) as strings.
      daily_budget_minor: c.daily_budget != null ? Math.round(num(c.daily_budget)) : null,
      lifetime_budget_minor: c.lifetime_budget != null ? Math.round(num(c.lifetime_budget)) : null,
    },
  };
}

/** Page insights come as one series per metric; pivot them into one item per day. */
export function mapPageInsights(insights: MetaPageInsight[], pageId: string, pageName: string | null): SourceItemInput[] {
  const byDay = new Map<string, Record<string, number>>();
  for (const series of insights) {
    if (!series.name) continue;
    for (const v of series.values ?? []) {
      if (!v.end_time) continue;
      const day = v.end_time.slice(0, 10);
      const value = typeof v.value === "number" ? v.value : 0;
      const rec = byDay.get(day) ?? {};
      rec[series.name] = value;
      byDay.set(day, rec);
    }
  }
  return [...byDay.entries()].map(([day, metrics]) => ({
    provider: "meta",
    capability: "pages",
    resource_type: "page_insight",
    external_id: `${pageId}:${day}`,
    title: `${pageName ?? `Page ${pageId}`} · ${day}`,
    summary: Object.entries(metrics)
      .map(([k, v]) => `${k.replace(/^page_/, "")} ${v}`)
      .join(" · "),
    author: null,
    source_url: `https://www.facebook.com/${pageId}`,
    source_timestamp: `${day}T00:00:00.000Z`,
    content_hash: hash([metrics]),
    tags: ["pages", "meta"],
    metadata: { page_id: pageId, date: day, ...metrics },
  }));
}

export function mapPost(p: MetaPost, pageId: string): SourceItemInput {
  const metrics: Record<string, number> = {};
  for (const m of p.insights?.data ?? []) if (m.name) metrics[m.name] = num(m.values?.[0]?.value);
  return {
    provider: "meta",
    capability: "pages",
    resource_type: "post",
    external_id: p.id,
    title: truncate(p.message, 120) ?? `Post ${p.id}`,
    summary: truncate(p.message),
    author: null,
    source_url: p.permalink_url ?? null,
    source_timestamp: p.created_time ?? null,
    content_hash: hash([p.message?.slice(0, 200), metrics]),
    tags: ["pages", "meta", "post"],
    metadata: { page_id: pageId, ...metrics },
  };
}

export function mapIgAccount(a: MetaIgAccount): SourceItemInput {
  return {
    provider: "meta",
    capability: "instagram",
    resource_type: "ig_account",
    external_id: a.id,
    title: a.username ? `@${a.username}` : `Instagram ${a.id}`,
    summary: `${a.followers_count ?? 0} followers · ${a.media_count ?? 0} posts`,
    author: null,
    source_url: a.username ? `https://www.instagram.com/${a.username}/` : null,
    source_timestamp: null,
    content_hash: hash([a.followers_count, a.media_count]),
    tags: ["instagram", "meta"],
    metadata: { ig_id: a.id, username: a.username ?? null, followers_count: a.followers_count ?? null, media_count: a.media_count ?? null },
  };
}

export function mapIgInsights(insights: MetaPageInsight[], igId: string, username: string | null): SourceItemInput[] {
  const byDay = new Map<string, Record<string, number>>();
  for (const series of insights) {
    if (!series.name) continue;
    for (const v of series.values ?? []) {
      if (!v.end_time) continue;
      const day = v.end_time.slice(0, 10);
      const rec = byDay.get(day) ?? {};
      rec[series.name] = typeof v.value === "number" ? v.value : 0;
      byDay.set(day, rec);
    }
  }
  return [...byDay.entries()].map(([day, metrics]) => ({
    provider: "meta",
    capability: "instagram",
    resource_type: "ig_insight",
    external_id: `${igId}:${day}`,
    title: `${username ? `@${username}` : `Instagram ${igId}`} · ${day}`,
    summary: Object.entries(metrics)
      .map(([k, v]) => `${k} ${v}`)
      .join(" · "),
    author: null,
    source_url: username ? `https://www.instagram.com/${username}/` : null,
    source_timestamp: `${day}T00:00:00.000Z`,
    content_hash: hash([metrics]),
    tags: ["instagram", "meta"],
    metadata: { ig_id: igId, date: day, ...metrics },
  }));
}

export function mapIgMedia(m: MetaIgMedia, igId: string): SourceItemInput {
  return {
    provider: "meta",
    capability: "instagram",
    resource_type: "ig_media",
    external_id: m.id,
    title: truncate(m.caption, 120) ?? `${m.media_type ?? "Media"} ${m.id}`,
    summary: truncate(m.caption),
    author: null,
    source_url: m.permalink ?? null,
    source_timestamp: m.timestamp ?? null,
    content_hash: hash([m.like_count, m.comments_count]),
    tags: ["instagram", "meta", String(m.media_type ?? "").toLowerCase()].filter(Boolean),
    metadata: { ig_id: igId, media_type: m.media_type ?? null, like_count: m.like_count ?? 0, comments_count: m.comments_count ?? 0 },
  };
}

/** Incremental window: from (cursor − overlap) or the initial lookback, to today. */
export function insightsWindow(cursor: string | null, now: Date, opts: { initialDays: number; overlapDays: number }): { since: string; until: string; nextCursor: string } {
  const day = 86_400_000;
  const until = now.toISOString().slice(0, 10);
  let sinceMs = now.getTime() - opts.initialDays * day;
  if (cursor && /^\d{4}-\d{2}-\d{2}$/.test(cursor)) {
    const c = Date.parse(`${cursor}T00:00:00.000Z`) - opts.overlapDays * day;
    if (Number.isFinite(c) && c > sinceMs) sinceMs = c;
  }
  return { since: new Date(sinceMs).toISOString().slice(0, 10), until, nextCursor: until };
}
