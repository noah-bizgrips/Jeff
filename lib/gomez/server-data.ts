import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GomezDoc } from "./demo-data";
import { sourceIdFor } from "./sources";
import type { SavedAnswer } from "@/components/gomez/store";
import type { MissionItem, ApprovalItem } from "@/components/mission-control/MissionsView";
import type { FindingItem } from "@/components/mission-control/InsightsView";

/**
 * Server-side loaders. They use the request-scoped (RLS-enforced) client,
 * so the database itself rejects anything that is not the aal2 owner.
 */

export async function loadLiveDocs(supabase: SupabaseClient, limit = 300): Promise<GomezDoc[]> {
  const { data } = await supabase
    .from("source_items")
    .select("id, provider, capability, resource_type, title, summary, author, source_url, source_timestamp, tags")
    .eq("is_sample", false)
    .order("source_timestamp", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r) => ({
    id: r.id,
    source: sourceIdFor(r.provider, r.capability),
    title: r.title ?? r.resource_type,
    author: r.author ?? "",
    content: r.summary ?? "",
    tags: r.tags ?? [],
    updated: r.source_timestamp ?? new Date().toISOString(),
    url: r.source_url ?? "",
    sample: false,
  }));
}

export async function loadNotes(supabase: SupabaseClient): Promise<GomezDoc[]> {
  const { data } = await supabase.from("notes").select("id, title, content, tags, created_at").order("created_at", { ascending: false }).limit(500);
  return (data ?? []).map((n) => ({ id: n.id, source: "notes", title: n.title, author: "You / Personal notes", content: n.content, tags: n.tags ?? [], updated: n.created_at, url: "", sample: false }));
}

export async function loadSaved(supabase: SupabaseClient): Promise<SavedAnswer[]> {
  const { data } = await supabase.from("saved_answers").select("id, question, answer, mode, created_at").order("created_at", { ascending: false }).limit(200);
  return (data ?? []).map((s) => ({ id: s.id, question: s.question, text: s.answer, mode: s.mode, savedAt: s.created_at }));
}

export async function loadMissions(supabase: SupabaseClient): Promise<MissionItem[]> {
  const { data } = await supabase.from("missions").select("*").order("created_at", { ascending: false }).limit(200);
  return (data ?? []).map((m) => ({
    id: m.id,
    code: m.code,
    title: m.title,
    goal: m.goal,
    status: m.status,
    worker: m.worker,
    environment: m.environment,
    budgetUsd: Number(m.budget_usd),
    timeLimitMin: m.time_limit_min,
    maxRetries: m.max_retries,
    createdAt: m.created_at,
    isSample: m.is_sample,
    result: m.result ?? {},
    findingId: m.finding_id ?? null,
    goalId: m.goal_id ?? null,
    completedAt: m.completed_at ?? null,
    outcome: null,
  }));
}

export async function loadApprovals(supabase: SupabaseClient): Promise<ApprovalItem[]> {
  const { data } = await supabase.from("approvals").select("*, missions(code, title, goal)").order("requested_at", { ascending: false }).limit(200);
  return (data ?? []).map((a) => ({
    id: a.id,
    action: a.action,
    artifactRef: a.artifact_ref,
    environment: a.environment,
    status: a.status,
    requestedAt: a.requested_at,
    expiresAt: a.expires_at,
    reason: a.reason,
    mission: a.missions ? { code: a.missions.code, title: a.missions.title, goal: a.missions.goal } : null,
  }));
}

export async function loadFindings(supabase: SupabaseClient): Promise<FindingItem[]> {
  const { data } = await supabase.from("findings").select("*, operating_rules(name)").eq("is_sample", false).order("created_at", { ascending: false }).limit(200);
  return (data ?? []).map((f) => ({
    suppressedByRuleId: f.suppressed_by_rule_id ?? null,
    suppressedByRuleName: (f as { operating_rules?: { name?: string } | null }).operating_rules?.name ?? null,
    id: f.id,
    category: f.category,
    title: f.title,
    observedFacts: f.observed_facts ?? [],
    metrics: f.metrics ?? {},
    interpretation: f.interpretation,
    evidence: f.evidence ?? [],
    rangeStart: f.range_start,
    rangeEnd: f.range_end,
    confidence: f.confidence,
    limitations: f.limitations,
    severity: f.severity,
    status: f.status,
    proposedMission: f.proposed_mission,
    createdAt: f.created_at,
    isSample: f.is_sample,
  }));
}

export async function loadCounts(supabase: SupabaseClient) {
  const [m, a] = await Promise.all([
    supabase.from("missions").select("id", { count: "exact", head: true }),
    supabase.from("approvals").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);
  return { missions: m.count ?? 0, approvals: a.count ?? 0 };
}
