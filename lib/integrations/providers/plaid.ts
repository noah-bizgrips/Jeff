import "server-only";
import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products } from "plaid";
import { createPublicKey, createVerify } from "node:crypto";
import type { TestResult } from "./base";
import type { SecretBundle } from "@/lib/integrations/store";
import { requireEnv } from "@/lib/env";

/**
 * Plaid "Financial Accounts": Transactions only. No Auth, Transfer, or
 * Payment Initiation products are ever requested.
 */
export interface PlaidSecret extends SecretBundle {
  kind: "plaid_access_token";
  access_token: string;
  item_id: string;
}

export function plaidEnv(): "sandbox" | "production" {
  const v = (process.env.PLAID_ENV ?? "sandbox").toLowerCase();
  return v === "production" ? "production" : "sandbox";
}

export function plaidClient(): PlaidApi {
  const cfg = new Configuration({
    basePath: PlaidEnvironments[plaidEnv()],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": requireEnv("PLAID_CLIENT_ID"),
        "PLAID-SECRET": requireEnv("PLAID_SECRET"),
        "Plaid-Version": "2020-09-14",
      },
      timeout: 15000,
    },
  });
  return new PlaidApi(cfg);
}

export async function createLinkToken(ownerId: string, webhookUrl: string) {
  const client = plaidClient();
  const res = await client.linkTokenCreate({
    user: { client_user_id: ownerId },
    client_name: "Jeff",
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
    webhook: webhookUrl,
    transactions: { days_requested: 90 },
  });
  return res.data.link_token;
}

export async function exchangePublicToken(publicToken: string) {
  const client = plaidClient();
  const res = await client.itemPublicTokenExchange({ public_token: publicToken });
  return { accessToken: res.data.access_token, itemId: res.data.item_id };
}

/** Harmless read: item + account names/masks only. */
export async function testPlaid(secret: SecretBundle): Promise<TestResult> {
  const s = secret as PlaidSecret;
  const client = plaidClient();
  try {
    const item = await client.itemGet({ access_token: s.access_token });
    const products = item.data.item.products ?? [];
    const forbidden = products.filter((p) => ["auth", "transfer", "payment_initiation"].includes(String(p)));
    if (forbidden.length) return { ok: false, error: `plaid_forbidden_products:${forbidden.join(",")}` };
    const accounts = await client.accountsGet({ access_token: s.access_token });
    const summary = accounts.data.accounts.map((a) => ({ name: a.name, mask: a.mask, type: a.type, subtype: a.subtype }));
    return {
      ok: true,
      accountIdentifier: item.data.item.institution_name ?? item.data.item.institution_id ?? `Item ${s.item_id.slice(0, 8)}`,
      details: { accounts: summary, products, env: plaidEnv() },
    };
  } catch (err) {
    const code = (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code;
    return { ok: false, error: `plaid_test_failed:${code ?? "unknown"}` };
  }
}

/**
 * Verifies a Plaid webhook (JWT in `Plaid-Verification`, ES256, body sha256).
 * https://plaid.com/docs/api/webhooks/webhook-verification/
 */
export async function verifyPlaidWebhook(rawBody: string, verificationHeader: string | null): Promise<boolean> {
  if (!verificationHeader) return false;
  const parts = verificationHeader.split(".");
  if (parts.length !== 3) return false;
  const [h, p, sig] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let payload: { iat?: number; request_body_sha256?: string };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (header.alg !== "ES256" || !header.kid) return false;
  if (!payload.iat || Date.now() / 1000 - payload.iat > 300) return false;
  const { createHash } = await import("node:crypto");
  const bodyHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
  if (bodyHash !== payload.request_body_sha256) return false;
  const client = plaidClient();
  const keyRes = await client.webhookVerificationKeyGet({ key_id: header.kid });
  const jwk = keyRes.data.key;
  if (jwk.expired_at) return false;
  const pub = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
  const verifier = createVerify("SHA256");
  verifier.update(`${h}.${p}`);
  verifier.end();
  return verifier.verify({ key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
}
