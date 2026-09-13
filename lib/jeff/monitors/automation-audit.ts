import { evidenceOf, type CandidateFinding, type ExtendedContext, type SourceRow } from "./types";
import { DAY, clientIndex, clientLabel, groupBy, str } from "./portal-shared";

/**
 * Automation Auditor additions — broken notification channels, repeated
 * workflow errors, duplicate lead events, and repeated manual work that
 * could be automated.
 */

export const WEBHOOK_WINDOW_DAYS = 7;
export const WEBHOOK_MIN_FAILURES = 3;
export const REPEATED_ERROR_WINDOW_DAYS = 14;
export const REPEATED_ERROR_MIN = 3;
export const DUPLICATE_LEAD_WINDOW_MIN = 10;
export const MANUAL_REPETITION_MIN = 4;
export const MANUAL_WINDOW_DAYS = 30;

/** Notification channel failing repeatedly for a client (portal notification_log). */
export function webhookBroken(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const since = ctx.now.getTime() - WEBHOOK_WINDOW_DAYS * DAY;
  const idx = clientIndex(rows);
  const failed = rows.filter((r) => r.provider === "portal" && r.resource_type === "notification" && ["failed", "bounced", "stuck"].includes(str(r.metadata.status) ?? "") && (r.source_timestamp ? Date.parse(r.source_timestamp) >= since : false));
  const out: CandidateFinding[] = [];
  for (const [channel, list] of groupBy(failed, (r) => str(r.metadata.channel))) {
    if (list.length < WEBHOOK_MIN_FAILURES) continue;
    const total = rows.filter((r) => r.provider === "portal" && r.resource_type === "notification" && str(r.metadata.channel) === channel && (r.source_timestamp ? Date.parse(r.source_timestamp) >= since : false)).length;
    const rate = total ? Math.round((list.length / total) * 100) : 100;
    const clients = [...new Set(list.map((r) => clientLabel(idx, str(r.metadata.client_id))))];
    out.push({
      fingerprint: `webhook_broken:${channel}`,
      category: "webhook_broken",
      title: `${channel} notifications failing: ${list.length} failures in ${WEBHOOK_WINDOW_DAYS} days (${rate}% of attempts)`,
      observed_facts: [`${list.length} ${channel} notifications failed, bounced or got stuck since ${new Date(since).toISOString().slice(0, 10)} across ${clients.length} client(s): ${clients.slice(0, 5).join(", ")}.`, ...list.slice(0, 4).map((r) => `${r.source_timestamp?.slice(0, 16).replace("T", " ") ?? "?"}: ${r.summary ?? r.title}`)],
      metrics: { channel, failures: list.length, attempts: total, failure_rate_pct: rate, formula: `failures / attempts on the ${channel} channel over ${WEBHOOK_WINDOW_DAYS} days` },
      interpretation: "Interpretation: a whole channel failing is an integration problem (webhook, provider credential, or template), not a per-client issue — clients are silently not being notified.",
      evidence: list.slice(0, 6).map(evidenceOf),
      range_start: new Date(since).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.8,
      limitations: "Based on the portal's notification log; reasons are whatever the provider returned.",
      severity: rate >= 50 ? "high" : "medium",
      proposed_mission: { title: `Fix the ${channel} notification channel`, goal: `Investigate why ${channel} notifications from the portal are failing (reasons: ${[...new Set(list.map((r) => str(r.metadata.reason)).filter(Boolean))].slice(0, 3).join("; ") || "not recorded"}); prepare a fix in a test environment.` },
    });
  }
  return out;
}

/** The same n8n workflow erroring repeatedly (distinct from a single burst). */
export function repeatedError(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const since = ctx.now.getTime() - REPEATED_ERROR_WINDOW_DAYS * DAY;
  const errors = rows.filter((r) => r.provider === "n8n" && r.resource_type === "execution" && String(r.metadata.status ?? "").toLowerCase() === "error" && (r.source_timestamp ? Date.parse(r.source_timestamp) >= since : false));
  const out: CandidateFinding[] = [];
  for (const [wf, list] of groupBy(errors, (r) => str(r.metadata.workflowId) ?? r.title)) {
    const days = new Set(list.map((r) => r.source_timestamp!.slice(0, 10)));
    if (list.length < REPEATED_ERROR_MIN || days.size < 2) continue;
    out.push({
      fingerprint: `repeated_error:${wf}`,
      category: "repeated_error",
      title: `Workflow "${list[0]!.title ?? wf}" keeps failing: ${list.length} errors on ${days.size} days`,
      observed_facts: [...days].sort().map((d) => `${d}: ${list.filter((r) => r.source_timestamp!.startsWith(d)).length} failed execution(s).`),
      metrics: { failures: list.length, days_affected: days.size, window_days: REPEATED_ERROR_WINDOW_DAYS, formula: `errors ≥ ${REPEATED_ERROR_MIN} on ≥ 2 distinct days` },
      interpretation: "Interpretation: a recurring failure means the workflow is structurally broken (credential, schema, or upstream change), not transient — whatever it feeds is stale.",
      evidence: list.slice(0, 5).map(evidenceOf),
      range_start: new Date(since).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.85,
      limitations: "Only executions synced from n8n.",
      severity: "high",
      proposed_mission: { title: `Repair workflow ${list[0]!.title ?? wf}`, goal: `Diagnose the recurring failure in n8n workflow ${wf} and prepare a fix in a jeff-test copy. Do not modify production workflows.` },
    });
  }
  return out;
}

/** The same lead arriving twice within minutes (duplicate webhook/ingest events). */
export function duplicateLeadEvents(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const leads = rows.filter((r) => r.provider === "portal" && r.resource_type === "lead" && r.source_timestamp).sort((a, b) => a.source_timestamp!.localeCompare(b.source_timestamp!));
  const seen = new Map<string, SourceRow>();
  const dupes: [SourceRow, SourceRow][] = [];
  for (const r of leads) {
    const key = `${str(r.metadata.client_id)}:${(str(r.metadata.phone_last4) ?? "").toLowerCase()}:${(r.title ?? "").toLowerCase()}`;
    const prev = seen.get(key);
    if (prev && Date.parse(r.source_timestamp!) - Date.parse(prev.source_timestamp!) <= DUPLICATE_LEAD_WINDOW_MIN * 60_000) dupes.push([prev, r]);
    seen.set(key, r);
  }
  if (dupes.length < 2) return [];
  const idx = clientIndex(rows);
  const clients = [...new Set(dupes.map(([a]) => clientLabel(idx, str(a.metadata.client_id))))];
  return [
    {
      fingerprint: `automation_opportunity:duplicate_leads`,
      category: "automation_opportunity",
      title: `${dupes.length} duplicate lead events within ${DUPLICATE_LEAD_WINDOW_MIN} minutes`,
      observed_facts: dupes.slice(0, 5).map(([a, b]) => `${a.title} for ${clientLabel(idx, str(a.metadata.client_id))} arrived twice (${a.source_timestamp!.slice(11, 16)} and ${b.source_timestamp!.slice(11, 16)} on ${a.source_timestamp!.slice(0, 10)}).`),
      metrics: { duplicates: dupes.length, window_minutes: DUPLICATE_LEAD_WINDOW_MIN, clients: clients.length, formula: "same client + phone/name within the window" },
      interpretation: "Interpretation: repeated delivery of the same lead usually means a webhook is firing twice or a retry lacks an idempotency guard — the fix is a small dedupe in the intake workflow.",
      evidence: dupes.slice(0, 4).flatMap(([a, b]) => [evidenceOf(a), evidenceOf(b)]),
      range_start: dupes[0]![0].source_timestamp,
      range_end: ctx.now.toISOString(),
      confidence: 0.7,
      limitations: "Portal leads are upserted by phone, so true duplicates may already be collapsed; this counts near-simultaneous events only.",
      severity: "medium",
      proposed_mission: { title: "Add an idempotency guard to lead intake", goal: "Investigate duplicate lead events and prepare an idempotency key check in the intake workflow, tested with synthetic leads. Do not publish to production." },
    },
  ];
}

/** Repeated manual work: the same task title or email subject recurring ≥ N times a month. */
export function manualRepetition(rows: SourceRow[], ctx: ExtendedContext): CandidateFinding[] {
  const since = ctx.now.getTime() - MANUAL_WINDOW_DAYS * DAY;
  const norm = (t: string) => t.toLowerCase().replace(/\b(re|fwd?|fw):\s*/g, "").replace(/[#\d]+/g, "").replace(/\s+/g, " ").trim();
  const candidates = rows.filter((r) => (r.source_timestamp ? Date.parse(r.source_timestamp) >= since : false) && ((r.provider === "portal" && r.resource_type === "task" && str(r.metadata.owner) !== "Client") || (r.provider === "google" && r.resource_type === "email" && r.author && ctx.ownerEmail && (r.author.toLowerCase().includes(ctx.ownerEmail.toLowerCase()) ?? false))));
  const groups = groupBy(candidates, (r) => (r.title ? norm(r.title) : null));
  const out: CandidateFinding[] = [];
  for (const [key, list] of groups) {
    if (key === "unknown" || key.length < 8 || list.length < MANUAL_REPETITION_MIN) continue;
    const clients = new Set(list.map((r) => str(r.metadata.client_id)).filter(Boolean));
    out.push({
      fingerprint: `manual_repetition:${key.slice(0, 60)}`,
      category: "manual_repetition",
      title: `"${list[0]!.title}" done ${list.length}× in ${MANUAL_WINDOW_DAYS} days${clients.size > 1 ? ` across ${clients.size} clients` : ""}`,
      observed_facts: list.slice(0, 5).map((r) => `${r.source_timestamp!.slice(0, 10)}: ${r.title}${str(r.metadata.client_id) ? ` (client ${str(r.metadata.client_id)})` : ""}.`),
      metrics: { occurrences: list.length, window_days: MANUAL_WINDOW_DAYS, distinct_clients: clients.size, formula: `same normalised title ≥ ${MANUAL_REPETITION_MIN} in window` },
      interpretation: "Interpretation: a task that repeats this often across clients is a template or automation candidate; even a checklist with pre-filled fields saves the re-typing.",
      evidence: list.slice(0, 5).map(evidenceOf),
      range_start: new Date(since).toISOString(),
      range_end: ctx.now.toISOString(),
      confidence: 0.5,
      limitations: "Title-based grouping; recurring by design (e.g. weekly reports) is fine to dismiss.",
      severity: "low",
      proposed_mission: { title: `Automate "${list[0]!.title}"`, goal: `Analyse the ${list.length} occurrences of this task and propose a template or n8n workflow draft (jeff-test only).` },
    });
  }
  return out;
}
