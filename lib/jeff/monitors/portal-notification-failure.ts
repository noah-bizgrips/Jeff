import { evidenceOf, type CandidateFinding, type Monitor } from "./types";
import { DAY, clientIndex, clientLabel, groupBy, str } from "./portal-shared";

/** Failed/bounced/stuck client notifications in the last LOOKBACK_DAYS, grouped by client + channel. */
export const LOOKBACK_DAYS = 7;

export const portalNotificationFailure: Monitor = {
  id: "portal_notification_failure",
  run(rows, ctx) {
    const now = ctx.now.getTime();
    const since = now - LOOKBACK_DAYS * DAY;
    const idx = clientIndex(rows);
    const failures = rows.filter((r) => {
      if (r.provider !== "portal" || r.resource_type !== "notification") return false;
      const t = r.source_timestamp ? Date.parse(r.source_timestamp) : NaN;
      return Number.isFinite(t) && t >= since;
    });
    const out: CandidateFinding[] = [];
    for (const [key, items] of groupBy(failures, (r) => `${str(r.metadata.client_id) ?? "none"}|${str(r.metadata.channel) ?? "unknown"}`)) {
      const [clientId, channel] = key.split("|");
      const name = clientLabel(idx, clientId === "none" ? null : clientId!, str(items[0]!.metadata.client_name) ?? "Staff/unknown");
      const reasons = [...new Set(items.map((r) => str(r.metadata.reason)).filter(Boolean))].slice(0, 4);
      out.push({
        fingerprint: `portal_notification_failure:${clientId}:${channel}`,
        category: "portal_notification_failure",
        title: `${name}: ${items.length} ${channel} notification${items.length === 1 ? "" : "s"} not delivered in ${LOOKBACK_DAYS} days`,
        observed_facts: items.slice(0, 8).map((r) => `${channel} for "${str(r.metadata.event) ?? "event"}" was ${str(r.metadata.status)}${str(r.metadata.reason) ? ` (${str(r.metadata.reason)})` : ""} at ${r.source_timestamp?.slice(0, 16).replace("T", " ")}.`),
        metrics: { failures: items.length, channel, reasons, lookback_days: LOOKBACK_DAYS, formula: "count of notification_log rows with status in (failed, bounced) or queued > 1h, per client and channel" },
        interpretation:
          channel === "email"
            ? "Interpretation: a bouncing address means the client is not seeing task reminders; the portal contact probably needs a corrected email."
            : channel === "sms"
              ? "Interpretation: SMS failures are usually an opted-out or invalid number; the client may think they were never asked."
              : "Interpretation: push failures usually mean an expired subscription on the client's device; email still reaches them.",
        evidence: items.slice(0, 10).map(evidenceOf),
        range_start: new Date(since).toISOString(),
        range_end: ctx.now.toISOString(),
        confidence: 0.85,
        limitations: "Only notifications the portal itself sends are visible; GoHighLevel/n8n messages are not in this log.",
        severity: items.length >= 3 ? "medium" : "low",
        proposed_mission: { title: `Fix ${channel} delivery for ${name}`, goal: `Check the ${channel} contact details for ${name} in the portal and prepare a corrected contact or an alternative channel. Do not message the client.` },
      });
    }
    return out;
  },
};
