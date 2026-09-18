import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log } from "@/lib/security/log";
import { loadRows } from "@/lib/gomez/monitors";
import { CLASSIFIER_VERSION, classifyCommitment } from "@/lib/gomez/monitors/commitment-classifier";
import { listRules } from "@/lib/gomez/rules/store";
import { decide } from "@/lib/gomez/rules/precedence";
import { bareAddress, subjectFromRow } from "@/lib/gomez/rules/engine";
import { ClientLeadIndex } from "@/lib/gomez/clients/client-leads";
import { ownerIdentity } from "@/lib/env";
import { patchObligation, recordEvent } from "@/lib/gomez/obligations/store";
import { TERMINAL_STATUSES } from "@/lib/gomez/obligations/types";
import type { SourceRow } from "@/lib/gomez/monitors/types";
import { isKnownCounterparty, knownCounterparties } from "./counterparties";
import { commitmentRules, listCommitments } from "./store";

/**
 * Re-runs the current classifier over every open/overdue commitment and
 * retires the ones it no longer accepts (marketing, vendor, social
 * notifications, unknown senders, rows an operating rule now excludes).
 *
 * Idempotent and conservative: rows are DISMISSED — never deleted, never
 * completed — and the linked Follow-Through obligation (if any) is dismissed
 * with a `note` event explaining why, plus `classifier_version` in its
 * metadata. Commitments whose source row is no longer synced are left alone.
 * Owner decisions (done/dismissed) are never touched. Safe to run every cron.
 */

export const RECLASSIFY_NOTE = `reclassified as marketing/system by classifier v${CLASSIFIER_VERSION}`;
const MIN_CONFIDENCE = 0.45;

export interface ReclassifySummary {
  version: number;
  scanned: number;
  dismissed: number;
  kept: number;
  /** Open commitments whose source row is not synced any more (left as they are). */
  unverifiable: number;
  reasons: Record<string, number>;
}

async function loadSourceRows(ownerId: string, ids: string[]): Promise<Map<string, SourceRow>> {
  const out = new Map<string, SourceRow>();
  if (!ids.length) return out;
  const admin = createAdminClient();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin
      .from("source_items")
      .select("id, provider, capability, resource_type, external_id, title, summary, author, source_url, source_timestamp, tags, metadata")
      .eq("owner_id", ownerId)
      .in("id", ids.slice(i, i + 200));
    for (const r of data ?? []) out.set(r.id, r as SourceRow);
  }
  return out;
}

export async function reclassifyCommitments(ownerId: string, now = new Date()): Promise<ReclassifySummary> {
  const summary: ReclassifySummary = { version: CLASSIFIER_VERSION, scanned: 0, dismissed: 0, kept: 0, unverifiable: 0, reasons: {} };
  const open = await listCommitments(ownerId, { status: ["open", "overdue"], limit: 500 });
  summary.scanned = open.length;
  if (!open.length) return summary;

  const rows = await loadRows(ownerId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = open.map((c) => c.source_item_id).filter((id): id is string => !!id && !byId.has(id));
  for (const [id, r] of await loadSourceRows(ownerId, missing)) byId.set(id, r);

  const own = [ownerIdentity().email].filter(Boolean);
  const known = knownCounterparties(rows, own);
  const rules = commitmentRules(await listRules(ownerId).catch(() => []));
  const subjectCtx = { clientLeads: ClientLeadIndex.from(rows) };
  const admin = createAdminClient();
  const iso = now.toISOString();

  for (const c of open) {
    const src = c.source_item_id ? byId.get(c.source_item_id) : undefined;
    if (!src) {
      summary.unverifiable++;
      continue;
    }
    let reason: string | null = null;
    const verdict = rules.length ? decide(rules, subjectFromRow(src, "missed_commitment", subjectCtx)) : null;
    if (verdict?.excluded && verdict.decidedBy) reason = `excluded by rule "${verdict.decidedBy.name}"`;
    else {
      const sender = bareAddress(src.author);
      const fromOwner = !!sender && own.includes(sender);
      const signal = classifyCommitment(src, { ownAddresses: own, knownCounterparty: fromOwner || isKnownCounterparty(src, known) });
      if (signal.sender_class !== "human") reason = `${signal.sender_class} source`;
      else if (!signal.sentence) reason = "no commitment sentence";
      else if (signal.confidence < MIN_CONFIDENCE) reason = signal.reasons[0] ?? "low confidence";
    }
    if (!reason) {
      summary.kept++;
      continue;
    }
    const { error } = await admin.from("commitments").update({ status: "dismissed", last_seen_at: iso }).eq("owner_id", ownerId).eq("id", c.id).in("status", ["open", "overdue"]);
    if (error) {
      log.warn("commitment_reclassify_failed", { id: c.id, message: error.message });
      continue;
    }
    summary.dismissed++;
    summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
    // Linked Follow-Through obligation: dismiss (not complete) and explain.
    const { data: obs } = await admin.from("obligations").select("id, status, metadata").eq("owner_id", ownerId).eq("commitment_id", c.id);
    for (const o of obs ?? []) {
      if ((TERMINAL_STATUSES as readonly string[]).includes(String(o.status))) continue;
      const metadata = { ...((o.metadata as Record<string, unknown>) ?? {}), classifier_version: CLASSIFIER_VERSION, reclassified_reason: reason, reclassified_at: iso };
      await patchObligation(ownerId, String(o.id), { status: "dismissed", dismissed_at: iso, next_reminder_at: null, completion_question: null, metadata });
      await recordEvent(ownerId, String(o.id), "note", { actor: "gomez", note: RECLASSIFY_NOTE, reason, classifier_version: CLASSIFIER_VERSION }, now);
      await admin.from("alerts").update({ status: "resolved", resolved_at: iso }).eq("owner_id", ownerId).eq("kind", "obligation").eq("ref_id", String(o.id)).in("status", ["open", "acknowledged", "snoozed"]);
    }
    await admin.from("alerts").update({ status: "resolved", resolved_at: iso }).eq("owner_id", ownerId).eq("kind", "commitment").eq("ref_id", c.id).in("status", ["open", "acknowledged", "snoozed"]);
  }
  if (summary.dismissed) log.info("commitments_reclassified", { version: CLASSIFIER_VERSION, scanned: summary.scanned, dismissed: summary.dismissed, kept: summary.kept, unverifiable: summary.unverifiable });
  return summary;
}
