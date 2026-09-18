import { evidenceOf, type CandidateFinding, type ExtendedContext, type SourceRow } from "./types";
import { buildContactGraph, importantContacts, DAY, type Contact, type ContactGraph } from "./contacts-shared";
import { str } from "./portal-shared";

/**
 * Relationship Radar — important relationships going quiet, referral sources
 * declining, contacts resurfacing, explicit important dates. Promises are NOT
 * emitted here; they are handed to Follow-Through via the obligation source
 * adapter (lib/gomez/obligations/relationship-source.ts) so nothing is tracked twice.
 */

export const QUIET_MIN_DAYS = 21;
export const QUIET_GAP_MULTIPLIER = 2;
export const RESURFACE_SILENCE_DAYS = 90;
export const REFERRAL_RECENT_DAYS = 45;
export const REFERRAL_PRIOR_DAYS = 225;
export const REFERRAL_MIN_PRIOR = 3;
export const REFERRAL_SILENCE_DAYS = 45;
export const IMPORTANT_DATE_LOOKAHEAD_DAYS = 14;

/** Non-person acquisition channels that must never be treated as referral partners. */
const CHANNEL_SOURCES = /^(facebook|instagram|meta|google|website|web|form|paid|ads?|organic|seo|referral|direct|walk[- ]?in|phone|sms|email|typeform|unknown|manual|import|api|zapier|n8n|calendly|thumbtack|angi|yelp|nextdoor|linkedin)$/i;

function evidenceForContact(rows: SourceRow[], c: Contact, limit = 5) {
  const ids = new Set(c.interactions.slice(-limit).map((i) => i.rowId));
  return rows.filter((r) => ids.has(r.id)).map(evidenceOf);
}

function graphFor(rows: SourceRow[], ctx: ExtendedContext): ContactGraph {
  return buildContactGraph(rows, ctx.now, ctx.ownerEmail ?? null);
}

function includePersonal(ctx: ExtendedContext): boolean {
  return ctx.config?.include_personal !== false;
}

/** Important contacts whose silence is unusual for them. */
export function relationshipQuiet(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const graph = graphFor(rows, ctx);
  const out: CandidateFinding[] = [];
  const now = ctx.now.getTime();
  for (const { contact: c, reason } of importantContacts(graph, { memories: ctx.memories })) {
    if (!includePersonal(ctx) && !c.isClientUser && !c.ghlContactIds.length && !(c.domain && !/gmail|yahoo|hotmail|icloud|outlook/.test(c.domain))) continue;
    if (!c.lastAt || c.typicalGapDays == null) continue;
    const silentDays = (now - c.lastAt) / DAY;
    const threshold = Math.max(QUIET_MIN_DAYS, c.typicalGapDays * QUIET_GAP_MULTIPLIER);
    if (silentDays < threshold) continue;
    const key = c.emails[0] ?? c.name.toLowerCase();
    out.push({
      fingerprint: `relationship_quiet:${key}`,
      category: "relationship_quiet",
      title: `${c.name} has gone quiet (${Math.floor(silentDays)} days; usually every ${Math.round(c.typicalGapDays)})`,
      observed_facts: [
        `${c.interactions.length} interactions with ${c.name} in the last 180 days across ${[...new Set(c.interactions.map((i) => i.provider))].join(", ")}.`,
        `Typical gap between interactions: ${Math.round(c.typicalGapDays)} days; current silence: ${Math.floor(silentDays)} days (threshold ${Math.round(threshold)}).`,
        `Why this contact matters: ${reason}.`,
      ],
      metrics: { silent_days: Math.floor(silentDays), typical_gap_days: Math.round(c.typicalGapDays), threshold_days: Math.round(threshold), interactions_180d: c.interactions.length, formula: `silence ≥ max(${QUIET_MIN_DAYS}, ${QUIET_GAP_MULTIPLIER} × median gap)` },
      interpretation: "Interpretation: a relationship that was regular and then stopped is either fine (they are busy) or a slow loss of a client, partner or friend. A short check-in costs nothing and usually tells you which.",
      evidence: evidenceForContact(rows, c),
      range_start: new Date(now - 180 * DAY).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: c.interactions.length >= 8 ? 0.7 : 0.55,
      limitations: "Only synced channels count (email, calendar, CRM, Slack); phone calls and texts outside HighLevel are invisible. Identity is matched by email or display name.",
      severity: c.isClientUser || c.ghlContactIds.length ? "medium" : "low",
      proposed_mission: { title: `Check in with ${c.name}`, goal: `Draft a short, personal check-in to ${c.name} referencing the last interaction; the owner sends it.` },
    });
  }
  return out;
}

/** Referral partners (HighLevel contact `source` naming a person/company) whose referrals have stopped. */
export function referralSourceDeclining(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const now = ctx.now.getTime();
  const recentStart = now - REFERRAL_RECENT_DAYS * DAY;
  const priorStart = now - REFERRAL_PRIOR_DAYS * DAY;
  const contacts = rows.filter((r) => r.provider === "highlevel" && r.resource_type === "contact");
  const bySource = new Map<string, SourceRow[]>();
  for (const r of contacts) {
    const src = str(r.metadata.source)?.trim();
    if (!src || CHANNEL_SOURCES.test(src) || src.length < 3) continue;
    bySource.set(src, [...(bySource.get(src) ?? []), r]);
  }
  const contactIdSet = new Set(contacts.map((r) => r.external_id));
  const opps = rows.filter((r) => r.provider === "highlevel" && r.resource_type === "opportunity");
  const graph = graphFor(rows, ctx);
  const out: CandidateFinding[] = [];
  for (const [source, referred] of bySource) {
    const referredIds = new Set(referred.map((r) => r.external_id));
    const items = [
      ...referred.map((r) => ({ at: Date.parse(str(r.metadata.dateAdded) ?? r.source_timestamp ?? ""), row: r })),
      ...opps.filter((o) => referredIds.has(str(o.metadata.contactId) ?? "") && contactIdSet.has(str(o.metadata.contactId) ?? "")).map((o) => ({ at: Date.parse(str(o.metadata.createdAt) ?? o.source_timestamp ?? ""), row: o })),
    ].filter((x) => Number.isFinite(x.at));
    const prior = items.filter((x) => x.at >= priorStart && x.at < recentStart);
    const recent = items.filter((x) => x.at >= recentStart);
    if (prior.length < REFERRAL_MIN_PRIOR || recent.length > 0) continue;
    const lastReferral = Math.max(...prior.map((x) => x.at));
    const partner = graph.byName.get(source.toLowerCase()) ? graph.contacts.get(graph.byName.get(source.toLowerCase())!) : undefined;
    const lastComms = partner?.lastAt ?? null;
    const commsSilentDays = lastComms ? Math.floor((now - lastComms) / DAY) : null;
    const daysSinceReferral = Math.floor((now - lastReferral) / DAY);
    out.push({
      fingerprint: `referral_source_declining:${source.toLowerCase()}`,
      category: "referral_source_declining",
      title: `Referrals from ${source} have stopped (${prior.length} in the prior ${REFERRAL_PRIOR_DAYS - REFERRAL_RECENT_DAYS} days, none in ${daysSinceReferral})`,
      observed_facts: [
        `${prior.length} referred contacts/opportunities from "${source}" between ${new Date(priorStart).toISOString().slice(0, 10)} and ${new Date(recentStart).toISOString().slice(0, 10)}.`,
        `0 in the last ${REFERRAL_RECENT_DAYS} days; last referral ${daysSinceReferral} days ago.`,
        commsSilentDays != null ? `Last direct communication with ${source}: ${commsSilentDays} days ago.` : `No direct communication with ${source} found in synced channels.`,
      ],
      metrics: { prior_referrals: prior.length, recent_referrals: 0, days_since_last_referral: daysSinceReferral, comms_silent_days: commsSilentDays, formula: `referrals(prior ${REFERRAL_PRIOR_DAYS - REFERRAL_RECENT_DAYS}d) ≥ ${REFERRAL_MIN_PRIOR} AND referrals(last ${REFERRAL_RECENT_DAYS}d) = 0` },
      interpretation: "Interpretation: a referral source that used to send business and stopped is one of the cheapest relationships to repair and one of the most expensive to lose quietly.",
      evidence: prior.slice(-5).map((x) => evidenceOf(x.row)),
      range_start: new Date(priorStart).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: commsSilentDays != null && commsSilentDays >= REFERRAL_SILENCE_DAYS ? 0.75 : 0.6,
      limitations: "Referral attribution relies on the HighLevel contact `source` field being set to the partner's name.",
      severity: prior.length >= 5 ? "high" : "medium",
      proposed_mission: { title: `Reconnect with referral partner ${source}`, goal: `Summarise the referral history from ${source} and draft a thank-you / check-in for the owner to send. Do not contact anyone.` },
    });
  }
  return out;
}

/** A previously known contact who reappears after a long silence. */
export function contactResurfaced(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const graph = graphFor(rows, ctx);
  const now = ctx.now.getTime();
  const out: CandidateFinding[] = [];
  for (const c of graph.contacts.values()) {
    if (c.timeline.length < 3 || !c.lastAt) continue;
    if (now - c.lastAt > 7 * DAY) continue;
    const last = c.interactions.filter((i) => i.at === c.lastAt);
    if (!last.some((i) => i.kind === "inbound" || i.kind === "chat")) continue;
    const previous = c.timeline[c.timeline.length - 2]!;
    const gapDays = (c.lastAt - previous) / DAY;
    if (gapDays < RESURFACE_SILENCE_DAYS) continue;
    const key = c.emails[0] ?? c.name.toLowerCase();
    out.push({
      fingerprint: `contact_resurfaced:${key}:${new Date(c.lastAt).toISOString().slice(0, 10)}`,
      category: "contact_resurfaced",
      title: `${c.name} reached out after ${Math.floor(gapDays)} days of silence`,
      observed_facts: [`Inbound contact from ${c.name} on ${new Date(c.lastAt).toISOString().slice(0, 10)}; previous interaction ${new Date(previous).toISOString().slice(0, 10)}.`, `${c.interactions.length} interactions on record before that.`],
      metrics: { silence_days: Math.floor(gapDays), interactions_180d: c.interactions.length, formula: `inbound in last 7d AND gap to previous interaction ≥ ${RESURFACE_SILENCE_DAYS}d` },
      interpretation: "Interpretation: people who resurface after months usually want something specific — a referral, a project, or help. Worth answering deliberately rather than as inbox noise.",
      evidence: evidenceForContact(rows, c, 3),
      range_start: new Date(previous).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.6,
      limitations: "Based on synced email/Slack/CRM only.",
      severity: "low",
      proposed_mission: null,
    });
  }
  return out;
}

/** Explicit dates only: calendar events that look like birthdays/anniversaries within the lookahead. */
export function importantDate(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const now = ctx.now.getTime();
  const horizon = now + IMPORTANT_DATE_LOOKAHEAD_DAYS * DAY;
  const out: CandidateFinding[] = [];
  for (const r of rows) {
    if (r.provider !== "google" || r.resource_type !== "event" || !r.title) continue;
    if (!/\b(birthday|anniversary|b-?day)\b/i.test(r.title)) continue;
    const at = r.source_timestamp ? Date.parse(r.source_timestamp) : NaN;
    if (!Number.isFinite(at) || at < now || at > horizon) continue;
    const days = Math.ceil((at - now) / DAY);
    out.push({
      fingerprint: `important_date:${r.external_id}`,
      category: "important_date",
      title: `${r.title} in ${days} day${days === 1 ? "" : "s"}`,
      observed_facts: [`Calendar event "${r.title}" on ${r.source_timestamp!.slice(0, 10)}.`],
      metrics: { days_until: days, formula: `event date within ${IMPORTANT_DATE_LOOKAHEAD_DAYS} days` },
      interpretation: "Interpretation: an explicit personal date on your calendar; no inference beyond that.",
      evidence: [evidenceOf(r)],
      range_start: null,
      range_end: r.source_timestamp,
      confidence: 0.9,
      limitations: "Only events you named as birthday/anniversary; Gomez does not infer dates from other data.",
      severity: "info",
      proposed_mission: null,
    });
  }
  return out;
}

export const RELATIONSHIP_DETECTORS = { relationshipQuiet, referralSourceDeclining, contactResurfaced, importantDate };
