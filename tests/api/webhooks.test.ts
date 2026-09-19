import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
// `after()` needs a Next request scope; run the callback inline in tests.
vi.mock("next/server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("next/server")>();
  return { ...orig, after: (fn: () => unknown) => void fn() };
});
const syncFromWebhook = vi.fn(async () => {});
vi.mock("@/lib/integrations/sync/webhook-trigger", () => ({ syncFromWebhook: (...args: unknown[]) => syncFromWebhook(...(args as [])) }));

process.env.STRIPE_WEBHOOK_SECRET = "whsec_" + "t".repeat(32);
process.env.GITHUB_APP_WEBHOOK_SECRET = "gh-webhook-test-secret";
process.env.PLAID_CLIENT_ID = "plaid-test";
process.env.PLAID_SECRET = "plaid-test-secret";

const stripe = await import("@/app/api/webhooks/stripe/route");
const github = await import("@/app/api/webhooks/github/route");
const plaid = await import("@/app/api/webhooks/plaid/route");

function post(path: string, body: string, headers: Record<string, string> = {}) {
  return new Request(`https://jeff.test${path}`, { method: "POST", body, headers });
}

describe("Stripe webhook", () => {
  it("rejects a missing signature", async () => {
    const r = await stripe.POST(post("/api/webhooks/stripe", "{}"));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "missing_signature" });
  });
  it("rejects an invalid signature", async () => {
    const r = await stripe.POST(post("/api/webhooks/stripe", JSON.stringify({ id: "evt_1", type: "x" }), { "stripe-signature": "t=1,v1=deadbeef" }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_signature" });
  });
  it("accepts a correctly signed event", async () => {
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "customer.created", data: { object: {} } });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${payload}`).digest("hex");
    const r = await stripe.POST(post("/api/webhooks/stripe", payload, { "stripe-signature": `t=${t},v1=${v1}` }));
    expect(r.status).toBe(200);
    expect(syncFromWebhook).toHaveBeenCalledWith("stripe");
  });
  it("does not trigger a sync for rejected events", async () => {
    syncFromWebhook.mockClear();
    await stripe.POST(post("/api/webhooks/stripe", "{}", { "stripe-signature": "t=1,v1=bad" }));
    expect(syncFromWebhook).not.toHaveBeenCalled();
  });
});

describe("GitHub webhook", () => {
  it("rejects a bad HMAC", async () => {
    const r = await github.POST(post("/api/webhooks/github", "{}", { "x-hub-signature-256": "sha256=00" }));
    expect(r.status).toBe(400);
  });
  it("accepts a valid HMAC", async () => {
    const body = JSON.stringify({ action: "opened" });
    const sig = `sha256=${createHmac("sha256", process.env.GITHUB_APP_WEBHOOK_SECRET!).update(body).digest("hex")}`;
    const r = await github.POST(post("/api/webhooks/github", body, { "x-hub-signature-256": sig, "x-github-event": "pull_request" }));
    expect(r.status).toBe(200);
  });
});

describe("Plaid webhook", () => {
  it("rejects a malformed / unsigned request", async () => {
    const r = await plaid.POST(post("/api/webhooks/plaid", "not json"));
    expect(r.status).toBe(400);
    const r2 = await plaid.POST(post("/api/webhooks/plaid", "{}", { "plaid-verification": "garbage" }));
    expect(r2.status).toBe(400);
  });
});
