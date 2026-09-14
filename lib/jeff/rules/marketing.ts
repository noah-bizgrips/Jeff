/**
 * Marketing / vendor / social-notification detection shared by the author
 * classifier and the commitment classifier. Pure, structural patterns only —
 * no vendor names are hard-coded beyond generic mailbox roles.
 *
 * A promotional email ("Last call: 15% off ends tonight") or a transactional
 * vendor mailbox (servicing@, billing@, no-reply@) is never a human counterparty,
 * so nothing it says can be a commitment owed to the owner.
 */

/** Copy that only appears in promotional / bulk mail — one hit is enough. */
export const PROMOTIONAL_PATTERNS: RegExp[] = [
  /\b\d{1,3}\s?%\s?off\b/i,
  /\b(?:save|get|take|extra)\s+(?:up to\s+)?\$?\d{1,4}(?:\s?%)?\s+off\b/i,
  /\bends?\s+(?:tonight|today|at midnight|this weekend|sunday|soon)\b/i,
  /\blast\s+(?:call|chance)\b/i,
  /\blimited[- ]time\b/i,
  /\bwhile supplies last\b/i,
  /\b(?:flash|clearance|holiday|summer|winter|spring|fall|annual|semi-annual|end of season|storewide|site-?wide|big|huge|labor day|memorial day|black friday|cyber monday)\s+sale\b/i,
  /\bsale\s+(?:ends|starts|is (?:on|live|here)|extended)\b|\bon sale\b|\bsale!/i,
  /\bpromo\s?code\b|\bcoupon\s?code\b/i,
  /\bunsubscribe\b/i,
  /\bview (?:this (?:email|message) )?(?:in|on) (?:your )?(?:browser|web)\b/i,
  /\bfree (?:trial|shipping|gift)\b/i,
  /\boffer (?:expires|ends)\b/i,
  /\bexpires (?:tonight|today|soon|in \d+)\b/i,
  /\bshop now\b|\bbuy now\b|\border now\b|\bclaim (?:your|now)\b/i,
  /\bdeals? (?:end|expire)s?\b/i,
  /\bpre-?approved\b|\byou(?:'re| are) (?:eligible|approved) for\b/i,
  /\bearn (?:rewards|points|cash ?back)\b/i,
  /\bexclusive (?:offer|deal|access)\b/i,
];

/** Weaker marketing words that also occur in real conversations; two distinct hits are needed. */
export const PROMOTIONAL_HINTS: RegExp[] = [/\bcoupon\b/i, /\bpromo(?:tion|tional)?\b/i, /\bdiscount(?:s|ed)?\b/i, /\bnewsletter\b/i, /\bwebinar\b/i, /\bspecial offer\b/i, /\blast (?:day|hours?)\b/i, /\bdeals?\b/i, /\brewards?\b/i, /\bsale\b/i, /\bsubscribe\b/i, /\bblack friday\b/i, /\bgiveaway\b/i];

/** Gmail categories that never carry human commitments (labelIds or lowercased tags). */
export const MARKETING_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"]);
export const MARKETING_TAGS = new Set(["promotions", "updates", "social", "forums"]);

/** Mailbox roles (local part) that are vendor/transactional/notification senders, never a person. */
export const VENDOR_LOCAL_PARTS =
  /^(?:no-?reply|noreply|do-?not-?reply|donotreply|notifications?|notify|alerts?|servicing|billing|invoices?|statements?|support|info|hello|marketing|news|newsletters?|digest|mailer|updates?|offers?|promotions?|promo|deals?|customer-?care|customer-?service|payments?|receipts?|orders?|shipping|survey|rewards|security|verify|verification|password|reminders?|messages?-noreply|bounce)(?:[+._-][^@]*)?@/i;

/** Substrings anywhere in the local part that mark automated mail. */
export const VENDOR_LOCAL_HINTS = /(?:no-?reply|mailer|digest|notification|servicing|autoresponder|auto-?reply|bulk|campaign)/i;

/** Display names that mark relayed / social notifications. */
export const SOCIAL_DISPLAY_PATTERNS: RegExp[] = [/\bvia (?:linkedin|facebook|instagram|twitter|x\.com|nextdoor|yelp|alignable|meetup|eventbrite)\b/i, /\(via [^)]+\)/i];

/** Social notification subjects: "Steve: Liked your comment", "X commented on your post". */
export const SOCIAL_SUBJECT_PATTERNS: RegExp[] = [
  /^[^:]{2,80}:\s*(?:like[ds]?|comment(?:ed)?(?: on)?|react(?:ed|ion)|mention(?:ed)?|shar(?:e|ed)|tagged|posted|replied|follow(?:ed|s)?|endorse[ds]?|invit(?:ed|ation)|congratulat)/i,
  /\b(?:liked|likes|commented on|reacted to|shared|mentioned you in|tagged you in|replied to)\s+your\s+(?:post|photo|comment|update|video|reel|story|article|message|event)\b/i,
  /\bnew (?:connection request|follower|message request|notification)\b/i,
  /\byou have (?:\d+ )?new (?:notifications?|messages?|connections?|likes?|comments?)\b/i,
];

export function isPromotionalText(text: string | null | undefined): boolean {
  if (!text) return false;
  if (PROMOTIONAL_PATTERNS.some((re) => re.test(text))) return true;
  return PROMOTIONAL_HINTS.filter((re) => re.test(text)).length >= 2;
}

export function isVendorAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const local = address.split("@")[0] ?? "";
  return VENDOR_LOCAL_PARTS.test(address) || VENDOR_LOCAL_HINTS.test(local);
}

export function isSocialNotification(display: string | null | undefined, subject: string | null | undefined): boolean {
  return SOCIAL_DISPLAY_PATTERNS.some((re) => re.test(display ?? "")) || SOCIAL_SUBJECT_PATTERNS.some((re) => re.test(subject ?? ""));
}

export function hasMarketingLabel(row: { tags?: string[] | null; metadata?: Record<string, unknown> | null }): boolean {
  const labels = Array.isArray(row.metadata?.labelIds) ? (row.metadata!.labelIds as unknown[]) : [];
  if (labels.some((l) => typeof l === "string" && MARKETING_LABELS.has(l))) return true;
  return (row.tags ?? []).some((t) => MARKETING_TAGS.has(String(t).toLowerCase()));
}
