import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log } from "@/lib/security/log";
import { redactString } from "@/lib/security/redact";
import { loadRows } from "@/lib/jeff/monitors";
import { listRules } from "@/lib/jeff/rules/store";
import { decide } from "@/lib/jeff/rules/precedence";
import { subjectFromRow } from "@/lib/jeff/rules/engine";
import { ownerIdentity } from "@/lib/env";
import { ClientLeadIndex } from "@/lib/jeff/clients/client-leads";
import { extractCommitments, isOverdue, type CommitmentCandidate } from "./extract";

export interface CommitmentRow {
  id: string;
  source_item_id: string | null;
  fingerprint: string;
  actor: string | null;
  action_text: string;
  context_text: string | null;
  due_at: string | null;
  confidence: number;
  status: "open" | "done" | "dismissed" | "overdue";
  direction: "owed_by_me" | "owed_to_me";
  counterparty: string | null;
  provider: string | null;
  source_url: string | null;
  last_seen_at: string;
  created_at: string;
}

const COLUMNS = "id, source_item_id, fingerprint, actor, action_text, context_text, due_at, confidence, status, direction, counterparty, provider, source_url, last_seen_at, created_at";

export interface CommitmentRunSummary {
  candidates: number;
  created: number;
  updated: number;
  overdue: number;
  excludedByRules: number;
}

/** Enabled rules that can affect the commitment pipeline (global or targeting Open commitments). */
export function commitmentRules<T extends { enabled: boolean; pending_confirmation: boolean; target_monitor: string | null; target_job?: string | null }>(rules: T[]): T[] {
  return rules.filter((r) => r.enabled && !r.pending_confirmation && !r.target_job && (!r.target_monitor || ["missed_commitment", "open_commitments", "commitments"].includes(r.target_monitor)));
}

export async function runCommitmentsForOwner(ownerId: string, now = new Date()): Promise<CommitmentRunSummary> {
  const admin = createAdminClient();
  const rows = await loadRows(ownerId);
  const rules = commitmentRules(await listRules(ownerId).catch(() => []));
  let excludedByRules = 0;
  const subjectCtx = { clientLeads: ClientLeadIndex.from(rows) };
  const input = rules.length
    ? rows.filter((r) => {
        if (r.resource_type !== "email" && r.resource_type !== "message") return true;
        const d = decide(rules, subjectFromRow(r, "missed_commitment", subjectCtx));
        if (d.excluded) excludedByRules++;
        return !d.excluded;
      })
    : rows;
  const own = [ownerIdentity().email].filter(Boolean);
  const candidates = extractCommitments(input, { ownAddresses: own, now });

  const { data: existingRows } = await admin.from("commitments").select("id, fingerprint, status, due_at").eq("owner_id", ownerId);
  const existing = new Map((existingRows ?? []).map((r) => [r.fingerprint as string, r]));
  let created = 0;
  let updated = 0;
  for (const c of candidates) {
    const prev = existing.get(c.fingerprint);
    const base = {
      source_item_id: c.source_item_id,
      actor: c.actor,
      action_text: redactString(c.action_text),
      context_text: redactString(c.context_text),
      due_at: c.due_at,
      confidence: c.confidence,
      direction: c.direction,
      counterparty: c.counterparty,
      provider: c.provider,
      source_url: c.source_url,
      last_seen_at: now.toISOString(),
    };
    if (prev) {
      if (prev.status === "done" || prev.status === "dismissed") continue; // owner decisions stick
      const status = isOverdue({ due_at: c.due_at, status: prev.status }, now) ? "overdue" : "open";
      const { error } = await admin.from("commitments").update({ ...base, status }).eq("id", prev.id);
      if (!error) updated++;
    } else {
      const status = isOverdue({ due_at: c.due_at, status: "open" }, now) ? "overdue" : "open";
      const { error } = await admin.from("commitments").insert({ ...base, owner_id: ownerId, fingerprint: c.fingerprint, status });
      if (error) log.warn("commitment_insert_failed", { message: error.message });
      else created++;
    }
  }
  const { count } = await admin.from("commitments").select("id", { count: "exact", head: true }).eq("owner_id", ownerId).eq("status", "overdue");
  return { candidates: candidates.length, created, updated, overdue: count ?? 0, excludedByRules };
}

export async function listCommitments(ownerId: string, opts: { status?: CommitmentRow["status"][]; limit?: number } = {}): Promise<CommitmentRow[]> {
  const admin = createAdminClient();
  let q = admin.from("commitments").select(COLUMNS).eq("owner_id", ownerId).order("due_at", { ascending: true, nullsFirst: false }).limit(opts.limit ?? 100);
  if (opts.status?.length) q = q.in("status", opts.status);
  const { data, error } = await q;
  if (error) throw new Error(`commitments_list_failed:${error.code ?? ""}`);
  return (data ?? []) as unknown as CommitmentRow[];
}

export async function updateCommitment(ownerId: string, id: string, status: "done" | "dismissed" | "open"): Promise<CommitmentRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("commitments").update({ status }).eq("owner_id", ownerId).eq("id", id).select(COLUMNS).maybeSingle();
  if (error) throw new Error(`commitment_update_failed:${error.code ?? ""}`);
  return (data as unknown as CommitmentRow) ?? null;
}

export type { CommitmentCandidate };
