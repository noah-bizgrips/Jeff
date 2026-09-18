import { evidenceOf, type CandidateFinding, type ExtendedContext, type SourceRow } from "./types";
import { DAY, money, num, tsOf } from "./finance-shared";
import { str } from "./portal-shared";

/**
 * Expense Creep Hunter additions — new recurring charges, overlapping tools,
 * price increases, possibly-unused software and upcoming annual renewals.
 * All from Plaid transaction rows (and Stripe charges the owner pays out).
 */

export const LOOKBACK_DAYS = 400;
export const NEW_WINDOW_DAYS = 45;
export const PRICE_INCREASE_PCT = 10;
export const UNUSED_SILENCE_DAYS = 60;
export const ANNUAL_LOOKAHEAD_DAYS = 30;

/** Small SaaS category map for duplicate-tool detection (merchant_key substrings). */
export const TOOL_CATEGORIES: { category: string; tools: string[] }[] = [
  { category: "video meetings", tools: ["zoom", "google meet", "microsoft teams", "webex", "loom"] },
  { category: "scheduling", tools: ["calendly", "acuity", "savvycal", "cal.com", "youcanbook"] },
  { category: "team chat", tools: ["slack", "discord", "microsoft teams"] },
  { category: "project management", tools: ["asana", "trello", "monday", "clickup", "notion", "basecamp", "linear"] },
  { category: "email marketing", tools: ["mailchimp", "constant contact", "activecampaign", "convertkit", "klaviyo", "sendgrid", "mailgun"] },
  { category: "cloud storage", tools: ["dropbox", "google one", "box.com", "icloud", "onedrive"] },
  { category: "design", tools: ["canva", "figma", "adobe"] },
  { category: "ai assistants", tools: ["openai", "chatgpt", "anthropic", "claude", "midjourney", "jasper", "copy.ai"] },
  { category: "crm / marketing automation", tools: ["hubspot", "gohighlevel", "highlevel", "pipedrive", "zoho", "keap"] },
  { category: "accounting", tools: ["quickbooks", "xero", "freshbooks", "wave"] },
  { category: "website hosting", tools: ["vercel", "netlify", "wix", "squarespace", "godaddy", "bluehost", "hostinger", "webflow", "wordpress", "cloudflare"] },
  { category: "automation", tools: ["zapier", "make.com", "integromat", "n8n"] },
  { category: "password manager", tools: ["1password", "lastpass", "bitwarden", "dashlane"] },
  { category: "e-signature", tools: ["docusign", "pandadoc", "hellosign", "dropbox sign"] },
];

interface Charge {
  row: SourceRow;
  at: number;
  amount: number;
  merchant: string;
  label: string;
}

function outflows(rows: SourceRow[], now: number): Charge[] {
  const since = now - LOOKBACK_DAYS * DAY;
  const out: Charge[] = [];
  for (const r of rows) {
    if (r.provider !== "plaid" || r.resource_type !== "transaction") continue;
    if (r.metadata.pending) continue;
    const at = tsOf(r);
    if (at == null || at < since) continue;
    const amount = num(r.metadata.amount);
    const direction = str(r.metadata.direction);
    if (direction === "inflow" || amount <= 0) continue;
    const merchant = str(r.metadata.merchant_key) ?? str(r.metadata.merchant_name)?.toLowerCase() ?? (r.title ?? "").toLowerCase();
    if (!merchant) continue;
    out.push({ row: r, at, amount: Math.abs(amount), merchant, label: str(r.metadata.merchant_name) ?? r.title ?? merchant });
  }
  return out.sort((a, b) => a.at - b.at);
}

function groupByMerchant(charges: Charge[]): Map<string, Charge[]> {
  const m = new Map<string, Charge[]>();
  for (const c of charges) m.set(c.merchant, [...(m.get(c.merchant) ?? []), c]);
  return m;
}

function isMonthlyCadence(items: Charge[]): boolean {
  if (items.length < 2) return false;
  const gaps: number[] = [];
  for (let i = 1; i < items.length; i++) gaps.push((items[i]!.at - items[i - 1]!.at) / DAY);
  return gaps.every((g) => g >= 20 && g <= 45);
}

function currencyOf(items: Charge[]): string {
  return (str(items[0]?.row.metadata.currency) ?? "USD").toUpperCase();
}

/** A merchant that started charging monthly within the last NEW_WINDOW_DAYS. */
export function newRecurringCharge(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const now = ctx.now.getTime();
  const out: CandidateFinding[] = [];
  for (const [merchant, items] of groupByMerchant(outflows(rows, now))) {
    if (items.length < 2 || !isMonthlyCadence(items)) continue;
    const first = items[0]!.at;
    if (now - first > NEW_WINDOW_DAYS * DAY + 35 * DAY) continue; // started recently (allow the second charge to land)
    if (items.length > 3) continue;
    const amt = items.at(-1)!.amount;
    const cur = currencyOf(items);
    out.push({
      fingerprint: `new_recurring_charge:${merchant}`,
      category: "new_recurring_charge",
      title: `New recurring charge: ${items[0]!.label} ${money(amt, cur)}/month`,
      observed_facts: items.map((c) => `${new Date(c.at).toISOString().slice(0, 10)}: ${money(c.amount, cur)} to ${c.label}.`),
      metrics: { occurrences: items.length, amount_minor: amt, monthly_minor: amt, annualised_minor: amt * 12, currency: cur, first_seen: new Date(first).toISOString().slice(0, 10), formula: "≥2 charges 20–45 days apart, first within the new-charge window" },
      interpretation: `Interpretation: a new subscription (about ${money(amt * 12, cur)}/year). Worth confirming it was intended and who owns it.`,
      evidence: items.map((c) => evidenceOf(c.row)),
      range_start: new Date(first).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.7,
      limitations: "Merchant names are normalised by Plaid; the same vendor can appear under two descriptors.",
      severity: amt >= 10_000 ? "medium" : "low",
      proposed_mission: null,
    });
  }
  return out;
}

/** Two or more paid tools in the same category. */
export function duplicateTool(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const now = ctx.now.getTime();
  const recent = outflows(rows, now).filter((c) => now - c.at <= 120 * DAY);
  const byMerchant = groupByMerchant(recent);
  const out: CandidateFinding[] = [];
  for (const cat of TOOL_CATEGORIES) {
    const matched = [...byMerchant.entries()].filter(([m]) => cat.tools.some((t) => m.includes(t)));
    const distinct = new Map<string, Charge[]>();
    for (const [m, items] of matched) {
      const tool = cat.tools.find((t) => m.includes(t))!;
      distinct.set(tool, [...(distinct.get(tool) ?? []), ...items]);
    }
    if (distinct.size < 2) continue;
    const cur = currencyOf(recent);
    const monthly = [...distinct.entries()].map(([tool, items]) => ({ tool, monthly: Math.round(items.reduce((s, c) => s + c.amount, 0) / 4), items }));
    out.push({
      fingerprint: `duplicate_tool:${cat.category.replace(/\W+/g, "_")}`,
      category: "duplicate_tool",
      title: `Paying for ${distinct.size} ${cat.category} tools: ${monthly.map((m) => m.tool).join(", ")}`,
      observed_facts: monthly.map((m) => `${m.tool}: ${m.items.length} charge(s) in 120 days, ≈${money(m.monthly, cur)}/month.`),
      metrics: { category: cat.category, tools: monthly.map((m) => m.tool), combined_monthly_minor: monthly.reduce((s, m) => s + m.monthly, 0), currency: cur, formula: "distinct paid merchants matching one tool category in the last 120 days ≥ 2" },
      interpretation: "Interpretation: overlapping tools are the most common expense creep; one is usually a leftover from a trial or a client-specific need that ended.",
      evidence: monthly.flatMap((m) => m.items.slice(0, 2)).map((c) => evidenceOf(c.row)),
      range_start: new Date(now - 120 * DAY).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.55,
      limitations: "Category map is a small curated list; some overlap is deliberate (e.g. Slack + Teams for different clients).",
      severity: "low",
      proposed_mission: null,
    });
  }
  return out;
}

/** Recurring merchant whose latest charge is > PRICE_INCREASE_PCT above its prior median. */
export function priceIncrease(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const now = ctx.now.getTime();
  const out: CandidateFinding[] = [];
  for (const [merchant, items] of groupByMerchant(outflows(rows, now))) {
    if (items.length < 4 || !isMonthlyCadence(items)) continue;
    const latest = items.at(-1)!;
    if (now - latest.at > 45 * DAY) continue;
    const prior = items.slice(0, -1).map((c) => c.amount).sort((a, b) => a - b);
    const med = prior.length % 2 ? prior[Math.floor(prior.length / 2)]! : (prior[prior.length / 2 - 1]! + prior[prior.length / 2]!) / 2;
    if (!med) continue;
    const pct = Math.round(((latest.amount - med) / med) * 1000) / 10;
    if (pct < PRICE_INCREASE_PCT) continue;
    const cur = currencyOf(items);
    out.push({
      fingerprint: `price_increase:${merchant}:${new Date(latest.at).toISOString().slice(0, 7)}`,
      category: "price_increase",
      title: `${latest.label} went up ${pct}% (${money(med, cur)} → ${money(latest.amount, cur)})`,
      observed_facts: [`Prior ${prior.length} charges had a median of ${money(med, cur)}.`, `Latest charge on ${new Date(latest.at).toISOString().slice(0, 10)}: ${money(latest.amount, cur)}.`],
      metrics: { prior_median_minor: med, latest_minor: latest.amount, increase_pct: pct, annual_impact_minor: (latest.amount - med) * 12, currency: cur, formula: "(latest − median(prior)) / median(prior)" },
      interpretation: `Interpretation: about ${money((latest.amount - med) * 12, cur)}/year more for the same service unless usage changed. Vendors rarely announce this loudly.`,
      evidence: items.slice(-3).map((c) => evidenceOf(c.row)),
      range_start: new Date(items[0]!.at).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.7,
      limitations: "Usage-based bills (ads, cloud) legitimately vary; treat those as informational.",
      severity: latest.amount - med >= 5_000 ? "medium" : "low",
      proposed_mission: null,
    });
  }
  return out;
}

/** Recurring tool with no mention anywhere in synced email/Slack for UNUSED_SILENCE_DAYS. Low confidence by design. */
export function unusedSoftware(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const now = ctx.now.getTime();
  const since = now - UNUSED_SILENCE_DAYS * DAY;
  const comms = rows.filter((r) => (r.provider === "google" && r.resource_type === "email") || (r.provider === "slack" && r.resource_type === "message")).filter((r) => (tsOf(r) ?? 0) >= since);
  const haystack = comms.map((r) => `${r.title ?? ""} ${r.summary ?? ""} ${r.author ?? ""}`.toLowerCase());
  const out: CandidateFinding[] = [];
  for (const [merchant, items] of groupByMerchant(outflows(rows, now))) {
    if (items.length < 3 || !isMonthlyCadence(items)) continue;
    const tool = TOOL_CATEGORIES.flatMap((c) => c.tools).find((t) => merchant.includes(t));
    if (!tool) continue;
    if (haystack.some((h) => h.includes(tool))) continue;
    const cur = currencyOf(items);
    const amt = items.at(-1)!.amount;
    out.push({
      fingerprint: `unused_software:${merchant}`,
      category: "unused_software",
      title: `${items[0]!.label} (${money(amt, cur)}/month) not mentioned anywhere in ${UNUSED_SILENCE_DAYS} days`,
      observed_facts: [`${items.length} monthly charges on record; latest ${new Date(items.at(-1)!.at).toISOString().slice(0, 10)}.`, `No email or Slack message in the last ${UNUSED_SILENCE_DAYS} days mentions "${tool}".`],
      metrics: { monthly_minor: amt, annualised_minor: amt * 12, silence_days: UNUSED_SILENCE_DAYS, currency: cur, formula: "recurring charge AND zero mentions of the tool name in synced comms over the window" },
      interpretation: "Interpretation: possibly unused — or used silently (a tool you log into without talking about it). Low confidence; the charge history is the only hard fact.",
      evidence: items.slice(-2).map((c) => evidenceOf(c.row)),
      range_start: new Date(since).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.35,
      limitations: "Absence of mentions is weak evidence; login/usage data is not connected.",
      severity: "info",
      proposed_mission: null,
    });
  }
  return out;
}

/** Charges that recurred ~365 days ago and are due again within ANNUAL_LOOKAHEAD_DAYS. */
export function annualRenewalUpcoming(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const now = ctx.now.getTime();
  const out: CandidateFinding[] = [];
  for (const [merchant, items] of groupByMerchant(outflows(rows, now))) {
    if (items.length < 1) continue;
    const yearAgo = items.filter((c) => {
      const d = (now - c.at) / DAY;
      return d >= 365 - ANNUAL_LOOKAHEAD_DAYS && d <= 365;
    });
    if (!yearAgo.length) continue;
    const last = yearAgo.at(-1)!;
    // If the same merchant charged monthly, it is not an annual renewal.
    if (isMonthlyCadence(items) && items.length >= 3) continue;
    if (items.some((c) => c.at > last.at && now - c.at < 60 * DAY)) continue; // already renewed
    const dueAt = last.at + 365 * DAY;
    const days = Math.max(0, Math.ceil((dueAt - now) / DAY));
    const cur = currencyOf(items);
    out.push({
      fingerprint: `annual_renewal_upcoming:${merchant}:${new Date(dueAt).toISOString().slice(0, 7)}`,
      category: "annual_renewal_upcoming",
      title: `${last.label} annual renewal (~${money(last.amount, cur)}) expected in ${days} day${days === 1 ? "" : "s"}`,
      observed_facts: [`Charged ${money(last.amount, cur)} on ${new Date(last.at).toISOString().slice(0, 10)}; no charge from this merchant since.`],
      metrics: { last_amount_minor: last.amount, expected_on: new Date(dueAt).toISOString().slice(0, 10), days_until: days, currency: cur, formula: "single charge 335–365 days ago with no subsequent charge → renewal expected at +365d" },
      interpretation: "Interpretation: annual renewals are the easiest charges to forget and the hardest to reverse. Decide before it bills, not after.",
      evidence: [evidenceOf(last.row)],
      range_start: new Date(last.at).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.6,
      limitations: "Inferred from a single prior charge; some vendors bill on a different day or moved to monthly.",
      severity: last.amount >= 20_000 ? "medium" : "low",
      proposed_mission: null,
    });
  }
  return out;
}
