import { compilePattern, resolveMonitorId, type OperatingRule, type RuleCondition } from "./schema";
import type { CandidateFinding, SourceRow } from "@/lib/jeff/monitors/types";

/**
 * Deterministic rule matcher. Pure functions only — no I/O, no LLM.
 * A "subject" is either a synced source row (pre-monitor filtering) or a
 * candidate finding (post-detection adjustment).
 */

export type AuthorType = "human" | "bot" | "system";

export interface MatchSubject {
  kind: "item" | "finding";
  monitor?: string | null; // monitor evaluating the item / category of the finding
  source_type?: string | null;
  provider?: string | null;
  sender?: string | null; // bare email address (lowercase) when known
  author_type?: AuthorType | null;
  subject?: string | null; // title
  tags?: string[];
  metadata?: Record<string, unknown>;
  amount_minor?: number | null;
  confidence?: number | null;
  severity?: "info" | "low" | "medium" | "high" | null;
  category?: string | null;
}

const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3 } as const;

export function bareAddress(author: string | null | undefined): string | null {
  if (!author) return null;
  const m = author.match(/<([^>]+)>/);
  const addr = (m ? m[1]! : author).trim().toLowerCase();
  return /@/.test(addr) ? addr : null;
}

export function domainOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : null;
}

function senderMatches(patterns: string[], sender: string | null): boolean {
  if (!sender) return false;
  const dom = domainOf(sender) ?? "";
  return patterns.some((p) => {
    const q = p.trim().toLowerCase();
    if (q.startsWith("*@")) return dom === q.slice(2) || dom.endsWith(`.${q.slice(2)}`);
    if (!q.includes("@")) return dom === q || dom.endsWith(`.${q}`);
    return sender === q;
  });
}

function domainMatches(domains: string[], sender: string | null): boolean {
  const dom = domainOf(sender);
  if (!dom) return false;
  return domains.some((d) => dom === d || dom.endsWith(`.${d}`));
}

/** True when every present condition in `c` holds for `s`. Empty conditions match everything. */
export function conditionsMatch(c: RuleCondition, s: MatchSubject): boolean {
  if (c.monitor) {
    const want = resolveMonitorId(c.monitor);
    const have = resolveMonitorId(s.monitor ?? undefined);
    if (want && have !== want) return false;
  }
  if (c.source_type && c.source_type !== "any" && (s.source_type ?? "") !== c.source_type) return false;
  if (c.provider && (s.provider ?? "") !== c.provider) return false;
  if (c.sender_matches?.length && !senderMatches(c.sender_matches, s.sender ?? null)) return false;
  if (c.sender_domain?.length && !domainMatches(c.sender_domain, s.sender ?? null)) return false;
  if (c.author_type?.length && !(s.author_type && c.author_type.includes(s.author_type))) return false;
  if (c.subject_patterns?.length) {
    const subj = s.subject ?? "";
    if (!c.subject_patterns.some((p) => compilePattern(p)(subj))) return false;
  }
  if (c.tags_any?.length) {
    const tags = (s.tags ?? []).map((t) => t.toLowerCase());
    if (!c.tags_any.some((t) => tags.includes(t))) return false;
  }
  if (c.metadata_equals) {
    for (const [k, v] of Object.entries(c.metadata_equals)) {
      if (String(s.metadata?.[k] ?? "") !== String(v)) return false;
    }
  }
  if (c.amount_min != null && !(typeof s.amount_minor === "number" && s.amount_minor >= c.amount_min)) return false;
  if (c.amount_max != null && !(typeof s.amount_minor === "number" && s.amount_minor <= c.amount_max)) return false;
  if (c.confidence_max != null && !(typeof s.confidence === "number" && s.confidence <= c.confidence_max)) return false;
  if (c.category && (s.category ?? "") !== c.category) return false;
  if (c.severity_min && !(s.severity && SEVERITY_RANK[s.severity] >= SEVERITY_RANK[c.severity_min])) return false;
  return true;
}

export function ruleTargetsMonitor(rule: Pick<OperatingRule, "target_monitor">, monitor: string | null | undefined): boolean {
  if (!rule.target_monitor) return true;
  return resolveMonitorId(rule.target_monitor) === resolveMonitorId(monitor ?? undefined);
}

export function matchesRule(rule: Pick<OperatingRule, "target_monitor" | "conditions" | "enabled">, s: MatchSubject): boolean {
  if (!rule.enabled) return false;
  if (!ruleTargetsMonitor(rule, s.monitor)) return false;
  return conditionsMatch(rule.conditions, s);
}

/**
 * Specificity score used for precedence. Narrow identifiers (exact sender,
 * subject pattern, metadata key, amount bound) weigh more than broad classes
 * (source type, author type), so an exception like "GitHub deploy failures"
 * outranks "all GitHub bot mail".
 */
const WEIGHT: Record<string, number> = {
  source_type: 0.5,
  provider: 0.5,
  sender_domain: 1,
  author_type: 0.7,
  subject_patterns: 1.5,
  tags_any: 1,
  amount_min: 1.2,
  amount_max: 1.2,
  confidence_max: 0.8,
  category: 1,
  severity_min: 0.8,
  monitor: 1,
};

export function specificity(rule: Pick<OperatingRule, "target_monitor" | "conditions">): number {
  const c = rule.conditions;
  let n = rule.target_monitor ? 1 : 0;
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined || v === null) continue;
    if (k === "source_type" && v === "any") continue;
    if (k === "sender_matches" && Array.isArray(v)) {
      // Exact addresses are more specific than wildcard/domain matches.
      n += 1 + v.reduce((acc, s) => acc + (String(s).includes("@") && !String(s).startsWith("*@") ? 0.3 : 0.1), 0);
      continue;
    }
    if (k === "metadata_equals" && v && typeof v === "object") {
      n += 1.3 * Object.keys(v as object).length;
      continue;
    }
    n += WEIGHT[k] ?? 1;
  }
  return Math.round(n * 100) / 100;
}

/** Bot/system detection for synced records. Shared by the commitment classifier and matcher. */
const BOT_SENDER_PATTERNS = [
  /^notifications@github\.com$/,
  /^noreply@github\.com$/,
  /@noreply\./,
  /^no-?reply/,
  /^do-?not-?reply/,
  /^mailer-daemon/,
  /^postmaster@/,
  /^bounce/,
  /^calendar-notification@google\.com$/,
  /^drive-shares-(dm-)?noreply@google\.com$/,
  /@notifications\./,
  /@(?:mail\.)?notifications?\.[a-z0-9.-]+$/,
  /^(?:receipts|invoice\+statements|notifications|support)@stripe\.com$/,
  /@vercel\.com$/,
  /@(?:.*\.)?slack(?:-mail)?\.com$/,
  /^bot@/,
  /\+bot@/,
  /@(?:.*\.)?linear\.app$/,
  /@(?:.*\.)?atlassian\.net$/,
  /@(?:.*\.)?intercom(?:mail)?\.com$/,
  /^hello@|^team@|^newsletter@|^news@|^marketing@|^updates@|^info@/,
];
const BOT_DISPLAY_PATTERNS = [/\bbot\b/i, /\bnotifications?\b/i, /\bno-?reply\b/i, /\(GitHub\)/i, /via GitHub/i];
const SYSTEM_LABELS = new Set(["CATEGORY_UPDATES", "CATEGORY_PROMOTIONS", "CATEGORY_FORUMS", "CATEGORY_SOCIAL"]);
const SYSTEM_SUBJECTS = [
  /^\[[^\]]+\/[^\]]+\]/, // [owner/repo] ...
  /^re: \[[^\]]+\/[^\]]+\]/i,
  /\bPR #\d+/i,
  /\bpull request\b/i,
  /\bmerged\b.*\bpull\b/i,
  /^\[.*\]\s*(?:build|deploy(?:ment)?|pipeline|workflow run)\b/i,
  /\b(?:build|deploy(?:ment)?) (?:failed|succeeded|completed|started)\b/i,
  /\bworkflow run\b/i,
  /\bnew (?:issue|release|comment) on\b/i,
  /^\[?(?:vercel|github|gitlab|netlify|jira|linear)\]?[:\s]/i,
  /\byour (?:receipt|invoice|statement|order) (?:from|for|#)/i,
  /\bunsubscribe\b/i,
];

export function classifyAuthor(row: Pick<SourceRow, "author" | "title" | "tags" | "metadata" | "provider" | "resource_type">): AuthorType {
  const sender = bareAddress(row.author);
  const display = row.author ?? "";
  const labels = Array.isArray(row.metadata?.labelIds) ? (row.metadata.labelIds as string[]) : [];
  const meta = row.metadata ?? {};
  if (meta.author_type === "bot" || meta.author_type === "system") return meta.author_type as AuthorType;
  if (meta.is_bot === true) return "bot";
  if (row.provider === "slack") {
    if (meta.bot_id || meta.subtype === "bot_message") return "bot";
    if (typeof meta.subtype === "string" && /join|leave|topic|purpose|archive|pinned/.test(meta.subtype)) return "system";
  }
  if (labels.some((l) => SYSTEM_LABELS.has(l))) return "system";
  if (typeof meta.list_unsubscribe === "string" || meta.list_unsubscribe === true) return "system";
  if (sender && BOT_SENDER_PATTERNS.some((re) => re.test(sender))) return "bot";
  if (BOT_DISPLAY_PATTERNS.some((re) => re.test(display))) return "bot";
  if (row.resource_type === "email" && SYSTEM_SUBJECTS.some((re) => re.test(row.title ?? ""))) return "system";
  if (row.resource_type === "email" && !sender) return "system";
  return "human";
}

export function subjectFromRow(row: SourceRow, monitor: string | null): MatchSubject {
  const m = row.metadata ?? {};
  const amount = typeof m.amount === "number" ? m.amount : typeof m.amount_due === "number" ? m.amount_due : typeof m.monetaryValue === "number" ? Math.round(m.monetaryValue * 100) : null;
  return {
    kind: "item",
    monitor,
    source_type: row.resource_type,
    provider: row.provider,
    sender: bareAddress(row.author),
    author_type: classifyAuthor(row),
    subject: row.title,
    tags: row.tags ?? [],
    metadata: m,
    amount_minor: amount,
  };
}

export function subjectFromCandidate(c: CandidateFinding, rows?: Map<string, SourceRow>): MatchSubject {
  const first = c.evidence[0] ? rows?.get(c.evidence[0].source_item_id) : undefined;
  const amount = typeof c.metrics.amount_minor === "number" ? c.metrics.amount_minor : typeof c.metrics.total_minor === "number" ? c.metrics.total_minor : first ? subjectFromRow(first, c.category).amount_minor : null;
  return {
    kind: "finding",
    monitor: c.category,
    category: c.category,
    source_type: first?.resource_type ?? null,
    provider: first?.provider ?? c.evidence[0]?.provider ?? null,
    sender: first ? bareAddress(first.author) : null,
    author_type: first ? classifyAuthor(first) : null,
    subject: first?.title ?? c.title,
    tags: first?.tags ?? [],
    metadata: first?.metadata ?? {},
    amount_minor: amount,
    confidence: c.confidence,
    severity: c.severity,
  };
}
