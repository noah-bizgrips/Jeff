import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorMessage, log } from "@/lib/security/log";
import { redact } from "@/lib/security/redact";
import type { CandidateFinding, Monitor, SourceRow } from "./types";
import { leadFollowupGap } from "./lead-followup-gap";
import { pipelineAging } from "./pipeline-aging";
import { missedCommitment } from "./missed-commitment";
import { automationFailure } from "./automation-failure";
import { operationalBottleneck } from "./operational-bottleneck";

/**
 * Monitor runner. Loads the owner's live (non-sample) source_items, runs every
 * pure monitor, upserts findings keyed by fingerprint, and resolves findings
 * whose condition no longer holds. Owner-decided statuses (dismissed) are
 * preserved across runs.
 */

export const MONITORS: Monitor[] = [leadFollowupGap, pipelineAging, missedCommitment, automationFailure, operationalBottleneck];

export interface MonitorRunSummary {
  rows: number;
  candidates: number;
  created: number;
  updated: number;
  resolved: number;
  errors: { monitor: string; message: string }[];
}

const ROW_LIMIT = 5000;
const DAY = 86_400_000;

export async function loadRows(ownerId: string): Promise<SourceRow[]> {
  const admin = createAdminClient();
  const since = new Date(Date.now() - 120 * DAY).toISOString();
  const { data, error } = await admin
    .from("source_items")
    .select("id, provider, capability, resource_type, external_id, title, summary, author, source_url, source_timestamp, tags, metadata")
    .eq("owner_id", ownerId)
    .eq("is_sample", false)
    .or(`source_timestamp.gte.${since},source_timestamp.is.null`)
    .order("source_timestamp", { ascending: false })
    .limit(ROW_LIMIT);
  if (error) throw new Error(`monitor_rows_failed:${error.code ?? ""}`);
  return (data ?? []) as SourceRow[];
}

/** Pure: runs all monitors, isolating failures per monitor. */
export function runMonitors(rows: SourceRow[], now = new Date(), monitors: Monitor[] = MONITORS): { candidates: CandidateFinding[]; errors: { monitor: string; message: string }[] } {
  const candidates: CandidateFinding[] = [];
  const errors: { monitor: string; message: string }[] = [];
  for (const m of monitors) {
    try {
      candidates.push(...m.run(rows, { now }));
    } catch (err) {
      errors.push({ monitor: m.id, message: errorMessage(err) });
    }
  }
  // De-duplicate by fingerprint (last one wins).
  const byFp = new Map<string, CandidateFinding>();
  for (const c of candidates) byFp.set(c.fingerprint, c);
  return { candidates: [...byFp.values()], errors };
}

export async function runMonitorsForOwner(ownerId: string, now = new Date()): Promise<MonitorRunSummary> {
  const admin = createAdminClient();
  const rows = await loadRows(ownerId);
  const { candidates, errors } = runMonitors(rows, now);

  const { data: existingRows } = await admin.from("findings").select("id, fingerprint, status").eq("owner_id", ownerId).not("fingerprint", "is", null);
  const existing = new Map<string, { id: string; status: string }>();
  for (const r of existingRows ?? []) if (r.fingerprint) existing.set(r.fingerprint, { id: r.id, status: r.status });

  let created = 0;
  let updated = 0;
  const seen = new Set<string>();
  const nowIso = now.toISOString();
  for (const c of candidates) {
    seen.add(c.fingerprint);
    const prev = existing.get(c.fingerprint);
    const base = {
      category: c.category,
      title: c.title.slice(0, 300),
      observed_facts: redact(c.observed_facts),
      metrics: redact(c.metrics),
      interpretation: c.interpretation,
      evidence: c.evidence,
      range_start: c.range_start,
      range_end: c.range_end,
      confidence: Math.max(0, Math.min(1, c.confidence)),
      limitations: c.limitations,
      severity: c.severity,
      proposed_mission: c.proposed_mission,
      last_seen_at: nowIso,
      is_sample: false,
    };
    if (prev) {
      // Keep owner decisions; reopen only findings that were auto-resolved.
      const status = prev.status === "resolved" ? "open" : prev.status;
      const { error } = await admin.from("findings").update({ ...base, status }).eq("id", prev.id);
      if (error) log.warn("finding_update_failed", { fingerprint: c.fingerprint, message: error.message });
      else updated++;
    } else {
      const { error } = await admin.from("findings").insert({ ...base, owner_id: ownerId, fingerprint: c.fingerprint, status: "open" });
      if (error) log.warn("finding_insert_failed", { fingerprint: c.fingerprint, message: error.message });
      else created++;
    }
  }

  let resolved = 0;
  for (const [fp, prev] of existing) {
    if (seen.has(fp)) continue;
    if (!["open", "acknowledged", "in_progress"].includes(prev.status)) continue;
    const { error } = await admin.from("findings").update({ status: "resolved", last_seen_at: nowIso }).eq("id", prev.id);
    if (!error) resolved++;
  }

  log.info("monitors_run", { rows: rows.length, candidates: candidates.length, created, updated, resolved, errors: errors.length });
  return { rows: rows.length, candidates: candidates.length, created, updated, resolved, errors };
}
