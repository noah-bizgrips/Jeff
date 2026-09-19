"use client";

import { shouldSendSignal, type AttentionSignal } from "./types";

/**
 * Browser helper: records what the owner looks at so Jeff can tell what is
 * NOT being looked at. Fire-and-forget; throttled per (kind, ref/path).
 */
const lastSent = new Map<string, number>();

export function noteAttention(signal: AttentionSignal): void {
  if (typeof window === "undefined") return;
  const key = `${signal.kind}:${signal.ref_id ?? signal.path ?? ""}`;
  if (!shouldSendSignal(key, lastSent, Date.now())) return;
  const body = JSON.stringify({ signals: [signal] });
  try {
    if (typeof navigator.sendBeacon === "function") {
      const ok = navigator.sendBeacon("/api/attention", new Blob([body], { type: "application/json" }));
      if (ok) return;
    }
    void fetch("/api/attention", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => undefined);
  } catch {
    /* attention is best-effort */
  }
}
