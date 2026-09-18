import { evidenceOf, type CandidateFinding, type ExtendedContext, type SourceRow } from "./types";
import { DAY, clientIdOf, clientIndex, groupBy, isActiveClient, str } from "./portal-shared";

/**
 * Client Health Analyst additions — communication cadence drop, missed /
 * cancelled appointments, and keyword-based negative signals in client
 * messages (low confidence; interpretation clearly separated).
 */

export const ENGAGEMENT_RECENT_DAYS = 14;
export const ENGAGEMENT_PRIOR_DAYS = 42;
export const ENGAGEMENT_DROP_PCT = 60;
export const ENGAGEMENT_MIN_PRIOR = 6;
export const MISSED_WINDOW_DAYS = 30;
export const MISSED_MIN = 2;
export const NEGATIVE_WINDOW_DAYS = 21;

const NEGATIVE = /\b(unhappy|disappointed|frustrat(ed|ing)|not (happy|satisfied)|unacceptable|cancel(l)?ing|cancel our|refund|complain(t|ing)?|escalat(e|ion)|dissatisfied|terrible|worst|no longer|reconsider|switch(ing)? to|too expensive|overcharg|not working|still broken|no response|haven'?t heard|ignored|delay(ed)?|missed deadline|behind schedule)\b/i;

function clientRows(rows: SourceRow[], clientId: string): SourceRow[] {
  return rows.filter((r) => clientIdOf(r) === clientId);
}

function isComms(r: SourceRow): boolean {
  return (r.provider === "google" && r.resource_type === "email") || (r.provider === "highlevel" && r.resource_type === "message") || (r.provider === "slack" && r.resource_type === "message") || (r.provider === "portal" && r.resource_type === "portal_event");
}

/** Communication cadence for a client dropped sharply vs its prior baseline. */
export function clientEngagementDrop(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const now = ctx.now.getTime();
  const recentStart = now - ENGAGEMENT_RECENT_DAYS * DAY;
  const priorStart = recentStart - ENGAGEMENT_PRIOR_DAYS * DAY;
  const idx = clientIndex(rows);
  const out: CandidateFinding[] = [];
  for (const [clientId, info] of idx) {
    if (!isActiveClient(idx, clientId)) continue;
    const comms = clientRows(rows, clientId).filter(isComms).filter((r) => !!r.source_timestamp);
    const prior = comms.filter((r) => {
      const t = Date.parse(r.source_timestamp!);
      return t >= priorStart && t < recentStart;
    });
    const recent = comms.filter((r) => Date.parse(r.source_timestamp!) >= recentStart);
    if (prior.length < ENGAGEMENT_MIN_PRIOR) continue;
    const priorRate = prior.length / ENGAGEMENT_PRIOR_DAYS;
    const recentRate = recent.length / ENGAGEMENT_RECENT_DAYS;
    const dropPct = priorRate ? Math.round((1 - recentRate / priorRate) * 100) : 0;
    if (dropPct < ENGAGEMENT_DROP_PCT) continue;
    out.push({
      fingerprint: `client_engagement_drop:${clientId}`,
      category: "client_engagement_drop",
      title: `${info.name}: communication down ${dropPct}% (${recent.length} in ${ENGAGEMENT_RECENT_DAYS}d vs ${prior.length} in the prior ${ENGAGEMENT_PRIOR_DAYS}d)`,
      observed_facts: [`${prior.length} messages/events between ${new Date(priorStart).toISOString().slice(0, 10)} and ${new Date(recentStart).toISOString().slice(0, 10)} (≈${(priorRate * 7).toFixed(1)}/week).`, `${recent.length} in the last ${ENGAGEMENT_RECENT_DAYS} days (≈${(recentRate * 7).toFixed(1)}/week).`, `Portal status: ${info.status ?? "unknown"}.`],
      metrics: { prior_count: prior.length, recent_count: recent.length, prior_per_week: Math.round(priorRate * 70) / 10, recent_per_week: Math.round(recentRate * 70) / 10, drop_pct: dropPct, formula: "1 − (recent rate / prior rate)" },
      interpretation: "Interpretation: a sharp drop in two-way communication is the earliest churn signal in a services business — often before anyone says they're unhappy. It can also just be a quiet phase of delivery; the portal stage tells you which.",
      evidence: [...recent.slice(0, 2), ...prior.slice(-3)].map(evidenceOf),
      range_start: new Date(priorStart).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: prior.length >= 12 ? 0.7 : 0.55,
      limitations: "Counts only communications Gomez can attribute to the client (portal, attributed email/CRM/Slack).",
      severity: dropPct >= 80 ? "medium" : "low",
      proposed_mission: { title: `Check in on ${info.name}`, goal: `Summarise recent delivery progress and draft a proactive status update for ${info.name}; the owner reviews and sends.` },
    });
  }
  return out;
}

/** Cancelled / no-show appointments per client in the window. */
export function clientMissedMeeting(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const since = ctx.now.getTime() - MISSED_WINDOW_DAYS * DAY;
  const idx = clientIndex(rows);
  const missed = rows.filter((r) => {
    if (!(r.provider === "portal" && r.resource_type === "appointment") && !(r.provider === "highlevel" && r.resource_type === "event")) return false;
    const st = (str(r.metadata.status) ?? "").toLowerCase();
    if (!/cancel|no[_ -]?show|noshow|missed/.test(st)) return false;
    return !!r.source_timestamp && Date.parse(r.source_timestamp) >= since;
  });
  const out: CandidateFinding[] = [];
  for (const [clientId, list] of groupBy(missed, clientIdOf)) {
    if (clientId === "unknown" || list.length < MISSED_MIN || !isActiveClient(idx, clientId)) continue;
    const name = idx.get(clientId)?.name ?? `Client ${clientId}`;
    out.push({
      fingerprint: `client_missed_meeting:${clientId}`,
      category: "client_missed_meeting",
      title: `${name}: ${list.length} cancelled or missed appointments in ${MISSED_WINDOW_DAYS} days`,
      observed_facts: list.slice(0, 6).map((r) => `${r.source_timestamp!.slice(0, 16).replace("T", " ")}: ${str(r.metadata.status)}.`),
      metrics: { missed: list.length, window_days: MISSED_WINDOW_DAYS, formula: "appointments with status cancelled/no-show/missed in window" },
      interpretation: "Interpretation: repeated cancellations are a soft signal of disengagement or scheduling friction; worth asking directly rather than rebooking a fourth time.",
      evidence: list.slice(0, 5).map(evidenceOf),
      range_start: new Date(since).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.65,
      limitations: "Depends on appointment status being updated in HighLevel/portal.",
      severity: list.length >= 3 ? "medium" : "low",
      proposed_mission: null,
    });
  }
  return out;
}

/** Keyword-based negative sentiment in client-attributed inbound messages. Quotes ≤ 120 chars; low confidence by design. */
export function clientNegativeSignal(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const since = ctx.now.getTime() - NEGATIVE_WINDOW_DAYS * DAY;
  const idx = clientIndex(rows);
  const hits = rows.filter((r) => {
    if (!isComms(r) || r.resource_type === "portal_event") return false;
    if (!r.source_timestamp || Date.parse(r.source_timestamp) < since) return false;
    if (r.provider === "highlevel" && r.metadata.lastMessageDirection === "outbound") return false;
    if (ctx.ownerEmail && r.author && r.author.toLowerCase().includes(ctx.ownerEmail.toLowerCase())) return false;
    return NEGATIVE.test(`${r.title ?? ""} ${r.summary ?? ""}`);
  });
  const out: CandidateFinding[] = [];
  for (const [clientId, list] of groupBy(hits, clientIdOf)) {
    if (clientId === "unknown" || !isActiveClient(idx, clientId)) continue;
    const name = idx.get(clientId)?.name ?? `Client ${clientId}`;
    const quotes = list.slice(0, 3).map((r) => {
      const text = `${r.title ?? ""} — ${r.summary ?? ""}`;
      const m = text.match(NEGATIVE);
      const i = m ? Math.max(0, text.toLowerCase().indexOf(m[0].toLowerCase()) - 50) : 0;
      return `"${text.slice(i, i + 120).trim()}"`;
    });
    out.push({
      fingerprint: `client_negative_signal:${clientId}:${list[0]!.source_timestamp!.slice(0, 10)}`,
      category: "client_negative_signal",
      title: `${name}: ${list.length} message${list.length === 1 ? "" : "s"} with negative language`,
      observed_facts: [`Matched phrases in inbound messages attributed to ${name} since ${new Date(since).toISOString().slice(0, 10)}:`, ...quotes],
      metrics: { messages: list.length, window_days: NEGATIVE_WINDOW_DAYS, formula: "inbound client messages matching a negative-sentiment keyword list" },
      interpretation: "Interpretation (AI/keyword, not a judgment of the relationship): the wording suggests friction. Read the originals — keyword matches include quotes, jokes and forwarded content.",
      evidence: list.slice(0, 5).map(evidenceOf),
      range_start: new Date(since).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.35,
      limitations: "Keyword heuristic on subjects/snippets only; no tone model. False positives are expected.",
      severity: list.length >= 3 ? "medium" : "low",
      proposed_mission: null,
    });
  }
  return out;
}
