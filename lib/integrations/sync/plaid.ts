import "server-only";
import { plaidClient, type PlaidSecret } from "@/lib/integrations/providers/plaid";
import { readSecret, setConnectionStatus } from "@/lib/integrations/store";
import type { ConnectionSummary } from "@/lib/integrations/types";
import { redactString } from "@/lib/security/redact";
import { mapAccount, mapTransaction } from "./plaid-mappers";
import type { SourceItemInput } from "./types";
import type { CapabilityFetch, SyncAdapter } from "./runner";

/**
 * Plaid "Financial Accounts" sync — Transactions product only.
 *
 * - /transactions/sync with the stored next_cursor (loops has_more, capped).
 * - added/modified → upsert; removed → delete (handled by the runner via
 *   `remove`).
 * - /accounts/balance/get → one "account" item per account (names, masks,
 *   balances only; never account/routing numbers).
 * - ITEM_LOGIN_REQUIRED flips the connection to reconnect_required.
 */

const MAX_PAGES = 5;
const PAGE_COUNT = 500;

interface PlaidApiError {
  response?: { data?: { error_code?: string; error_type?: string; request_id?: string } };
}

function plaidErrorCode(err: unknown): string {
  const e = err as PlaidApiError;
  return e?.response?.data?.error_code ?? e?.response?.data?.error_type ?? "unknown";
}

async function secretFor(conn: ConnectionSummary): Promise<PlaidSecret> {
  const secret = await readSecret<PlaidSecret>(conn.id);
  if (!secret || secret.kind !== "plaid_access_token") throw new Error("secret_missing");
  return secret;
}

function institutionOf(conn: ConnectionSummary): string | null {
  return conn.accountIdentifier ?? null;
}

async function failIfLoginRequired(conn: ConnectionSummary, err: unknown, what: string): Promise<never> {
  const code = plaidErrorCode(err);
  if (code === "ITEM_LOGIN_REQUIRED" || code === "ITEM_LOCKED" || code === "ACCESS_NOT_GRANTED") {
    await setConnectionStatus(conn.id, { status: "reconnect_required", lastError: `plaid_${code.toLowerCase()}` });
  }
  throw new Error(`plaid_${what}_failed:${redactString(code).slice(0, 60)}`);
}

const transactions: CapabilityFetch = async (conn, cursor) => {
  const secret = await secretFor(conn);
  const client = plaidClient();
  const institution = institutionOf(conn);
  const items: SourceItemInput[] = [];
  const remove: string[] = [];
  let seen = 0;
  let next = cursor ?? undefined;
  let hasMore = true;
  let pages = 0;
  while (hasMore && pages < MAX_PAGES) {
    pages++;
    let res;
    try {
      res = await client.transactionsSync({ access_token: secret.access_token, cursor: next, count: PAGE_COUNT });
    } catch (err) {
      await failIfLoginRequired(conn, err, "transactions_sync");
    }
    const data = res!.data;
    for (const t of [...data.added, ...data.modified]) {
      seen++;
      items.push(mapTransaction(t, institution));
    }
    for (const r of data.removed) if (r.transaction_id) remove.push(r.transaction_id);
    next = data.next_cursor;
    hasMore = !!data.has_more;
  }
  return { items, seen, cursor: next ?? null, remove: remove.length ? { resource_type: "transaction", external_ids: remove } : undefined };
};

/**
 * Account metadata + balances. Uses /accounts/get (no per-call charge; balances
 * are as of Plaid's last transaction refresh) instead of /accounts/balance/get,
 * which is billed per call and would run ~96×/day on the 30-minute cron.
 * Real-time balances are available on demand via `refreshBalancesNow`.
 */
const accounts: CapabilityFetch = async (conn) => {
  const secret = await secretFor(conn);
  const client = plaidClient();
  let res;
  try {
    res = await client.accountsGet({ access_token: secret.access_token });
  } catch (err) {
    await failIfLoginRequired(conn, err, "accounts_get");
  }
  const list = res!.data.accounts;
  return { items: list.map((a) => mapAccount(a, institutionOf(conn), secret.item_id)), seen: list.length };
};

/** Explicit, owner-triggered real-time balance refresh (billable per call). Not used by the cron. */
export async function refreshBalancesNow(conn: Parameters<CapabilityFetch>[0]) {
  const secret = await secretFor(conn);
  const client = plaidClient();
  const res = await client.accountsBalanceGet({ access_token: secret.access_token });
  const list = res.data.accounts;
  return { items: list.map((a) => mapAccount(a, institutionOf(conn), secret.item_id)), seen: list.length };
}

export const plaidSyncAdapter: SyncAdapter = {
  provider: "plaid",
  capabilities: { transactions, accounts },
  alwaysRun: ["accounts"],
};
