import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { log } from "@/lib/security/log";
import { createRule, listRules } from "@/lib/gomez/rules/store";
import type { OperatingRule } from "@/lib/gomez/rules/schema";
import { filterAlreadyCovered, LEARNING_WINDOW_DAYS, proposeLearnings, type LearningProposal, type LearningSignal } from "./learning";

/**
 * I/O side of job learning (§64): collect the last two weeks of set-aside
 * signals, turn them into proposals, and materialise each new proposal as a
 * pending Tier-2 rule (disabled until the owner confirms it in Memory &
 * Rules). The one-line suggestion lives in `source_quote` so Ask Gomez and
 * the brief can quote it without recomputing.
 */

export const LEARNED_PREFIX = "Learned:";
const SET_ASIDE = ["not_useful", "wrong", "too_noisy", "dont_show", "already_knew"];

export async function collectLearningSignals(ownerId: string, now = new Date(), windowDays = LEARNING_WINDOW_DAYS): Promise<LearningSignal[]> {
  const admin = createAdminClient();
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const signals: LearningSignal[] = [];
  const { data: feedback } = await admin.from("finding_feedback").select("finding_id, verdict, job_id, created_at").eq("owner_id", ownerId).gte("created_at", since).in("verdict", SET_ASIDE).limit(500);
  const fb = feedback ?? [];
  if (fb.length) {
    const ids = [...new Set(fb.map((f) => f.finding_id as string))];
    const { data: findings } = await admin.from("findings").select("id, category, title, job_id").eq("owner_id", ownerId).in("id", ids);
    const byId = new Map((findings ?? []).map((f) => [f.id as string, f]));
    const jobIds = [...new Set([...fb.map((f) => f.job_id as string | null), ...(findings ?? []).map((f) => f.job_id as string | null)].filter((v): v is string => !!v))];
    const { data: jobs } = jobIds.length ? await admin.from("jobs").select("id, slug").in("id", jobIds) : { data: [] as { id: string; slug: string }[] };
    const slugOf = new Map((jobs ?? []).map((j) => [j.id as string, j.slug as string]));
    for (const f of fb) {
      const finding = byId.get(f.finding_id as string);
      if (!finding) continue;
      const jobId = (f.job_id as string | null) ?? (finding.job_id as string | null);
      signals.push({ kind: "finding_set_aside", at: f.created_at as string, job_slug: jobId ? (slugOf.get(jobId) ?? null) : null, subtype: finding.category as string, title: finding.title as string, detail: f.verdict as string });
    }
  }
  const { data: events } = await admin.from("obligation_events").select("obligation_id, kind, created_at").eq("owner_id", ownerId).gte("created_at", since).in("kind", ["snoozed", "dismissed"]).limit(500);
  const ev = events ?? [];
  if (ev.length) {
    const ids = [...new Set(ev.map((e) => e.obligation_id as string))];
    const { data: obligations } = await admin.from("obligations").select("id, title, scope, origin").eq("owner_id", ownerId).in("id", ids);
    const byId = new Map((obligations ?? []).map((o) => [o.id as string, o]));
    for (const e of ev) {
      const o = byId.get(e.obligation_id as string);
      if (!o) continue;
      signals.push({ kind: e.kind === "snoozed" ? "obligation_snoozed" : "obligation_dismissed", at: e.created_at as string, job_slug: "follow-through-watchdog", subtype: o.scope as string, title: o.title as string, detail: o.origin as string });
    }
  }
  return signals;
}

export interface LearningRunSummary {
  signals: number;
  proposals: number;
  created: string[];
}

/** Collects signals → proposals → pending Tier-2 rules. Idempotent: a proposal already on file (any state) is never re-created. */
export async function runJobLearning(ownerId: string, now = new Date()): Promise<LearningRunSummary> {
  const signals = await collectLearningSignals(ownerId, now);
  const rules = await listRules(ownerId, { enabledOnly: false }).catch(() => [] as OperatingRule[]);
  const proposals = filterAlreadyCovered(proposeLearnings(signals, now), rules);
  const created: string[] = [];
  for (const p of proposals) {
    const res = await createRule(ownerId, p.rule, { source: "feedback", createdBy: "gomez", pendingConfirmation: true, sourceQuote: p.suggestion });
    if (res.ok) {
      created.push(res.rule.name);
      await audit({ event: "rule_proposed", ownerId, targetId: res.rule.id, actor: "system", metadata: { name: res.rule.name, job: p.job_slug, subtype: p.subtype, count: p.count, window_days: p.window_days } });
    } else log.warn("job_learning_proposal_failed", { key: p.key, reason: res.reason });
  }
  return { signals: signals.length, proposals: proposals.length, created };
}

export interface LearnedSuggestion {
  rule_id: string;
  name: string;
  suggestion: string;
  job_slug: string | null;
  created_at: string;
}

/** Pending learned proposals, as one-liners for Ask Gomez and the brief. */
export function pendingSuggestions(rules: OperatingRule[]): LearnedSuggestion[] {
  return rules
    .filter((r) => r.pending_confirmation && r.name.startsWith(LEARNED_PREFIX))
    .map((r) => ({ rule_id: r.id, name: r.name, suggestion: r.source_quote ?? r.description ?? r.name, job_slug: r.target_job ?? null, created_at: r.created_at }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function listPendingSuggestions(ownerId: string): Promise<LearnedSuggestion[]> {
  const rules = await listRules(ownerId, { enabledOnly: false }).catch(() => [] as OperatingRule[]);
  return pendingSuggestions(rules);
}

export type { LearningProposal };
