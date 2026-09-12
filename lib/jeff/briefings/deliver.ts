/**
 * Delivery-provider abstraction (spec §37). In-app is the only implemented
 * channel in V1; the others are explicit stubs so adding email/push/SMS/Slack
 * later is a matter of implementing one function, not touching the engine.
 */

export type DeliveryProvider = "in_app" | "email" | "push" | "sms" | "slack";

export interface DeliveryReceipt {
  provider: DeliveryProvider;
  delivered_at: string | null;
  status: "delivered" | "not_configured" | "failed";
  detail?: string;
}

export interface Deliverable {
  id: string;
  kind: "briefing" | "alert";
  title: string;
  summary: string;
  /** Required for channels that address the owner's devices (push). */
  ownerId?: string;
  url?: string;
}

type Deliverer = (item: Deliverable, now: Date) => Promise<DeliveryReceipt>;

const providers: Record<DeliveryProvider, Deliverer> = {
  // The row in the database IS the in-app inbox; nothing else to do.
  in_app: async (_item, now) => ({ provider: "in_app", delivered_at: now.toISOString(), status: "delivered" }),
  email: async () => ({ provider: "email", delivered_at: null, status: "not_configured", detail: "Email delivery is not configured." }),
  push: async (item, now) => {
    const { pushConfigured, sendPush } = await import("@/lib/jeff/push/send");
    if (!pushConfigured() || !item.ownerId) return { provider: "push", delivered_at: null, status: "not_configured", detail: "Push delivery is not configured." };
    const res = await sendPush(item.ownerId, { title: item.title, body: item.summary, url: item.url ?? "/", tag: `${item.kind}:${item.id}` });
    if (res.delivered) return { provider: "push", delivered_at: now.toISOString(), status: "delivered", detail: `${res.delivered} device(s)` };
    return { provider: "push", delivered_at: null, status: res.attempted ? "failed" : "not_configured", detail: res.attempted ? "No device accepted the notification." : "No subscribed devices." };
  },
  sms: async () => ({ provider: "sms", delivered_at: null, status: "not_configured", detail: "SMS delivery is not configured." }),
  slack: async () => ({ provider: "slack", delivered_at: null, status: "not_configured", detail: "Slack delivery is not configured." }),
};

export async function deliver(item: Deliverable, channels: DeliveryProvider[] = ["in_app"], now = new Date()): Promise<DeliveryReceipt[]> {
  const out: DeliveryReceipt[] = [];
  for (const c of channels) {
    try {
      out.push(await providers[c](item, now));
    } catch (err) {
      out.push({ provider: c, delivered_at: null, status: "failed", detail: err instanceof Error ? err.message.slice(0, 120) : "failed" });
    }
  }
  return out;
}
