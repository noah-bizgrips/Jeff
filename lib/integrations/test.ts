import "server-only";
import { getOAuthAdapter } from "./providers";
import type { TestResult } from "./providers/base";
import { readSecret, setConnectionStatus, writeSecret, type SecretBundle } from "./store";
import type { ConnectionSummary } from "./types";
import { testStripe } from "./providers/stripe";
import { testPlaid } from "./providers/plaid";
import { testN8n } from "./providers/n8n";
import { testGithubApp } from "./providers/github";
import { googleAccessToken, type GoogleSecret } from "./providers/google";
import { highlevelAccessToken, type HighLevelSecret } from "./providers/highlevel";
import { errorMessage, log } from "@/lib/security/log";

/**
 * Runs the harmless provider test for a stored connection and records the
 * outcome. The decrypted secret never leaves this function's call stack.
 */
export async function runConnectionTest(conn: ConnectionSummary): Promise<TestResult> {
  await setConnectionStatus(conn.id, { status: "testing" });
  let result: TestResult;
  try {
    result = await testByProvider(conn);
  } catch (err) {
    result = { ok: false, error: errorMessage(err) };
  }
  const finalStatus = result.ok ? (result.limited ? "limited" : "connected") : reconnectOrError(result.error);
  try {
    await setConnectionStatus(conn.id, {
      status: finalStatus,
      lastTestOk: result.ok,
      lastError: result.ok ? null : (result.error ?? "test_failed"),
      accountIdentifier: result.accountIdentifier ?? conn.accountIdentifier,
      metadata: { ...conn.metadata, last_test_details: result.details ?? null },
    });
  } catch (err) {
    // Never leave a connection stuck in "testing": record the outcome without the optional fields, then surface the error.
    log.error("connection_status_write_failed", { connectionId: conn.id, message: errorMessage(err) });
    await setConnectionStatus(conn.id, { status: finalStatus, lastTestOk: result.ok, lastError: result.ok ? null : (result.error ?? "test_failed") });
  }
  // Strip anything that might be sensitive before returning to a route.
  return { ok: result.ok, limited: result.limited, accountIdentifier: result.accountIdentifier ?? null, details: result.details, error: result.error };
}

function reconnectOrError(error?: string) {
  if (error && /401|invalid_grant|refresh|expired|revoked/i.test(error)) return "reconnect_required" as const;
  return "error" as const;
}

async function testByProvider(conn: ConnectionSummary): Promise<TestResult> {
  const oauth = getOAuthAdapter(conn.provider);
  if (oauth) {
    const secret = await readSecret(conn.id);
    if (!secret) return { ok: false, error: "secret_missing" };
    // Refresh-capable providers: persist a refreshed token when the helper produced one.
    if (conn.provider === "google") {
      const r = await googleAccessToken(secret as GoogleSecret);
      if (r.refreshed) await writeSecret(conn.id, r.refreshed as SecretBundle, r.refreshed.expires_at ?? null);
      return oauth.test(r.refreshed ?? secret, conn.id);
    }
    if (conn.provider === "highlevel") {
      const r = await highlevelAccessToken(secret as HighLevelSecret);
      if (r.refreshed) await writeSecret(conn.id, r.refreshed as SecretBundle, r.refreshed.expires_at ?? null);
      return oauth.test(r.refreshed ?? secret, conn.id);
    }
    return oauth.test(secret, conn.id);
  }
  switch (conn.provider) {
    case "stripe": {
      const secret = await readSecret(conn.id);
      if (!secret) return { ok: false, error: "secret_missing" };
      return testStripe(secret);
    }
    case "plaid": {
      const secret = await readSecret(conn.id);
      if (!secret) return { ok: false, error: "secret_missing" };
      return testPlaid(secret);
    }
    case "n8n":
      return testN8n();
    case "github":
      return testGithubApp(conn);
    default:
      return { ok: false, error: "provider_not_testable" };
  }
}
