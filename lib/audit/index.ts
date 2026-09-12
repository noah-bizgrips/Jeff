import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { redact } from "@/lib/security/redact";
import { log } from "@/lib/security/log";

export type AuditEvent =
  | "login"
  | "login_failed"
  | "logout"
  | "mfa_enrollment_started"
  | "mfa_enrolled"
  | "mfa_verified"
  | "mfa_failed"
  | "owner_bound"
  | "connection_created"
  | "connection_updated"
  | "connection_removed"
  | "connection_permission_changed"
  | "connection_tested"
  | "oauth_started"
  | "oauth_failed"
  | "sync_started"
  | "sync_failed"
  | "sync_completed"
  | "mission_created"
  | "mission_updated"
  | "approval_requested"
  | "approval_granted"
  | "approval_denied"
  | "production_action_requested"
  | "service_request_created"
  | "webhook_received"
  | "webhook_rejected"
  | "jeff_chat"
  | "rule_created"
  | "rule_updated"
  | "rule_disabled"
  | "rule_deleted"
  | "rule_refused"
  | "memory_created"
  | "memory_updated"
  | "memory_deleted"
  | "findings_reprocessed"
  | "finding_feedback"
  | "goal_created"
  | "goal_approved"
  | "goal_updated"
  | "goal_deleted"
  | "goal_recommendation_prepared";

export interface AuditInput {
  event: AuditEvent;
  ownerId?: string | null;
  actor?: "owner" | "system" | "webhook" | "worker";
  provider?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  request?: Request;
}

function hashIp(req?: Request): string | null {
  if (!req) return null;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "";
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

/**
 * Writes an audit row via the service role. Never throws (audit failures are
 * logged, not surfaced), and never stores request bodies.
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("audit_events").insert({
      owner_id: input.ownerId ?? null,
      actor: input.actor ?? "owner",
      event: input.event,
      provider: input.provider ?? null,
      target_id: input.targetId ?? null,
      ip_hash: hashIp(input.request),
      user_agent: input.request?.headers.get("user-agent")?.slice(0, 200) ?? null,
      metadata: input.metadata ? redact(input.metadata) : {},
    });
    if (error) log.warn("audit_write_failed", { event: input.event, message: error.message });
  } catch (err) {
    log.warn("audit_write_failed", { event: input.event, message: err instanceof Error ? err.message : "unknown" });
  }
}
