export const ATTENTION_KINDS = ["finding_viewed", "alert_viewed", "goal_viewed", "client_viewed", "page_viewed", "briefing_read"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export interface AttentionSignal {
  kind: AttentionKind;
  ref_id?: string | null;
  path?: string | null;
}

export interface AttentionRow extends AttentionSignal {
  created_at: string;
}

/** Client-side throttle window for repeated signals (ms). */
export const PAGE_VIEW_THROTTLE_MS = 5 * 60_000;

/**
 * Pure throttle used by the browser helper: returns true when a signal should
 * be sent given when the same (kind, path/ref) key was last sent.
 */
export function shouldSendSignal(key: string, lastSentAt: Map<string, number>, now: number, windowMs = PAGE_VIEW_THROTTLE_MS): boolean {
  const last = lastSentAt.get(key);
  if (last != null && now - last < windowMs) return false;
  lastSentAt.set(key, now);
  return true;
}
