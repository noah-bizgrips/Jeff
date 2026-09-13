import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { errorMessage, log } from "@/lib/security/log";
import { redact, redactString } from "@/lib/security/redact";
import { ownerIdentity } from "@/lib/env";
import { getSettings } from "@/lib/jeff/settings-store";
import { listMemories, listRules } from "@/lib/jeff/rules/store";
import { listAlerts } from "@/lib/jeff/alerts/store";
import { listCommitments } from "@/lib/jeff/commitments/store";
import { listObligations } from "@/lib/jeff/obligations/store";
import { bucketOf } from "@/lib/jeff/obligations/types";
import { loadFreshness } from "@/lib/jeff/freshness-store";
import { loadRows } from "@/lib/jeff/monitors";
import { plaidFlows, stripeFlows, inWindow, num } from "@/lib/jeff/monitors/finance-shared";
import { latestSnapshot, listGoalEvents, listGoalMetrics, listGoals } from "@/lib/jeff/goals/store";
import { formatMetricValue, formatTarget } from "@/lib/jeff/goals/metrics";
import { TRAJECTORY_LABEL } from "@/lib/jeff/goals/schema";
import { label as trajectoryWord } from "@/lib/jeff/alerts/engine";
import { composeBriefing, type ComposeDeps } from "./compose";
import { deliver } from "./deliver";
import { dueBriefings, periodFor, periodInstants, type BriefingKind } from "./schedule";
import { shouldPushBriefing } from "@/lib/jeff/push/decide";

const BRIEF_PUSH_TITLE: Record<BriefingKind, string> = { daily: "☀️ Your Daily Brief", weekly: "📊 Weekly review", monthly: "🗓️ Monthly review" };
import { maxItemsFromMemories, type BriefingBundle, type BundleFinance } from "./bundle";
import type { BriefingSummary } from "./schema";

export interface BriefingRow {
  id: string;
  kind: BriefingKind;
  period_start: string;
  period_end: string;
  timezone: string;
  title: string;
  sections: BriefingSummary;
  model: string | null;
  status: "generated" | "read" | "saved";
  read_at: string | null;
  saved: boolean;
  delivery: unknown[];
  created_at: string;
}

const COLUMNS = "id, kind, period_start, period_end, timezone, title, sections, model, status, read_at, saved, delivery, created_at";
const DAY = 86_400_000;

/** Assembles the evidence bundle for a period. All reads are bounded. */
export async function buildBundle(ownerId: string, kind: BriefingKind, period: { period_start: string; period_end: string }, now = new Date()): Promise<BriefingBundle> {
  const settings = await getSettings(ownerId);
  const { start, end } = periodInstants(period.period_start, period.period_end, settings.timezone);
  const [alerts, goals, commitmentsAll, rows, freshness, memories, rules, obligations] = await Promise.all([
    listAlerts(ownerId, { status: ["open", "acknowledged"], limit: 100 }).catch(() => []),
    listGoals(ownerId, ["active"]).catch(() => []),
    listCommitments(ownerId, { status: ["open", "overdue"], limit: 50 }).catch(() => []),
    loadRows(ownerId).catch(() => []),
    loadFreshness(ownerId, now).catch(() => []),
    listMemories(ownerId, { activeOnly: true }).catch(() => []),
    listRules(ownerId).catch(() => []),
    listObligations(ownerId, { live: true, limit: 200 }).catch(() => []),
  ]);
  // Commitments already tracked as obligations are surfaced once, through FOLLOW-THROUGH.
  const trackedCommitmentIds = new Set(obligations.map((o) => o.commitment_id).filter(Boolean));
  const commitments = commitmentsAll.filter((c) => !trackedCommitmentIds.has(c.id));
  const admin = createAdminClient();
  const periodStartIso = new Date(kind === "daily" ? now.getTime() - 7 * DAY : start.getTime()).toISOString();
  const { data: findingRows } = await admin
    .from("findings")
    .select("id, category, title, severity, status, created_at, proposed_mission, updated_at")
    .eq("owner_id", ownerId)
    .eq("is_sample", false)
    .or(`status.in.(open,new,reviewing,accepted,monitoring),updated_at.gte.${periodStartIso}`)
    .order("created_at", { ascending: false })
    .limit(100);
  const { data: missionRows } = await admin.from("missions").select("id, code, title, status, completed_at").eq("owner_id", ownerId).eq("is_sample", false).order("updated_at", { ascending: false }).limit(50);
  const { data: outcomeRows } = await admin.from("mission_outcomes").select("mission_id, metric_label, metric_key, direction, delta_pct, limitations, measured_at, missions(title)").eq("owner_id", ownerId).not("measured_at", "is", null).order("measured_at", { ascending: false }).limit(10);

  const goalBundles: BriefingBundle["goals"] = [];
  for (const g of goals) {
    const snap = await latestSnapshot(g.id).catch(() => null);
    const metrics = await listGoalMetrics(g.id).catch(() => []);
    const events = await listGoalEvents(g.id, 10).catch(() => []);
    const change = events.find((e) => e.kind === "trajectory_changed" && Date.parse(e.created_at) >= (kind === "daily" ? now.getTime() - DAY : start.getTime()));
    const primary = metrics.find((m) => m.is_primary) ?? metrics[0];
    const p = primary && snap ? snap.metrics?.[primary.key] : null;
    goalBundles.push({
      id: g.id,
      name: g.name,
      trajectory: snap?.trajectory ?? "unknown",
      trajectory_label: TRAJECTORY_LABEL[snap?.trajectory ?? "unknown"],
      primary: p ? `${formatMetricValue(p)} of ${formatTarget(p)}` : null,
      constraint: snap?.constraint_key ?? null,
      days_remaining: g.end_date ? Math.max(0, Math.round((Date.parse(g.end_date) - now.getTime()) / DAY)) : null,
      change: change ? `${trajectoryWord(String(change.payload.from ?? "unknown"))} → ${trajectoryWord(String(change.payload.to ?? ""))}` : null,
    });
  }

  // Today's events (local day) — from synced calendar items.
  const dayStart = periodInstants(period.period_end, period.period_end, settings.timezone).start.getTime();
  const dayEnd = dayStart + DAY;
  const eventsToday = rows
    .filter((r) => r.resource_type === "event" && r.source_timestamp && inWindow(r, dayStart, dayEnd))
    .sort((a, b) => Date.parse(a.source_timestamp!) - Date.parse(b.source_timestamp!))
    .slice(0, 12)
    .map((r) => ({ title: r.title ?? "Event", start: r.source_timestamp, location: typeof r.metadata.location === "string" ? (r.metadata.location as string) : null, attendees: Array.isArray(r.metadata.attendees) ? (r.metadata.attendees as unknown[]).length : null }));

  // Finance for the period vs the prior period of equal length.
  const len = Math.max(DAY, end.getTime() - start.getTime());
  const cur = rows.filter((r) => inWindow(r, start.getTime(), end.getTime() + 1));
  const prev = rows.filter((r) => inWindow(r, start.getTime() - len, start.getTime()));
  const hasFinance = rows.some((r) => r.provider === "stripe" || r.provider === "plaid");
  let finance: BundleFinance | null = null;
  if (hasFinance) {
    const sCur = stripeFlows(cur);
    const sPrev = stripeFlows(prev);
    const pCur = plaidFlows(cur);
    const pPrev = plaidFlows(prev);
    const hasPlaid = rows.some((r) => r.provider === "plaid");
    const hasStripe = rows.some((r) => r.provider === "stripe");
    const openInvoices = rows.filter((r) => r.provider === "stripe" && r.resource_type === "invoice" && ["open", "past_due"].includes(String(r.metadata.status ?? "")));
    const failedCharges = cur.filter((r) => r.provider === "stripe" && r.resource_type === "charge" && String(r.metadata.status ?? "") === "failed");
    const subs = rows.filter((r) => r.provider === "stripe" && r.resource_type === "subscription" && ["active", "trialing"].includes(String(r.metadata.status ?? "")));
    let mrr = 0;
    for (const s of subs) for (const it of (Array.isArray(s.metadata.items) ? (s.metadata.items as { unit_amount?: number; quantity?: number; interval?: string }[]) : [])) mrr += (it.interval === "year" ? num(it.unit_amount) / 12 : num(it.unit_amount)) * (it.quantity ?? 1);
    finance = {
      stripe_inflow: hasStripe ? sCur.inflow : null,
      stripe_prev_inflow: hasStripe ? sPrev.inflow : null,
      plaid_inflow: hasPlaid ? pCur.inflow : null,
      plaid_outflow: hasPlaid ? pCur.outflow : null,
      plaid_prev_inflow: hasPlaid ? pPrev.inflow : null,
      plaid_prev_outflow: hasPlaid ? pPrev.outflow : null,
      open_invoices_count: openInvoices.length,
      open_invoices_minor: openInvoices.reduce((s, r) => s + num(r.metadata.amount_due), 0),
      failed_charges_count: failedCharges.length,
      mrr_minor: subs.length ? Math.round(mrr) : null,
    };
  }

  const memoryTexts = memories.filter((m) => ["communication_style", "preference", "priority", "dislike", "working_style"].includes(m.category)).map((m) => m.content);
  const briefingRules = rules.filter((r) => r.enabled && !r.pending_confirmation && (r.target_system === "briefings" || r.rule_type === "briefing_pref")).map((r) => r.name);

  return {
    kind,
    period_start: period.period_start,
    period_end: period.period_end,
    timezone: settings.timezone,
    owner_first_name: firstName(ownerIdentity().email),
    now,
    alerts: alerts.map((a) => ({ id: a.id, kind: a.kind, category: a.category, importance: a.importance, title: a.title, summary: a.summary, ref_id: a.ref_id, occurrences: a.occurrences, status: a.status })),
    goals: goalBundles,
    events_today: eventsToday,
    commitments: commitments.map((c) => ({ id: c.id, action_text: c.action_text, context_text: c.context_text, due_at: c.due_at, direction: c.direction, status: c.status })),
    obligations: obligations.map((o) => {
      const amount = o.completion_strategy?.match?.amount_minor;
      return {
        id: o.id,
        title: o.title,
        bucket: bucketOf(o, now) as "overdue" | "waiting_on_me" | "waiting_on_other" | "possibly_complete" | "snoozed",
        due_at: o.due_at,
        priority: o.priority,
        tracking_mode: o.tracking_mode,
        waiting_on: o.waiting_on ?? o.counterparty,
        related_goal_id: o.related_goal_id,
        scope: o.scope,
        amount_label: typeof amount === "number" ? `$${(amount / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : null,
        briefing_only: Boolean(o.cadence?.briefing_only),
        question: o.completion_question,
      };
    }),
    findings: (findingRows ?? []).map((f) => ({ id: f.id, category: f.category, title: f.title, severity: f.severity, status: f.status, created_at: f.created_at, proposed_mission: (f.proposed_mission as { title: string; goal: string } | null) ?? null })),
    finance,
    missions: (missionRows ?? []).map((m) => ({ id: m.id, code: m.code, title: m.title, status: m.status, completed_at: m.completed_at })),
    outcomes: (outcomeRows ?? []).map((o) => ({ mission_id: o.mission_id, mission_title: (o.missions as unknown as { title?: string } | null)?.title ?? "Mission", metric_label: o.metric_label ?? o.metric_key, direction: o.direction, delta_pct: o.delta_pct == null ? null : Number(o.delta_pct), limitations: o.limitations })),
    freshness: freshness.map((f) => f.text),
    memories: memoryTexts,
    briefing_rules: briefingRules,
    learning_suggestions: rules.filter((r) => r.pending_confirmation && r.name.startsWith("Learned:")).map((r) => r.source_quote ?? r.description ?? r.name),
    max_items: maxItemsFromMemories(memoryTexts, settings.brief_max_items),
  };
}

function firstName(email: string): string {
  const local = email.split("@")[0] ?? "";
  return local ? local.charAt(0).toUpperCase() + local.slice(1).replace(/[._].*$/, "") : "";
}

export interface GenerateOptions {
  force?: boolean;
  deps?: ComposeDeps;
}

/** Idempotent per (owner, kind, period_start): returns the existing row unless `force`. */
export async function generateBriefing(ownerId: string, kind: BriefingKind, now = new Date(), opts: GenerateOptions = {}): Promise<{ briefing: BriefingRow; created: boolean; usedModel: boolean }> {
  const settings = await getSettings(ownerId);
  const period = periodFor(kind, now, settings.timezone);
  const admin = createAdminClient();
  const { data: existing } = await admin.from("briefings").select(COLUMNS).eq("owner_id", ownerId).eq("kind", kind).eq("period_start", period.period_start).maybeSingle();
  if (existing && !opts.force) return { briefing: existing as unknown as BriefingRow, created: false, usedModel: false };

  const bundle = await buildBundle(ownerId, kind, period, now);
  const composed = await composeBriefing(ownerId, bundle, opts.deps);
  const receipts = await deliver({ id: "pending", kind: "briefing", title: composed.summary.title, summary: composed.summary.greeting }, ["in_app"], now);
  const payload = {
    owner_id: ownerId,
    kind,
    period_start: period.period_start,
    period_end: period.period_end,
    timezone: settings.timezone,
    title: redactString(composed.summary.title).slice(0, 160),
    sections: redact(composed.summary),
    model: composed.model,
    input_tokens: composed.usage?.input_tokens ?? 0,
    output_tokens: composed.usage?.output_tokens ?? 0,
    estimated_usd: composed.usage?.usd ?? 0,
    delivery: receipts,
  };
  const { data, error } = existing
    ? await admin.from("briefings").update({ ...payload, status: "generated", read_at: null }).eq("id", existing.id).select(COLUMNS).single()
    : await admin.from("briefings").insert(payload).select(COLUMNS).single();
  if (error || !data) throw new Error(`briefing_write_failed:${error?.code ?? ""}:${redactString(error?.message ?? "").slice(0, 120)}`);
  await audit({ event: "briefing_generated", ownerId, actor: "system", targetId: data.id, metadata: { kind, period_start: period.period_start, usedModel: composed.usedModel, notes: composed.notes, top: composed.summary.top_attention.length } });
  // Push to the owner's devices (toggle in Settings). Only for a newly generated brief, never a forced re-run.
  if (!existing && shouldPushBriefing(settings)) {
    const first = composed.summary.top_attention[0];
    const pushReceipts = await deliver(
      { id: data.id, kind: "briefing", ownerId, title: BRIEF_PUSH_TITLE[kind], summary: first?.title ?? composed.summary.title, url: "/briefings" },
      ["push"],
      now,
    );
    await admin.from("briefings").update({ delivery: [...receipts, ...pushReceipts] }).eq("id", data.id);
  }
  return { briefing: data as unknown as BriefingRow, created: !existing, usedModel: composed.usedModel };
}

/** Cron entry point: generates every briefing that is due and not yet generated. */
export async function generateDueBriefings(ownerId: string, now = new Date()): Promise<{ generated: BriefingKind[]; skipped: BriefingKind[] }> {
  const settings = await getSettings(ownerId);
  const due = dueBriefings(now, settings);
  const generated: BriefingKind[] = [];
  const skipped: BriefingKind[] = [];
  const admin = createAdminClient();
  for (const d of due) {
    const { data } = await admin.from("briefings").select("id").eq("owner_id", ownerId).eq("kind", d.kind).eq("period_start", d.period_start).maybeSingle();
    if (data) {
      skipped.push(d.kind);
      continue;
    }
    try {
      await generateBriefing(ownerId, d.kind, now);
      generated.push(d.kind);
    } catch (err) {
      log.warn("briefing_generate_failed", { kind: d.kind, message: errorMessage(err) });
    }
  }
  return { generated, skipped };
}

export async function listBriefings(ownerId: string, limit = 30): Promise<BriefingRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("briefings").select(COLUMNS).eq("owner_id", ownerId).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`briefings_list_failed:${error.code ?? ""}`);
  return (data ?? []) as unknown as BriefingRow[];
}

export async function getBriefing(ownerId: string, id: string): Promise<BriefingRow | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("briefings").select(COLUMNS).eq("owner_id", ownerId).eq("id", id).maybeSingle();
  return (data as unknown as BriefingRow) ?? null;
}

export async function latestBriefing(ownerId: string, kind: BriefingKind): Promise<BriefingRow | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("briefings").select(COLUMNS).eq("owner_id", ownerId).eq("kind", kind).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return (data as unknown as BriefingRow) ?? null;
}

export async function updateBriefing(ownerId: string, id: string, action: "read" | "save" | "unsave", now = new Date()): Promise<BriefingRow | null> {
  const admin = createAdminClient();
  const patch = action === "read" ? { status: "read", read_at: now.toISOString() } : action === "save" ? { status: "saved", saved: true } : { saved: false, status: "read" };
  const { data, error } = await admin.from("briefings").update(patch).eq("owner_id", ownerId).eq("id", id).select(COLUMNS).maybeSingle();
  if (error) throw new Error(`briefing_update_failed:${error.code ?? ""}`);
  return (data as unknown as BriefingRow) ?? null;
}
