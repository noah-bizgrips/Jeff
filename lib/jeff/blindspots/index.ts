import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { ownerIdentity } from "@/lib/env";
import { errorMessage, log } from "@/lib/security/log";
import { redact } from "@/lib/security/redact";
import { loadRows } from "@/lib/jeff/monitors";
import { listRules, recordRuleEvents } from "@/lib/jeff/rules/store";
import { getSettings } from "@/lib/jeff/settings-store";
import { localTime, type OwnerSettings } from "@/lib/jeff/settings";
import { listAttention } from "@/lib/jeff/attention/store";
import { loadFreshness } from "@/lib/jeff/freshness-store";
import { loadClientMap } from "@/lib/jeff/clients/map";
import { latestSnapshot, listGoalMetrics, listGoals } from "@/lib/jeff/goals/store";
import { listCommitments } from "@/lib/jeff/commitments/store";
import { runAlertsForOwner } from "@/lib/jeff/alerts/store";
import { pushConfigured, sendPush } from "@/lib/jeff/push/send";
import { applyDailyCap, detectBlindSpots, toFinding } from "./detect";
import { applyReview, reviewBlindSpots, type EvidenceBundleEntry } from "./interpret";
import { blindSpotPushPayload, shouldPushBlindSpotBatch } from "./push";
import type { BlindSpotCandidate, BlindSpotContext } from "./types";

export { detectBlindSpots, DETECTORS } from "./detect";
export type { BlindSpotCandidate, BlindSpotContext } from "./types";

/** Detection runs once per owner-local day, on the first cron after this hour. */
export const RUN_AFTER_LOCAL_HOUR = 7;
const ACTIVE = ["open", "new", "reviewing", "accepted", "acknowledged", "action_planned", "action_in_progress", "monitoring"];

export interface BlindSpotRunSummary {
  ran: boolean;
  reason?: string;
  candidates: number;
  excludedByRules: number;
  created: number;
  updated: number;
  resolved: number;
  deferredByCap: number;
  usedModel: boolean;
  pushed: boolean;
  errors: { detector: string; message: string }[];
}

export async function loadBlindSpotContext(ownerId: string, now = new Date()): Promise<BlindSpotContext> {
  const admin = createAdminClient();
  const [sourceItems, findings, alerts, goals, clients, freshness, attention, commitments] = await Promise.all([
    loadRows(ownerId),
    admin.from("findings").select("id, category, title, status, created_at").eq("owner_id", ownerId).eq("is_sample", false).limit(1000),
    admin.from("alerts").select("id, ref_id, category, status").eq("owner_id", ownerId).limit(500),
    listGoals(ownerId, ["active"]).catch(() => []),
    loadClientMap(ownerId).catch(() => []),
    loadFreshness(ownerId, now).catch(() => []),
    listAttention(ownerId, 30),
    listCommitments(ownerId, { status: ["open", "overdue"], limit: 200 }).catch(() => []),
  ]);
  const goalsLite = await Promise.all(
    goals.map(async (g) => {
      const [snap, metrics] = await Promise.all([latestSnapshot(g.id).catch(() => null), listGoalMetrics(g.id).catch(() => [])]);
      return { id: g.id, name: g.name, status: g.status, trajectory: snap?.trajectory ?? null, metric_keys: metrics.map((m) => m.key), end_date: g.end_date };
    }),
  );
  return {
    now,
    ownerEmail: ownerIdentity().email,
    sourceItems,
    findings: (findings.data ?? []) as BlindSpotContext["findings"],
    alerts: (alerts.data ?? []) as BlindSpotContext["alerts"],
    goals: goalsLite,
    clients: clients.map((c) => ({ portal_client_id: c.portal_client_id, name: c.name, slug: c.slug, status: c.status, ghl_contact_id: c.ghl_contact_id, email_domains: c.email_domains, stripe_customer_ids: c.stripe_customer_ids, highlevel_contact_ids: c.highlevel_contact_ids, meta_page_ids: c.meta_page_ids })),
    connections: freshness.map((f) => ({ id: f.connection_id, provider: f.provider, display_name: f.display_name, status: f.status, last_success_at: f.last_success_at, last_error: f.last_error, age_hours: f.age_hours })),
    attention,
    commitments: commitments.map((c) => ({ id: c.id, action_text: c.action_text, context_text: c.context_text, due_at: c.due_at, direction: c.direction, counterparty: c.counterparty, source_item_id: c.source_item_id, source_url: c.source_url, status: c.status })),
  };
}

/** True when today's run (owner-local) has not happened yet and it is after the run hour. */
export function isDueToday(settings: Pick<OwnerSettings, "timezone">, lastRunAt: string | null, now: Date): boolean {
  const local = localTime(now, settings.timezone);
  if (local.hour < RUN_AFTER_LOCAL_HOUR) return false;
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt);
  if (Number.isNaN(last.getTime())) return true;
  return localTime(last, settings.timezone).date !== local.date;
}

function evidenceBundle(ctx: BlindSpotContext, candidates: BlindSpotCandidate[]): EvidenceBundleEntry[] {
  const ids = new Set<string>();
  for (const c of candidates) for (const e of c.evidence) if (e.source_item_id) ids.add(e.source_item_id);
  // A small sample of recent cross-source rows the model may connect (ids + labels only, no bodies).
  const recent = [...ctx.sourceItems].sort((a, b) => (b.source_timestamp ?? "").localeCompare(a.source_timestamp ?? "")).slice(0, 80);
  for (const r of recent) ids.add(r.id);
  const byId = new Map(ctx.sourceItems.map((r) => [r.id, r]));
  const out: EvidenceBundleEntry[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    out.push({ id, label: `${r.provider}/${r.resource_type} · ${(r.title ?? "").slice(0, 80)} · ${(r.source_timestamp ?? "").slice(0, 10)}` });
  }
  return out.slice(0, 200);
}

export type BlindSpotProgress = "preparing" | "reviewing_goals" | "business_signals" | "commitments" | "obligations" | "financial" | "patterns" | "novel" | "ranking" | "complete";

export async function runBlindSpotsForOwner(
  ownerId: string,
  now = new Date(),
  opts: { force?: boolean; skipAi?: boolean; onProgress?: (step: BlindSpotProgress) => Promise<void> | void } = {},
): Promise<BlindSpotRunSummary> {
  const progress = async (step: BlindSpotProgress) => {
    try {
      await opts.onProgress?.(step);
    } catch {
      /* progress reporting is best-effort */
    }
  };
  const admin = createAdminClient();
  const settings = await getSettings(ownerId);
  const { data: state } = await admin.from("owner_settings").select("blind_spots_last_run_at").eq("owner_id", ownerId).maybeSingle();
  const lastRunAt = (state?.blind_spots_last_run_at as string | null) ?? null;
  const summary: BlindSpotRunSummary = { ran: false, candidates: 0, excludedByRules: 0, created: 0, updated: 0, resolved: 0, deferredByCap: 0, usedModel: false, pushed: false, errors: [] };
  if (!opts.force && !isDueToday(settings, lastRunAt, now)) return { ...summary, reason: "not_due" };

  await progress("preparing");
  const ctx = await loadBlindSpotContext(ownerId, now);
  await progress("reviewing_goals");
  const rules = await listRules(ownerId).catch(() => []);
  await progress("business_signals");
  const detected = detectBlindSpots(ctx, rules);
  await progress("patterns");
  summary.errors = detected.errors;
  summary.excludedByRules = detected.excluded;

  let candidates = detected.candidates;
  if (!opts.skipAi) {
    await progress("novel");
    const bundle = evidenceBundle(ctx, candidates);
    const outcome = await reviewBlindSpots(ownerId, candidates, bundle);
    summary.usedModel = outcome.usedModel;
    candidates = applyReview(candidates, outcome.review, bundle, now);
  }
  summary.candidates = candidates.length;

  // Persist as findings (category blind_spot) with the daily cap on NEW ones.
  const { data: existingRows } = await admin.from("findings").select("id, fingerprint, status, created_at").eq("owner_id", ownerId).eq("category", "blind_spot");
  const existing = new Map<string, { id: string; status: string; created_at: string }>();
  for (const r of existingRows ?? []) if (r.fingerprint) existing.set(r.fingerprint, { id: r.id, status: r.status, created_at: r.created_at });
  const today = localTime(now, settings.timezone).date;
  const createdToday = [...existing.values()].filter((r) => localTime(new Date(r.created_at), settings.timezone).date === today).length;
  await progress("ranking");
  const { pass, deferred } = applyDailyCap(candidates, new Set(existing.keys()), createdToday, settings.blind_spot_max_per_day);
  summary.deferredByCap = deferred.length;

  const nowIso = now.toISOString();
  const seen = new Set<string>();
  for (const c of pass) {
    const f = toFinding(c);
    seen.add(f.fingerprint);
    const prev = existing.get(f.fingerprint);
    const base = {
      category: f.category,
      title: f.title.slice(0, 300),
      observed_facts: redact(f.observed_facts),
      metrics: redact(f.metrics),
      interpretation: f.interpretation,
      evidence: f.evidence,
      range_start: f.range_start,
      range_end: f.range_end,
      confidence: Math.max(0, Math.min(1, f.confidence)),
      limitations: f.limitations,
      severity: f.severity,
      proposed_mission: null,
      last_seen_at: nowIso,
      is_sample: false,
    };
    if (prev) {
      const status = prev.status === "resolved" ? "open" : prev.status;
      const { error } = await admin.from("findings").update({ ...base, status }).eq("id", prev.id);
      if (error) log.warn("blindspot_update_failed", { fingerprint: f.fingerprint, message: error.message });
      else summary.updated++;
    } else {
      const { error } = await admin.from("findings").insert({ ...base, owner_id: ownerId, fingerprint: f.fingerprint, status: "open" });
      if (error) log.warn("blindspot_insert_failed", { fingerprint: f.fingerprint, message: error.message });
      else summary.created++;
    }
  }
  // Auto-resolve blind spots whose condition cleared (deferred ones are still "seen" — they simply wait).
  for (const c of deferred) seen.add(c.fingerprint);
  for (const [fp, prev] of existing) {
    if (seen.has(fp) || !ACTIVE.includes(prev.status)) continue;
    const { error } = await admin.from("findings").update({ status: "resolved", last_seen_at: nowIso }).eq("id", prev.id);
    if (!error) summary.resolved++;
  }
  await recordRuleEvents(ownerId, detected.events);
  await admin.from("owner_settings").upsert({ owner_id: ownerId, blind_spots_last_run_at: nowIso }, { onConflict: "owner_id" });
  summary.ran = true;
  await progress("complete");

  // Alerts for the new/updated findings, then a single daily push batch.
  try {
    await runAlertsForOwner(ownerId, now);
  } catch (err) {
    log.warn("blindspot_alerts_failed", { message: errorMessage(err) });
  }
  try {
    summary.pushed = await pushBlindSpotBatch(ownerId, settings, now);
  } catch (err) {
    log.warn("blindspot_push_failed", { message: errorMessage(err) });
  }
  await audit({ event: "blind_spots_run", ownerId, actor: "system", metadata: { candidates: summary.candidates, created: summary.created, updated: summary.updated, resolved: summary.resolved, deferredByCap: summary.deferredByCap, usedModel: summary.usedModel, pushed: summary.pushed } });
  log.info("blind_spots_run", { ...summary, errors: summary.errors.length });
  return summary;
}

/** One push per owner-local day covering every open, not-yet-pushed blind-spot alert. */
export async function pushBlindSpotBatch(ownerId: string, settings: OwnerSettings, now = new Date()): Promise<boolean> {
  if (!pushConfigured()) return false;
  const admin = createAdminClient();
  const { data } = await admin.from("alerts").select("id, title, status, pushed_at, evidence").eq("owner_id", ownerId).eq("category", "blind_spot").order("last_seen", { ascending: false }).limit(50);
  const rows = (data ?? []) as { id: string; title: string; status: string; pushed_at: string | null; evidence: unknown[] }[];
  const lastBatchAt = rows.map((r) => r.pushed_at).filter((v): v is string => !!v).sort().at(-1) ?? null;
  const pending = rows.filter((r) => r.status === "open" && !r.pushed_at);
  // A grouped alert ("N blind spot findings") carries the individual titles in its evidence.
  const titles = pending.flatMap((r) => {
    const items = Array.isArray(r.evidence) ? (r.evidence as { title?: string }[]).map((e) => e.title).filter((t): t is string => !!t) : [];
    return items.length ? items : [r.title];
  });
  if (!shouldPushBlindSpotBatch({ pendingTitles: titles, lastBatchAt, settings, now })) return false;
  const payload = blindSpotPushPayload(titles);
  const res = await sendPush(ownerId, payload);
  await admin
    .from("alerts")
    .update({ pushed_at: now.toISOString(), pushed_importance: "briefing" })
    .in(
      "id",
      pending.map((r) => r.id),
    );
  await audit({ event: "push_sent", ownerId, actor: "system", metadata: { kind: "blind_spots", count: titles.length, delivered: res.delivered } });
  return !!res.delivered;
}

/** Open blind spots for Ask Jeff / UI (bounded, no PII). */
export async function listBlindSpots(ownerId: string, limit = 10) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("findings")
    .select("id, title, observed_facts, metrics, interpretation, evidence, confidence, limitations, severity, status, created_at")
    .eq("owner_id", ownerId)
    .eq("category", "blind_spot")
    .in("status", ACTIVE)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((f) => ({
    id: f.id,
    title: f.title,
    subtype: (f.metrics as Record<string, unknown>)?.subtype ?? null,
    why_missing: (f.metrics as Record<string, unknown>)?.attention ?? null,
    observed_facts: f.observed_facts,
    metrics: f.metrics,
    interpretation: f.interpretation,
    evidence: (f.evidence as unknown[]).slice(0, 4),
    confidence: f.confidence,
    limitations: f.limitations,
    severity: f.severity,
    status: f.status,
    created_at: f.created_at,
  }));
}
