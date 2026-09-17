import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { redactString } from "@/lib/security/redact";
import { GoalInterpretationSchema, GoalMetricSchema, type Ambiguity, type GoalInterpretation, type GoalMetric, type MetricResult, type Trajectory } from "./schema";
import type { TrajectoryResult } from "./trajectory";

/**
 * Goal persistence. All writes go through the service role so events and
 * validation always run; reads for the UI can also go through RLS.
 */

export interface GoalRow {
  id: string;
  owner_id: string;
  name: string;
  prompt_text: string;
  description: string | null;
  scope: "business" | "personal" | "financial";
  status: "draft" | "active" | "paused" | "achieved" | "missed" | "archived";
  start_date: string | null;
  end_date: string | null;
  interpretation: GoalInterpretation;
  assumptions: string[];
  ambiguities: Ambiguity[];
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalMetricRow {
  id: string;
  goal_id: string;
  key: string;
  name: string;
  kind: GoalMetric["kind"];
  target_value: number | null;
  comparator: GoalMetric["comparator"];
  target_upper: number | null;
  unit: string | null;
  formula: string | null;
  source_mappings: GoalMetric["inputs"];
  time_range: GoalMetric["time_range"];
  is_primary: boolean;
  is_constraint: boolean;
  constraint_strength: "soft" | "hard";
  current_value: number | null;
  current_computed_at: string | null;
  limitations: string | null;
  sort: number;
}

export interface GoalSnapshotRow {
  id: string;
  goal_id: string;
  taken_at: string;
  metrics: Record<string, MetricResult>;
  elapsed_pct: number | null;
  completion_pct: number | null;
  observed_pace: number | null;
  required_pace: number | null;
  forecast: TrajectoryResult["forecast"] | null;
  trajectory: Trajectory;
  constraint_key: string | null;
  data_freshness: Record<string, unknown>;
}

export interface GoalRecommendationRow {
  id: string;
  goal_id: string;
  fingerprint: string;
  title: string;
  why: string;
  evidence: unknown[];
  mechanism: string | null;
  downside: string | null;
  jeff_can_prepare: string | null;
  requires_approval: boolean;
  status: "proposed" | "accepted" | "dismissed" | "prepared";
  mission_id: string | null;
  created_at: string;
}

export interface GoalEventRow {
  id: number;
  goal_id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}

const GOAL_COLUMNS = "id, owner_id, name, prompt_text, description, scope, status, start_date, end_date, interpretation, assumptions, ambiguities, approved_at, created_at, updated_at";
const METRIC_COLUMNS = "id, goal_id, key, name, kind, target_value, comparator, target_upper, unit, formula, source_mappings, time_range, is_primary, is_constraint, constraint_strength, current_value, current_computed_at, limitations, sort";

function fail(code: string, error: { code?: string; message?: string } | null): never {
  throw new Error(`${code}:${error?.code ?? ""}:${redactString(error?.message ?? "").slice(0, 200)}`);
}

/** Converts a metric definition (schema) into a goal_metrics row payload. */
export function metricToRow(ownerId: string, goalId: string, m: GoalMetric, sort: number) {
  return {
    owner_id: ownerId,
    goal_id: goalId,
    key: m.key,
    name: m.name,
    kind: m.kind,
    target_value: m.target,
    comparator: m.comparator,
    target_upper: m.target_upper,
    unit: m.unit,
    formula: m.formula,
    source_mappings: m.inputs,
    time_range: m.time_range,
    is_primary: m.is_primary,
    is_constraint: m.is_constraint,
    constraint_strength: m.constraint_strength,
    limitations: m.limitations.join(" "),
    sort,
  };
}

/** Rebuilds the schema-level metric definition from a row (+ the interpretation's duration spec). */
export function rowToMetric(row: GoalMetricRow, interpretation: GoalInterpretation): GoalMetric {
  const fromInterp = interpretation.metrics.find((m) => m.key === row.key);
  return GoalMetricSchema.parse({
    key: row.key,
    name: row.name,
    kind: row.kind,
    target: row.target_value == null ? null : Number(row.target_value),
    comparator: row.comparator,
    target_upper: row.target_upper == null ? null : Number(row.target_upper),
    unit: row.unit ?? "",
    formula: row.formula ?? "",
    inputs: row.source_mappings ?? {},
    duration: fromInterp?.duration,
    time_range: row.time_range ?? { kind: "goal_window" },
    is_primary: row.is_primary,
    is_constraint: row.is_constraint,
    constraint_strength: row.constraint_strength,
    limitations: fromInterp?.limitations ?? (row.limitations ? [row.limitations] : []),
  });
}

export async function logGoalEvent(ownerId: string, goalId: string, kind: string, payload: Record<string, unknown> = {}) {
  const admin = createAdminClient();
  await admin.from("goal_events").insert({ owner_id: ownerId, goal_id: goalId, kind, payload });
}

export async function createDraftGoal(ownerId: string, promptText: string, interpretation: GoalInterpretation, meta: { usedModel: boolean; notes: string[] }): Promise<GoalRow> {
  const admin = createAdminClient();
  const interp = GoalInterpretationSchema.parse(interpretation);
  const { data, error } = await admin
    .from("goals")
    .insert({
      owner_id: ownerId,
      name: interp.name,
      prompt_text: promptText,
      description: interp.outcome,
      scope: interp.scope,
      status: "draft",
      start_date: interp.timeframe.start,
      end_date: interp.timeframe.end,
      interpretation: interp,
      assumptions: interp.assumptions,
      ambiguities: interp.ambiguities,
    })
    .select(GOAL_COLUMNS)
    .single();
  if (error || !data) fail("goal_create_failed", error);
  const goal = data as unknown as GoalRow;
  await replaceMetrics(ownerId, goal.id, interp);
  await logGoalEvent(ownerId, goal.id, "created", { usedModel: meta.usedModel, notes: meta.notes, metrics: interp.metrics.map((m) => m.key), ambiguities: interp.ambiguities.length });
  return goal;
}

async function replaceMetrics(ownerId: string, goalId: string, interp: GoalInterpretation) {
  const admin = createAdminClient();
  const { error: delErr } = await admin.from("goal_metrics").delete().eq("goal_id", goalId);
  if (delErr) fail("goal_metrics_replace_failed", delErr);
  const rows = interp.metrics.map((m, i) => metricToRow(ownerId, goalId, m, i));
  const { error } = await admin.from("goal_metrics").insert(rows);
  if (error) fail("goal_metrics_insert_failed", error);
  await admin.from("goal_source_mappings").delete().eq("goal_id", goalId);
  const mappings = interp.metrics.flatMap((m) =>
    Object.entries(m.inputs).map(([inputKey, spec]) => ({
      owner_id: ownerId,
      goal_id: goalId,
      metric_key: m.key,
      input_key: inputKey,
      provider: spec.provider,
      resource_type: spec.resource_type,
      filter: spec.filter ?? {},
      aggregation: spec.aggregation,
      field: spec.field ?? null,
      notes: m.formula || null,
    })),
  );
  if (mappings.length) await admin.from("goal_source_mappings").insert(mappings);
  if (interp.milestones.length) {
    await admin.from("goal_milestones").delete().eq("goal_id", goalId);
    const base = interp.timeframe.start ? new Date(interp.timeframe.start) : new Date();
    await admin.from("goal_milestones").insert(
      interp.milestones.map((ms) => ({
        owner_id: ownerId,
        goal_id: goalId,
        name: ms.name,
        due_date: ms.due_in_days == null ? null : new Date(base.getTime() + ms.due_in_days * 86_400_000).toISOString().slice(0, 10),
        target_value: ms.target,
      })),
    );
  }
}

export async function getGoal(ownerId: string, id: string): Promise<GoalRow | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("goals").select(GOAL_COLUMNS).eq("owner_id", ownerId).eq("id", id).maybeSingle();
  return (data as unknown as GoalRow) ?? null;
}

export async function listGoals(ownerId: string, statuses?: GoalRow["status"][]): Promise<GoalRow[]> {
  const admin = createAdminClient();
  let q = admin.from("goals").select(GOAL_COLUMNS).eq("owner_id", ownerId).order("created_at", { ascending: false }).limit(100);
  if (statuses?.length) q = q.in("status", statuses);
  const { data, error } = await q;
  if (error) fail("goals_list_failed", error);
  return (data ?? []) as unknown as GoalRow[];
}

export async function listGoalMetrics(goalId: string): Promise<GoalMetricRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("goal_metrics").select(METRIC_COLUMNS).eq("goal_id", goalId).order("sort", { ascending: true });
  if (error) fail("goal_metrics_list_failed", error);
  return (data ?? []) as unknown as GoalMetricRow[];
}

export async function latestSnapshot(goalId: string): Promise<GoalSnapshotRow | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("goal_snapshots").select("*").eq("goal_id", goalId).order("taken_at", { ascending: false }).limit(1).maybeSingle();
  return (data as unknown as GoalSnapshotRow) ?? null;
}

export async function listSnapshots(goalId: string, limit = 60): Promise<GoalSnapshotRow[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("goal_snapshots").select("*").eq("goal_id", goalId).order("taken_at", { ascending: false }).limit(limit);
  return ((data ?? []) as unknown as GoalSnapshotRow[]).reverse();
}

export async function listGoalEvents(goalId: string, limit = 40): Promise<GoalEventRow[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("goal_events").select("id, goal_id, kind, payload, created_at").eq("goal_id", goalId).order("created_at", { ascending: false }).limit(limit);
  return (data ?? []) as unknown as GoalEventRow[];
}

export async function listRecommendations(goalId: string): Promise<GoalRecommendationRow[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("goal_recommendations").select("*").eq("goal_id", goalId).order("created_at", { ascending: false }).limit(20);
  return (data ?? []) as unknown as GoalRecommendationRow[];
}

export interface ApproveInput {
  resolutions: Record<string, string>;
  name?: string;
  start_date?: string;
  end_date?: string;
}

/**
 * Resolutions that change what a metric measures. The regex pre-parse asks
 * "what counts as a client?"; choosing (or typing) a Stripe first-payment
 * definition rewrites that metric's input so the answer actually takes
 * effect. "$1,000" in the answer becomes a minimum paid amount.
 */
export function applyDefinitionResolutions(metrics: GoalMetric[], ambiguities: { field: string; resolution: string | null }[]): { metrics: GoalMetric[]; changed: boolean } {
  let changed = false;
  const out = metrics.map((m) => {
    const amb = ambiguities.find((a) => a.field === `${m.key}.definition` && a.resolution);
    if (!amb || m.kind !== "count") return m;
    const r = amb.resolution!.toLowerCase();
    if (!/\b(stripe|payment|paid|invoice)\b/.test(r)) return m;
    const money = r.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k)?/);
    const minCents = money ? Math.round(Number(money[1]!.replace(/,/g, "")) * (money[2] ? 1000 : 1) * 100) : null;
    const filter: GoalMetric["inputs"][string]["filter"] = { status_in: ["paid"], ...(minCents ? { metadata_min: { amount_paid: minCents } } : {}) };
    changed = true;
    return GoalMetricSchema.parse({
      ...m,
      formula: "count(distinct paying emails with a paid Stripe invoice in window)",
      inputs: { value: { provider: "stripe", resource_type: "invoice", filter, aggregation: "count", distinct_by: "email_hash" } },
      limitations: [`Client definition (owner): "${amb.resolution}". Counts one client per paying email; the first paid invoice in the window counts.`],
    });
  });
  return { metrics: out, changed };
}

/** Approves a draft: every ambiguity needs a resolution; dates are fixed; the interpretation records the choices. */
export async function approveGoal(ownerId: string, id: string, input: ApproveInput, now = new Date()): Promise<GoalRow> {
  const goal = await getGoal(ownerId, id);
  if (!goal) throw new Error("goal_not_found");
  if (goal.status !== "draft") throw new Error("goal_not_draft");
  const unresolved = goal.ambiguities.filter((a) => !(input.resolutions[a.field] ?? a.resolution));
  if (unresolved.length) throw new Error(`goal_ambiguities_unresolved:${unresolved.map((a) => a.field).join(",")}`);
  const ambiguities = goal.ambiguities.map((a) => ({ ...a, resolution: input.resolutions[a.field] ?? a.resolution }));
  // An anchored start ("Steve's sign date") is confirmed through its ambiguity; a typed/selected date wins over the resolver's guess.
  const anchored = ambiguities.find((a) => a.field === "timeframe.start")?.resolution?.match(/^\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  const start = input.start_date ?? anchored ?? goal.start_date ?? now.toISOString().slice(0, 10);
  const days = goal.interpretation.timeframe.days;
  const end = input.end_date ?? goal.end_date ?? (days ? new Date(Date.parse(start) + days * 86_400_000).toISOString().slice(0, 10) : null);
  const resolvedMetrics = applyDefinitionResolutions(goal.interpretation.metrics, ambiguities);
  const interpretation: GoalInterpretation = { ...goal.interpretation, name: input.name ?? goal.interpretation.name, timeframe: { ...goal.interpretation.timeframe, start, end, days }, ambiguities, metrics: resolvedMetrics.metrics };
  if (resolvedMetrics.changed) await replaceMetrics(ownerId, id, interpretation);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("goals")
    .update({ status: "active", name: input.name ?? goal.name, start_date: start, end_date: end, approved_at: now.toISOString(), ambiguities, interpretation })
    .eq("id", id)
    .eq("owner_id", ownerId)
    .select(GOAL_COLUMNS)
    .single();
  if (error || !data) fail("goal_approve_failed", error);
  await logGoalEvent(ownerId, id, "approved", { resolutions: input.resolutions, start_date: start, end_date: end });
  return data as unknown as GoalRow;
}

export interface GoalPatch {
  action?: "pause" | "resume" | "archive" | "achieved" | "missed";
  name?: string;
  description?: string;
  start_date?: string;
  end_date?: string;
  /** Explicit metric edits (post-approval edits are recorded as `edited` events with before/after). */
  metrics?: GoalMetric[];
  note?: string;
}

export async function updateGoal(ownerId: string, id: string, patch: GoalPatch): Promise<GoalRow> {
  const goal = await getGoal(ownerId, id);
  if (!goal) throw new Error("goal_not_found");
  const admin = createAdminClient();
  const update: Record<string, unknown> = {};
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  if (patch.action === "pause" && goal.status === "active") {
    update.status = "paused";
    events.push({ kind: "paused", payload: {} });
  }
  if (patch.action === "resume" && goal.status === "paused") {
    update.status = "active";
    events.push({ kind: "resumed", payload: {} });
  }
  if (patch.action === "archive") {
    update.status = "archived";
    events.push({ kind: "archived", payload: {} });
  }
  if (patch.action === "achieved" || patch.action === "missed") {
    update.status = patch.action;
    events.push({ kind: "edited", payload: { status: patch.action } });
  }
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of ["name", "description", "start_date", "end_date"] as const) {
    if (patch[k] !== undefined && patch[k] !== goal[k]) {
      before[k] = goal[k];
      after[k] = patch[k];
      update[k] = patch[k];
    }
  }
  if (patch.metrics) {
    const parsed = patch.metrics.map((m) => GoalMetricSchema.parse(m));
    const interpretation: GoalInterpretation = GoalInterpretationSchema.parse({ ...goal.interpretation, metrics: parsed });
    before.metrics = goal.interpretation.metrics;
    after.metrics = parsed;
    update.interpretation = interpretation;
    await replaceMetrics(ownerId, id, interpretation);
  }
  if (Object.keys(before).length) events.push({ kind: "edited", payload: { before, after, approved: !!goal.approved_at } });
  if (patch.note) events.push({ kind: "note", payload: { note: patch.note.slice(0, 2000) } });
  if (Object.keys(update).length) {
    const { error } = await admin.from("goals").update(update).eq("id", id).eq("owner_id", ownerId);
    if (error) fail("goal_update_failed", error);
  }
  for (const e of events) await logGoalEvent(ownerId, id, e.kind, e.payload);
  return (await getGoal(ownerId, id))!;
}

export async function deleteDraftGoal(ownerId: string, id: string): Promise<boolean> {
  const admin = createAdminClient();
  const { error, count } = await admin.from("goals").delete({ count: "exact" }).eq("id", id).eq("owner_id", ownerId).eq("status", "draft");
  if (error) fail("goal_delete_failed", error);
  return (count ?? 0) > 0;
}

export async function writeSnapshot(ownerId: string, goalId: string, snap: Omit<GoalSnapshotRow, "id" | "goal_id" | "taken_at">, takenAt: Date) {
  const admin = createAdminClient();
  const { error } = await admin.from("goal_snapshots").insert({ owner_id: ownerId, goal_id: goalId, taken_at: takenAt.toISOString(), ...snap });
  if (error) fail("goal_snapshot_failed", error);
}

export async function updateMetricValues(goalId: string, results: Record<string, MetricResult>, at: Date) {
  const admin = createAdminClient();
  for (const [key, r] of Object.entries(results)) {
    await admin.from("goal_metrics").update({ current_value: r.value, current_computed_at: at.toISOString() }).eq("goal_id", goalId).eq("key", key);
  }
}

export async function upsertRecommendations(ownerId: string, goalId: string, recs: { fingerprint: string; title: string; why: string; evidence: unknown[]; mechanism: string; downside: string; jeff_can_prepare: string; requires_approval: boolean }[]) {
  const admin = createAdminClient();
  const existing = await listRecommendations(goalId);
  const keep = new Set(recs.map((r) => r.fingerprint));
  let created = 0;
  for (const r of recs) {
    const found = existing.find((e) => e.fingerprint === r.fingerprint);
    if (found) {
      if (found.status === "proposed") await admin.from("goal_recommendations").update({ title: r.title, why: r.why, evidence: r.evidence, mechanism: r.mechanism, downside: r.downside, jeff_can_prepare: r.jeff_can_prepare, requires_approval: r.requires_approval }).eq("id", found.id);
      continue;
    }
    const { error } = await admin.from("goal_recommendations").insert({ owner_id: ownerId, goal_id: goalId, ...r });
    if (!error) created++;
  }
  // Proposed recommendations whose condition disappeared are dismissed automatically (owner decisions are kept).
  for (const e of existing) if (!keep.has(e.fingerprint) && e.status === "proposed") await admin.from("goal_recommendations").update({ status: "dismissed" }).eq("id", e.id);
  return created;
}

export async function prepareRecommendation(ownerId: string, goalId: string, recId: string): Promise<{ missionId: string; code: string }> {
  const admin = createAdminClient();
  const { data: rec } = await admin.from("goal_recommendations").select("*").eq("id", recId).eq("goal_id", goalId).eq("owner_id", ownerId).maybeSingle();
  if (!rec) throw new Error("recommendation_not_found");
  const r = rec as unknown as GoalRecommendationRow & { mission?: { title?: string; goal?: string } };
  if (r.mission_id) {
    const { data: m } = await admin.from("missions").select("id, code").eq("id", r.mission_id).maybeSingle();
    if (m) return { missionId: m.id, code: m.code };
  }
  const { count } = await admin.from("missions").select("id", { count: "exact", head: true }).eq("owner_id", ownerId);
  const code = `M-${String((count ?? 0) + 1).padStart(4, "0")}`;
  const goalText = `${r.jeff_can_prepare ?? r.why}\n\nWhy: ${r.why}\nMechanism: ${r.mechanism ?? "—"}\nDownside: ${r.downside ?? "—"}\nRequires approval for any consequential action: ${r.requires_approval ? "yes" : "no"}.`;
  const { data: mission, error } = await admin
    .from("missions")
    .insert({ owner_id: ownerId, code, title: r.title.slice(0, 120), goal: goalText.slice(0, 4000), status: "draft", worker: "claude", environment: "sandbox", goal_id: goalId })
    .select("id, code")
    .single();
  if (error || !mission) fail("mission_create_failed", error);
  await admin.from("goal_recommendations").update({ status: "prepared", mission_id: mission.id }).eq("id", recId);
  await logGoalEvent(ownerId, goalId, "note", { recommendation_prepared: recId, mission: mission.code });
  return { missionId: mission.id, code: mission.code };
}

export async function listGoalMissions(goalId: string) {
  const admin = createAdminClient();
  const { data } = await admin.from("missions").select("id, code, title, status, created_at").eq("goal_id", goalId).order("created_at", { ascending: false }).limit(20);
  return data ?? [];
}
