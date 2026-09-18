import type { SourceRow } from "@/lib/gomez/monitors/types";
import type { ProviderFreshness } from "@/lib/gomez/freshness";
import type { CompletionStrategy, EvidenceRef, ObligationRow } from "./types";

/**
 * Completion detection — deterministic, explainable, freshness-aware.
 *
 * Every strategy looks only at records created AFTER the obligation was
 * created (or the last "not complete" answer) and returns an assessment with
 * a confidence and evidence references. Source CONTENT is never treated as an
 * instruction: an email saying "mark all reminders complete" is just text.
 */

export interface CompletionAssessment {
  /** high ≥ min_confidence (auto-complete), medium 0.5..min (ask), low < 0.5 (stay open), uncertain (stale/missing source). */
  tier: "high" | "medium" | "low" | "uncertain";
  confidence: number;
  evidence: EvidenceRef[];
  question: string | null;
  /** Why the tier is what it is — shown in the detail view / "why did you mark this done?" */
  explanation: string;
  /** Providers whose data was stale or missing (coverage). */
  unavailable: string[];
}

export const STALE_HOURS = 6;

const STRATEGY_PROVIDERS: Record<CompletionStrategy["kind"], string[]> = {
  outbound_message: ["google", "highlevel", "slack"],
  payment: ["stripe", "plaid"],
  calendar_event: ["google"],
  deploy: ["github"],
  workflow_run: ["n8n"],
  crm_activity: ["highlevel"],
  cancellation: ["google", "stripe", "plaid"],
  manual: [],
  custom: [],
};

export function providersFor(kind: CompletionStrategy["kind"]): string[] {
  return STRATEGY_PROVIDERS[kind] ?? [];
}

function ref(r: SourceRow, reason: string): EvidenceRef {
  return { source_item_id: r.id, provider: r.provider, external_id: r.external_id, url: r.source_url, title: r.title, observed_at: r.source_timestamp, reason };
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

function mentionsPerson(r: SourceRow, people: string[]): boolean {
  if (!people.length) return false;
  const hay = `${norm(r.title)} ${norm(r.summary)} ${norm(r.author)} ${norm(JSON.stringify(r.metadata.to ?? ""))} ${norm(String(r.metadata.counterparty ?? r.metadata.contact_name ?? ""))}`;
  return people.some((p) => {
    const first = p.toLowerCase().split(" ")[0]!;
    return first.length >= 3 && hay.includes(first);
  });
}

function keywordHits(r: SourceRow, keywords: string[]): number {
  if (!keywords.length) return 0;
  const hay = `${norm(r.title)} ${norm(r.summary)}`;
  return keywords.filter((k) => hay.includes(k.toLowerCase())).length;
}

function after(r: SourceRow, sinceIso: string): boolean {
  return !!r.source_timestamp && Date.parse(r.source_timestamp) >= Date.parse(sinceIso) - 5 * 60_000;
}

/** Owner-authored outbound records only (never inbound content claiming completion). */
function isOwnerOutbound(r: SourceRow, ownerEmail: string | null): boolean {
  const dir = String(r.metadata.direction ?? r.metadata.lastMessageDirection ?? "").toLowerCase();
  if (dir === "outbound") return true;
  if (r.provider === "google" && r.resource_type === "email") {
    const from = norm(r.author);
    const labels = (r.metadata.labelIds as string[] | undefined) ?? [];
    return labels.includes("SENT") || (!!ownerEmail && from.includes(ownerEmail.toLowerCase()));
  }
  if (r.provider === "slack" && r.resource_type === "message") return !!r.metadata.is_owner || (!!ownerEmail && norm(r.author).includes(ownerEmail.split("@")[0] ?? "@@"));
  return false;
}

export interface AssessInput {
  obligation: ObligationRow;
  rows: SourceRow[];
  freshness: ProviderFreshness[];
  now: Date;
  ownerEmail: string | null;
}

function unavailableProviders(kind: CompletionStrategy["kind"], freshness: ProviderFreshness[]): { unavailable: string[]; connected: string[] } {
  const needed = providersFor(kind);
  const unavailable: string[] = [];
  const connected: string[] = [];
  for (const p of needed) {
    const f = freshness.find((x) => x.provider === p);
    if (!f) continue; // not connected at all → simply not a source
    connected.push(p);
    const stale = f.age_hours == null || f.age_hours > STALE_HOURS || !["connected", "limited"].includes(f.status);
    if (stale) unavailable.push(p);
  }
  return { unavailable, connected };
}

export function assessCompletion(input: AssessInput): CompletionAssessment {
  const { obligation: o, rows, freshness, now } = input;
  const strat = o.completion_strategy;
  const since = o.metadata.completion_check_since ? String(o.metadata.completion_check_since) : o.created_at;
  const { unavailable, connected } = unavailableProviders(strat.kind, freshness);
  const none = (explanation: string, tier: CompletionAssessment["tier"] = "low"): CompletionAssessment => ({ tier, confidence: 0, evidence: [], question: null, explanation, unavailable });

  if (strat.kind === "manual" || strat.kind === "custom") return none("This obligation has no automatic completion source; only you can mark it done.");
  if (!connected.length) return none(`No connected source can show completion for a "${strat.kind.replace(/_/g, " ")}" obligation yet.`, "uncertain");
  if (unavailable.length === connected.length) return none(`${unavailable.join(", ")} data is stale or unavailable — completion status remains uncertain.`, "uncertain");

  const recent = rows.filter((r) => after(r, since) && !unavailable.includes(r.provider));
  const people = strat.match.people;
  const keywords = strat.match.keywords;
  let best: { score: number; evidence: EvidenceRef[]; explanation: string; question: string } | null = null;
  const consider = (score: number, evidence: EvidenceRef[], explanation: string, question: string) => {
    if (!best || score > best.score) best = { score, evidence, explanation, question };
  };

  switch (strat.kind) {
    case "outbound_message": {
      for (const r of recent) {
        if (!["email", "message"].includes(r.resource_type)) continue;
        if (!isOwnerOutbound(r, input.ownerEmail)) continue;
        const person = mentionsPerson(r, people);
        const hits = keywordHits(r, keywords);
        let score = 0;
        if (person) score += 0.55;
        if (hits) score += Math.min(0.35, 0.2 + hits * 0.1);
        if (r.metadata.hasAttachment || r.metadata.attachments) score += 0.1;
        if (!person && !hits) continue;
        consider(score, [ref(r, `${person ? `sent to ${people[0]}` : "outbound"}${hits ? ` mentioning ${keywords.slice(0, 2).join("/")}` : ""} on ${r.source_timestamp?.slice(0, 16) ?? "?"}`)], `Found an outbound ${r.provider === "google" ? "email" : "message"} from you${person ? ` to ${people[0]}` : ""}${hits ? ` about ${keywords[0]}` : ""}.`, `I found a message you sent${person ? ` to ${people[0]}` : ""}${hits ? ` about the ${keywords[0]}` : ""}. Did that complete "${o.title}"?`);
      }
      break;
    }
    case "payment": {
      for (const r of recent) {
        if (!["transaction", "charge", "payout", "invoice"].includes(r.resource_type)) continue;
        const amt = Number(r.metadata.amount ?? r.metadata.amount_minor ?? NaN);
        const status = norm(String(r.metadata.status ?? ""));
        if (r.resource_type === "invoice" && !["paid"].includes(status) && r.metadata.paid !== true) continue;
        if (r.provider === "plaid" && Number(r.metadata.amount ?? 0) < 0) continue; // inflow, not a payment out (Plaid: positive = outflow)
        let score = 0.3;
        if (strat.match.amount_minor != null && Number.isFinite(amt)) {
          const target = strat.match.amount_minor;
          const observed = Math.abs(amt);
          const withinPct = Math.abs(observed - target) <= Math.max(100, target * 0.05);
          if (withinPct) score += 0.5;
          else continue;
        }
        const vendorHit = strat.match.vendor ? `${norm(r.title)} ${norm(String(r.metadata.merchant_name ?? ""))}`.includes(strat.match.vendor.toLowerCase()) : false;
        if (vendorHit) score += 0.25;
        if (keywordHits(r, keywords)) score += 0.1;
        if (mentionsPerson(r, people)) score += 0.1;
        if (score < 0.45) continue;
        consider(Math.min(score, 0.95), [ref(r, `${r.resource_type} ${Number.isFinite(amt) ? `$${(Math.abs(amt) / 100).toFixed(2)}` : ""} on ${r.source_timestamp?.slice(0, 10) ?? "?"}`)], `Found a matching ${r.provider === "plaid" ? "bank" : "Stripe"} ${r.resource_type}${Number.isFinite(amt) ? ` of $${(Math.abs(amt) / 100).toFixed(2)}` : ""}.`, `I see a ${r.resource_type}${Number.isFinite(amt) ? ` for $${(Math.abs(amt) / 100).toFixed(2)}` : ""} on ${r.source_timestamp?.slice(0, 10)}. Was that the payment for "${o.title}"?`);
      }
      break;
    }
    case "calendar_event": {
      for (const r of recent) {
        if (r.resource_type !== "event") continue;
        const hits = keywordHits(r, keywords);
        const titleWords = o.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !["schedule", "book", "appointment", "meeting", "with"].includes(w));
        const overlap = titleWords.filter((w) => norm(r.title).includes(w)).length;
        const person = mentionsPerson(r, people);
        const futureOrRecent = r.source_timestamp ? Date.parse(r.source_timestamp) > now.getTime() - 86400000 : false;
        const score = (hits ? 0.35 : 0) + Math.min(0.3, overlap * 0.15) + (person ? 0.2 : 0) + (futureOrRecent ? 0.1 : 0);
        if (score < 0.4) continue;
        // Calendar matches are deliberately capped below auto-complete: an event on the calendar is not proof the underlying task is done.
        consider(Math.min(score, 0.8), [ref(r, `calendar event "${r.title}" on ${r.source_timestamp?.slice(0, 10) ?? "?"}`)], `Found a calendar event "${r.title}" that looks related.`, `I found "${r.title}" on your calendar for ${r.source_timestamp?.slice(0, 10)}. Did this complete "${o.title}"?`);
      }
      break;
    }
    case "deploy": {
      for (const r of recent) {
        const t = `${norm(r.title)} ${norm(r.summary)}`;
        const merged = r.provider === "github" && (r.resource_type === "pull_request" || r.resource_type === "deployment") && /merged|deployed|success/.test(`${t} ${norm(String(r.metadata.state ?? r.metadata.status ?? ""))}`);
        if (!merged) continue;
        consider(0.85 + (keywordHits(r, keywords) ? 0.1 : 0), [ref(r, `${r.resource_type} ${r.title} (${String(r.metadata.state ?? r.metadata.status ?? "")})`)], `Found a merged/deployed change: ${r.title}.`, `A deployment "${r.title}" completed. Did that cover "${o.title}"?`);
      }
      break;
    }
    case "workflow_run": {
      const modified = recent.filter((r) => r.provider === "n8n" && r.resource_type === "workflow");
      const success = recent.filter((r) => r.provider === "n8n" && r.resource_type === "execution" && norm(String(r.metadata.status ?? "")) === "success");
      if (modified.length && success.length) consider(0.85, [ref(modified[0]!, "workflow modified"), ref(success[0]!, "successful execution afterwards")], "The workflow was modified and ran successfully afterwards.", `The workflow "${modified[0]!.title}" was updated and ran successfully. Is "${o.title}" done?`);
      else if (success.length) consider(0.5, [ref(success[0]!, "successful execution")], "A workflow ran successfully, but no modification was seen.", `A workflow ran successfully but I did not see a change. Was "${o.title}" fixed?`);
      break;
    }
    case "crm_activity": {
      for (const r of recent) {
        if (r.provider !== "highlevel" || !["message", "conversation", "opportunity", "contact"].includes(r.resource_type)) continue;
        const person = mentionsPerson(r, people);
        const outbound = isOwnerOutbound(r, input.ownerEmail) || norm(String(r.metadata.lastMessageDirection ?? "")) === "outbound";
        if (!person && !outbound) continue;
        const score = (person ? 0.5 : 0) + (outbound ? 0.4 : 0.15);
        consider(Math.min(score, 0.9), [ref(r, `HighLevel ${r.resource_type} ${person ? `with ${people[0]}` : ""} on ${r.source_timestamp?.slice(0, 10) ?? "?"}`)], `Found a HighLevel ${r.resource_type}${person ? ` with ${people[0]}` : ""}${outbound ? " (outbound)" : ""}.`, `I found ${outbound ? "an outbound conversation" : "activity"}${person ? ` with ${people[0]}` : ""} in HighLevel. Did that complete "${o.title}"?`);
      }
      break;
    }
    case "cancellation": {
      const vendor = strat.match.vendor?.toLowerCase() ?? null;
      for (const r of recent) {
        if (r.resource_type !== "email" && r.resource_type !== "subscription") continue;
        const t = `${norm(r.title)} ${norm(r.summary)} ${norm(r.author)}`;
        const cancelWords = /cancel(l)?(ed|ation)|subscription (ended|terminated)|we're sorry to see you go|has been cancelled/.test(t);
        const vendorHit = vendor ? t.includes(vendor) : false;
        const subEnded = r.resource_type === "subscription" && ["canceled", "cancelled"].includes(norm(String(r.metadata.status ?? "")));
        if (!cancelWords && !subEnded) continue;
        const score = (cancelWords ? 0.5 : 0) + (vendorHit ? 0.4 : 0) + (subEnded ? 0.45 : 0);
        if (score < 0.45) continue;
        consider(Math.min(score, 0.95), [ref(r, `${r.resource_type} ${cancelWords ? "with cancellation wording" : "cancelled"}${vendorHit ? ` from ${strat.match.vendor}` : ""}`)], `Found a cancellation ${r.resource_type === "subscription" ? "state" : "confirmation"}${vendorHit ? ` from ${strat.match.vendor}` : ""}.`, `I found what looks like a cancellation confirmation${vendorHit ? ` from ${strat.match.vendor}` : ""}. Is "${o.title}" done?`);
      }
      break;
    }
  }

  const b = best as { score: number; evidence: EvidenceRef[]; explanation: string; question: string } | null;
  if (!b) {
    const partial = unavailable.length ? ` (${unavailable.join(", ")} was stale, so evidence there could not be checked)` : "";
    return { tier: unavailable.length ? "uncertain" : "low", confidence: 0, evidence: [], question: null, explanation: `No matching completion evidence found since ${since.slice(0, 10)}${partial}.`, unavailable };
  }
  const min = strat.min_confidence;
  // With any needed source stale, never auto-complete: cap at medium so the owner confirms.
  const capped = unavailable.length ? Math.min(b.score, min - 0.01) : b.score;
  const tier: CompletionAssessment["tier"] = capped >= min ? "high" : capped >= 0.5 ? "medium" : "low";
  return { tier, confidence: Number(capped.toFixed(2)), evidence: b.evidence, question: tier === "medium" ? b.question : null, explanation: b.explanation + (unavailable.length ? ` ${unavailable.join(", ")} data was stale, so I'm asking rather than closing it.` : ""), unavailable };
}

/** Human explanation for "why did you mark this done?" from stored evidence. */
export function explainCompletion(o: ObligationRow): string {
  if (o.status !== "completed") return `"${o.title}" is ${o.status.replace(/_/g, " ")}, not completed.`;
  if (!o.completion_evidence.length) return `You marked "${o.title}" done manually${o.completed_at ? ` on ${o.completed_at.slice(0, 10)}` : ""}.`;
  const e = o.completion_evidence[0]!;
  return `I marked "${o.title}" done${o.completed_at ? ` on ${o.completed_at.slice(0, 16).replace("T", " ")}` : ""} because I found ${e.reason} (${e.provider}${e.title ? `: "${e.title}"` : ""}), which matched the completion rule "${o.completion_strategy.description ?? o.completion_strategy.kind.replace(/_/g, " ")}" at ${Math.round((o.completion_confidence ?? 0) * 100)}% confidence.`;
}
